import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';
import { insertTemplate, splitWikiLink } from '../../core/vaultNotes';
import { livePreview, type LiveHooks } from './livePreview';
import { holds, lineBreakOf, textWith } from './lineEndings';

/**
 * A note's source, written in place: CodeMirror 6 with Markdown (GitHub's, as
 * remark-gfm reads it in the reading view), headings set at their size,
 * emphasis as emphasis, the marks that make them faint, and a wiki link or a
 * tag picked out as it is typed. `[[` offers the vault's notes, by name or
 * alias, and `#` its tags; Ctrl- or Cmd-click on a link opens it, Ctrl-S
 * saves at once (the screen saves by itself a moment after the last key too).
 *
 * The editor keeps the note's line endings (lineEndings.ts): a file written
 * with `\r\n` is saved with them, so a note made on Windows does not change
 * on every line because it was opened here, and a note opened and not touched
 * is not saved at all.
 */

export interface NoteEditorHandle {
  /** The first line drawn at the top, for the reading view to open at. */
  topLine(): number;
  focus(): void;
  /** A filled template put in at the cursor, its properties at the top when the note has none (`insertTemplate`). */
  insertTemplate(template: string): void;
}

export interface LinkChoice {
  title: string;
  path: string;
  folder: string;
  aliases: string[];
  /** What a link to it is written as: its name, or its path when another note has the name. */
  link: string;
}

const style = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.6em', fontWeight: '800', fontFamily: 'var(--font-display)', lineHeight: '1.3' },
  { tag: tags.heading2, fontSize: '1.32em', fontWeight: '800', fontFamily: 'var(--font-display)', lineHeight: '1.3' },
  { tag: tags.heading3, fontSize: '1.14em', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--color-muted)' },
  { tag: tags.link, color: 'var(--color-accent-2)' },
  { tag: tags.url, color: 'var(--color-muted)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', backgroundColor: 'var(--color-zinc-50)', borderRadius: '3px' },
  { tag: tags.quote, color: 'var(--color-zinc-600)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--color-zinc-400)' },
  { tag: tags.meta, color: 'var(--color-zinc-500)', fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  { tag: tags.labelName, color: 'var(--color-accent)' },
  { tag: tags.comment, color: 'var(--color-zinc-400)' },
]);

/**
 * The properties block at the top of a note, as one node: Markdown's own
 * grammar does not know it, and read its last key and the closing `---` as a
 * second-level heading. Drawn faint and in the label face, as the source of
 * what the reading view shows as properties. A block never closed runs to the
 * end of the note here - the grammar cannot look further than one line ahead
 * before it commits - where the reading view, as Obsidian does, reads none.
 */
const properties: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: tags.meta }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        const from = cx.lineStart;
        let to = from + line.text.length;
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length;
          if (/^---[ \t]*$/.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', from, to));
        return true;
      },
    },
  ],
};

/** CodeMirror's own look for the notes screen, as a theme: its classes outrank a stylesheet's. */
const look = EditorView.theme({
  '.cm-tooltip': {
    border: '1px solid var(--color-zinc-200)',
    borderRadius: '10px',
    backgroundColor: 'var(--color-white)',
    boxShadow: '0 12px 32px -12px rgb(27 23 18 / 0.35)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxHeight: '16rem' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0.3rem 0.7rem', fontSize: '13px', lineHeight: '1.4' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--color-zinc-100)', color: 'var(--color-ink)' },
  '.cm-completionDetail': { color: 'var(--color-zinc-400)', fontStyle: 'normal', marginLeft: '0.6rem', fontSize: '11px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-panels': { backgroundColor: 'var(--color-zinc-50)', borderColor: 'var(--color-zinc-100)', fontFamily: 'var(--font-sans)' },
});

/** A text put in from outside the editor - the note read again from disk - which is what the screen holds already, not typed. */
const fromDisk = Annotation.define<boolean>();

const WIKI = /!?\[\[[^[\]\n]+?\]\]/g;
const TAG = /(?<=^|[\s,;(])#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu;

/** Wiki links and tags picked out as they are typed, which Markdown's own grammar does not know. */
function marks(regexp: RegExp, className: string) {
  const decorator = new MatchDecorator({ regexp, decoration: Decoration.mark({ class: className }) });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/** The link under a position of the document, if a wiki link or a Markdown link is there. */
function linkAt(view: EditorView, pos: number): { target: string; subpath: string | null; kind: 'wiki' | 'markdown' } | null {
  const line = view.state.doc.lineAt(pos);
  const at = pos - line.from;
  for (const match of line.text.matchAll(/!?\[\[([^[\]\n]+?)\]\]/g)) {
    const start = match.index ?? 0;
    if (at < start || at > start + match[0].length) continue;
    const { target, subpath } = splitWikiLink(match[1]);
    return { target, subpath, kind: 'wiki' };
  }
  for (const match of line.text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0;
    if (at < start || at > start + match[0].length || /^[a-z][a-z0-9+.-]*:/i.test(match[1])) continue;
    let href = match[1];
    try {
      href = decodeURIComponent(href);
    } catch {
      /* as written */
    }
    const [target, subpath] = href.split('#');
    return { target, subpath: subpath ?? null, kind: 'markdown' };
  }
  return null;
}

export const NoteEditor = forwardRef<
  NoteEditorHandle,
  {
    value: string;
    readOnly: boolean;
    empty: string;
    onChange: (text: string) => void;
    onSave: () => void;
    onOpenLink: (link: { target: string; subpath: string | null; kind: 'wiki' | 'markdown' }, newTab: boolean) => void;
    choices: () => { notes: LinkChoice[]; tags: string[] };
    jump: { line: number; seq: number } | null;
    /** Obsidian's live preview (livePreview.ts); off, every line is its source. */
    live: boolean;
    hooks: LiveHooks;
  }
>(function NoteEditor({ value, readOnly, empty, onChange, onSave, onOpenLink, choices, jump, live, hooks }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const preview = useRef(new Compartment());
  // The latest of each callback, read when the editor calls it: the editor is made once.
  const latest = useRef({ onChange, onSave, onOpenLink, choices, hooks });
  latest.current = { onChange, onSave, onOpenLink, choices, hooks };
  const previewOf = (on: boolean) => (on ? livePreview(() => latest.current.hooks) : []);
  // The line break the note is written with, as last read: what it is given back with.
  const eol = useRef(lineBreakOf(value));

  useImperativeHandle(ref, () => ({
    topLine() {
      const editor = view.current;
      if (!editor) return 0;
      const block = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);
      return editor.state.doc.lineAt(block.from).number - 1;
    },
    focus() {
      view.current?.focus();
    },
    insertTemplate(template) {
      const editor = view.current;
      if (!editor) return;
      // Counted with one character a line break, as the editor counts its positions, whatever the note's own line endings.
      const doc = editor.state.doc.sliceString(0, editor.state.doc.length, '\n');
      const { text, cursor } = insertTemplate(doc, editor.state.selection.main.head, template.replace(/\r\n/g, '\n'));
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: EditorSelection.cursor(cursor), scrollIntoView: true });
      editor.focus();
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const links = (context: CompletionContext): CompletionResult | null => {
      const before = context.matchBefore(/\[\[[^[\]|#\n]*$/);
      if (!before) return null;
      const closed = context.state.sliceDoc(context.pos, context.pos + 2) === ']]';
      const apply = (text: string) => (editor: EditorView, _completion: Completion, from: number, to: number) => {
        const insert = closed ? text : `${text}]]`;
        editor.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + text.length + 2) });
      };
      const options: Completion[] = [];
      for (const note of latest.current.choices().notes) {
        options.push({ label: note.title, detail: note.folder || undefined, apply: apply(note.link), type: 'text' });
        for (const alias of note.aliases) options.push({ label: alias, detail: `→ ${note.title}`, apply: apply(`${note.link}|${alias}`), type: 'text' });
      }
      return { from: before.from + 2, options, validFor: /^[^[\]|#\n]*$/ };
    };
    const hashtags = (context: CompletionContext): CompletionResult | null => {
      const before = context.matchBefore(/(?:^|[\s,;(])#[\p{L}\p{N}_/-]*$/u);
      if (!before) return null;
      const hash = before.text.indexOf('#');
      return {
        from: before.from + hash + 1,
        options: latest.current.choices().tags.map((tag) => ({ label: tag, type: 'keyword' })),
        validFor: /^[\p{L}\p{N}_/-]*$/u,
      };
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, extensions: [properties] }),
        look,
        syntaxHighlighting(style),
        marks(WIKI, 'cm-wikilink'),
        marks(TAG, 'cm-tagmark'),
        search({ top: true }),
        autocompletion({ override: [links, hashtags], icons: false, activateOnTyping: true }),
        placeholder(empty),
        editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        preview.current.of(previewOf(live)),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave(), true) },
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({
          mousedown(event, editor) {
            if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
            const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            const link = pos === null ? null : linkAt(editor, pos);
            if (!link) return false;
            event.preventDefault();
            latest.current.onOpenLink(link, event.shiftKey);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((one) => one.annotation(fromDisk))) latest.current.onChange(textWith(update.state.doc, eol.current));
        }),
        EditorView.contentAttributes.of({ spellcheck: 'true', 'data-note-editor': '' }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    // The pointer says a link can be followed while Ctrl or Cmd is held.
    const held = (event: KeyboardEvent) => host.current?.classList.toggle('kg-editor-ctrl', event.ctrlKey || event.metaKey);
    window.addEventListener('keydown', held);
    window.addEventListener('keyup', held);
    return () => {
      window.removeEventListener('keydown', held);
      window.removeEventListener('keyup', held);
      editor.destroy();
      view.current = null;
    };
    // Made once per note: the parent keys the editor by the note's path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    A version read again from disk replaces the text; one that is what the
    editor already holds, whatever its line breaks, does nothing. Put in, it is
    not said back as typed (`fromDisk`): the screen has it already, and a note
    with both kinds of line break would have come back with one kind, and been
    saved so with nothing typed.
  */
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (/[\r\n]/.test(value)) eol.current = lineBreakOf(value);
    if (holds(editor.state.doc, value)) return;
    const lines = value.replace(/\r\n?/g, '\n');
    const head = Math.min(editor.state.selection.main.head, lines.length);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: lines }, selection: EditorSelection.cursor(head), annotations: fromDisk.of(true) });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: preview.current.reconfigure(previewOf(live)) });
    // Reconfigured when the mode is switched, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !jump) return;
    const line = editor.state.doc.line(Math.min(Math.max(1, jump.line + 1), editor.state.doc.lines));
    editor.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 48 }) });
    editor.focus();
  }, [jump]);

  return <div ref={host} className="kg-editor h-full min-h-0" />;
});

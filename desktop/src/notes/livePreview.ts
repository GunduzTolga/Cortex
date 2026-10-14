import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { splitWikiLink } from '../../core/vaultNotes';

/**
 * Obsidian's live preview, in CodeMirror: the note is written as it is read.
 * On every line but the ones the cursor or the selection is on, the Markdown's
 * marks are taken out of sight - a heading's `#`, the stars round emphasis, a
 * link's brackets and address, a wiki link's brackets and, where it has one,
 * its target behind the alias - and what they mark is drawn: a task as a box
 * that ticks, a bullet as a dot, a quote with its rule, a line of dashes as a
 * line, an image from the vault as the image. The lines the cursor is on show
 * their source, so what is written is never hidden from the one writing it.
 *
 * Nothing here changes the text but a ticked box, which is the same edit
 * typing an `x` would be. A link drawn on a line is followed by a click, as in
 * Obsidian; to edit it, the cursor is brought onto its line from beside it.
 * Tables, the properties block and code are left as their source, faint where
 * they are marks.
 */

export interface LiveHooks {
  /** The file a link of this note finds, or null. */
  resolve(target: string, kind: 'wiki' | 'markdown'): string | null;
  /** A vault image as a data URL, or null. */
  image(path: string): Promise<string | null>;
  open(link: { target: string; subpath: string | null; kind: 'wiki' | 'markdown' }, newTab: boolean): void;
  /** The pointer stopped on a drawn link, or left it: the note it finds is shown over the page (peek.tsx). */
  peek(link: { target: string; subpath: string | null; kind: 'wiki' | 'markdown' } | null, box?: DOMRect): void;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** A callout's colour by its kind, the palette the reading view uses (notes.css). */
const CALLOUT_COLOURS: Record<string, string> = {
  tip: 'var(--color-good)',
  hint: 'var(--color-good)',
  important: 'var(--color-good)',
  success: 'var(--color-good)',
  check: 'var(--color-good)',
  done: 'var(--color-good)',
  question: 'var(--color-warn)',
  help: 'var(--color-warn)',
  faq: 'var(--color-warn)',
  warning: 'var(--color-warn)',
  caution: 'var(--color-warn)',
  attention: 'var(--color-warn)',
  failure: 'var(--color-bad)',
  fail: 'var(--color-bad)',
  missing: 'var(--color-bad)',
  danger: 'var(--color-bad)',
  error: 'var(--color-bad)',
  bug: 'var(--color-bad)',
  example: 'var(--color-accent-2)',
  quote: 'var(--color-zinc-500)',
  cite: 'var(--color-zinc-500)',
};

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-lp-bullet';
    dot.textContent = '•';
    return dot;
  }
}

class Rule extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const line = document.createElement('span');
    line.className = 'cm-lp-rule';
    return line;
  }
}

/** A task's box. A click ticks it in the text, at the marker it stands for, found again at the moment of the click. */
class TaskBox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskBox) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'done' : 'to do');
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const at = view.posAtDOM(box);
      const marker = view.state.sliceDoc(at, at + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: marker[1] === ' ' ? 'x' : ' ' } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** An image of the vault, drawn where it is embedded, at the width `|300` asks for. */
class Picture extends WidgetType {
  constructor(
    readonly path: string,
    readonly width: number | null,
    readonly load: (path: string) => Promise<string | null>,
  ) {
    super();
  }
  eq(other: Picture) {
    return other.path === this.path && other.width === this.width;
  }
  toDOM() {
    const frame = document.createElement('span');
    frame.className = 'cm-lp-image';
    const image = document.createElement('img');
    image.alt = this.path.slice(this.path.lastIndexOf('/') + 1);
    if (this.width) image.width = this.width;
    frame.appendChild(image);
    void this.load(this.path).then((url) => {
      if (url) image.src = url;
      else frame.textContent = image.alt;
    });
    return frame;
  }
  ignoreEvent() {
    return false;
  }
}

/** The lines the selection touches: there the source is shown. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let line = state.doc.lineAt(range.from).number; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

/** Whether a position is in code, the properties block or a comment, where a `[[` is text. */
function inLiteral(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (['InlineCode', 'FencedCode', 'CodeBlock', 'Frontmatter', 'Comment', 'CommentBlock', 'HTMLBlock'].includes(node.name)) return true;
  }
  return false;
}

function build(view: EditorView, hooks: LiveHooks): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const lineOf = (pos: number) => state.doc.lineAt(pos).number;
  const shown = (pos: number) => active.has(lineOf(pos));
  const out: Range<Decoration>[] = [];
  /*
    A plugin may not replace a line break - CodeMirror throws, and the editor
    with it - and a link's title may run over two lines. What would is left
    as its source.
  */
  const oneLine = (from: number, to: number) => lineOf(from) === lineOf(to);
  const replace = (from: number, to: number, widget?: WidgetType) => {
    if (from < to && oneLine(from, to)) out.push(Decoration.replace(widget ? { widget } : {}).range(from, to));
  };
  const hide = (from: number, to: number) => replace(from, to);
  const lineClass = (from: number, to: number, className: string) => {
    for (let line = lineOf(from); line <= lineOf(to); line += 1) out.push(Decoration.line({ class: className }).range(state.doc.line(line).from));
  };
  const linkMark = (from: number, to: number, target: string, subpath: string | null, kind: 'wiki' | 'markdown', missing: boolean) => {
    if (from >= to) return;
    out.push(
      Decoration.mark({
        class: missing ? 'cm-lp-link cm-lp-missing' : 'cm-lp-link',
        attributes: { 'data-lp-target': target, 'data-lp-subpath': subpath ?? '', 'data-lp-kind': kind },
      }).range(from, to),
    );
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'Frontmatter':
          case 'CodeBlock':
          case 'HTMLBlock':
            return false;
          case 'FencedCode':
            lineClass(node.from, node.to, 'cm-lp-codeblock');
            return false;
          case 'Table':
            return false;
          case 'Blockquote': {
            // A callout (`> [!warning] Title`) is drawn as the reading view draws it: a tinted box, its marker out of sight.
            const first = state.doc.lineAt(node.from);
            const callout = /^\s*>\s*\[!([A-Za-z][\w-]*)\]([+-]?)/.exec(first.text);
            if (!callout) {
              lineClass(node.from, node.to, 'cm-lp-quote');
              return;
            }
            const colour = CALLOUT_COLOURS[callout[1].toLowerCase()] ?? 'var(--color-accent)';
            for (let line = first.number; line <= lineOf(node.to); line += 1) {
              out.push(Decoration.line({ class: line === first.number ? 'cm-lp-callout cm-lp-callout-title' : 'cm-lp-callout', attributes: { style: `--callout: ${colour}` } }).range(state.doc.line(line).from));
            }
            if (!shown(node.from)) {
              const marker = first.text.indexOf('[!');
              hide(first.from + marker, first.from + callout[0].length + (first.text[callout[0].length] === ' ' ? 1 : 0));
            }
            return;
          }
          case 'HeaderMark': {
            if (shown(node.from)) return;
            const line = state.doc.lineAt(node.from);
            // The opening marks and the space after them; closing ones and the space before.
            if (node.from === line.from || /^\s*$/.test(state.sliceDoc(line.from, node.from))) hide(node.from, Math.min(line.to, node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0)));
            else hide(state.sliceDoc(node.from - 1, node.from) === ' ' ? node.from - 1 : node.from, node.to);
            return;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!shown(node.from)) hide(node.from, node.to);
            return;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !shown(node.from)) hide(node.from, node.to);
            return;
          case 'QuoteMark':
            if (!shown(node.from)) hide(node.from, node.to + (state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0));
            return;
          case 'HorizontalRule':
            if (!shown(node.from)) replace(node.from, node.to, new Rule());
            return;
          case 'ListMark': {
            const item = node.node.parent;
            if (item?.parent?.name !== 'BulletList' || shown(node.from)) return;
            const task = item.getChild('Task');
            const after = state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0;
            if (task) hide(node.from, node.to + after);
            else replace(node.from, node.to, new Bullet());
            return;
          }
          case 'TaskMarker': {
            // Shown as source only while the cursor is in the brackets themselves, as Obsidian does.
            const touched = state.selection.ranges.some((range) => range.to >= node.from && range.from <= node.to);
            if (touched) return;
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            replace(node.from, node.to, new TaskBox(checked));
            return;
          }
          case 'Link':
          case 'Image': {
            if (shown(node.from) || !oneLine(node.from, node.to)) return;
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length < 2 || !url) return;
            let href = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
            try {
              href = decodeURIComponent(href);
            } catch {
              /* the path as written */
            }
            const [target, subpath] = href.split('#');
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (node.name === 'Image') {
              const path = external ? null : hooks.resolve(target, 'markdown');
              if (path && IMAGE.test(path)) replace(node.from, node.to, new Picture(path, null, hooks.image));
              return false;
            }
            hide(node.from, textFrom);
            hide(textTo, node.to);
            if (external) out.push(Decoration.mark({ class: 'cm-lp-link cm-lp-external', attributes: { title: href, 'data-lp-url': href } }).range(textFrom, textTo));
            else linkMark(textFrom, textTo, target, subpath ?? null, 'markdown', !hooks.resolve(target, 'markdown'));
            return;
          }
        }
      },
    });

    // What Markdown's grammar does not know: wiki links and embeds, and `==highlights==`.
    const text = state.sliceDoc(from, to);
    for (const match of text.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
      const start = from + (match.index ?? 0);
      const end = start + match[0].length;
      if (shown(start) || inLiteral(state, start)) continue;
      const { target, subpath, alias } = splitWikiLink(match[2]);
      const found = target ? hooks.resolve(target, 'wiki') : null;
      if (match[1] === '!' && found && IMAGE.test(found)) {
        const width = alias && /^\d{1,4}/.test(alias) ? Number(/^\d{1,4}/.exec(alias)![0]) : null;
        replace(start, end, new Picture(found, width, hooks.image));
        continue;
      }
      const open = start + match[1].length + 2;
      const close = end - 2;
      const pipe = match[2].search(/\\?\|/);
      // With an alias the target goes out of sight with the brackets, and the alias is the link.
      const shownFrom = pipe < 0 ? open : open + pipe + (match[2][pipe] === '\\' ? 2 : 1);
      hide(start, shownFrom);
      hide(close, end);
      linkMark(shownFrom, close, target, subpath, 'wiki', Boolean(target) && !found);
    }
    for (const match of text.matchAll(/==([^=\n](?:[^\n]*?[^=\n])?)==/g)) {
      const start = from + (match.index ?? 0);
      const end = start + match[0].length;
      if (inLiteral(state, start)) continue;
      if (!shown(start)) {
        hide(start, start + 2);
        hide(end - 2, end);
      }
      out.push(Decoration.mark({ class: 'cm-lp-highlight' }).range(start + 2, end - 2));
    }
  }
  return Decoration.set(out, true);
}

/** The live preview as one extension, its hooks read when they are needed. */
export function livePreview(hooks: () => LiveHooks) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, hooks());
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = build(update.view, hooks());
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
  // A link drawn on a line is followed by a plain click, as in Obsidian; Ctrl or Cmd opens it in a new tab.
  const linkOf = (element: HTMLElement) => ({
    target: element.dataset.lpTarget ?? '',
    subpath: element.dataset.lpSubpath || null,
    kind: element.dataset.lpKind === 'markdown' ? ('markdown' as const) : ('wiki' as const),
  });
  const follow = EditorView.domEventHandlers({
    mouseover(event) {
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-lp-target]');
      if (element) hooks().peek(linkOf(element), element.getBoundingClientRect());
      return false;
    },
    mouseout(event) {
      if ((event.target as HTMLElement | null)?.closest('[data-lp-target]')) hooks().peek(null);
      return false;
    },
    mousedown(event) {
      if (event.button !== 0 || event.shiftKey) return false;
      // A link off the machine goes to the system's browser on Ctrl- or Cmd-click (electron/main.ts sends a new window there), and only the web's.
      const web = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-lp-url]');
      if (web && (event.ctrlKey || event.metaKey) && /^https?:/i.test(web.dataset.lpUrl ?? '')) {
        event.preventDefault();
        window.open(web.dataset.lpUrl, '_blank', 'noopener');
        return true;
      }
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-lp-target]');
      if (!element) return false;
      event.preventDefault();
      hooks().peek(null);
      hooks().open(linkOf(element), event.ctrlKey || event.metaKey);
      return true;
    },
  });
  const look = EditorView.theme({
    '.cm-lp-bullet': { color: 'var(--color-zinc-400)', display: 'inline-block', width: '0.9em', fontWeight: '700' },
    '.cm-lp-task': { width: '0.95em', height: '0.95em', margin: '0 0.35em 0 0', verticalAlign: '-0.1em', accentColor: 'var(--color-accent)', cursor: 'pointer' },
    '.cm-lp-rule': { display: 'inline-block', width: '100%', borderTop: '1px solid var(--color-zinc-200)', verticalAlign: 'middle' },
    '.cm-line.cm-lp-quote': { borderLeft: '3px solid var(--color-zinc-200)', paddingLeft: '0.9em', color: 'var(--color-zinc-600)' },
    '.cm-line.cm-lp-callout': {
      backgroundColor: 'color-mix(in oklab, var(--callout) 9%, transparent)',
      borderLeft: '3px solid color-mix(in oklab, var(--callout) 45%, transparent)',
      paddingLeft: '0.9em',
      fontStyle: 'normal',
    },
    '.cm-line.cm-lp-callout-title': { color: 'var(--callout)', fontWeight: '700' },
    '.cm-line.cm-lp-codeblock': { backgroundColor: 'var(--color-zinc-50)', fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
    '.cm-lp-link': { color: 'var(--color-accent-2)', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'color-mix(in oklab, var(--color-accent-2) 35%, transparent)', textUnderlineOffset: '3px' },
    '.cm-lp-missing': { opacity: '0.6', textDecorationStyle: 'dashed' },
    '.cm-lp-external': { cursor: 'text' },
    '.cm-lp-highlight': { backgroundColor: 'color-mix(in oklab, var(--color-warn) 28%, transparent)', borderRadius: '3px' },
    '.cm-lp-image img': { maxWidth: '100%', borderRadius: '8px', verticalAlign: 'top', margin: '0.2em 0' },
  });
  return [plugin, follow, look];
}

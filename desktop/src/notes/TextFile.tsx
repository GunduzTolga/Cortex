import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

/**
 * A file of the vault that is not a note, shown as the text it is: a JSON, a
 * script, a config. Read only - the main process has no channel that writes
 * one (electron/services/vaultNotes.ts, `readVaultText`) - and never run.
 * The text can be selected, copied and searched (Ctrl+F); a JSON is coloured
 * in the paper's inks.
 */

const look = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--color-ink)' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--color-zinc-100)', color: 'var(--color-zinc-400)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-zinc-50)', color: 'var(--color-zinc-600)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(232 178 58 / 0.3) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgb(232 178 58 / 0.2)' },
  '.cm-panels': { backgroundColor: 'var(--color-zinc-50)', borderColor: 'var(--color-zinc-100)', fontFamily: 'var(--font-sans)' },
});

const inks = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--color-accent)' },
  { tag: tags.string, color: 'var(--color-good)' },
  { tag: tags.number, color: 'var(--color-warn)' },
  { tag: [tags.bool, tags.null], color: 'var(--color-accent-2)' },
  { tag: [tags.separator, tags.brace, tags.squareBracket], color: 'var(--color-zinc-400)' },
]);

export function TextFile({ path, text }: { path: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          drawSelection(),
          EditorState.readOnly.of(true),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          /\.json$/i.test(path) ? [json(), syntaxHighlighting(inks)] : [],
          look,
          EditorView.contentAttributes.of({ spellcheck: 'false', 'data-text-file': path }),
        ],
      }),
    });
    return () => view.destroy();
  }, [path, text]);
  return <div ref={host} className="h-full min-h-0" />;
}

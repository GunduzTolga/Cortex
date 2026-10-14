import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { folderOf } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import { NoteMarkdown, sectionOf } from './NoteMarkdown';
import { labelOf, useNotes } from './notesStore';
import { noteTextOf } from './vaultCache';

/**
 * Obsidian's page preview: a note shown over the page while a link to it is
 * hovered, a moment after the pointer stops on the link and for as long as it
 * is on the link or the preview. Read through the same cache the embeds use,
 * drawn without its own embeds (one level, as Obsidian's), and opened for good
 * by a click on its title.
 */

const SHOW_AFTER_MS = 450;
const HIDE_AFTER_MS = 250;
let showing: ReturnType<typeof setTimeout> | null = null;
let hiding: ReturnType<typeof setTimeout> | null = null;

const clear = () => {
  if (showing) clearTimeout(showing);
  if (hiding) clearTimeout(hiding);
  showing = hiding = null;
};

/** The pointer stopped on a link to `path`: shown in a moment, beside where the link is drawn. */
export function peekSoon(path: string, subpath: string | null, box: DOMRect): void {
  clear();
  showing = setTimeout(() => useNotes.setState({ peek: { path, subpath, x: box.left, y: box.top, below: box.bottom } }), SHOW_AFTER_MS);
}

/** The pointer left the link or the preview: gone in a moment, unless it comes back. */
export function peekLeave(): void {
  if (showing) clearTimeout(showing);
  showing = null;
  if (hiding) clearTimeout(hiding);
  hiding = setTimeout(() => useNotes.setState({ peek: null }), HIDE_AFTER_MS);
}

export function NotePeek() {
  const t = useT();
  const peek = useNotes((state) => state.peek);
  const modified = useNotes((state) => (peek ? state.index?.notes.find((note) => note.path === peek.path)?.modified ?? 0 : 0));
  const [text, setText] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!peek) return;
    let live = true;
    setText(undefined);
    void noteTextOf(peek.path, modified).then((read) => live && setText(read?.text ?? null));
    return () => {
      live = false;
    };
  }, [peek, modified]);

  const section = useMemo(() => (text ? sectionOf(text, peek?.subpath ?? null) : null), [text, peek]);
  if (!peek) return null;
  // Below the link where there is room, else above it; never off the window's side.
  const width = Math.min(440, window.innerWidth - 32);
  const left = Math.max(16, Math.min(peek.x, window.innerWidth - width - 16));
  const room = window.innerHeight - peek.below;
  const style = room > 300 ? { left, top: peek.below + 6, width } : { left, bottom: window.innerHeight - peek.y + 6, width };
  return (
    <div
      className="fixed z-[70] max-h-80 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_18px_44px_-18px_rgba(27,23,18,0.5)]"
      style={style}
      onMouseEnter={clear}
      onMouseLeave={peekLeave}
      data-note-peek={peek.path}
    >
      <button
        type="button"
        onClick={(event) => {
          useNotes.setState({ peek: null });
          useNotes.getState().open(peek.path, { newTab: event.ctrlKey || event.metaKey, subpath: peek.subpath });
        }}
        className="flex w-full items-center gap-2 border-b border-zinc-100 px-4 py-2 text-left hover:bg-zinc-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-darkDelegation">{labelOf(peek.path)}</span>
          {folderOf(peek.path) ? <span className="block truncate text-[10.5px] text-zinc-400">{folderOf(peek.path)}</span> : null}
        </span>
        <ExternalLink size={13} className="shrink-0 text-zinc-400" />
      </button>
      <div className="max-h-[16.5rem] overflow-y-auto px-5 py-3 text-[13px]">
        {text === undefined ? (
          <div className="h-16 animate-pulse rounded bg-zinc-50" />
        ) : text === null || !section ? (
          <p className="text-zinc-400">{t('notes.embed.none')}</p>
        ) : (
          <NoteMarkdown path={peek.path} source={section.source} offset={section.offset} depth={3} />
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, FilePlus2, FileText } from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import { folderOf, fuzzyMatch, nameProblem, noteTitle } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { useDialogLayer } from '../ui/useEscapeLayer';
import { useNotes } from './notesStore';

/**
 * Obsidian's quick switcher (Ctrl-O): a note by a few letters of its name, its
 * path or an alias, the most recently written first while nothing is typed.
 * Enter opens it, Ctrl-Enter in a new tab; a name no note has is offered as a
 * new note, made at the vault's top as a link would make it.
 */

const SHOWN = 40;

interface Choice {
  path: string;
  title: string;
  alias: string | null;
  score: number;
  indices: number[];
}

/** The letters that matched in bold; `indices` count UTF-16 units, as the match does, so an emoji is one piece and not two halves. */
function Bold({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices);
  let unit = 0;
  return (
    <>
      {Array.from(text).map((char, at) => {
        const here = unit;
        unit += char.length;
        return set.has(here) ? (
          <b key={at} className="font-bold text-darkDelegation">
            {char}
          </b>
        ) : (
          char
        );
      })}
    </>
  );
}

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const index = useNotes((state) => state.index);
  const readOnly = Boolean(index?.readOnly);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const sheet = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useDialogLayer(open, onClose, sheet);

  useEffect(() => {
    if (open) {
      setQuery('');
      setAt(0);
    }
  }, [open]);

  const choices = useMemo<Choice[]>(() => {
    const notes = index?.notes ?? [];
    if (!query.trim()) {
      return [...notes]
        .sort((a, b) => b.modified - a.modified)
        .slice(0, SHOWN)
        .map((note) => ({ path: note.path, title: noteTitle(note.path), alias: null, score: 0, indices: [] }));
    }
    const out: Choice[] = [];
    for (const note of notes) {
      const title = noteTitle(note.path);
      const byTitle = fuzzyMatch(query, title);
      const byPath = byTitle ? null : fuzzyMatch(query, note.path.replace(/\.md$/i, ''));
      let best: Choice | null = byTitle ? { path: note.path, title, alias: null, score: byTitle.score + 50, indices: byTitle.indices } : byPath ? { path: note.path, title, alias: null, score: byPath.score, indices: [] } : null;
      for (const alias of note.aliases) {
        const byAlias = fuzzyMatch(query, alias);
        if (byAlias && (!best || byAlias.score + 40 > best.score)) best = { path: note.path, title, alias, score: byAlias.score + 40, indices: byAlias.indices };
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, SHOWN);
  }, [index, query]);

  const exact = choices.some((one) => one.title.toLowerCase() === query.trim().toLowerCase());
  const canMake = Boolean(query.trim()) && !exact && !readOnly && !nameProblem(query.trim());
  const count = choices.length + (canMake ? 1 : 0);

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-switch-at="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const make = async () => {
    try {
      const made = await window.cortex.notes.create('', query.trim(), { text: '' });
      await useNotes.getState().refresh();
      useNotes.getState().open(made.path, { edit: true });
      onClose();
    } catch (err) {
      toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) });
    }
  };
  const choose = (which: number, newTab: boolean) => {
    if (which === choices.length && canMake) {
      void make();
      return;
    }
    const choice = choices[which];
    if (!choice) return;
    useNotes.getState().open(choice.path, { newTab });
    onClose();
  };

  if (!open) return null;
  return (
    <div className="below-titlebar z-[85] flex items-start justify-center bg-black/25 px-6 pt-[12vh]" onMouseDown={onClose}>
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.switcher')}
        tabIndex={-1}
        className="kg-sheet animate-rise w-full max-w-xl overflow-hidden bg-white outline-none"
        onMouseDown={(event) => event.stopPropagation()}
        data-notes-switcher
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setAt((at + 1) % Math.max(count, 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setAt((at - 1 + Math.max(count, 1)) % Math.max(count, 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey && canMake) void make();
              else choose(at, event.ctrlKey || event.metaKey);
            }
          }}
          placeholder={t('notes.switcher.placeholder')}
          className="h-12 w-full border-b border-zinc-100 bg-transparent px-4 text-[15px] text-darkDelegation outline-none placeholder:text-zinc-400"
          data-notes-switcher-input
        />
        <ul ref={list} className="max-h-[50vh] overflow-y-auto py-1.5">
          {choices.map((choice, which) => (
            <li key={`${choice.path}\n${choice.alias ?? ''}`}>
              <button
                type="button"
                data-switch-at={which}
                data-switch-path={choice.path}
                onMouseEnter={() => setAt(which)}
                onClick={(event) => choose(which, event.ctrlKey || event.metaKey)}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left ${which === at ? 'bg-zinc-100' : ''}`}
              >
                <FileText size={14} className="shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-zinc-600">
                    {choice.alias ? (
                      <>
                        <Bold text={choice.alias} indices={choice.indices} />
                        <span className="ml-2 text-zinc-400">→ {choice.title}</span>
                      </>
                    ) : (
                      <Bold text={choice.title} indices={choice.indices} />
                    )}
                  </span>
                  {folderOf(choice.path) ? <span className="block truncate text-[11px] text-zinc-400">{folderOf(choice.path)}</span> : null}
                </span>
                {which === at ? <CornerDownLeft size={13} className="shrink-0 text-zinc-400" /> : null}
              </button>
            </li>
          ))}
          {canMake ? (
            <li>
              <button
                type="button"
                data-switch-at={choices.length}
                data-switch-make
                onMouseEnter={() => setAt(choices.length)}
                onClick={() => void make()}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13.5px] text-zinc-600 ${at === choices.length ? 'bg-zinc-100' : ''}`}
              >
                <FilePlus2 size={14} className="shrink-0 text-zinc-400" />
                {t('notes.switcher.make', { name: query.trim() })}
              </button>
            </li>
          ) : null}
          {!count ? <li className="px-4 py-3 text-[13px] text-zinc-400">{t('notes.switcher.none')}</li> : null}
        </ul>
        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-400">{t('notes.switcher.keys')}</p>
      </div>
    </div>
  );
}

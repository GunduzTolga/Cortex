import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, X } from 'lucide-react';
import type { NoteRead } from '@shared/notes';
import { messageOf } from '@shared/ipcError';
import { refusal } from '../store/app';
import { folderOf } from '../../core/vaultNotes';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { NoteDocument } from '../notes/NoteMarkdown';
import { folderLabel, useLabel, useNotes } from '../notes/notesStore';
import { Spinner } from '../ui/ui';
import { useChat } from './chatStore';
import { captureNoteLinks, openNote } from './noteLinks';
import type { NoteRef } from './turns';

/**
 * The panel beside the chat: the notes this chat touched - read or changed
 * by a step, named in an answer - and, opened from there or from a link in
 * an answer, one of them, read as the notes screen reads it. A note the AI
 * changes on disk is read again as it changes. Written in the notes, a click
 * away; the conversation never leaves the screen.
 */

const TAGS: Array<[keyof Omit<NoteRef, 'path'>, Key, string]> = [
  ['edited', 'chat.side.edited', 'bg-gold/25 text-darkDelegation'],
  ['read', 'chat.side.read', 'bg-zinc-100 text-zinc-500'],
  ['mentioned', 'chat.side.mentioned', 'bg-zinc-100 text-zinc-500'],
];

function NoteRow({ note }: { note: NoteRef }) {
  const t = useT();
  const label = useLabel(note.path);
  return (
    <li>
      <button type="button" onClick={(event) => openNote(note.path, event.ctrlKey || event.metaKey)} className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-zinc-50" data-chat-side-item={note.path}>
        <FileText size={14} className="mt-0.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-zinc-700">{label}</span>
          <span className="block truncate text-[10.5px] text-zinc-400">{folderLabel(folderOf(note.path)) || '/'}</span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {TAGS.filter(([key]) => note[key]).map(([key, words, colours]) => (
            <span key={key} className={`rounded px-1.5 py-px text-[10px] font-semibold ${colours}`}>
              {t(words)}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

/** One note, read: again whenever it changes on disk. */
function Preview({ path }: { path: string }) {
  const t = useT();
  const modified = useNotes((state) => state.index?.notes.find((note) => note.path === path)?.modified ?? null);
  const [read, setRead] = useState<NoteRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.cortex.notes.read(path).then(
      (got) => {
        if (!live) return;
        setRead(got);
        setFailed(null);
      },
      (err) => live && setFailed(refusal(messageOf(err))),
    );
    return () => {
      live = false;
    };
  }, [path, modified]);
  if (failed) return <p className="p-4 text-[12.5px] text-bad">{t('chat.side.failed')}: {failed}</p>;
  if (!read) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="kg-chat px-5 py-4" onClickCapture={captureNoteLinks} data-chat-side-note={path}>
      {read.text === null ? <p className="text-[12.5px] text-zinc-500">{t('notes.tooLarge')}</p> : <NoteDocument path={path} text={read.text} />}
    </div>
  );
}

export function SidePane({ notes }: { notes: NoteRef[] }) {
  const t = useT();
  const side = useChat((state) => state.side);
  const label = useLabel(side.path ?? '');
  const iconButton = 'rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation';
  return (
    <aside className="flex w-[24rem] shrink-0 flex-col border-l border-zinc-100" data-chat-side>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-100 px-2">
        {side.path ? (
          <>
            <button type="button" onClick={() => useChat.getState().showSide(null)} title={t('chat.side.title')} aria-label={t('chat.side.title')} className={iconButton} data-chat-side-back>
              <ArrowLeft size={14} />
            </button>
            <p className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-darkDelegation">{label}</p>
            <button type="button" onClick={() => side.path && openNote(side.path, true)} title={t('chat.side.open')} aria-label={t('chat.side.open')} className={iconButton} data-chat-side-open>
              <ExternalLink size={14} />
            </button>
          </>
        ) : (
          <p className="min-w-0 flex-1 px-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{t('chat.side.title')}</p>
        )}
        <button type="button" onClick={() => useChat.getState().hideSide()} title={t('chat.side.close')} aria-label={t('chat.side.close')} className={iconButton} data-chat-side-close>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {side.path ? (
          <Preview key={side.path} path={side.path} />
        ) : notes.length ? (
          <ul className="space-y-px p-1.5">
            {notes.map((note) => (
              <NoteRow key={note.path} note={note} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-[12px] leading-relaxed text-zinc-400">{t('chat.side.empty')}</p>
        )}
      </div>
    </aside>
  );
}

import { useEffect } from 'react';
import { File, FileText, Folder, HelpCircle, RotateCcw, Trash2, X } from 'lucide-react';
import type { TrashItem } from '@shared/notes';
import { messageOf } from '@shared/ipcError';
import { baseName, folderOf, isNotePath, noteTitle } from '../../core/vaultNotes';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Button, Spinner } from '../ui/ui';
import { useNotes } from './notesStore';
import { useConfirm } from './NotesMenus';

/**
 * The vault's bin on this screen (electron/services/vaultNotes.ts keeps it in
 * `.trash/`): a delete moves the thing there and says so with an Undo, the
 * left column lists what is in it, and from there each comes back where it
 * was or goes on to the system's bin. A note or a file is moved without a
 * question, since one click brings it back; a folder, which can hold much,
 * is asked about first.
 */

type Translate = ReturnType<typeof useT>;
type Toast = ReturnType<typeof useApp.getState>['toast'];

/** The name a thing in the bin is shown by: a note without `.md`, as the tree shows it. */
const nameOf = (from: string) => (isNotePath(from) ? noteTitle(from) : baseName(from));

/** Take one back: where it was, or beside it when that place was taken since; a note is opened again. */
export async function restoreFromBin(id: string, t: Translate, toast: Toast, wanted?: string): Promise<void> {
  try {
    const { path } = await window.cortex.notes.binRestore(id);
    await useNotes.getState().refresh();
    toast({ tone: 'success', title: t('notes.bin.restored', { name: nameOf(path) }), ...(wanted && wanted !== path ? { detail: t('notes.bin.beside', { path }) } : {}) });
    if (isNotePath(path)) useNotes.getState().open(path);
  } catch (err) {
    toast({ tone: 'error', title: t('notes.bin.failed'), detail: messageOf(err) });
  }
}

/** Delete from the tree or a note's menu: into the bin, with an Undo on the toast that says so. */
export function useTrash() {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const confirm = useConfirm();
  return async (path: string, folder?: { count: number }) => {
    const name = nameOf(path);
    if (folder && !(await confirm({ title: t('notes.trash.title', { name }), detail: t('notes.trash.folder', { count: folder.count }), action: t('notes.trash.action') }))) return;
    try {
      const { id } = await window.cortex.notes.trash(path);
      useNotes.getState().removed(path);
      await useNotes.getState().refresh();
      toast({ tone: 'success', title: t('notes.trash.moved', { name }), action: { label: t('notes.trash.undo'), run: () => void restoreFromBin(id, t, toast, path) } });
    } catch (err) {
      toast({ tone: 'error', title: t('notes.trash.failed'), detail: messageOf(err) });
    }
  };
}

/** When it was deleted, as a person says it: a moment ago, minutes, hours, days; past a week, the date. */
function whenOf(at: number, language: string): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const words = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
  ];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return unit === 'second' ? words.format(0, 'second') : words.format(value, unit);
    value = Math.round(value / size);
  }
  return new Date(at).toLocaleDateString(language);
}

const ICONS: Record<TrashItem['kind'], React.ReactNode> = {
  note: <FileText size={14} />,
  file: <File size={14} />,
  folder: <Folder size={14} />,
};

/** The left column's bin: what is in it, the last deleted first, each to restore or delete for good. */
export function TrashPanel() {
  const t = useT();
  const language = useLanguage();
  const toast = useApp((s) => s.toast);
  const confirm = useConfirm();
  const bin = useNotes((state) => state.bin);

  useEffect(() => {
    void useNotes.getState().refreshBin();
  }, []);

  const failed = (err: unknown) => toast({ tone: 'error', title: t('notes.bin.failed'), detail: messageOf(err) });
  const remove = async (item: TrashItem) => {
    if (!(await confirm({ title: t('notes.bin.delete.title', { name: nameOf(item.from) }), detail: t('notes.bin.delete.detail'), action: t('notes.bin.delete') }))) return;
    try {
      await window.cortex.notes.binDelete(item.id);
    } catch (err) {
      failed(err);
    }
    await useNotes.getState().refreshBin();
  };
  const empty = async () => {
    if (!bin?.length) return;
    if (!(await confirm({ title: t('notes.bin.emptyAll.title', { count: bin.length }), detail: t('notes.bin.emptyAll.detail'), action: t('notes.bin.emptyAll') }))) return;
    try {
      await window.cortex.notes.binEmpty();
    } catch (err) {
      failed(err);
    }
    await useNotes.getState().refreshBin();
  };

  if (bin === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  const sizeOf = (item: TrashItem) => (item.kind === 'folder' ? t('notes.bin.files', { count: item.size }) : t('notes.file.size', { size: Math.max(1, Math.round(item.size / 1024)) }));
  const hint: Key = bin.length ? 'notes.bin.hint' : 'notes.bin.empty';

  return (
    <div className="flex h-full min-h-0 flex-col" data-notes-bin>
      <p className="shrink-0 px-3.5 pb-1 pt-2.5 text-[10.5px] leading-relaxed text-zinc-400">{t(hint)}</p>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-4">
        {bin.map((item) => (
          <li key={item.id} className="group rounded-md px-2 py-1.5 hover:bg-zinc-50" data-bin-item={item.id}>
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-zinc-400">{ICONS[item.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-600">{nameOf(item.from)}</span>
              {!item.known ? (
                <span className="shrink-0 text-zinc-300" title={t('notes.bin.unknown')}>
                  <HelpCircle size={12} />
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void restoreFromBin(item.id, t, toast, item.from)}
                title={t('notes.bin.restore')}
                aria-label={t('notes.bin.restore')}
                className="shrink-0 rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-darkDelegation focus:opacity-100 group-hover:opacity-100"
                data-bin-restore
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                onClick={() => void remove(item)}
                title={t('notes.bin.delete')}
                aria-label={t('notes.bin.delete')}
                className="shrink-0 rounded p-1 text-zinc-400 opacity-0 hover:bg-red-50 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
                data-bin-delete
              >
                <X size={13} />
              </button>
            </div>
            <p className="truncate pl-[1.35rem] text-[10.5px] text-zinc-400">
              {folderOf(item.from) || t('notes.bin.top')} · {whenOf(item.deletedAt, language)} · {sizeOf(item)}
            </p>
          </li>
        ))}
      </ul>
      {bin.length ? (
        <div className="shrink-0 border-t border-zinc-100 p-2">
          <Button tone="danger" className="w-full" onClick={() => void empty()} data-bin-empty>
            <Trash2 size={13} />
            {t('notes.bin.emptyAll')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

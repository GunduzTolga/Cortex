import { useEffect, useState } from 'react';
import type { TextRead } from '@shared/notes';
import { CalendarDays, FilePlus2, FileText, FolderOpen, LayoutDashboard, Network, PanelLeftOpen, PanelRightOpen, Plus, Search, X, Zap } from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import { baseName, dayOf, folderOf, isNotePath, noteTitle } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Button, Spinner } from '../ui/ui';
import { NotePane } from './NotePane';
import { NotesNav, useMakers } from './NotesNav';
import { NoteSidebar } from './NoteSidebar';
import { QuickSwitcher } from './QuickSwitcher';
import { NotePeek } from './peek';
import { imageOf } from './vaultCache';
import { folderLabel, labelOf, nameLabel, useActiveTab, useNotes } from './notesStore';
import { TextFile } from './TextFile';
import './notes.css';

/**
 * The notes screen on the Cortex side (14 October): the vault read and written
 * as in Obsidian, which is closed source and cannot be put inside the app.
 * The tree, a search and the tags on the left; the notes open in tabs in the
 * middle, read or edited; what links where, the outline and the graph around
 * the note on the right. Ctrl-O finds a note, Ctrl-Shift-F searches, Ctrl-N
 * makes one, Ctrl-E switches between reading and editing, Alt and the arrows
 * go back and forward.
 *
 * Everything shown is read by the main process's whole-vault reader
 * (electron/services/vaultNotes.ts), which is the person's alone: nothing
 * here is handed to a model.
 */

const FOLD_KEY = 'cortex.notes.fold';

function useFold(): [{ nav: boolean; side: boolean }, (next: { nav: boolean; side: boolean }) => void] {
  const [fold, setFold] = useState<{ nav: boolean; side: boolean }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as { nav?: unknown; side?: unknown };
      return { nav: saved.nav === true, side: saved.side === true };
    } catch {
      return { nav: false, side: false };
    }
  });
  return [
    fold,
    (next) => {
      setFold(next);
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        /* for this run */
      }
    },
  ];
}

export function NotesView({ visible, onGraph }: { visible: boolean; onGraph: () => void }) {
  const t = useT();
  const index = useNotes((state) => state.index);
  const error = useNotes((state) => state.error);
  const tabs = useNotes((state) => state.tabs);
  const active = useNotes((state) => state.active);
  const tab = useActiveTab();
  const [fold, setFold] = useFold();
  const [switching, setSwitching] = useState(false);
  const makers = useMakers();

  // Read when first shown, whenever the vault changes on disk, and when the window comes back (where the platform cannot watch the vault).
  useEffect(() => {
    if (!visible) return;
    void useNotes.getState().refresh();
    const changed = window.cortex.on.notesChanged(() => void useNotes.getState().refresh());
    const back = () => void useNotes.getState().refresh();
    window.addEventListener('focus', back);
    return () => {
      changed();
      window.removeEventListener('focus', back);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const keys = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && !event.altKey && key === 'e') {
        event.preventDefault();
        useNotes.getState().switchMode();
      } else if (mod && !event.shiftKey && key === 'o') {
        event.preventDefault();
        setSwitching(true);
      } else if (mod && event.shiftKey && key === 'f') {
        event.preventDefault();
        if (fold.nav) setFold({ ...fold, nav: false });
        useNotes.getState().setNav('search');
      } else if (mod && event.shiftKey && key === 'n') {
        event.preventDefault();
        if (!useNotes.getState().index?.readOnly) void makers.capture();
      } else if (mod && !event.shiftKey && key === 'n') {
        event.preventDefault();
        if (!useNotes.getState().index?.readOnly) void makers.newNote('');
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        useNotes.getState().back();
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        useNotes.getState().forward();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [visible, fold, setFold, makers]);

  if (error && !index) return <p className="p-8 text-[13px] text-bad">{error}</p>;
  if (!index) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (index.missing) return <p className="p-8 text-[13px] text-bad">{index.missing}</p>;

  const titleOf = (path: string | null) => (path ? labelOf(path) : t('notes.tab.new'));

  return (
    <div className="@container flex h-full min-h-0" data-notes-view>
      {fold.nav ? (
        <button type="button" onClick={() => setFold({ ...fold, nav: false })} title={t('notes.nav.unfold')} className="flex w-9 shrink-0 justify-center border-r border-zinc-100 pt-2.5 text-zinc-400 hover:text-darkDelegation">
          <PanelLeftOpen size={15} />
        </button>
      ) : (
        <aside className="@container w-64 shrink-0 border-r border-zinc-100">
          <NotesNav onFold={() => setFold({ ...fold, nav: true })} />
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-zinc-100 bg-zinc-50/60 px-2" role="tablist" data-notes-tabs>
          {tabs.map((one) => (
            <div
              key={one.id}
              role="tab"
              aria-selected={one.id === active}
              data-notes-tab={one.path ?? ''}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  useNotes.getState().closeTab(one.id);
                }
              }}
              className={`group flex h-8 min-w-0 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 pl-3 pr-1 text-[12px] ${
                one.id === active ? 'border-zinc-100 bg-white text-darkDelegation' : 'border-transparent text-zinc-400 hover:text-zinc-600'
              }`}
            >
              <button type="button" onClick={() => useNotes.getState().setActive(one.id)} className="min-w-0 flex-1 truncate text-left">
                {titleOf(one.path)}
              </button>
              <button type="button" onClick={() => useNotes.getState().closeTab(one.id)} title={t('notes.tab.close')} className="rounded p-0.5 text-zinc-300 opacity-0 hover:bg-zinc-100 hover:text-darkDelegation group-hover:opacity-100 aria-selected:opacity-100">
                <X size={12} />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => useNotes.getState().newTab()} title={t('notes.tab.add')} className="mb-1 ml-1 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {!tab.path ? (
            <NotesHome onSwitch={() => setSwitching(true)} onGraph={onGraph} onNew={() => void makers.newNote('')} onCapture={() => void makers.capture()} />
          ) : isNotePath(tab.path) ? (
            <NotePane key={tab.path} path={tab.path} />
          ) : (
            <FileView key={tab.path} path={tab.path} />
          )}
        </div>
      </section>

      {fold.side ? (
        <button type="button" onClick={() => setFold({ ...fold, side: false })} title={t('notes.side.unfold')} className="hidden w-9 shrink-0 justify-center border-l border-zinc-100 pt-2.5 text-zinc-400 hover:text-darkDelegation @3xl:flex">
          <PanelRightOpen size={15} />
        </button>
      ) : (
        <aside className="@container hidden w-72 shrink-0 border-l border-zinc-100 @3xl:block">
          <NoteSidebar onFold={() => setFold({ ...fold, side: true })} />
        </aside>
      )}

      <QuickSwitcher open={switching} onClose={() => setSwitching(false)} />
      <NotePeek />
    </div>
  );
}

/** An empty tab: what can be done from here, and the notes written last. */
function NotesHome({ onSwitch, onGraph, onNew, onCapture }: { onSwitch: () => void; onGraph: () => void; onNew: () => void; onCapture: () => void }) {
  const t = useT();
  const index = useNotes((state) => state.index);
  const recent = [...(index?.notes ?? [])].sort((a, b) => b.modified - a.modified).slice(0, 8);
  const readOnly = Boolean(index?.readOnly);
  /*
    Cortex's own places, where the vault has them (its CLAUDE.md routes them
    so): the day's page in its command centre, and today's record of sessions
    with Pyn, which Cortex writes and the person reads.
  */
  const dashboard = index?.notes.find((note) => noteTitle(note.path) === 'Dashboard' && /Command-Center$/.test(folderOf(note.path).normalize('NFC')))?.path ?? null;
  const today = index?.notes.find((note) => note.path === `daily/${dayOf(new Date())}.md`)?.path ?? null;
  return (
    <div className="h-full overflow-y-auto" data-notes-home>
      <div className="mx-auto max-w-xl px-8 py-14">
        <h2 className="font-display text-3xl font-extrabold tracking-tight text-darkDelegation">{index?.vault?.name}</h2>
        <p className="mt-1 text-[13px] text-zinc-500">{t('notes.home.counts', { notes: index?.notes.length ?? 0, files: index?.files.length ?? 0 })}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button tone="primary" onClick={onNew} disabled={readOnly}>
            <FilePlus2 size={14} />
            {t('notes.new.note')}
          </Button>
          <Button onClick={onCapture} disabled={readOnly} data-notes-home-capture>
            <Zap size={14} />
            {t('notes.capture')}
          </Button>
          <Button onClick={onSwitch}>
            <FileText size={14} />
            {t('notes.home.find')}
          </Button>
          <Button onClick={() => useNotes.getState().setNav('search')}>
            <Search size={14} />
            {t('notes.nav.search')}
          </Button>
          <Button onClick={onGraph}>
            <Network size={14} />
            {t('notes.graph.title')}
          </Button>
        </div>
        {dashboard || today ? (
          <div className="mt-8 grid gap-2 @lg:grid-cols-2" data-notes-places>
            {[
              dashboard ? { path: dashboard, icon: <LayoutDashboard size={15} />, label: t('notes.home.dashboard') } : null,
              today ? { path: today, icon: <CalendarDays size={15} />, label: t('notes.home.today') } : null,
            ]
              .filter((place): place is NonNullable<typeof place> => place !== null)
              .map((place) => (
                <button
                  key={place.path}
                  type="button"
                  onClick={(event) => useNotes.getState().open(place.path, { newTab: event.ctrlKey || event.metaKey })}
                  className="flex items-center gap-3 rounded-xl border border-zinc-100 px-4 py-3 text-left hover:bg-zinc-50"
                >
                  <span className="text-accent">{place.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-darkDelegation">{place.label}</span>
                    <span className="block truncate text-[11px] text-zinc-400">{place.path}</span>
                  </span>
                </button>
              ))}
          </div>
        ) : null}
        {recent.length ? (
          <>
            <p className="mb-2 mt-10 text-[10px] font-black uppercase tracking-widest text-zinc-400">{t('notes.home.recent')}</p>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-100" data-notes-recent>
              {recent.map((note) => (
                <li key={note.path}>
                  <button type="button" onClick={(event) => useNotes.getState().open(note.path, { newTab: event.ctrlKey || event.metaKey })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50">
                    <FileText size={14} className="shrink-0 text-zinc-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-darkDelegation">{labelOf(note.path)}</span>
                      {folderOf(note.path) ? <span className="block truncate text-[11px] text-zinc-400">{folderLabel(folderOf(note.path))}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-400">{new Date(note.modified).toLocaleDateString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-10 text-[13px] text-zinc-400">{t('notes.home.empty')}</p>
        )}
        <p className="mt-10 text-[11.5px] leading-relaxed text-zinc-400">{t('notes.home.keys')}</p>
      </div>
    </div>
  );
}

/**
 * A file of the vault that is not a note: an image drawn, a text file (a JSON,
 * a script, a config) shown read only with its lines numbered, anything else
 * named; its folder a click away. Nothing is run.
 */
function FileView({ path }: { path: string }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const file = useNotes((state) => state.index?.files.find((one) => one.path === path) ?? null);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [read, setRead] = useState<TextRead | null | undefined>(undefined);
  const image = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
  useEffect(() => {
    if (!image || !file) return;
    let live = true;
    void imageOf(path, file.modified).then((got) => live && setUrl(got));
    return () => {
      live = false;
    };
  }, [image, path, file]);
  // Read again when the file changes on disk, as a note is.
  useEffect(() => {
    if (image || !file) return;
    let live = true;
    window.cortex.notes.text(path).then(
      (got) => live && setRead(got),
      () => live && setRead(null),
    );
    return () => {
      live = false;
    };
  }, [image, path, file?.modified]);
  const show = () =>
    window.cortex.notes.open(path, 'folder').catch((err) => toast({ tone: 'error', title: t('notes.open.failed'), detail: messageOf(err) }));
  const size = file ? t('notes.file.size', { size: Math.max(1, Math.round(file.size / 1024)) }) : null;

  if (!image && read === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!image && read?.text != null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-notes-file={path} data-notes-file-text>
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
          <p className="min-w-0 truncate text-[12px] text-zinc-400">
            {folderOf(path) ? `${folderLabel(folderOf(path)).split('/').join(' / ')} / ` : ''}
            <span className="text-zinc-600">{nameLabel(baseName(path))}</span>
          </p>
          {size ? <span className="shrink-0 text-[11px] text-zinc-400">{size}</span> : null}
          <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{t('notes.file.readOnly')}</span>
          <button type="button" onClick={() => void show()} title={t('notes.open.folder')} aria-label={t('notes.open.folder')} className="ml-auto shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
            <FolderOpen size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TextFile path={path} text={read.text} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8" data-notes-file={path}>
      {image && url ? <img src={url} alt={baseName(path)} className="max-h-[70%] max-w-full rounded-lg shadow-sm" /> : null}
      <p className="text-[14px] font-semibold text-darkDelegation">{baseName(path)}</p>
      {size ? <p className="text-[12px] text-zinc-400">{size}</p> : null}
      {!image ? <p className="max-w-sm text-center text-[12px] text-zinc-500">{t(read?.tooLarge ? 'notes.file.tooLarge' : 'notes.file.notText')}</p> : null}
      <Button onClick={() => void show()}>
        <FolderOpen size={14} />
        {t('notes.open.folder')}
      </Button>
    </div>
  );
}

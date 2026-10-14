import { create } from 'zustand';
import type { TrashItem, VaultIndex } from '@shared/notes';
import { messageOf } from '@shared/ipcError';
import { withoutIcon } from '../../core/titles';
import { isNotePath, makeResolver, noteTitle, pathKey, type Resolve } from '../../core/vaultNotes';

/**
 * What the notes screen holds between its parts: the vault's index as the main
 * process last read it (electron/services/vaultNotes.ts), the notes open in
 * tabs with each tab's way back and forward, whether a note is read or edited,
 * and the text of the note in front as it is being written, for the panels
 * beside it.
 *
 * The tabs and the mode are kept in this window's storage, per vault, so the
 * screen opens where it was left. That is a convenience and nothing else: a
 * storage that will not answer starts the screen on an empty tab.
 */

export interface NoteTab {
  id: string;
  /** Null for a tab with nothing open in it. */
  path: string | null;
  back: string[];
  forward: string[];
}

/** Where to take the note in front once it is drawn: a line, a heading or a block (`^id`). */
export interface NoteTarget {
  path: string;
  line?: number | null;
  subpath?: string | null;
  /** Put the cursor there and edit, as for a note just made. */
  edit?: boolean;
}

export type NoteMode = 'read' | 'edit';

/** What the left column shows: the vault's tree, a search, its tags, or its bin. */
export type NavTab = 'files' | 'search' | 'tags' | 'trash';

interface NotesState {
  index: VaultIndex | null;
  error: string | null;
  resolve: Resolve;
  /** Every file of the vault, notes and attachments, by path. */
  paths: string[];
  /** Notes by `pathKey`, for a lookup by any case. */
  byKey: Map<string, string>;
  /** The notes shown by a name other than their file's: a receipt by its event_id, a name without its leading emoji (`labelOf`). */
  labels: Map<string, string>;
  /** Of those, the ones Cortex's engine names: a receipt by its event_id, never renamed from here. */
  keptLabels: Map<string, string>;
  /** Names shown with the emoji they start with on disk (the window's settings, `setNameIcons`). */
  nameIcons: boolean;
  setNameIcons(on: boolean): void;
  /** What is in the vault's bin (`.trash/`), the last deleted first; null before it is read. */
  bin: TrashItem[] | null;
  tabs: NoteTab[];
  active: string;
  mode: NoteMode;
  /** Editing shows the Markdown as it is written on every line (Obsidian's source mode), not only on the cursor's. */
  sourceMode: boolean;
  target: NoteTarget | null;
  /** The note in front as it is now, saved or not. */
  live: { path: string; text: string } | null;
  /** Bumped when a note changed on disk, so a reader of one reads it again. */
  revision: number;
  nav: NavTab;
  /** What the search box holds; a tag clicked in a note puts `tag:#x` here. */
  query: string;
  /**
   * Ctrl+E, asked of the note in front by the screen, which hears keys only
   * while it is on screen: a pane that listened on the window itself took
   * Ctrl+E from a terminal on the coding side, where it moves to the line's end.
   */
  modeSwitch: number;
  /** A note shown over the page while a link to it is hovered (peek.tsx), by where the link is on screen. */
  peek: { path: string; subpath: string | null; x: number; y: number; below: number } | null;
  refresh(): Promise<void>;
  /** Read the vault's bin again: after something went in or came out of it. */
  refreshBin(): Promise<void>;
  open(path: string, options?: { newTab?: boolean; line?: number | null; subpath?: string | null; edit?: boolean }): void;
  back(): void;
  forward(): void;
  newTab(): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  setMode(mode: NoteMode): void;
  setSourceMode(source: boolean): void;
  takeTarget(path: string): NoteTarget | null;
  setLive(live: { path: string; text: string } | null): void;
  setNav(nav: NavTab): void;
  switchMode(): void;
  /** Search for this, with the search open. */
  search(query: string): void;
  /** A note renamed or moved: every tab and every way back follows it. */
  moved(from: string, to: string): void;
  /** A note or a folder put in the bin: tabs on it are emptied. */
  removed(path: string): void;
}

const newId = () => Math.random().toString(36).slice(2, 10);
const emptyTab = (): NoteTab => ({ id: newId(), path: null, back: [], forward: [] });
const HISTORY = 50;

const storageKey = (vault: string) => `cortex.notes.${vault}`;

function loadSaved(vault: string): { tabs: NoteTab[]; active: string; mode: NoteMode; sourceMode: boolean } | null {
  try {
    const raw = localStorage.getItem(storageKey(vault));
    if (!raw) return null;
    const saved = JSON.parse(raw) as { tabs?: Array<{ path?: unknown }>; active?: unknown; mode?: unknown; sourceMode?: unknown };
    const tabs = (saved.tabs ?? [])
      .slice(0, 12)
      .map((tab) => ({ id: newId(), path: typeof tab.path === 'string' ? tab.path : null, back: [], forward: [] }));
    if (!tabs.length) return null;
    const active = typeof saved.active === 'number' && tabs[saved.active] ? tabs[saved.active].id : tabs[0].id;
    return { tabs, active, mode: saved.mode === 'edit' ? 'edit' : 'read', sourceMode: saved.sourceMode === true };
  } catch {
    return null;
  }
}

function save(state: NotesState): void {
  const vault = state.index?.vault?.name;
  if (!vault) return;
  try {
    localStorage.setItem(
      storageKey(vault),
      JSON.stringify({ tabs: state.tabs.map((tab) => ({ path: tab.path })), active: state.tabs.findIndex((tab) => tab.id === state.active), mode: state.mode, sourceMode: state.sourceMode }),
    );
  } catch {
    /* A storage that will not take it: the screen opens on an empty tab next time. */
  }
}

let loadedFor: string | null = null;

export const useNotes = create<NotesState>((set, get) => {
  const first = emptyTab();
  const update = (change: Partial<NotesState> | ((state: NotesState) => Partial<NotesState>)) => {
    set(change);
    save(get());
  };
  const activeTab = () => get().tabs.find((tab) => tab.id === get().active) ?? get().tabs[0];
  const replaceTab = (tab: NoteTab) => update((state) => ({ tabs: state.tabs.map((one) => (one.id === tab.id ? tab : one)) }));

  return {
    index: null,
    error: null,
    resolve: () => null,
    paths: [],
    byKey: new Map(),
    labels: new Map(),
    keptLabels: new Map(),
    nameIcons: false,

    setNameIcons(on) {
      if (on === get().nameIcons) return;
      const index = get().index;
      set((state) => ({ nameIcons: on, ...(index ? labelsOf(index, on) : {}), revision: state.revision + 1 }));
    },
    bin: null,
    tabs: [first],
    active: first.id,
    mode: 'read',
    sourceMode: false,
    target: null,
    live: null,
    revision: 0,
    nav: 'files',
    query: '',
    modeSwitch: 0,
    peek: null,

    async refresh() {
      let index: VaultIndex;
      try {
        index = await window.cortex.notes.index();
      } catch (err) {
        set({ error: messageOf(err) });
        return;
      }
      const paths = [...index.notes.map((note) => note.path), ...index.files.map((file) => file.path)];
      const byKey = new Map(index.notes.map((note) => [pathKey(note.path), note.path]));
      const vault = index.vault?.name ?? null;
      set((state) => ({ index, error: null, paths, byKey, ...labelsOf(index, state.nameIcons), resolve: makeResolver(paths), revision: state.revision + 1 }));
      if (vault && loadedFor !== vault) {
        loadedFor = vault;
        const saved = loadSaved(vault);
        const fresh = emptyTab();
        set(saved ?? { tabs: [fresh], active: fresh.id });
      }
      // A tab on a note no longer there is emptied, not left pointing at nothing.
      const there = new Set(paths);
      const tabs = get().tabs.map((tab) => (tab.path && !there.has(tab.path) ? { ...tab, path: null } : tab));
      if (tabs.some((tab, at) => tab !== get().tabs[at])) update({ tabs });
      void get().refreshBin();
    },

    async refreshBin() {
      try {
        set({ bin: await window.cortex.notes.binList() });
      } catch {
        // A bin that will not be read is not the notes' business: the tab says nothing is in it.
        set({ bin: [] });
      }
    },

    open(path, options = {}) {
      const target: NoteTarget = { path, line: options.line ?? null, subpath: options.subpath ?? null, edit: options.edit };
      const mode = options.edit ? 'edit' : get().mode;
      if (options.newTab) {
        const tab: NoteTab = { ...emptyTab(), path };
        update((state) => ({ tabs: [...state.tabs, tab], active: tab.id, target, mode }));
        return;
      }
      const tab = activeTab();
      if (tab.path === path) {
        set({ target, mode });
        return;
      }
      replaceTab({ ...tab, path, back: tab.path ? [...tab.back, tab.path].slice(-HISTORY) : tab.back, forward: [] });
      update({ target, mode });
    },

    back() {
      const tab = activeTab();
      const previous = tab.back[tab.back.length - 1];
      if (previous === undefined) return;
      replaceTab({ ...tab, path: previous, back: tab.back.slice(0, -1), forward: tab.path ? [tab.path, ...tab.forward] : tab.forward });
      set({ target: { path: previous } });
    },

    forward() {
      const tab = activeTab();
      const next = tab.forward[0];
      if (next === undefined) return;
      replaceTab({ ...tab, path: next, forward: tab.forward.slice(1), back: tab.path ? [...tab.back, tab.path] : tab.back });
      set({ target: { path: next } });
    },

    newTab() {
      const tab = emptyTab();
      update((state) => ({ tabs: [...state.tabs, tab], active: tab.id }));
    },

    closeTab(id) {
      const { tabs, active } = get();
      if (tabs.length === 1) {
        const tab = emptyTab();
        update({ tabs: [tab], active: tab.id });
        return;
      }
      const at = tabs.findIndex((tab) => tab.id === id);
      const rest = tabs.filter((tab) => tab.id !== id);
      update({ tabs: rest, active: active === id ? rest[Math.max(0, at - 1)].id : active });
    },

    setActive(id) {
      update({ active: id });
    },

    setMode(mode) {
      update({ mode });
    },

    setSourceMode(sourceMode) {
      update({ sourceMode });
    },

    takeTarget(path) {
      const target = get().target;
      if (!target || target.path !== path) return null;
      set({ target: null });
      return target;
    },

    setLive(live) {
      set({ live });
    },

    setNav(nav) {
      set({ nav });
    },

    switchMode() {
      set((state) => ({ modeSwitch: state.modeSwitch + 1 }));
    },

    search(query) {
      set({ nav: 'search', query });
    },

    moved(from, to) {
      const follow = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);
      update((state) => ({
        tabs: state.tabs.map((tab) => ({ ...tab, path: tab.path ? follow(tab.path) : null, back: tab.back.map(follow), forward: tab.forward.map(follow) })),
        live: state.live ? { ...state.live, path: follow(state.live.path) } : null,
      }));
    },

    removed(path) {
      const gone = (one: string) => one === path || one.startsWith(`${path}/`);
      update((state) => ({
        tabs: state.tabs.map((tab) => ({ ...tab, path: tab.path && gone(tab.path) ? null : tab.path, back: tab.back.filter((one) => !gone(one)), forward: tab.forward.filter((one) => !gone(one)) })),
      }));
    },
  };
});

/** The tab in front. */
export const useActiveTab = () => useNotes((state) => state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0]);

/** Whether a path is a note the index has, by any case. */
export function noteFor(path: string): string | null {
  return useNotes.getState().byKey.get(pathKey(path)) ?? null;
}

/**
 * The name a note or a file is shown by: a receipt by the event_id it
 * carries, where its file's name is a hash Cortex's engine finds it by
 * (core/vaultNotes.ts, `keptBy`); anything else by its file's name.
 */
export function labelOf(path: string): string {
  return useNotes.getState().labels.get(path) ?? noteTitle(path);
}

/** `labelOf`, kept current for a component that shows it. */
export const useLabel = (path: string) => useNotes((state) => state.labels.get(path) ?? noteTitle(path));

/** The names notes are shown by: the engine's for what it keeps, and a name without its leading emoji unless those are asked for. */
function labelsOf(index: VaultIndex, nameIcons: boolean): Pick<NotesState, 'labels' | 'keptLabels'> {
  const keptLabels = new Map(index.notes.flatMap((note) => (note.label ? [[note.path, note.label] as const] : [])));
  const labels = new Map(keptLabels);
  if (!nameIcons) {
    for (const note of index.notes) {
      const title = noteTitle(note.path);
      const shown = withoutIcon(title);
      if (!labels.has(note.path) && shown !== title) labels.set(note.path, shown);
    }
  }
  return { labels, keptLabels };
}

/** A folder's or a file's own name as shown: without its leading emoji unless those are asked for. */
export function nameLabel(name: string): string {
  return useNotes.getState().nameIcons ? name : withoutIcon(name);
}

/** A folder path as shown, each folder by `nameLabel`. */
export function folderLabel(folder: string): string {
  return useNotes.getState().nameIcons ? folder : folder.split('/').map(withoutIcon).join('/');
}

export { isNotePath };

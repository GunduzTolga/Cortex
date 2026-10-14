import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  ExternalLink,
  File,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Image,
  PanelLeftOpen,
  PencilLine,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import type { SearchHit } from '@shared/notes';
import { baseName, captureFolder, dayOf, folderOf, isNotePath, nameProblem, noteTitle, pathKey, shortestLink } from '../../core/vaultNotes';
import { noteTemplateOf, templateText } from './templates';
import { foldForMatch } from '../../core/titles';
import { useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { useApp } from '../store/app';
import { Spinner } from '../ui/ui';
import { labelOf, useActiveTab, useNotes, type NavTab } from './notesStore';
import { openContextMenu, usePrompt, type MenuItem } from './NotesMenus';
import { TrashPanel, useTrash } from './bin';

/**
 * The notes screen's left column: the vault as a tree, a search over every
 * note, and its tags. The tree is the vault as Obsidian shows it - folders
 * first, then notes by name, an attachment with its extension - with what is
 * open marked and its folders opened to it. What changes the vault from here
 * (a new note or folder, a rename, the bin) asks first where it can lose
 * something, and is the person's press every time.
 */

interface TreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'note' | 'file';
  children: TreeNode[];
}

/** What a row being dragged carries, apart from the wiki link it carries as text. */
const TREE_DRAG = 'application/x-cortex-vault-path';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/**
 * A name as it is sorted: past a leading emoji or mark, so Cortex's numbered
 * folders (`📥 000-Inbox`, `🎯 100-Command-Center`, `💻 310-Code-Projects`)
 * read in their numbers' order and not in their emoji's. Obsidian sorts by the
 * whole name, which puts them in the order of the emoji's code points.
 */
const sortName = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '') || name;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const NAME_PROBLEM: Record<NonNullable<ReturnType<typeof nameProblem>>, Key> = {
  empty: 'notes.name.empty',
  characters: 'notes.name.characters',
  dot: 'notes.name.dot',
  reserved: 'notes.name.reserved',
  long: 'notes.name.long',
};

function buildTree(folders: string[], files: string[], labels: ReadonlyMap<string, string>): TreeNode {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);
  const folder = (path: string): TreeNode => {
    const had = byPath.get(path);
    if (had) return had;
    const node: TreeNode = { name: baseName(path), path, kind: 'folder', children: [] };
    byPath.set(path, node);
    folder(folderOf(path)).children.push(node);
    return node;
  };
  for (const one of folders) folder(one);
  // A receipt by its event_id, and sorted by it, where its file's name is a hash (`labelOf`).
  for (const one of files) folder(folderOf(one)).children.push({ name: labels.get(one) ?? (isNotePath(one) ? noteTitle(one) : baseName(one)), path: one, kind: isNotePath(one) ? 'note' : 'file', children: [] });
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => (a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : collator.compare(sortName(a.name), sortName(b.name)));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** The tree cut to what matches the filter, with the folders on the way kept. */
function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (!query) return node;
  const children = node.children.map((child) => filterTree(child, query)).filter((child): child is TreeNode => child !== null);
  if (children.length || (node.path && foldForMatch(node.name).includes(query))) return { ...node, children: node.kind === 'folder' && !children.length ? node.children : children };
  return null;
}

const expandedKey = (vault: string) => `cortex.notes.open.${vault}`;

function readExpanded(vault: string | null): Set<string> {
  if (!vault) return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(expandedKey(vault)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * The folders open in the tree, per vault. Read as the tree is first drawn,
 * not after: read in an effect, the folders opened to the note in front were
 * written over them first, and every folder closed whenever the tree was drawn
 * again - on coming back from the search, say.
 */
function useExpanded(vault: string | null) {
  const [held, setHeld] = useState(() => ({ vault, open: readExpanded(vault) }));
  const open = held.vault === vault ? held.open : readExpanded(vault);
  const change = (next: Set<string> | ((was: Set<string>) => Set<string>)) => {
    setHeld((before) => {
      const was = before.vault === vault ? before.open : readExpanded(vault);
      const value = typeof next === 'function' ? next(was) : next;
      try {
        if (vault) localStorage.setItem(expandedKey(vault), JSON.stringify([...value]));
      } catch {
        /* remembered for this run only */
      }
      return { vault, open: value };
    });
  };
  return [open, change] as const;
}

export function NotesNav({ onFold }: { onFold: () => void }) {
  const t = useT();
  const nav = useNotes((state) => state.nav);
  const tabs: Array<{ id: NavTab; icon: React.ReactNode; label: Key }> = [
    { id: 'files', icon: <FolderOpen size={14} />, label: 'notes.nav.files' },
    { id: 'search', icon: <Search size={14} />, label: 'notes.nav.search' },
    { id: 'tags', icon: <Hash size={14} />, label: 'notes.nav.tags' },
  ];
  const binCount = useNotes((state) => state.bin?.length ?? 0);
  return (
    <div className="flex h-full min-h-0 flex-col" data-notes-nav>
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-zinc-100 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          {tabs.map((one) => (
            <button
              key={one.id}
              type="button"
              onClick={() => useNotes.getState().setNav(one.id)}
              aria-pressed={nav === one.id}
              title={t(one.label)}
              data-notes-nav-tab={one.id}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-bold transition-colors ${nav === one.id ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              {one.icon}
              <span className="hidden @[14rem]:inline">{t(one.label)}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onFold} title={t('notes.nav.fold')} data-notes-nav-fold className="ml-1 shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
          <PanelLeftOpen size={14} className="rotate-180" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{nav === 'files' ? <FileTree /> : nav === 'search' ? <SearchPanel /> : nav === 'tags' ? <TagsPanel /> : <TrashPanel />}</div>
      {/* The bin at the column's foot, where a sidebar keeps it: a press opens it, a second goes back to the files. */}
      <button
        type="button"
        onClick={() => useNotes.getState().setNav(nav === 'trash' ? 'files' : 'trash')}
        aria-pressed={nav === 'trash'}
        data-notes-nav-tab="trash"
        className={`flex h-9 shrink-0 items-center gap-2 border-t border-zinc-100 px-3.5 text-[12px] font-semibold transition-colors ${nav === 'trash' ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600'}`}
      >
        <Trash2 size={14} />
        {t('notes.nav.trash')}
        {binCount ? (
          <span className="ml-auto rounded-full bg-zinc-200/70 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-600" data-bin-count>
            {binCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/** The actions that make something in a folder: a note, a folder. Shared by the tree's header and its menus. */
export function useMakers() {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const prompt = usePrompt();
  const check = (value: string) => {
    const problem = nameProblem(value);
    return problem ? t(NAME_PROBLEM[problem]) : null;
  };
  // A move or a rename said the same way: the tabs follow it, and the notes whose links were pointed at it, or could not be, are named.
  const moved = async (path: string, ask: () => Promise<{ path: string; updated: string[]; skipped: string[] }>, failed: Key) => {
    try {
      const done = await ask();
      useNotes.getState().moved(path, done.path);
      await useNotes.getState().refresh();
      if (done.updated.length) toast({ tone: 'success', title: t('notes.rename.updated', { count: done.updated.length }) });
      if (done.skipped.length) toast({ tone: 'error', title: t('notes.rename.skipped', { count: done.skipped.length }), detail: done.skipped.join('\n') });
    } catch (err) {
      toast({ tone: 'error', title: t(failed), detail: messageOf(err) });
    }
  };
  return {
    /** A new note, started as Cortex's `Note.md` where the vault has one, else empty. */
    async newNote(folder: string) {
      try {
        const template = (await templateText(noteTemplateOf(useNotes.getState().index))) ?? undefined;
        const made = await window.cortex.notes.create(folder, t('notes.untitled'), { unique: true, template });
        await useNotes.getState().refresh();
        useNotes.getState().open(made.path, { edit: true });
      } catch (err) {
        toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) });
      }
    },
    /** A quick note where Cortex keeps raw capture (`📥 000-Inbox/Dump`), named by the minute, the cursor at its end. */
    async capture() {
      const index = useNotes.getState().index;
      const now = new Date();
      try {
        const template = (await templateText(noteTemplateOf(index))) ?? undefined;
        const name = `${dayOf(now)} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
        const made = await window.cortex.notes.create(captureFolder(index?.folders ?? []), name, { unique: true, template });
        await useNotes.getState().refresh();
        useNotes.getState().open(made.path, { edit: true, line: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) });
      }
    },
    async newFolder(parent: string) {
      const name = await prompt({ title: t('notes.folder.new'), label: t('notes.folder.name'), value: '', action: t('notes.folder.make'), check });
      if (!name) return;
      try {
        await window.cortex.notes.createFolder(parent, name);
        await useNotes.getState().refresh();
      } catch (err) {
        toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) });
      }
    },
    /** A note by its name without `.md`, a file or a folder by its whole name, as the tree shows them. */
    async rename(path: string, kind: 'note' | 'file' | 'folder') {
      const was = kind === 'note' ? noteTitle(path) : baseName(path);
      const name = await prompt({ title: t('notes.rename.title'), label: t('notes.rename.label'), value: was, action: t('notes.rename.action'), check });
      if (!name || name === was) return;
      await moved(path, () => window.cortex.notes.rename(path, name), 'notes.rename.failed');
    },
    /** Into a folder ('' for the top), by a drop in the tree. */
    async move(path: string, folder: string) {
      if (folderOf(path) === folder) return;
      await moved(path, () => window.cortex.notes.move(path, folder), 'notes.move.failed');
    },
  };
}

function FileTree() {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const index = useNotes((state) => state.index);
  const active = useActiveTab().path;
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useExpanded(index?.vault?.name ?? null);
  const makers = useMakers();
  const readOnly = Boolean(index?.readOnly);
  const paths = useNotes((state) => state.paths);
  const labels = useNotes((state) => state.labels);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const linkTo = (path: string) => shortestLink(path, paths);

  const tree = useMemo(
    () => buildTree(index?.folders ?? [], [...(index?.notes.map((note) => note.path) ?? []), ...(index?.files.map((file) => file.path) ?? [])], labels),
    [index, labels],
  );
  // What Cortex's engine keeps, and every folder on the way to it: not renamed, moved or binned from here (electron/services/vaultNotes.ts refuses it too).
  const kept = useMemo(() => {
    const out = new Set<string>();
    for (const note of index?.notes ?? []) {
      if (!note.keeper) continue;
      for (let at = note.path; at; at = folderOf(at)) out.add(at);
    }
    return out;
  }, [index]);
  const shown = useMemo(() => filterTree(tree, foldForMatch(filter.trim())), [tree, filter]);

  // The folders on the way to the note in front are opened, as Obsidian's "reveal" does.
  useEffect(() => {
    if (!active) return;
    const parts = folderOf(active).split('/').filter(Boolean);
    const needed = parts.map((_part, at) => parts.slice(0, at + 1).join('/'));
    setOpen((was) => (needed.every((one) => was.has(one)) ? was : new Set([...was, ...needed])));
    // Opened once per note put in front; a folder the person closes after stays closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };

  const outside = async (path: string, how: 'obsidian' | 'folder') => {
    try {
      const done = await window.cortex.notes.open(path, how);
      if (!done.opened) toast({ tone: 'error', title: t('notes.obsidian.none') });
    } catch (err) {
      toast({ tone: 'error', title: t('notes.open.failed'), detail: messageOf(err) });
    }
  };
  const trashEntry = useTrash();
  const trash = (node: TreeNode) => trashEntry(node.path, node.kind === 'folder' ? { count: node.children.length } : undefined);

  const menuFor = (node: TreeNode): MenuItem[] => {
    const items: MenuItem[] = [];
    if (node.kind === 'folder') {
      items.push({ label: t('notes.new.note'), icon: <FilePlus2 size={14} />, run: () => void makers.newNote(node.path), disabled: readOnly });
      items.push({ label: t('notes.folder.new'), icon: <FolderPlus size={14} />, run: () => void makers.newFolder(node.path), disabled: readOnly });
    } else {
      items.push({ label: t('notes.open.tab'), icon: <FileText size={14} />, run: () => useNotes.getState().open(node.path, { newTab: true }) });
    }
    if (node.path) items.push({ label: t('notes.rename'), icon: <PencilLine size={14} />, run: () => void makers.rename(node.path, node.kind), disabled: readOnly || kept.has(node.path) });
    if (node.path) {
      items.push({ label: t('notes.open.folder'), icon: <FolderOpen size={14} />, run: () => void outside(node.path, 'folder') });
      if (node.kind === 'note') items.push({ label: t('notes.open.obsidian'), icon: <ExternalLink size={14} />, run: () => void outside(node.path, 'obsidian') });
      items.push({ label: t('notes.trash'), icon: <Trash2 size={14} />, run: () => void trash(node), danger: true, disabled: readOnly || kept.has(node.path) });
    }
    return items;
  };

  /*
    Drag a row onto a folder, or onto anything in a folder, and it moves there;
    onto the empty part of the tree, and it goes to the top. The row carries a
    wiki link to itself as text too, so dropped into the editor it is a link,
    as in Obsidian.
  */
  const dropFolder = (node: TreeNode) => (node.kind === 'folder' ? node.path : folderOf(node.path));
  const canDropPath = (path: string, into: string) => folderOf(path) !== into && into !== path && !into.startsWith(`${path}/`);
  const dropHandlers = (into: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (dragging === null || readOnly || !canDropPath(dragging, into)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (target !== into) setTarget(into);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && target === into) setTarget(null);
    },
    onDrop: (event: React.DragEvent) => {
      const path = event.dataTransfer.getData(TREE_DRAG);
      setTarget(null);
      setDragging(null);
      if (!path || readOnly || !canDropPath(path, into)) return;
      event.preventDefault();
      event.stopPropagation();
      if (into) setOpen(new Set([...open, into]));
      void makers.move(path, into);
    },
  });

  const row = (node: TreeNode, depth: number): React.ReactNode => {
    const expanded = filter.trim() ? true : open.has(node.path);
    const isActive = node.path === active;
    const into = dropFolder(node);
    const icon =
      node.kind === 'folder' ? (
        expanded ? <FolderOpen size={14} /> : <Folder size={14} />
      ) : node.kind === 'note' ? (
        <FileText size={14} />
      ) : IMAGE.test(node.path) ? (
        <Image size={14} />
      ) : (
        <File size={14} />
      );
    return (
      <li key={node.path} {...dropHandlers(into)} className={node.kind === 'folder' && target === node.path ? 'rounded-md bg-accent/10 outline outline-1 outline-accent/40' : undefined}>
        <button
          type="button"
          draggable={!readOnly && !kept.has(node.path)}
          onDragStart={(event) => {
            event.dataTransfer.setData(TREE_DRAG, node.path);
            if (node.kind !== 'folder') event.dataTransfer.setData('text/plain', `${IMAGE.test(node.path) ? '!' : ''}[[${linkTo(node.path)}]]`);
            event.dataTransfer.effectAllowed = 'copyMove';
            setDragging(node.path);
          }}
          onDragEnd={() => {
            setDragging(null);
            setTarget(null);
          }}
          onClick={(event) => (node.kind === 'folder' ? toggle(node.path) : useNotes.getState().open(node.path, { newTab: event.ctrlKey || event.metaKey }))}
          onAuxClick={(event) => event.button === 1 && node.kind !== 'folder' && useNotes.getState().open(node.path, { newTab: true })}
          onContextMenu={(event) => openContextMenu(event, menuFor(node))}
          data-tree-path={node.path}
          data-tree-kind={node.kind}
          aria-expanded={node.kind === 'folder' ? expanded : undefined}
          className={`group flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] transition-colors ${
            isActive ? 'bg-zinc-100 font-semibold text-darkDelegation' : node.kind === 'file' ? 'text-zinc-400 hover:bg-zinc-50' : 'text-zinc-600 hover:bg-zinc-50 hover:text-darkDelegation'
          }`}
          style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}
        >
          <ChevronRight size={12} className={`shrink-0 text-zinc-300 transition-transform ${node.kind === 'folder' ? '' : 'invisible'} ${expanded ? 'rotate-90' : ''}`} />
          <span className="shrink-0 text-zinc-400">{icon}</span>
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
        {node.kind === 'folder' && expanded && node.children.length ? <ul>{node.children.map((child) => row(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('notes.tree.filter')}
          className="h-7 min-w-0 flex-1 rounded-md border border-zinc-100 bg-transparent px-2 text-[12px] text-darkDelegation outline-none placeholder:text-zinc-400 focus:border-zinc-300"
          data-tree-filter
        />
        <button type="button" disabled={readOnly} onClick={() => void makers.newNote('')} title={t('notes.new.note')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation disabled:opacity-30" data-notes-new>
          <FilePlus2 size={15} />
        </button>
        <button type="button" disabled={readOnly} onClick={() => void makers.capture()} title={t('notes.capture.hint')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation disabled:opacity-30" data-notes-capture>
          <Zap size={15} />
        </button>
        <button type="button" disabled={readOnly} onClick={() => void makers.newFolder('')} title={t('notes.folder.new')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation disabled:opacity-30">
          <FolderPlus size={15} />
        </button>
        <button type="button" onClick={() => setOpen(new Set())} title={t('notes.tree.collapse')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
          <ChevronsDownUp size={15} />
        </button>
      </div>
      <div
        className={`min-h-0 flex-1 overflow-y-auto px-1.5 pb-6 ${target === '' ? 'bg-accent/5' : ''}`}
        {...dropHandlers('')}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) openContextMenu(event, menuFor(tree));
        }}
        data-notes-tree
      >
        {!index ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : shown && shown.children.length ? (
          <ul>{shown.children.map((child) => row(child, 0))}</ul>
        ) : (
          <p className="px-3 py-4 text-[12px] leading-relaxed text-zinc-400">{filter ? t('notes.tree.noMatch') : t('notes.tree.empty')}</p>
        )}
        {index?.truncated ? <p className="px-3 py-2 text-[11px] text-warn">{t('notes.tree.truncated')}</p> : null}
      </div>
    </div>
  );
}

/** A line of a search hit with the words that matched set apart. */
function Marked({ text, marks }: { text: string; marks: Array<[number, number]> }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from < at) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <mark key={from} className="rounded-sm bg-warn/25 text-inherit">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function SearchPanel() {
  const t = useT();
  const query = useNotes((state) => state.query);
  const revision = useNotes((state) => state.revision);
  const [found, setFound] = useState<{ hits: SearchHit[]; more: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    if (!query.trim()) {
      setFound(null);
      return;
    }
    let live = true;
    setBusy(true);
    const timer = setTimeout(() => {
      window.cortex.notes.search(query).then(
        (got) => live && (setFound(got), setBusy(false)),
        () => live && (setFound({ hits: [], more: false }), setBusy(false)),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-1 pt-2">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            ref={field}
            value={query}
            onChange={(event) => useNotes.setState({ query: event.target.value })}
            placeholder={t('notes.search.placeholder')}
            className="h-8 w-full rounded-md border border-zinc-200 bg-transparent pl-7 pr-2 text-[12px] text-darkDelegation outline-none placeholder:text-zinc-400 focus:border-zinc-400"
            data-notes-search
          />
        </div>
        <p className="mt-1.5 px-0.5 text-[10.5px] leading-relaxed text-zinc-400">{t('notes.search.hint')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-6" data-notes-results>
        {busy && !found ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : found ? (
          <>
            <p className="px-2 py-1.5 text-[11px] text-zinc-400">{found.more ? t('notes.search.more', { count: found.hits.length }) : t('notes.search.count', { count: found.hits.length })}</p>
            <ul className="space-y-1">
              {found.hits.map((hit) => (
                <li key={hit.path} data-search-hit={hit.path}>
                  <button
                    type="button"
                    onClick={(event) => useNotes.getState().open(hit.path, { newTab: event.ctrlKey || event.metaKey, line: hit.lines[0]?.line ?? null })}
                    className="w-full rounded-md px-2 py-1 text-left hover:bg-zinc-50"
                  >
                    <span className="block truncate text-[13px] font-semibold text-darkDelegation">{labelOf(hit.path)}</span>
                    {folderOf(hit.path) ? <span className="block truncate text-[10.5px] text-zinc-400">{folderOf(hit.path)}</span> : null}
                  </button>
                  {hit.lines.map((line) => (
                    <button
                      key={line.line}
                      type="button"
                      onClick={() => useNotes.getState().open(hit.path, { line: line.line })}
                      className="block w-full rounded-md px-2 py-0.5 pl-4 text-left text-[11.5px] leading-snug text-zinc-500 hover:bg-zinc-50"
                    >
                      <Marked text={line.text} marks={line.marks} />
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function TagsPanel() {
  const t = useT();
  const index = useNotes((state) => state.index);
  const [byCount, setByCount] = useState(true);
  const tags = useMemo(() => {
    const counted = new Map<string, { tag: string; count: number }>();
    for (const note of index?.notes ?? []) {
      for (const tag of note.tags) {
        // A nested tag counts for each level above it too, as Obsidian's tag pane counts it.
        const parts = tag.split('/');
        for (let depth = 1; depth <= parts.length; depth += 1) {
          const one = parts.slice(0, depth).join('/');
          const key = pathKey(one);
          const had = counted.get(key);
          if (had) had.count += 1;
          else counted.set(key, { tag: one, count: 1 });
        }
      }
    }
    return [...counted.values()].sort((a, b) => (byCount ? b.count - a.count : 0) || collator.compare(a.tag, b.tag));
  }, [index, byCount]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2.5">
        <p className="text-[11px] text-zinc-400">{t('notes.tags.count', { count: tags.length })}</p>
        <button type="button" onClick={() => setByCount(!byCount)} className="text-[11px] text-zinc-400 underline hover:text-darkDelegation">
          {t(byCount ? 'notes.tags.byName' : 'notes.tags.byCount')}
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-6" data-notes-tags>
        {tags.length ? (
          tags.map(({ tag, count }) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => useNotes.getState().search(`tag:#${tag}`)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-left text-[13px] text-zinc-600 hover:bg-zinc-50 hover:text-darkDelegation"
                style={{ paddingLeft: `${0.5 + (tag.split('/').length - 1) * 0.85}rem` }}
                data-tag-row={tag}
              >
                <Hash size={12} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{tag.split('/').pop()}</span>
                <span className="shrink-0 rounded bg-zinc-50 px-1.5 text-[10.5px] text-zinc-400">{count}</span>
              </button>
            </li>
          ))
        ) : (
          <p className="px-2 py-4 text-[12px] text-zinc-400">{t('notes.tags.none')}</p>
        )}
      </ul>
    </div>
  );
}

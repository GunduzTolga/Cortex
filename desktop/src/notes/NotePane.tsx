import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Code2, ExternalLink, FolderOpen, LayoutTemplate, MoreHorizontal, PencilLine, Trash2 } from 'lucide-react';
import type { NoteRead } from '@shared/notes';
import { messageOf } from '@shared/ipcError';
import { appLanguage } from '@shared/language';
import { conflictName, fillTemplate, folderOf, insertTemplate, nameProblem, noteTitle, parseNote, pathKey, shortestLink } from '../../core/vaultNotes';
import { TemplatePicker, templateText } from './templates';
import { translate, type Key } from '../i18n';
import { useT } from '../i18n/useT';
import { refusal, useApp } from '../store/app';
import { Spinner } from '../ui/ui';
import { NoteDocument } from './NoteMarkdown';
import { NoteEditor, type LinkChoice, type NoteEditorHandle } from './NoteEditor';
import type { LiveHooks } from './livePreview';
import { imageOf } from './vaultCache';
import { peekLeave, peekSoon } from './peek';
import { nameIcon } from '../../core/titles';
import { folderLabel, nameLabel, useActiveTab, useLabel, useNotes } from './notesStore';
import { Menu } from './NotesMenus';
import { useTrash } from './bin';
import { NAME_PROBLEM } from './NotesNav';
import { holdOpenNote } from './openNotes';

/**
 * One note, read or written. It is read from the vault when it is opened and
 * again when the file changes on disk while nothing here is unsaved; it is
 * saved a moment after the last key, at Ctrl-S, when the window is left, and
 * when the note is left - each time over the version that was read, so that a
 * note Obsidian, Pyn or a sync wrote meanwhile is never written over: the
 * screen says so and the person chooses which stays. A note left before they
 * have chosen, or gone from where it was, keeps what was typed in a note of
 * its own beside it (`keepAside`): nothing typed goes with the pane.
 */

const SAVE_AFTER_MS = 1000;

type Saving = 'saved' | 'unsaved' | 'saving' | 'failed';

/** A sentence in the window's language, for what is said after the pane that asked is gone. */
const say = (key: Key, values?: Record<string, string | number>) => translate(appLanguage(useApp.getState().settings.language), key, values);

/** Text put on the clipboard from a press: the page's clipboard API is one of the permissions the window is refused (electron/main.ts). */
function copyText(text: string): void {
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}

/**
 * Text that could not be saved over its note - the note changed on disk
 * meanwhile, or is gone from where it was - kept as a note of its own beside
 * it (`conflictName`), or at the vault's top when its folder is gone too, and
 * the person told which, with the way to it. Where nothing can be written -
 * nor anything should be, as when another vault is open now and the note's
 * path names a note of that one (`here` false) - the toast stays and holds
 * the text, to be copied.
 */
async function keepAside(path: string, text: string, why: string, here = true): Promise<void> {
  const toast = useApp.getState().toast;
  const name = conflictName(noteTitle(path), say('notes.aside.word'), new Date());
  for (const folder of here ? new Set([folderOf(path), '']) : []) {
    try {
      const made = await window.cortex.notes.create(folder, name, { text, unique: true });
      void useNotes.getState().refresh();
      toast({
        tone: 'info',
        sticky: true,
        title: say('notes.aside.kept'),
        detail: `${say('notes.aside.where', { name: nameLabel(noteTitle(made.path)) })}\n${why}`,
        action: { label: say('notes.aside.open'), run: () => useNotes.getState().open(made.path) },
      });
      return;
    } catch {
      /* Not there: the next place. */
    }
  }
  toast({ tone: 'error', sticky: true, title: say('notes.aside.none', { name: nameLabel(noteTitle(path)) }), detail: why, action: { label: say('notes.aside.copy'), run: () => copyText(text) } });
}

/** `- [ ]` and `- [x]` on one line of a note, the other way round. */
export function toggleTask(text: string, line: number): string | null {
  const lines = text.split('\n');
  const now = lines[line];
  if (now === undefined) return null;
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(now);
  if (!match) return null;
  lines[line] = `${match[1]}${match[2] === ' ' ? 'x' : ' '}${match[3]}${now.slice(match[0].length)}`;
  return lines.join('\n');
}

/** The line a heading or a block of the note is on, by what a link names after `#`. */
function lineOfSubpath(text: string, subpath: string): number | null {
  const facts = parseNote(text);
  if (subpath.startsWith('^')) return facts.blocks.find((one) => one.id === subpath.slice(1))?.line ?? null;
  const wanted = pathKey(subpath.split('#').pop() ?? '');
  return facts.headings.find((one) => pathKey(one.text) === wanted)?.line ?? null;
}

export function NotePane({ path }: { path: string }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const mode = useNotes((state) => state.mode);
  const sourceMode = useNotes((state) => state.sourceMode);
  const revision = useNotes((state) => state.revision);
  const onDisk = useNotes((state) => state.index?.notes.find((note) => note.path === path)?.modified ?? null);
  const readOnlyVault = useNotes((state) => state.index?.readOnly ?? null);
  const tab = useActiveTab();
  const target = useNotes((state) => state.target);

  const [doc, setDoc] = useState<NoteRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState<Saving>('saved');
  const [conflict, setConflict] = useState<{ text: string; hash: string; modified: number } | null>(null);
  const [changed, setChanged] = useState(false);
  const [jump, setJump] = useState<{ line: number; seq: number } | null>(null);
  // A name's leading emoji, where names are shown without one: kept out of the field and put back on a rename.
  const icon = useNotes((state) => (state.nameIcons ? '' : nameIcon(noteTitle(path))));
  const [title, setTitle] = useState(() => noteTitle(path).slice(icon.length));
  // The setting changed with the note open: the field takes the name as now shown, so a commit does not rename it to that.
  useEffect(() => setTitle(noteTitle(path).slice(icon.length)), [icon, path]);
  const [titleProblem, setTitleProblem] = useState<string | null>(null);
  // A receipt is shown by its event_id: its file's name is the hash Cortex finds it by, and it is not renamed from here.
  const keptLabel = useNotes((state) => state.keptLabels.get(path) ?? null);
  const label = useLabel(path);
  const shownTitle = keptLabel ?? title;
  const reader = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditorHandle>(null);
  /*
    What the callbacks that outlive a render read: the note as last read or
    saved, the text as typed, the save in flight and the one asked for while it
    ran, whether the pane is still on screen, the text last kept aside, and the
    vault the note was read from (the screen keys the pane by it, NotesView.tsx).
  */
  const current = useRef({
    path,
    text,
    doc,
    vaultSeq: useApp.getState().vaultSeq,
    running: null as Promise<string | null> | null,
    queued: null as string | true | null,
    mounted: true,
    keptAside: null as string | null,
  });
  current.current = { ...current.current, path, text, doc };
  // The window's language as now chosen, for the callbacks made once.
  const saying = useRef(t);
  saying.current = t;

  const writable = doc !== null && doc.text !== null && doc.hash !== null && !doc.readOnly && !conflict;
  const dirty = doc !== null && doc.text !== null && text !== doc.text;

  const load = useCallback(async () => {
    // What was on screen as the read began: typed over meanwhile, the read is let go, not put over what was typed.
    const before = current.current.text;
    try {
      const read = await window.cortex.notes.read(path);
      // Its version is not taken either: a save then goes over the version read before, and says so if the disk is another.
      if (current.current.doc && current.current.text !== before) return;
      setDoc(read);
      setText(read.text ?? '');
      setFailed(null);
      setConflict(null);
      setChanged(false);
      setSaving('saved');
    } catch (err) {
      // A note on screen that would not be read again stays as it is, and says so; only one never read shows why in its place.
      if (current.current.doc) toast({ tone: 'error', title: saying.current('notes.read.failed'), detail: messageOf(err) });
      else setFailed(refusal(messageOf(err)));
    }
  }, [path, toast]);

  // One pane per note (the screen keys it by the path), so a save that outlives it is still of this note.
  useEffect(() => {
    void load();
  }, [load]);

  /*
    The file changed on disk: read again when nothing here is unsaved, else say
    so and wait for the person. Only a time later than the version read or
    saved here is a change from outside. The index is built again after each
    save, and until it is, it holds the time before it: read as a change, that
    read the note again and again, and each read put the note over what was
    typed meanwhile (desktop-ui-1). A file put back with an older time is not
    seen here, and the next save, checked against the disk, says so.
  */
  useEffect(() => {
    if (!doc || onDisk === null || onDisk - doc.modified < 1 || current.current.running) return;
    if (current.current.text === (doc.text ?? '')) void load();
    else setChanged(true);
  }, [onDisk, revision, doc, load]);

  /*
    The text saved over the version read: null once what is on screen is on
    disk, else why it is not. One save at a time, and one asked for while it
    runs is made once it ends, with what is typed by then: dropped, as it was,
    nothing armed the timer again, and what was typed during a slow save
    stayed unsaved (desktop-ui-5).
  */
  const save = useCallback(
    (base?: string): Promise<string | null> => {
      if (current.current.running) {
        current.current.queued = base ?? current.current.queued ?? true;
        return current.current.running;
      }
      const once = async (over: string | undefined): Promise<string | null> => {
        const { path: at, text: now, doc: was } = current.current;
        if (!was || was.text === null || was.hash === null || was.readOnly) return null;
        if (now === was.text && !over) return null;
        /*
          Another vault chosen since the note was read: its path now names a
          note of that one, which this text is not saved over. Choosing it saved
          the note first (store/app.ts, `chooseVault`); this is what a save
          still to come, from the pane going, would have written there - over a
          copy of the vault, say, where the same note is the same version.
        */
        if (useApp.getState().vaultSeq !== current.current.vaultSeq) return say('notes.aside.otherVault');
        setSaving('saving');
        try {
          const saved = await window.cortex.notes.save(at, now, over ?? was.hash);
          // The renderer is not strict: the union is told apart with `in`, as CLAUDE.md says.
          if ('hash' in saved) {
            const next = { ...was, text: now, hash: saved.hash, modified: saved.modified };
            current.current.doc = next;
            if (current.current.path === at) {
              setDoc(next);
              setConflict(null);
              setChanged(false);
              setSaving(current.current.text === now ? 'saved' : 'unsaved');
            }
            void useNotes.getState().refresh();
            return null;
          }
          if ('current' in saved && current.current.path === at) {
            setConflict(saved.current);
            setSaving('unsaved');
          }
          return say('notes.aside.changed');
        } catch (err) {
          setSaving('failed');
          // A pane left says it with where its text went (`leave`).
          if (current.current.mounted) toast({ tone: 'error', title: saying.current('notes.save.failed'), detail: messageOf(err) });
          return refusal(messageOf(err));
        }
      };
      const running = (async () => {
        try {
          for (let over = base; ; ) {
            const why = await once(over);
            const again = current.current.queued;
            current.current.queued = null;
            if (again === null) return why;
            over = again === true ? undefined : again;
          }
        } finally {
          current.current.running = null;
        }
      })();
      current.current.running = running;
      return running;
    },
    [toast],
  );

  useEffect(() => {
    if (!dirty || !writable) return;
    setSaving('unsaved');
    const timer = setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text, dirty, writable, save]);

  /*
    The note left - another note or tab, the bin, another vault, the window
    closed: what is unsaved is saved over the version read, and what cannot be
    (the note changed on disk and the person had not chosen yet, or it is gone
    from where it was) is kept as a note beside it. Before, it went with the
    pane, and nothing said so (desktop-ui-3).
  */
  const leave = useCallback(async () => {
    const why = await save();
    const { text: now, doc: was } = current.current;
    if (why === null || !was || was.text === null || now === was.text || now === current.current.keptAside) return;
    current.current.keptAside = now;
    await keepAside(path, now, why, useApp.getState().vaultSeq === current.current.vaultSeq);
  }, [path, save]);

  // Asked of the note by a delete, another vault and the window going away (openNotes.ts); left when the pane goes.
  useEffect(() => holdOpenNote(path, leave), [path, leave]);
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
      void leave();
    };
  }, [leave]);

  // The window left - for another app, the icon by the clock, sleep - saves at once, not a second later (desktop-ui-8).
  useEffect(() => {
    const now = () => void save();
    const hidden = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    window.addEventListener('blur', now);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', now);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [save]);

  // The text of the note in front, for the outline and the links beside it.
  useEffect(() => {
    const timer = setTimeout(() => useNotes.getState().setLive(doc ? { path, text } : null), 200);
    return () => clearTimeout(timer);
  }, [path, text, doc]);

  // Where the note was asked to open: a line, a heading, a block.
  useEffect(() => {
    if (!doc || !target || target.path !== path) return;
    useNotes.getState().takeTarget(path);
    const line = target.line ?? (target.subpath ? lineOfSubpath(current.current.text, target.subpath) : null);
    if (target.edit || mode === 'edit') setJump(line === null ? (target.edit ? { line: 0, seq: Date.now() } : null) : { line, seq: Date.now() });
    else if (line !== null) requestAnimationFrame(() => scrollReaderTo(reader.current, line, true));
  }, [doc, target, path, mode]);

  const switchMode = (next: 'read' | 'edit') => {
    if (next === mode) return;
    if (next === 'edit') {
      const line = topLineOf(reader.current);
      useNotes.getState().setMode('edit');
      setJump({ line, seq: Date.now() });
    } else {
      const line = editor.current?.topLine() ?? 0;
      void save();
      useNotes.getState().setMode('read');
      requestAnimationFrame(() => scrollReaderTo(reader.current, line, false));
    }
  };

  // Ctrl+E, heard by the screen while it is on screen (NotesView) and passed here.
  const modeSwitch = useNotes((state) => state.modeSwitch);
  const seenSwitch = useRef(modeSwitch);
  useEffect(() => {
    if (seenSwitch.current === modeSwitch) return;
    seenSwitch.current = modeSwitch;
    switchMode(mode === 'edit' ? 'read' : 'edit');
    // Only a new press switches; the rest is read as it is at that press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSwitch]);

  const onToggleTask = useMemo(
    () =>
      writable
        ? (line: number) => {
            const next = toggleTask(current.current.text, line);
            if (next === null) return;
            current.current.text = next;
            setText(next);
            void save();
          }
        : undefined,
    [writable, save],
  );

  const rename = async () => {
    const name = `${icon}${title.trim()}`;
    if (name === noteTitle(path)) {
      setTitleProblem(null);
      return;
    }
    const problem = nameProblem(name);
    if (problem) {
      setTitleProblem(t(NAME_PROBLEM[problem]));
      return;
    }
    await save();
    try {
      const done = await window.cortex.notes.rename(path, name);
      useNotes.getState().moved(path, done.path);
      await useNotes.getState().refresh();
      setTitleProblem(null);
      if (done.updated.length) toast({ tone: 'success', title: t('notes.rename.updated', { count: done.updated.length }) });
      if (done.skipped.length) toast({ tone: 'error', title: t('notes.rename.skipped', { count: done.skipped.length }), detail: done.skipped.join('\n') });
    } catch (err) {
      setTitleProblem(refusal(messageOf(err)));
    }
  };

  const choices = useCallback(() => linkChoices(), []);
  const openLink = useCallback((link: { target: string; subpath: string | null; kind: 'wiki' | 'markdown' }, newTab: boolean) => {
    const to = link.target ? useNotes.getState().resolve(link.target, path, link.kind) : path;
    if (to) useNotes.getState().open(to, { newTab, subpath: link.subpath });
  }, [path]);

  // What the live preview asks of the vault: where a link of this note goes, an image, and opening one.
  const liveHooks = useMemo<LiveHooks>(
    () => ({
      resolve: (target, kind) => useNotes.getState().resolve(target, path, kind),
      image: (file) => imageOf(file, useNotes.getState().index?.files.find((one) => one.path === file)?.modified ?? 0),
      open: (link, newTab) => openLink(link, newTab),
      peek: (link, box) => {
        const to = link ? (link.target ? useNotes.getState().resolve(link.target, path, link.kind) : path) : null;
        if (link && to && box && /\.md$/i.test(to)) peekSoon(to, link.subpath, box);
        else peekLeave();
      },
      taskLabel: (done) => t(done ? 'notes.task.done' : 'notes.task.todo'),
    }),
    [path, openLink, t],
  );

  // A template from the vault's templates folder, into this note: at the cursor while writing, at the end while reading.
  const [picking, setPicking] = useState(false);
  const putTemplate = async (from: string) => {
    setPicking(false);
    const raw = await templateText(from);
    if (raw === null) {
      toast({ tone: 'error', title: t('notes.template.failed') });
      return;
    }
    const filled = fillTemplate(raw, noteTitle(path), new Date());
    if (mode === 'edit' && editor.current) {
      editor.current.insertTemplate(filled);
      return;
    }
    const next = insertTemplate(current.current.text, current.current.text.length, filled).text;
    current.current.text = next;
    setText(next);
    void save();
  };

  const trashEntry = useTrash();
  const trash = () => trashEntry(path);

  const openOutside = async (how: 'obsidian' | 'folder') => {
    try {
      const done = await window.cortex.notes.open(path, how);
      if (!done.opened) toast({ tone: 'error', title: t('notes.obsidian.none') });
    } catch (err) {
      toast({ tone: 'error', title: t('notes.open.failed'), detail: messageOf(err) });
    }
  };

  // Counted from the text a moment behind the keys: a long note is parsed whole for it.
  const settled = useDeferredValue(text);
  const words = useMemo(() => (doc ? parseNote(settled).words : 0), [doc, settled]);
  const backlinks = useNotes((state) => state.index?.notes.filter((note) => note.path !== path && note.links.includes(path)).length ?? 0);
  const folder = folderOf(path);
  const reason =
    doc?.readOnly === 'encoding'
      ? t('notes.readOnly.encoding')
      : doc?.readOnly === 'receipt'
        ? t('notes.readOnly.receipt')
        : doc?.readOnly === 'generated'
          ? t('notes.readOnly.generated')
          : readOnlyVault
            ? t('notes.readOnly.vault')
            : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-note-pane={path}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-100 px-3">
        <button type="button" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation disabled:opacity-30" disabled={!tab.back.length} onClick={() => useNotes.getState().back()} title={t('notes.back')}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation disabled:opacity-30" disabled={!tab.forward.length} onClick={() => useNotes.getState().forward()} title={t('notes.forward')}>
          <ArrowRight size={15} />
        </button>
        <p className="ml-1 min-w-0 flex-1 truncate text-[12px] text-zinc-400" data-note-crumbs>
          {folder ? (
            <>
              {folderLabel(folder).split('/').join(' / ')}
              <span className="mx-1.5">/</span>
            </>
          ) : null}
          <span className="text-zinc-600">{label}</span>
        </p>
        <span className="mr-1 shrink-0 text-[11px] text-zinc-400" data-note-saving={saving}>
          {saving === 'saving' ? t('notes.saving') : saving === 'unsaved' ? t('notes.unsaved') : saving === 'failed' ? t('notes.save.failed') : null}
        </span>
        <div className="flex shrink-0 rounded-lg bg-zinc-50 p-0.5" role="group" aria-label={t('notes.mode')}>
          {(['read', 'edit'] as const).map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => switchMode(one)}
              aria-pressed={mode === one}
              data-note-mode={one}
              title={t(one === 'read' ? 'notes.mode.read.hint' : 'notes.mode.edit.hint')}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-bold transition-colors ${mode === one ? 'bg-white text-darkDelegation shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              {one === 'read' ? <BookOpen size={13} /> : <PencilLine size={13} />}
              {t(one === 'read' ? 'notes.mode.read' : 'notes.mode.edit')}
            </button>
          ))}
        </div>
        <Menu
          label={t('notes.more')}
          trigger={<MoreHorizontal size={16} />}
          items={[
            { label: t('notes.template.insert'), icon: <LayoutTemplate size={14} />, run: () => setPicking(true), disabled: !writable },
            { label: t(sourceMode ? 'notes.mode.live' : 'notes.mode.source'), icon: <Code2 size={14} />, run: () => useNotes.getState().setSourceMode(!sourceMode) },
            { label: t('notes.open.obsidian'), icon: <ExternalLink size={14} />, run: () => void openOutside('obsidian') },
            { label: t('notes.open.folder'), icon: <FolderOpen size={14} />, run: () => void openOutside('folder') },
            { label: t('notes.trash'), icon: <Trash2 size={14} />, run: () => void trash(), danger: true, disabled: Boolean(reason) },
          ]}
        />
      </div>

      {conflict ? (
        <Banner tone="warn" data="conflict">
          <span className="flex-1">{t('notes.conflict')}</span>
          <button
            type="button"
            className="font-bold underline"
            data-note-take-disk
            onClick={() => {
              current.current.text = conflict.text;
              setText(conflict.text);
              setDoc((was) => (was ? { ...was, text: conflict.text, hash: conflict.hash, modified: conflict.modified } : was));
              setConflict(null);
              setChanged(false);
              setSaving('saved');
            }}
          >
            {t('notes.conflict.theirs')}
          </button>
          <button type="button" className="font-bold underline" data-note-keep-mine onClick={() => (setConflict(null), void save(conflict.hash))}>
            {t('notes.conflict.mine')}
          </button>
        </Banner>
      ) : changed ? (
        <Banner tone="warn" data="changed">
          <span className="flex-1">{t('notes.changed')}</span>
          <button type="button" className="font-bold underline" onClick={() => void load()}>
            {t('notes.changed.reload')}
          </button>
        </Banner>
      ) : reason ? (
        <Banner tone="quiet" data="read-only">
          <span>{reason}</span>
        </Banner>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {failed ? (
          <p className="p-8 text-[13px] text-bad">{failed}</p>
        ) : !doc ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : doc.tooLarge ? (
          <p className="p-8 text-[13px] text-zinc-500">{t('notes.tooLarge')}</p>
        ) : (
          <>
            {mode === 'read' ? (
              <div ref={reader} className="absolute inset-0 overflow-y-auto px-8 pb-24 pt-8" data-note-reader>
                <TitleField value={shownTitle} onChange={setTitle} onCommit={() => void rename()} problem={titleProblem} disabled={!writable} />
                <NoteDocument path={path} text={text} onToggleTask={onToggleTask} />
              </div>
            ) : null}
            {mode === 'edit' ? (
              <div className="absolute inset-0 flex flex-col px-8">
                <div className="mx-auto w-full max-w-[46rem] pt-8">
                  <TitleField value={shownTitle} onChange={setTitle} onCommit={() => void rename()} problem={titleProblem} disabled={!writable} />
                </div>
                <div className="min-h-0 flex-1">
                  <NoteEditor
                    key={path}
                    ref={editor}
                    value={text}
                    readOnly={!writable}
                    empty={t('notes.editor.empty')}
                    onChange={(next) => {
                      current.current.text = next;
                      setText(next);
                    }}
                    onSave={() => void save()}
                    onOpenLink={openLink}
                    choices={choices}
                    jump={jump}
                    live={!sourceMode}
                    hooks={liveHooks}
                  />
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <TemplatePicker index={useNotes.getState().index} open={picking} onClose={() => setPicking(false)} onPick={(from) => void putTemplate(from)} />
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-zinc-100 px-4 text-[11px] text-zinc-400">
        <span data-note-words={words}>{t('notes.words', { count: words })}</span>
        <span>{t('notes.characters', { count: text.length })}</span>
        <span>{t('notes.backlinks.count', { count: backlinks })}</span>
      </div>
    </div>
  );
}

function Banner({ tone, data, children }: { tone: 'warn' | 'quiet'; data: string; children: React.ReactNode }) {
  return (
    <div
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-[12px] ${tone === 'warn' ? 'border-warn/30 bg-warn/10 text-darkDelegation' : 'border-zinc-100 bg-zinc-50 text-zinc-500'}`}
      data-note-banner={data}
    >
      {children}
    </div>
  );
}

/** The note's name above it, as Obsidian shows it, and where it is renamed: Enter or leaving the field renames it. */
function TitleField({ value, onChange, onCommit, problem, disabled }: { value: string; onChange: (value: string) => void; onCommit: () => void; problem: string | null; disabled: boolean }) {
  const t = useT();
  return (
    <div className="kg-note pb-5">
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            (event.target as HTMLInputElement).blur();
          }
        }}
        aria-label={t('notes.title')}
        data-note-title
        className="w-full bg-transparent font-display text-[2rem] font-extrabold leading-tight tracking-tight text-darkDelegation outline-none placeholder:text-zinc-300 disabled:opacity-100"
      />
      {problem ? (
        <p className="mt-1 text-[12px] text-bad" data-note-title-problem>
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** Every note, by the name a link to it is written with: its name alone where no other note has it, else its path. */
export function linkChoices(): { notes: LinkChoice[]; tags: string[] } {
  const { index, paths } = useNotes.getState();
  if (!index) return { notes: [], tags: [] };
  const named = new Map<string, number>();
  for (const note of index.notes) named.set(pathKey(noteTitle(note.path)), (named.get(pathKey(noteTitle(note.path))) ?? 0) + 1);
  const notes = index.notes.map((note) => ({
    title: note.label ?? noteTitle(note.path),
    path: note.path,
    folder: folderOf(note.path),
    aliases: note.aliases,
    link: (named.get(pathKey(noteTitle(note.path))) ?? 0) > 1 ? shortestLink(note.path, paths) : noteTitle(note.path),
  }));
  const tags = new Map<string, string>();
  for (const note of index.notes) for (const tag of note.tags) if (!tags.has(pathKey(tag))) tags.set(pathKey(tag), tag);
  return { notes, tags: [...tags.values()].sort((a, b) => a.localeCompare(b)) };
}

/** The first line of the note drawn at the top of the reading view. */
function topLineOf(reader: HTMLElement | null): number {
  if (!reader) return 0;
  const top = reader.getBoundingClientRect().top;
  let best = 0;
  for (const element of reader.querySelectorAll<HTMLElement>('[data-line]')) {
    const box = element.getBoundingClientRect();
    if (box.bottom < top + 8) {
      best = Number(element.dataset.line) || best;
      continue;
    }
    return Number(element.dataset.line) || best;
  }
  return best;
}

/** The reading view scrolled to the block a line is in, flashed when the person asked for that line. */
export function scrollReaderTo(reader: HTMLElement | null, line: number, flash: boolean): void {
  if (!reader) return;
  let found: HTMLElement | null = null;
  for (const element of reader.querySelectorAll<HTMLElement>('[data-line]')) {
    const at = Number(element.dataset.line);
    if (at <= line && (!found || at >= Number(found.dataset.line))) found = element;
  }
  if (!found) return;
  found.scrollIntoView({ block: flash ? 'center' : 'start' });
  if (flash) {
    found.classList.remove('kg-flash');
    void found.offsetWidth;
    found.classList.add('kg-flash');
  }
}

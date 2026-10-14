import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  emptyQuery,
  folderOf,
  freeName,
  isNotePath,
  keptBy,
  makeResolver,
  nameProblem,
  noteTitle,
  parseNote,
  parseQuery,
  pathKey,
  proseOnly,
  readProperties,
  splitProperties,
  relink,
  landingOf,
  fillTemplate,
  retitle,
  baseName,
  dayOf,
  searchNote,
  type IndexedNote,
  type NoteFacts,
  type SearchHit,
} from '../../core/vaultNotes';
import { foldForMatch } from '../../core/titles';
import type { Moved } from '../../shared/api';
import type { NoteBacklinks, NoteRead, NoteSaved, TextRead, TrashItem, VaultIndex } from '../../shared/notes';
import { readSettings } from './settings';

/**
 * The whole of the vault, for the person's own notes screen (src/notes/),
 * where Obsidian would otherwise be needed to read and write it. Carried from
 * Krewgent (desktop/KAYNAK.md), where it was written and tested.
 *
 * It is the person's alone: nothing here is handed to a CLI or a model, and
 * only the notes channels in electron/ipc.ts import it
 * (tests/vaultNotesBoundary.test.ts reads the source). What it reads goes to
 * the window that asked, over those channels, and stops there.
 *
 * It reads as the person would see the vault in Obsidian, less what is not
 * theirs to see there: a hidden file or folder - `.obsidian`, `.git`,
 * `.claude`, Cortex's own state, an access file - is never listed, read or
 * written, and no link is followed, in the vault or out of it. A path is held
 * inside the vault as spelled and as the disk resolves it, at every call.
 *
 * What changes the vault is the person's act on this screen, and each is said
 * before it is done: a note saved over the one that was read and no other (a
 * note changed on disk since is a conflict, shown, never written over), made
 * exclusively, renamed with the links to it pointed at its new name, or put in
 * the system's bin. Every write goes through a temporary renamed into place.
 *
 * Krewgent also refused to write a vault that landed in Hermes's, its older
 * second brain; this app has no Hermes, and that refusal is not carried.
 */

const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const same = (a: string, b: string) => (CASELESS ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A note larger than this is listed and not opened: a note, not an export. */
export const NOTE_READ_MAX = 4 * 1024 * 1024;
/** How much of the vault is listed: a vault of notes, not a disk. */
const LIST_MAX = 20_000;
const LIST_DEPTH = 32;
/** How much text is kept in memory for search and backlinks; past it, a note is read again when asked. */
const TEXT_CACHE_MAX = 64 * 1024 * 1024;
/** An image drawn in a note is sent to the window whole, as a data URL; one larger than this is not drawn. */
const ASSET_MAX = 12 * 1024 * 1024;
/** A file that is not a note is shown as text up to this size: a config or a script, not a log or a dump. */
export const TEXT_READ_MAX = 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  // Drawn as an image, where an SVG's scripts do not run.
  '.svg': 'image/svg+xml',
};
const SEARCH_MAX = 200;
const BACKLINK_LINES = 4;

export class VaultRefusal extends Error {}

function vaultRoot(): string {
  const vault = readSettings().vault;
  if (!vault) throw new VaultRefusal('Choose the vault first.');
  return vault;
}

/** The parts of a path inside the vault, or a refusal: nothing empty, nothing that climbs, nothing hidden. */
function partsOf(relative: unknown): string[] {
  if (typeof relative !== 'string' || relative.length > 1000) throw new VaultRefusal('Not a path inside the vault.');
  if (relative === '') return [];
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new VaultRefusal(`Not a path the notes screen reads: ${relative}`);
  return parts;
}

/**
 * Where a path of the vault is on disk, held to it as spelled and as resolved:
 * the vault itself must still be the folder that was chosen and not a link, and
 * nothing on the way to the path may be a link. `existing: false` is for a path
 * about to be made, whose folder is held so instead.
 */
async function onDisk(relative: unknown, existing = true): Promise<{ vault: string; file: string; relative: string }> {
  const vault = vaultRoot();
  const parts = partsOf(relative);
  let realVault: string;
  try {
    realVault = await fs.realpath(vault);
  } catch {
    throw new VaultRefusal(`The vault ${path.basename(vault)} is not where it was any more.`);
  }
  if (!same(realVault, vault)) throw new VaultRefusal(`The vault ${path.basename(vault)} leads elsewhere through a link now. Choose it again.`);
  const file = path.join(vault, ...parts);
  const held = existing ? file : path.dirname(file);
  let real: string;
  try {
    real = await fs.realpath(held);
  } catch {
    throw new VaultRefusal(`Not in the vault: ${parts.join('/') || '/'}`);
  }
  // Equal to the path as spelled: a link anywhere on the way makes them differ.
  if (!same(real, held)) throw new VaultRefusal(`Reached through a link: ${parts.join('/')}`);
  return { vault, file, relative: parts.join('/') };
}

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

interface Cached {
  modified: number;
  size: number;
  facts: NoteFacts | null;
  text: string | null;
}

let cache = new Map<string, Cached>();
let cachedFor: string | null = null;
let cachedText = 0;
let building: Promise<VaultIndex> | null = null;
let last: { files: string[]; notes: Map<string, IndexedNote> } | null = null;

function forget(vault: string | null): void {
  if (cachedFor === vault) return;
  cache = new Map();
  cachedText = 0;
  last = null;
  cachedFor = vault;
}

async function walk(vault: string): Promise<{ folders: string[]; files: Array<{ path: string; size: number; modified: number }>; truncated: boolean }> {
  const folders: string[] = [];
  const files: Array<{ path: string; size: number; modified: number }> = [];
  let truncated = false;
  const visit = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (depth > LIST_DEPTH) {
      truncated = true;
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (folders.length + files.length >= LIST_MAX) {
        truncated = true;
        return;
      }
      // Hidden, or a link: not the person's notes as Obsidian shows them, and a link is never followed.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const inside = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        folders.push(inside);
        await visit(full, inside, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.lstat(full);
          files.push({ path: inside, size: stat.size, modified: stat.mtimeMs });
        } catch {
          /* gone while listed */
        }
      }
    }
  };
  await visit(vault, '', 0);
  return { folders, files, truncated };
}

/** A note's bytes as text, or null when they are not UTF-8: such a note is shown and never saved, which would change bytes the person did not touch. */
function textOf(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.byteLength(text, 'utf8') === bytes.length && Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

async function build(): Promise<VaultIndex> {
  const vault = readSettings().vault;
  forget(vault);
  if (!vault) return { vault: null, folders: [], files: [], notes: [], truncated: false, readOnly: null };
  try {
    await onDisk('');
  } catch (err) {
    return { vault: { name: path.basename(vault) }, folders: [], files: [], notes: [], truncated: false, readOnly: null, missing: (err as Error).message };
  }
  const listed = await walk(vault);
  const seen = new Set<string>();
  for (const file of listed.files) {
    if (!isNotePath(file.path)) continue;
    seen.add(file.path);
    const before = cache.get(file.path);
    if (before && before.modified === file.modified && before.size === file.size) continue;
    if (before?.text) cachedText -= before.text.length;
    if (file.size > NOTE_READ_MAX) {
      cache.set(file.path, { modified: file.modified, size: file.size, facts: null, text: null });
      continue;
    }
    try {
      const bytes = await fs.readFile(path.join(vault, ...file.path.split('/')));
      const text = textOf(bytes) ?? bytes.toString('utf8');
      const keep = cachedText + text.length <= TEXT_CACHE_MAX;
      if (keep) cachedText += text.length;
      cache.set(file.path, { modified: file.modified, size: file.size, facts: parseNote(text), text: keep ? text : null });
    } catch {
      cache.delete(file.path);
    }
  }
  for (const [key, value] of cache) {
    if (seen.has(key)) continue;
    if (value.text) cachedText -= value.text.length;
    cache.delete(key);
  }
  const paths = listed.files.map((one) => one.path);
  const resolve = makeResolver(paths);
  const notes = new Map<string, IndexedNote>();
  for (const file of listed.files) {
    if (!isNotePath(file.path)) continue;
    const cached = cache.get(file.path);
    if (!cached) continue;
    const links = new Set<string>();
    const unresolved = new Map<string, string>();
    for (const link of cached.facts?.links ?? []) {
      if (!link.target) continue;
      const to = resolve(link.target, file.path, link.kind);
      if (to) links.add(to);
      else if (link.kind === 'wiki') unresolved.set(pathKey(link.target), link.target);
    }
    const kept = cached.facts ? keptBy(file.path, cached.facts.properties) : null;
    notes.set(file.path, {
      path: file.path,
      modified: file.modified,
      size: file.size,
      aliases: cached.facts?.aliases ?? [],
      tags: cached.facts?.tags ?? [],
      links: [...links],
      unresolved: [...unresolved.values()],
      ...(cached.facts ? {} : { tooLarge: true }),
      ...(kept ? { keeper: kept.keeper } : {}),
      ...(kept?.label ? { label: kept.label } : {}),
    });
  }
  last = { files: paths, notes };
  return {
    vault: { name: path.basename(vault) },
    folders: listed.folders,
    files: listed.files.filter((one) => !isNotePath(one.path)).map((one) => ({ path: one.path, size: one.size, modified: one.modified })),
    notes: [...notes.values()],
    truncated: listed.truncated,
    readOnly: null,
  };
}

/** The vault as the notes screen draws it, read again where a file changed since the last time. One build at a time. */
export function vaultIndex(): Promise<VaultIndex> {
  if (!building) {
    building = build().finally(() => {
      building = null;
    });
  }
  return building;
}

async function textFor(relative: string): Promise<string | null> {
  const cached = cache.get(relative);
  if (cached?.text) return cached.text;
  try {
    const { file } = await onDisk(relative);
    const stat = await fs.stat(file);
    if (stat.size > NOTE_READ_MAX) return null;
    return textOf(await fs.readFile(file));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* One note                                                            */
/* ------------------------------------------------------------------ */

const hashOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Whether Cortex's engine keeps the note this text is (`keptBy`), read from its properties alone. */
const keeperOf = (inside: string, text: string) => keptBy(inside, readProperties(splitProperties(text).yaml).properties)?.keeper ?? null;

export async function readVaultNote(relative: unknown): Promise<NoteRead> {
  const { file, relative: inside } = await onDisk(relative);
  if (!isNotePath(inside)) throw new VaultRefusal(`Not a note: ${inside}`);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new VaultRefusal(`Not a note: ${inside}`);
  if (stat.size > NOTE_READ_MAX) return { path: inside, text: null, hash: null, modified: stat.mtimeMs, tooLarge: true, readOnly: null };
  const bytes = await fs.readFile(file);
  const text = textOf(bytes);
  const readOnly = text === null ? 'encoding' : keeperOf(inside, text);
  return { path: inside, text: text ?? bytes.toString('utf8'), hash: hashOf(bytes), modified: stat.mtimeMs, tooLarge: false, readOnly };
}

/**
 * A file of the vault that is not a note, as text to be read: a JSON, a
 * script, a config. Shown and never written, and never run. Null text for
 * what is not text - bytes that are not UTF-8, or a NUL among them - and for
 * a file larger than TEXT_READ_MAX.
 */
export async function readVaultText(relative: unknown): Promise<TextRead> {
  const { file, relative: inside } = await onDisk(relative);
  if (isNotePath(inside)) throw new VaultRefusal(`A note is read as a note: ${inside}`);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new VaultRefusal(`Not a file: ${inside}`);
  if (stat.size > TEXT_READ_MAX) return { path: inside, text: null, modified: stat.mtimeMs, tooLarge: true };
  const bytes = await fs.readFile(file);
  const text = bytes.includes(0) ? null : textOf(bytes);
  return { path: inside, text: text === null ? null : text.replace(/^﻿/, ''), modified: stat.mtimeMs, tooLarge: false };
}

/** A file written beside where it goes and renamed into place, so a note is never left half written. */
async function writeInPlace(file: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, text, { flag: 'wx' });
  try {
    await renameBusy(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

/** A rename tried again for a moment while Windows says the file is busy (an antivirus or the indexer holds a file just written), without blocking the main process. */
async function renameBusy(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
      await new Promise((done) => setTimeout(done, 25 * (attempt + 1)));
    }
  }
}

/**
 * The person's note saved over the one they opened, and no other: when the
 * file on disk is not, byte for byte, the one that was read (`base`), nothing
 * is written and what is there now is handed back, for the person to choose.
 */
export async function saveVaultNote(relative: unknown, text: unknown, base: unknown): Promise<NoteSaved> {
  if (typeof text !== 'string' || typeof base !== 'string') throw new VaultRefusal('A note is saved as text, over the version that was read.');
  const { file, relative: inside } = await onDisk(relative);
  if (!isNotePath(inside)) throw new VaultRefusal(`Not a note: ${inside}`);
  if (Buffer.byteLength(text, 'utf8') > NOTE_READ_MAX) throw new VaultRefusal('The note is larger than a note the screen keeps.');
  const now = await fs.readFile(file);
  const was = textOf(now);
  if (was === null) throw new VaultRefusal(`${inside} is not UTF-8 text, and saving it here would change bytes the person did not touch.`);
  if (keeperOf(inside, was)) throw new VaultRefusal(`Cortex keeps ${inside} itself: it is read here and not written.`);
  if (hashOf(now) !== base) {
    const stat = await fs.stat(file);
    return { saved: false, current: { text: textOf(now) ?? now.toString('utf8'), hash: hashOf(now), modified: stat.mtimeMs } };
  }
  await writeInPlace(file, text);
  const stat = await fs.stat(file);
  return { saved: true, hash: hashOf(Buffer.from(text, 'utf8')), modified: stat.mtimeMs };
}

/**
 * A new note in a folder of the vault, under a name made free when asked
 * (`Untitled 1`), made exclusively: nothing is written over. With a template,
 * its text is the template filled for the name it was made under
 * (`fillTemplate`): a free name is only known here.
 */
export async function createVaultNote(folder: unknown, name: unknown, options: { text?: unknown; unique?: unknown; template?: unknown } = {}): Promise<{ path: string }> {
  if (typeof name !== 'string') throw new VaultRefusal('A note needs a name.');
  const problem = nameProblem(name);
  if (problem) throw new VaultRefusal(`Not a name a note can have (${problem}): ${name}`);
  const { file: dir, relative } = await onDisk(folder ?? '');
  if (!(await fs.stat(dir)).isDirectory()) throw new VaultRefusal(`Not a folder: ${relative}`);
  const template = typeof options.template === 'string' && options.template.length <= NOTE_READ_MAX ? options.template : null;
  const textFor = (title: string) => (template !== null ? fillTemplate(template, title, new Date()) : typeof options.text === 'string' ? options.text : '');
  const taken = async () => (await fs.readdir(dir)).filter((one) => /\.md$/i.test(one)).map((one) => one.replace(/\.md$/i, ''));
  let chosen = name.trim();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (options.unique === true) chosen = freeName(name.trim(), await taken());
    try {
      await fs.writeFile(path.join(dir, `${chosen}.md`), textFor(chosen), { flag: 'wx' });
      return { path: relative ? `${relative}/${chosen}.md` : `${chosen}.md` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || options.unique !== true) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultRefusal(`A note named ${chosen} is already in ${relative || 'the vault'}.`);
        throw err;
      }
    }
  }
  throw new VaultRefusal('No free name for a new note was found.');
}

export async function createVaultFolder(parent: unknown, name: unknown): Promise<{ path: string }> {
  if (typeof name !== 'string') throw new VaultRefusal('A folder needs a name.');
  const problem = nameProblem(name);
  if (problem) throw new VaultRefusal(`Not a name a folder can have (${problem}): ${name}`);
  const { file: dir, relative } = await onDisk(parent ?? '');
  // Not recursive: one folder, made where the person is.
  await fs.mkdir(path.join(dir, name.trim()));
  return { path: relative ? `${relative}/${name.trim()}` : name.trim() };
}

export type { Moved };

/**
 * Refused when Cortex's engine keeps this note, or the folder holds one it
 * keeps: the engine finds a receipt by its name and a generated page by its
 * path, so neither is moved, renamed or binned from here. Read against the
 * index last built (`vaultIndex` first).
 */
function refuseKept(inside: string, what: string): void {
  const kept = last ? [...last.notes.values()].find((note) => note.keeper && (note.path === inside || note.path.startsWith(`${inside}/`))) : undefined;
  if (!kept) return;
  throw new VaultRefusal(kept.path === inside ? `Cortex keeps ${inside} itself: it is not ${what} from here.` : `${inside} holds notes Cortex keeps (${kept.path}): it is not ${what} from here.`);
}

/**
 * A note, a file or a folder moved or renamed, and the links of the vault kept
 * finding what they found, as Obsidian keeps them: every note is read again
 * against the vault as it is now (`relink`, core/vaultNotes.ts), and one whose
 * link would find another file or none is saved with that link pointed at the
 * new place, through a temporary renamed into place, over the version read just
 * before. A note changed on disk in that moment is not written and is named in
 * the answer; the move itself stands. Refused before anything moves: a place
 * something else has, a folder into itself, the vault's top, anything hidden.
 */
async function moveEntry(fromRelative: unknown, toRelative: string): Promise<Moved> {
  const { file, relative: from } = await onDisk(fromRelative);
  if (!from) throw new VaultRefusal('The vault itself is not moved from here.');
  const { file: target, relative: to } = await onDisk(toRelative, false);
  if (to === from) return { path: from, updated: [], skipped: [] };
  const folder = (await fs.lstat(file)).isDirectory();
  if (folder && (to.startsWith(`${from}/`) || pathKey(to).startsWith(`${pathKey(from)}/`))) throw new VaultRefusal(`A folder cannot go inside itself: ${from}`);
  // The same thing under another case is a rename of its case, not a clash.
  if (pathKey(to) !== pathKey(from)) {
    try {
      await fs.lstat(target);
      throw new VaultRefusal(`Something named ${baseName(to)} is already in ${folderOf(to) || 'the vault'}.`);
    } catch (err) {
      if (err instanceof VaultRefusal) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  await vaultIndex();
  const before = last;
  refuseKept(from, 'moved or renamed');
  await renameBusy(file, target);
  const updated: string[] = [];
  const skipped: string[] = [];
  if (!before) return { path: to, updated, skipped };
  const movedTo = landingOf([{ from, to }]);
  const afterFiles = before.files.map(movedTo);
  const resolveBefore = makeResolver(before.files);
  const resolveAfter = makeResolver(afterFiles);
  /*
    A note is read again when it moved, when it links to what moved, or when it
    links to a file of the same name as what moved: arriving beside a note, a
    file takes over that note's links by name (Obsidian prefers the one beside
    it), and those are pointed back at what they found. Every other note - most
    of a vault - still finds what it found, and is not read.
  */
  const movedNames = new Set(before.files.filter((path) => movedTo(path) !== path).flatMap((path) => [pathKey(baseName(path)), pathKey(noteTitle(path))]));
  const touches = (link: string) => movedTo(link) !== link || movedNames.has(pathKey(baseName(link))) || movedNames.has(pathKey(noteTitle(link)));
  for (const note of before.notes.values()) {
    const now = movedTo(note.path);
    if (now === note.path && !note.links.some(touches)) continue;
    const cached = cache.get(note.path)?.text ?? (await textFor(now));
    if (cached === null) continue;
    const at = { was: note.path, now };
    const planned = relink(cached, at, resolveBefore, resolveAfter, movedTo, afterFiles);
    if (!planned.changed && !planned.lost) continue;
    try {
      const read = await readVaultNote(now);
      if (read.text === null || read.hash === null || read.readOnly) {
        skipped.push(now);
        continue;
      }
      const { text, changed, lost } = relink(read.text, at, resolveBefore, resolveAfter, movedTo, afterFiles);
      if (changed) {
        const saved = await saveVaultNote(now, text, read.hash);
        if (!('hash' in saved)) {
          skipped.push(now);
          continue;
        }
      }
      // A link that no wiki link could point back at its file is said, not left to look kept.
      (lost ? skipped : updated).push(now);
    } catch {
      skipped.push(now);
    }
  }
  return { path: to, updated, skipped };
}

/**
 * A note, a file or a folder renamed where it is. A note's name is given
 * without `.md`, which it keeps; a file's with its extension, as the tree
 * shows it; a folder's as it is.
 */
export async function renameVaultEntry(relative: unknown, name: unknown): Promise<Moved> {
  if (typeof name !== 'string') throw new VaultRefusal('A new name is needed.');
  const problem = nameProblem(name);
  if (problem) throw new VaultRefusal(`Not a name it can have (${problem}): ${name}`);
  const { file, relative: from } = await onDisk(relative);
  const isNote = isNotePath(from) && (await fs.lstat(file)).isFile();
  const named = isNote ? `${name.trim().replace(/\.md$/i, '')}.md` : name.trim();
  const moved = await moveEntry(from, folderOf(from) ? `${folderOf(from)}/${named}` : named);
  // The note's own title, where it repeated its old name (Cortex's notes carry it in `title:`), follows the rename.
  if (isNote && moved.path !== from) {
    try {
      const read = await readVaultNote(moved.path);
      if (read.text !== null && read.hash !== null && !read.readOnly) {
        const next = retitle(read.text, noteTitle(from), noteTitle(moved.path));
        if (next !== read.text) await saveVaultNote(moved.path, next, read.hash);
      }
    } catch {
      /* The rename stands; a title not brought along is the note's to fix. */
    }
  }
  return moved;
}

/** A note, a file or a folder moved into another folder of the vault, keeping its name. */
export async function moveVaultEntry(relative: unknown, folder: unknown): Promise<Moved> {
  const from = partsOf(relative).join('/');
  const into = partsOf(folder ?? '').join('/');
  const { file: dir } = await onDisk(into);
  if (!(await fs.stat(dir)).isDirectory()) throw new VaultRefusal(`Not a folder: ${into || '/'}`);
  return moveEntry(from, into ? `${into}/${baseName(from)}` : baseName(from));
}

/* ------------------------------------------------------------------ */
/* The vault's own bin                                                 */
/* ------------------------------------------------------------------ */

/*
  What is deleted on this screen goes to the vault's own bin, `.trash/` - the
  folder Obsidian's "move to Obsidian trash" uses - and comes back from it to
  where it was: a delete is a move, taken back with one click, and nothing
  here deletes. Each thing deleted is one entry at the bin's top under its own
  name (a name already there gets the moment it was deleted after it), and
  `.trash/.cortex.json` says where each came from and when. An entry that list
  does not know - Obsidian's own, or one whose record was lost - is listed too,
  and comes back at the vault's top.

  `.trash` is the one hidden folder written here, and only by this part: the
  index, the search and the links never see it, and Cortex's engine does not
  read hidden folders (beyin_v3_sync.py skips them), so nothing in the bin is
  in any assistant's memory. Deleted from the bin, an entry goes on to the
  system's bin, from where it can still be taken back.
*/

const TRASH = '.trash';
const TRASH_LIST = '.cortex.json';
const FOLDER_COUNT_MAX = 10_000;

interface TrashRecord {
  id: string;
  from: string;
  kind: TrashItem['kind'];
  deletedAt: number;
}

let binQueue: Promise<unknown> = Promise.resolve();

/** One change to the bin at a time: its list is read, changed and written whole. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = binQueue.then(work, work);
  binQueue = next.catch(() => undefined);
  return next;
}

/** A name at the bin's top: one part, not hidden, nothing that climbs. */
const isEntryName = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 255 && !/[\\/]/.test(id) && !id.startsWith('.');

/** The bin's folder, made when first needed: a folder of the vault's own, never a link. Null when there is none and none is to be made. */
async function binDir(make: boolean): Promise<{ vault: string; dir: string } | null> {
  const { vault } = await onDisk('');
  const dir = path.join(vault, TRASH);
  const stat = await fs.lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) {
    if (!make) return null;
    await fs.mkdir(dir);
  } else if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(dir), dir)) {
    throw new VaultRefusal(`${TRASH} in the vault is not a folder Cortex can keep its bin in.`);
  }
  return { vault, dir };
}

/** The bin's list. One that will not be read is kept beside, as the settings file is, and the bin goes on without it: its entries are still listed, as from the vault's top. */
async function readRecords(dir: string): Promise<TrashRecord[]> {
  const file = path.join(dir, TRASH_LIST);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const items = (JSON.parse(raw) as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new Error('no items');
    return items.filter(
      (one): one is TrashRecord =>
        typeof one === 'object' && one !== null && isEntryName(one.id) && typeof one.from === 'string' && ['note', 'file', 'folder'].includes(one.kind) && typeof one.deletedAt === 'number',
    );
  } catch {
    await fs.copyFile(file, path.join(dir, `.cortex.broken-${Date.now()}.json`));
    return [];
  }
}

async function writeRecords(dir: string, records: TrashRecord[]): Promise<void> {
  const there = new Set((await fs.readdir(dir)).filter((name) => !name.startsWith('.')));
  // A record whose entry is gone - emptied by hand, or taken back in Obsidian - is let go.
  const kept = records.filter((one) => there.has(one.id));
  await writeInPlace(path.join(dir, TRASH_LIST), `${JSON.stringify({ version: 1, items: kept }, null, 2)}\n`);
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** A name free in a folder: the one given, else the same with a number after it, before the extension of a file. */
async function freeIn(dir: string, name: string, folder: boolean, mark: (n: number) => string): Promise<string> {
  if (!(await exists(path.join(dir, name)))) return name;
  const dot = folder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n += 1) {
    const next = `${stem} ${mark(n)}${ext}`;
    if (!(await exists(path.join(dir, next)))) return next;
  }
  throw new VaultRefusal(`No free name for ${name} was found.`);
}

async function filesIn(dir: string): Promise<number> {
  let count = 0;
  const visit = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      if (count >= FOLDER_COUNT_MAX) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(at, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  await visit(dir);
  return count;
}

/** A note, a file or a folder moved into the vault's bin, to be taken back from there with one click. */
export async function trashVaultEntry(relative: unknown): Promise<{ id: string }> {
  const { file, relative: inside } = await onDisk(relative);
  if (!inside) throw new VaultRefusal('The vault itself is not put in the bin from here.');
  await vaultIndex();
  refuseKept(inside, 'put in the bin');
  return serial(async () => {
    const { dir } = (await binDir(true))!;
    const stat = await fs.lstat(file);
    const kind: TrashItem['kind'] = stat.isDirectory() ? 'folder' : isNotePath(inside) ? 'note' : 'file';
    const now = new Date();
    const stamp = `(${dayOf(now)} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')})`;
    const id = await freeIn(dir, baseName(inside), kind === 'folder', (n) => (n === 1 ? stamp : `${stamp} ${n}`));
    await renameBusy(file, path.join(dir, id));
    await writeRecords(dir, [...(await readRecords(dir)).filter((one) => one.id !== id), { id, from: inside, kind, deletedAt: now.getTime() }]);
    return { id };
  });
}

/** What is in the vault's bin, the last deleted first. */
export async function listVaultTrash(): Promise<TrashItem[]> {
  return serial(async () => {
    const bin = await binDir(false);
    if (!bin) return [];
    const records = new Map((await readRecords(bin.dir)).map((one) => [one.id, one]));
    const items: TrashItem[] = [];
    for (const entry of await fs.readdir(bin.dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) continue;
      const full = path.join(bin.dir, entry.name);
      const stat = await fs.lstat(full);
      const record = records.get(entry.name);
      items.push({
        id: entry.name,
        from: record?.from ?? entry.name,
        kind: entry.isDirectory() ? 'folder' : isNotePath(entry.name) ? 'note' : 'file',
        deletedAt: record?.deletedAt ?? stat.mtimeMs,
        size: entry.isDirectory() ? await filesIn(full) : stat.size,
        known: Boolean(record),
      });
    }
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  });
}

/**
 * An entry of the bin put back where it was, the folders on the way made
 * again where they are gone, never through a link. Where that place has been
 * taken since, it comes back beside it under a free name (`Plan 1.md`): nothing
 * is written over. Its links find it again by its name; none is rewritten.
 */
export async function restoreVaultTrash(id: unknown): Promise<{ path: string }> {
  if (!isEntryName(id)) throw new VaultRefusal('Not something in the bin.');
  return serial(async () => {
    const bin = await binDir(false);
    const source = bin ? path.join(bin.dir, id) : null;
    const stat = source ? await fs.lstat(source).catch(() => null) : null;
    if (!bin || !source || !stat || stat.isSymbolicLink()) throw new VaultRefusal(`${id} is not in the bin any more.`);
    const records = await readRecords(bin.dir);
    const parts = partsOf(records.find((one) => one.id === id)?.from ?? id);
    const folder = parts.slice(0, -1);
    for (let at = 1; at <= folder.length; at += 1) {
      const dir = path.join(bin.vault, ...folder.slice(0, at));
      const there = await fs.lstat(dir).catch(() => null);
      if (!there) await fs.mkdir(dir);
      else if (!there.isDirectory() || there.isSymbolicLink()) throw new VaultRefusal(`${folder.slice(0, at).join('/')} is not a folder any more.`);
    }
    const { file: home, relative } = await onDisk(folder.join('/'));
    const name = await freeIn(home, parts[parts.length - 1], stat.isDirectory(), (n) => String(n));
    await renameBusy(source, path.join(home, name));
    await writeRecords(bin.dir, records.filter((one) => one.id !== id));
    return { path: relative ? `${relative}/${name}` : name };
  });
}

/** An entry of the bin sent on to the system's bin: gone from the vault, and still not deleted. */
export async function deleteVaultTrash(id: unknown): Promise<void> {
  if (!isEntryName(id)) throw new VaultRefusal('Not something in the bin.');
  await serial(async () => {
    const bin = await binDir(false);
    const source = bin ? path.join(bin.dir, id) : null;
    const stat = source ? await fs.lstat(source).catch(() => null) : null;
    if (!bin || !source || !stat || stat.isSymbolicLink()) throw new VaultRefusal(`${id} is not in the bin any more.`);
    await shell.trashItem(source);
    await writeRecords(bin.dir, await readRecords(bin.dir));
  });
}

/** Every entry of the bin sent on to the system's bin. How many went. */
export async function emptyVaultTrash(): Promise<number> {
  return serial(async () => {
    const bin = await binDir(false);
    if (!bin) return 0;
    let sent = 0;
    for (const entry of await fs.readdir(bin.dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      await shell.trashItem(path.join(bin.dir, entry.name));
      sent += 1;
    }
    await writeRecords(bin.dir, []);
    return sent;
  });
}

/* ------------------------------------------------------------------ */
/* What points at a note, and what a search finds                      */
/* ------------------------------------------------------------------ */

/**
 * The notes that link to one, with the lines they do it on; and the notes that
 * name it without a link (its title or an alias, as a whole word), which
 * Obsidian calls unlinked mentions.
 */
export async function vaultBacklinks(relative: unknown): Promise<NoteBacklinks> {
  const target = partsOf(relative).join('/');
  await vaultIndex();
  const index = last;
  if (!index) return { linked: [], unlinked: [] };
  const resolve = makeResolver(index.files);
  const names = [noteTitle(target), ...(index.notes.get(target)?.aliases ?? [])].map((one) => foldForMatch(one)).filter((one) => one.length >= 3);
  const linked: NoteBacklinks['linked'] = [];
  const unlinked: NoteBacklinks['unlinked'] = [];
  for (const note of index.notes.values()) {
    if (note.path === target) continue;
    const text = await textFor(note.path);
    if (text === null) continue;
    const facts = cache.get(note.path)?.facts ?? parseNote(text);
    const textLines = text.split('\n');
    if (note.links.includes(target)) {
      const lines = [...new Set(facts.links.filter((link) => link.target && resolve(link.target, note.path, link.kind) === target).map((link) => link.line))];
      linked.push({ from: note.path, lines: lines.slice(0, BACKLINK_LINES).map((line) => ({ line, text: textLines[line]?.trim().slice(0, 300) ?? '' })) });
      continue;
    }
    if (!names.length) continue;
    const prose = foldForMatch(proseOnly(text));
    const found: Array<{ line: number; text: string }> = [];
    const proseLines = prose.split('\n');
    for (let i = 0; i < proseLines.length && found.length < BACKLINK_LINES; i += 1) {
      const line = proseLines[i];
      const hit = names.some((name) => {
        for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
          const before = at === 0 ? ' ' : line[at - 1];
          const after = at + name.length >= line.length ? ' ' : line[at + name.length];
          // A whole word, and not inside a link's brackets.
          if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after) && before !== '[' && after !== ']') return true;
        }
        return false;
      });
      if (hit) found.push({ line: i, text: textLines[i].trim().slice(0, 300) });
    }
    if (found.length) unlinked.push({ from: note.path, lines: found });
  }
  const order = (a: { from: string }, b: { from: string }) => noteTitle(a.from).localeCompare(noteTitle(b.from));
  return { linked: linked.sort(order), unlinked: unlinked.sort(order) };
}

export async function searchVault(query: unknown): Promise<{ hits: SearchHit[]; more: boolean }> {
  if (typeof query !== 'string') return { hits: [], more: false };
  const parsed = parseQuery(query.slice(0, 500));
  if (emptyQuery(parsed)) return { hits: [], more: false };
  await vaultIndex();
  const index = last;
  if (!index) return { hits: [], more: false };
  const hits: SearchHit[] = [];
  for (const note of index.notes.values()) {
    const text = (await textFor(note.path)) ?? '';
    const hit = searchNote(note.path, text, note, parsed);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || noteTitle(a.path).localeCompare(noteTitle(b.path)));
  return { hits: hits.slice(0, SEARCH_MAX), more: hits.length > SEARCH_MAX };
}

/** An image of the vault, for a note that draws it, as a data URL the window's policy allows; null for what is not an image or is too large. */
export async function vaultAsset(relative: unknown): Promise<string | null> {
  const { file, relative: inside } = await onDisk(relative);
  const type = IMAGE_TYPES[path.extname(inside).toLowerCase()];
  if (!type) return null;
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > ASSET_MAX) return null;
  return `data:${type};base64,${(await fs.readFile(file)).toString('base64')}`;
}

/**
 * A note or a file shown outside the app: in Obsidian, by its own address for a
 * file, or in the system's file manager. Nothing is opened by its own program:
 * a vault may hold a script, and a double-click on it here would run it.
 */
export async function openVaultEntry(relative: unknown, how: unknown): Promise<{ opened: boolean; reason?: 'no-obsidian' }> {
  const { file } = await onDisk(relative);
  if (how === 'folder') {
    shell.showItemInFolder(file);
    return { opened: true };
  }
  if (how !== 'obsidian') throw new VaultRefusal('Opened in Obsidian or shown in its folder, nothing else.');
  if (!app.getApplicationNameForProtocol('obsidian://')) return { opened: false, reason: 'no-obsidian' };
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(file)}`);
  return { opened: true };
}

/* ------------------------------------------------------------------ */
/* Changes on disk                                                     */
/* ------------------------------------------------------------------ */

let watching: { vault: string; watcher: FSWatcher } | null = null;
let soon: ReturnType<typeof setTimeout> | null = null;

/**
 * The window told that the vault changed on disk - Obsidian, Cortex, Pyn or a
 * sync wrote a note - a moment after the last change, so that it reads the
 * index again. Hidden files are not news: Obsidian rewrites its workspace file
 * every few seconds. Where the platform cannot watch a folder whole, nothing is
 * said, and the screen reads the vault again when the window comes back.
 */
export function watchVault(tell: () => void): void {
  const vault = readSettings().vault;
  if (watching?.vault === vault) return;
  stopWatchingVault();
  if (!vault) return;
  try {
    const watcher = watch(vault, { recursive: true }, (_event, name) => {
      const changed = typeof name === 'string' ? name : name ? String(name) : '';
      if (changed && changed.split(/[\\/]/).some((part) => part.startsWith('.'))) return;
      if (soon) clearTimeout(soon);
      soon = setTimeout(() => {
        soon = null;
        tell();
      }, 400);
    });
    watcher.on('error', () => stopWatchingVault());
    watching = { vault, watcher };
  } catch {
    watching = null;
  }
}

export function stopWatchingVault(): void {
  watching?.watcher.close();
  watching = null;
  if (soon) clearTimeout(soon);
  soon = null;
}


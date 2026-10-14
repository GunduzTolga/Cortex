import { CORE_SCHEMA, load } from 'js-yaml';
import { foldForMatch, titleKey } from './titles';

/**
 * The person's notes in Cortex's vault, read the way Obsidian reads them,
 * decided without a filesystem: what a note says about itself (its properties,
 * aliases, tags, headings), what it links to, which file a link means, what a
 * rename changes in the notes that link to it, and what a search or a quick
 * switch finds. The notes screen (src/notes/) draws it;
 * electron/services/vaultNotes.ts reads the disk for it.
 *
 * Carried from Krewgent (desktop/KAYNAK.md says from which commit), where it
 * was written and tested; the two are kept comparable, so a rule changed here
 * is a rule to change there too.
 *
 * Obsidian is closed source and cannot be put inside the app (14 October), so
 * the vault is read here in Obsidian's own terms, close enough that a note
 * written in either reads the same in the other: `[[wiki links]]` with an
 * alias, a heading or a block, `![[embeds]]`, Markdown links, `#tags` inline
 * and in the properties, `%% comments %%`. What Obsidian does that this does
 * not - setext headings, links inside a property's value, a link's resolution
 * by Obsidian's own index when two notes share a name and neither is beside
 * the linking one - is said where it is decided.
 *
 * For the person's eyes. Nothing here is handed to a model.
 */

/* ------------------------------------------------------------------ */
/* What a note says about itself                                       */
/* ------------------------------------------------------------------ */

/** A property's value as the screen shows it: one line, a list of them, or nothing. */
export type PropertyValue = string | number | boolean | null | string[];

export interface NoteProperty {
  key: string;
  value: PropertyValue;
}

export interface NoteHeading {
  level: number;
  text: string;
  /** Zero-based, in the whole file, properties included. */
  line: number;
}

export type LinkKind = 'wiki' | 'markdown';

export interface NoteLink {
  kind: LinkKind;
  /** The file it names, as written: `Note`, `folder/Note`, `pic.png`; empty for a link inside the note itself (`[[#Heading]]`). */
  target: string;
  /** What follows `#`: a heading, or `^id` for a block. */
  subpath: string | null;
  /** The text after `|`, or a Markdown link's own text. */
  alias: string | null;
  /** `![[...]]` or `![...](...)`: drawn in place rather than linked to. */
  embed: boolean;
  /** Zero-based line, and where in the text the whole link starts and ends. */
  line: number;
  start: number;
  end: number;
}

export interface NoteFacts {
  properties: NoteProperty[];
  /** The properties block would not parse: Obsidian shows such a note with none, and so does this. */
  propertiesBroken: boolean;
  aliases: string[];
  /** Without `#`, in the case first written; one per tag whatever its case. */
  tags: string[];
  headings: NoteHeading[];
  links: NoteLink[];
  /** `^id` at a line's end, which `[[note#^id]]` points at. */
  blocks: Array<{ id: string; line: number }>;
  words: number;
  /** The zero-based line the body starts on: past the properties when there are any. */
  bodyLine: number;
}

/** How many properties and how much of each a note is read for: a note's header, not a database. */
const PROPERTIES_MAX = 64;
const PROPERTY_LIST_MAX = 64;
const PROPERTY_TEXT_MAX = 2000;
const PROPERTIES_CHARS_MAX = 64 * 1024;

/**
 * The note's leading `---` block and where its body starts. A byte-order mark
 * before it is not the first thing in the file (core/frontmatter.ts learnt
 * that); a block never closed is not a block, as in Obsidian.
 */
export function splitProperties(text: string): { yaml: string | null; body: string; bodyLine: number; bodyStart: number } {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(text.slice(bom));
  if (!open) return { yaml: null, body: text.slice(bom), bodyLine: 0, bodyStart: bom };
  const from = bom + open[0].length;
  const close = /^---[ \t]*(\r?\n|$)/m;
  const rest = text.slice(from);
  // The closing fence at a line's start; an empty block is `---` straight after the opening one.
  const match = close.exec(rest);
  if (!match || (match.index > 0 && rest[match.index - 1] !== '\n')) return { yaml: null, body: text.slice(bom), bodyLine: 0, bodyStart: bom };
  const yaml = rest.slice(0, match.index);
  const bodyStart = from + match.index + match[0].length;
  const bodyLine = text.slice(0, bodyStart).split('\n').length - 1;
  return { yaml, body: text.slice(bodyStart), bodyLine, bodyStart };
}

/** One value as a line of text, a list of them, or as it is when it is already one. Nested maps are written out as JSON, short. */
function propertyValue(value: unknown): PropertyValue {
  const line = (one: unknown): string => {
    const text = typeof one === 'string' ? one : one === null || one === undefined ? '' : typeof one === 'object' ? JSON.stringify(one) ?? '' : String(one);
    return text.length > PROPERTY_TEXT_MAX ? `${text.slice(0, PROPERTY_TEXT_MAX)}…` : text;
  };
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, PROPERTY_LIST_MAX).map(line);
  return line(value);
}

/**
 * The properties, by js-yaml with its core schema: no dates turned into
 * objects (a `created: 2026-10-14` stays the text the person wrote), no
 * JavaScript types. A block larger than a header, or one that will not parse,
 * gives no properties and says so.
 */
export function readProperties(yaml: string | null): { properties: NoteProperty[]; broken: boolean } {
  if (yaml === null || !yaml.trim()) return { properties: [], broken: false };
  if (yaml.length > PROPERTIES_CHARS_MAX) return { properties: [], broken: true };
  let parsed: unknown;
  try {
    parsed = load(yaml, { schema: CORE_SCHEMA, json: true });
  } catch {
    return { properties: [], broken: true };
  }
  if (parsed === null || parsed === undefined) return { properties: [], broken: false };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { properties: [], broken: true };
  const properties = Object.entries(parsed as Record<string, unknown>)
    .slice(0, PROPERTIES_MAX)
    .map(([key, value]) => ({ key, value: propertyValue(value) }));
  return { properties, broken: false };
}

/** A list property that may be written as a list, as one comma-separated line, or as one value. */
function listOf(value: PropertyValue | undefined, split: RegExp): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : String(value).split(split);
  return items.map((one) => one.trim()).filter(Boolean);
}

/**
 * The text with everything that is not prose blanked out, character for
 * character, so that a position found in it is the same position in the note:
 * the properties block, fenced code, inline code, `%% comments %%` and HTML
 * comments. Obsidian draws a link inside any of those as text, and does not
 * count it as a link.
 */
export function proseOnly(text: string, bodyStart = splitProperties(text).bodyStart): string {
  const blank = (part: string) => part.replace(/[^\n]/g, ' ');
  let out = blank(text.slice(0, bodyStart));
  const lines = text.slice(bodyStart).split('\n');
  let fence: { char: string; size: number } | null = null;
  let comment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const sep = i < lines.length - 1 ? '\n' : '';
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      out += blank(line) + sep;
      continue;
    }
    const open = !comment ? /^ {0,3}(`{3,}|~{3,})/.exec(line) : null;
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = { char: open[1][0], size: open[1].length };
      out += blank(line) + sep;
      continue;
    }
    // A `%%` comment may run over lines; inline code is read within a line, which is where it almost always is.
    let kept = '';
    let at = 0;
    while (at < line.length) {
      if (comment) {
        const close = line.indexOf('%%', at);
        if (close < 0) {
          kept += blank(line.slice(at));
          at = line.length;
        } else {
          kept += blank(line.slice(at, close + 2));
          at = close + 2;
          comment = false;
        }
        continue;
      }
      const rest = line.slice(at);
      const tick = /^`+/.exec(rest);
      if (tick) {
        const closeAt = rest.indexOf(tick[0], tick[0].length);
        if (closeAt > 0) {
          kept += blank(rest.slice(0, closeAt + tick[0].length));
          at += closeAt + tick[0].length;
          continue;
        }
        kept += tick[0];
        at += tick[0].length;
        continue;
      }
      if (rest.startsWith('%%')) {
        const close = rest.indexOf('%%', 2);
        if (close < 0) {
          kept += blank(rest);
          at = line.length;
          comment = true;
        } else {
          kept += blank(rest.slice(0, close + 2));
          at += close + 2;
        }
        continue;
      }
      if (rest.startsWith('<!--')) {
        const close = rest.indexOf('-->', 4);
        // An HTML comment left open blanks the rest of its line only: Markdown does not carry it further in prose the way Obsidian's `%%` does.
        const end = close < 0 ? rest.length : close + 3;
        kept += blank(rest.slice(0, end));
        at += end;
        continue;
      }
      kept += line[at];
      at += 1;
    }
    out += kept + sep;
  }
  return out;
}

/** A heading's or an alias's words without the Markdown around them: the text a person reads. */
export function plainText(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target.replace(/#\^?/, ' › '))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|==|~~|\*|_|`)/g, '')
    .trim();
}

const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
// A tag follows nothing or a space; `#` with a space after it is a heading, and a tag must have something in it that is not a digit (Obsidian's rule).
const TAG = /(^|[\s,;(])#([\p{L}\p{N}_/-]+)/gu;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;

/** Split `target#subpath|alias`, the pipe written `\|` inside a table as Obsidian allows. */
export function splitWikiLink(inner: string): { target: string; subpath: string | null; alias: string | null } {
  const pipe = inner.search(/\\?\|/);
  const head = pipe < 0 ? inner : inner.slice(0, inner[pipe] === '\\' ? pipe : pipe);
  const alias = pipe < 0 ? null : inner.slice(pipe + (inner[pipe] === '\\' ? 2 : 1)).trim() || null;
  const hash = head.indexOf('#');
  const target = (hash < 0 ? head : head.slice(0, hash)).trim();
  const subpath = hash < 0 ? null : head.slice(hash + 1).trim() || null;
  return { target, subpath, alias };
}

/** Everything a note says about itself and points at. */
export function parseNote(text: string): NoteFacts {
  const split = splitProperties(text);
  const { properties, broken } = readProperties(split.yaml);
  const prop = (...keys: string[]) => properties.find((one) => keys.includes(one.key.toLowerCase()))?.value;
  const prose = proseOnly(text, split.bodyStart);
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const links: NoteLink[] = [];
  for (const match of prose.matchAll(WIKI)) {
    const start = match.index ?? 0;
    const inner = text.slice(start + match[1].length + 2, start + match[0].length - 2);
    const { target, subpath, alias } = splitWikiLink(inner);
    if (!target && !subpath) continue;
    links.push({ kind: 'wiki', target, subpath, alias, embed: match[1] === '!', line: lineAt(start), start, end: start + match[0].length });
  }
  for (const match of prose.matchAll(MARKDOWN)) {
    const start = match.index ?? 0;
    const raw = text.slice(start, start + match[0].length);
    const parsed = new RegExp(MARKDOWN.source).exec(raw);
    if (!parsed) continue;
    let href = parsed[3];
    if (href.startsWith('<')) href = href.slice(1, -1);
    // Off the machine, or a scheme of its own (obsidian://, mailto:): not a note of this vault.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* A stray `%` that is not an escape names the file as written (core/links.ts learnt it). */
    }
    const hash = decoded.indexOf('#');
    const target = (hash < 0 ? decoded : decoded.slice(0, hash)).trim();
    const subpath = hash < 0 ? null : decoded.slice(hash + 1).trim() || null;
    if (!target && !subpath) continue;
    links.push({ kind: 'markdown', target, subpath, alias: parsed[2] || null, embed: parsed[1] === '!', line: lineAt(start), start, end: start + match[0].length });
  }
  links.sort((a, b) => a.start - b.start);

  const tagSeen = new Map<string, string>();
  const addTag = (tag: string) => {
    const clean = tag.replace(/^#/, '').trim();
    if (!clean || /^[\d/_-]+$/.test(clean)) return;
    const key = foldForMatch(clean);
    if (!tagSeen.has(key)) tagSeen.set(key, clean);
  };
  for (const tag of listOf(prop('tags', 'tag'), /[,\s]+/)) addTag(tag);
  const prosLines = prose.split('\n');
  const headings: NoteHeading[] = [];
  const blocks: Array<{ id: string; line: number }> = [];
  for (let i = split.bodyLine; i < prosLines.length; i += 1) {
    const line = prosLines[i];
    const heading = HEADING.exec(line);
    if (heading) {
      const textLine = text.split('\n', i + 1)[i] ?? '';
      const real = HEADING.exec(textLine);
      headings.push({ level: heading[1].length, text: plainText(real ? real[2] : heading[2]), line: i });
    } else {
      for (const tag of line.matchAll(TAG)) addTag(tag[2]);
    }
    const block = BLOCK_ID.exec(line);
    if (block) blocks.push({ id: block[1], line: i });
  }
  // Tags inside a heading count too, as Obsidian counts them.
  for (const heading of headings) for (const tag of ` ${heading.text}`.matchAll(TAG)) addTag(tag[2]);

  const aliases = listOf(prop('aliases', 'alias'), /,/);
  const words = (split.body.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { properties, propertiesBroken: broken, aliases, tags: [...tagSeen.values()], headings, links, blocks, words, bodyLine: split.bodyLine };
}

/* ------------------------------------------------------------------ */
/* Which file a link means                                             */
/* ------------------------------------------------------------------ */

/** The form two paths or names are compared in: Obsidian's case-blindness, with Turkish `I` folded the way every title here is (core/titles.ts). */
export function pathKey(value: string): string {
  return titleKey(value.normalize('NFC')).replace(/\\/g, '/');
}

export const isNotePath = (path: string) => /\.md$/i.test(path);
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const noteTitle = (path: string) => baseName(path).replace(/\.md$/i, '');
export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `a/b/../c` as `a/c`; null when it climbs out of the vault. */
export function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

export type Resolve = (target: string, from: string, kind?: LinkKind) => string | null;

/**
 * Which file of the vault a link names, from the list of every file in it.
 *
 * As Obsidian reads one: a name alone is a note of that name anywhere in the
 * vault, a name with an extension a file of that name; a path is from the
 * vault's top, then from the linking note's folder, then any file whose path
 * ends so. A Markdown link is from the linking note's folder first, as a
 * browser would read it. Case and Turkish `I` do not matter.
 *
 * Two notes of one name: the one in the linking note's folder, else the one
 * nearest the top, else the first by name. Obsidian keeps its own order for
 * that last case; a link that depends on it is ambiguous in Obsidian too, and
 * Obsidian itself writes a path into such a link.
 */
export function makeResolver(paths: readonly string[]): Resolve {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    byPath.set(pathKey(path), path);
    const names = isNotePath(path) ? [noteTitle(path), baseName(path)] : [baseName(path)];
    for (const name of names) {
      const key = pathKey(name);
      const list = byName.get(key);
      if (list) list.push(path);
      else byName.set(key, [path]);
    }
  }
  const pick = (found: readonly string[], from: string): string => {
    if (found.length === 1) return found[0];
    const here = pathKey(folderOf(from));
    const beside = found.filter((one) => pathKey(folderOf(one)) === here);
    const pool = beside.length ? beside : found;
    return [...pool].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  };
  const exact = (path: string | null): string | null => {
    if (path === null) return null;
    return byPath.get(pathKey(path)) ?? (isNotePath(path) ? null : byPath.get(pathKey(`${path}.md`)) ?? null);
  };
  return (target, from, kind = 'wiki') => {
    const wanted = target.trim().replace(/\\/g, '/');
    if (!wanted) return null;
    if (wanted.includes('/') || kind === 'markdown') {
      const fromRoot = exact(normalisePath(wanted));
      const fromHere = exact(normalisePath(`${folderOf(from)}/${wanted}`));
      const found = kind === 'markdown' ? fromHere ?? fromRoot : fromRoot ?? fromHere;
      if (found) return found;
      if (!wanted.includes('/')) {
        const named = byName.get(pathKey(wanted));
        return named?.length ? pick(named, from) : null;
      }
      const tail = pathKey(`/${wanted.replace(/^\/+/, '')}`);
      const ends = paths.filter((path) => {
        const key = pathKey(`/${path}`);
        return key.endsWith(tail) || (isNotePath(path) && !isNotePath(wanted) && key.endsWith(`${tail}.md`));
      });
      return ends.length ? pick(ends, from) : null;
    }
    // A name: the note of that name first, so `[[v1.2]]` is the note before a file called `v1.2`.
    const notes = (byName.get(pathKey(wanted)) ?? []).filter((path) => isNotePath(path) && (pathKey(noteTitle(path)) === pathKey(wanted) || pathKey(baseName(path)) === pathKey(wanted)));
    if (notes.length) return pick(notes, from);
    const files = (byName.get(pathKey(wanted)) ?? []).filter((path) => pathKey(baseName(path)) === pathKey(wanted));
    return files.length ? pick(files, from) : null;
  };
}

/**
 * The shortest way to write a link to `path` that still finds it: the note's
 * name alone when no other file of the vault answers to it, else the path
 * without `.md`. Obsidian's own default, "shortest path when possible".
 */
export function shortestLink(path: string, paths: readonly string[], resolve: Resolve = makeResolver(paths)): string {
  const name = isNotePath(path) ? noteTitle(path) : baseName(path);
  const clash = paths.some((other) => other !== path && (pathKey(noteTitle(other)) === pathKey(name) || pathKey(baseName(other)) === pathKey(name)));
  if (!clash && resolve(name, '') === path) return name;
  return isNotePath(path) ? path.replace(/\.md$/i, '') : path;
}

/* ------------------------------------------------------------------ */
/* A move or a rename                                                  */
/* ------------------------------------------------------------------ */

/** A Markdown link's path from one note's folder to a file, `%20` for a space as Obsidian writes it. */
export function relativeHref(from: string, to: string): string {
  const fromParts = folderOf(from).split('/').filter(Boolean);
  const toParts = to.split('/');
  let same = 0;
  while (same < fromParts.length && same < toParts.length - 1 && pathKey(fromParts[same]) === pathKey(toParts[same])) same += 1;
  const up = fromParts.slice(same).map(() => '..');
  return [...up, ...toParts.slice(same)].map((part) => encodeURIComponent(part).replace(/%2F/g, '/')).join('/');
}

/**
 * The note's text after files of the vault moved or were renamed, with every
 * link that would no longer find its file pointed at where the file went, and
 * nothing else changed: the heading, the block and the alias of each link kept,
 * a wiki link written in the shortest form that finds the new place, a Markdown
 * link as a path from the linking note.
 *
 * A link is rewritten only when it has to be - when, in the vault as it is now,
 * it would find another file or none - so that a move into another folder
 * leaves `[[Name]]` alone, as it still finds the note, and a person's own way
 * of writing their links is not churned. The linking note may have moved
 * itself (`at.was`, `at.now`): its Markdown links, written from its folder,
 * are read from where it was and written from where it is.
 *
 * A Markdown link is kept only while its path, read from the note's folder or
 * from the top, names the file exactly: the resolver would still find one by
 * its ending, as Obsidian would, but anything else that reads the file - a
 * browser, GitHub - would not. A wiki link that cannot be written in a form
 * that finds the file (a note at the top whose name a note beside the linking
 * one now has) is left as it was and counted in `lost`, for the screen to say.
 */
export function relink(
  text: string,
  at: { was: string; now: string },
  before: Resolve,
  after: Resolve,
  movedTo: (path: string) => string,
  paths: readonly string[],
): { text: string; changed: number; lost: number } {
  const facts = parseNote(text);
  let out = '';
  let from = 0;
  let changed = 0;
  let lost = 0;
  // Whether a Markdown link's path, read from a folder or from the top, is exactly the file.
  const names = (target: string, folder: string, file: string) =>
    [`${folder}/${target}`, target].some((candidate) => {
      const path = normalisePath(candidate);
      return path !== null && (pathKey(path) === pathKey(file) || pathKey(`${path}.md`) === pathKey(file));
    });
  for (const link of facts.links) {
    if (!link.target) continue;
    const found = before(link.target, at.was, link.kind);
    if (!found) continue;
    const goes = movedTo(found);
    if (link.kind === 'wiki' ? after(link.target, at.now, 'wiki') === goes : names(link.target, folderOf(at.now), goes)) continue;
    const sub = link.subpath ? `#${link.subpath}` : '';
    let written: string;
    if (link.kind === 'wiki') {
      const target = shortestLink(goes, paths, after);
      if (after(target, at.now, 'wiki') !== goes) {
        lost += 1;
        continue;
      }
      const original = text.slice(link.start, link.end);
      const pipe = original.includes('\\|') ? '\\|' : '|';
      written = `${link.embed ? '!' : ''}[[${target}${sub}${link.alias !== null ? `${pipe}${link.alias}` : ''}]]`;
    } else {
      const href = relativeHref(at.now, goes) + (link.subpath ? `#${encodeURIComponent(link.subpath)}` : '');
      written = `${link.embed ? '!' : ''}[${link.alias ?? ''}](${href})`;
    }
    out += text.slice(from, link.start) + written;
    from = link.end;
    changed += 1;
  }
  return { text: out + text.slice(from), changed, lost };
}

/**
 * Where everything moving lands: a file moved or renamed, or a folder and all
 * under it. A path not moving lands where it is.
 */
export function landingOf(moves: ReadonlyArray<{ from: string; to: string }>): (path: string) => string {
  return (path) => {
    for (const { from, to } of moves) {
      if (path === from) return to;
      if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
    }
    return path;
  };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export type NameProblem = 'empty' | 'characters' | 'dot' | 'reserved' | 'long';

/**
 * Why a note's or a folder's name will not do, or null. Refused: what Windows
 * will not take in a file name, what breaks a wiki link (`# ^ [ ] |`), a
 * leading dot (a hidden file, which the vault's reader never shows), a
 * trailing dot or space (Windows drops it), and the device names Windows keeps.
 */
export function nameProblem(name: string): NameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > 180) return 'long';
  if (/[\\/:*?"<>|#^[\]\u0000-\u001f]/.test(trimmed)) return 'characters';
  if (trimmed.startsWith('.') || /[. ]$/.test(name)) return 'dot';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(trimmed)) return 'reserved';
  return null;
}

/** `base`, else `base 1`, `base 2`: the first not taken, compared as the vault compares names. */
export function freeName(base: string, taken: Iterable<string>): string {
  const keys = new Set([...taken].map(pathKey));
  if (!keys.has(pathKey(base))) return base;
  for (let n = 1; ; n += 1) if (!keys.has(pathKey(`${base} ${n}`))) return `${base} ${n}`;
}

/* ------------------------------------------------------------------ */
/* Search and the quick switcher                                       */
/* ------------------------------------------------------------------ */

export interface SearchQuery {
  /** Words and quoted phrases, each of which a note must hold somewhere. */
  terms: string[];
  /** `tag:x`, `#x`: a tag the note carries, or one under it (`#a` finds `#a/b`). */
  tags: string[];
  /** `path:x`: where the note is, part of its path. */
  paths: string[];
}

/** A query as Obsidian's search box takes the common part of one: words, `"phrases"`, `tag:`, `#tag`, `path:`. */
export function parseQuery(query: string): SearchQuery {
  const out: SearchQuery = { terms: [], tags: [], paths: [] };
  for (const match of query.normalize('NFC').matchAll(/(tag:|path:|file:)?(?:"([^"]*)"|(\S+))/gi)) {
    const prefix = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? match[3] ?? '').trim();
    if (!value) continue;
    if (prefix === 'tag:' || (!prefix && match[3]?.startsWith('#') && value.length > 1)) out.tags.push(foldForMatch(value.replace(/^#/, '')));
    else if (prefix === 'path:' || prefix === 'file:') out.paths.push(foldForMatch(value));
    else out.terms.push(foldForMatch(value));
  }
  return out;
}

export const emptyQuery = (query: SearchQuery) => !query.terms.length && !query.tags.length && !query.paths.length;

export interface SearchHit {
  path: string;
  score: number;
  /** Up to `SNIPPETS` lines that hold a term, each cut to a window around the first, with where the terms are in it. */
  lines: Array<{ line: number; text: string; marks: Array<[number, number]> }>;
  /** How many times the terms occur in the body. */
  count: number;
}

const SNIPPETS = 3;
const SNIPPET_WIDTH = 160;

/**
 * Whether a note matches the query, and how well: every term somewhere in its
 * title, path, aliases or body, every tag on it, every path part in its path.
 * A term in the title is worth more than any number in the body; the lines
 * shown are the first that hold one.
 */
export function searchNote(path: string, text: string, facts: Pick<NoteFacts, 'tags' | 'aliases'>, query: SearchQuery): SearchHit | null {
  if (emptyQuery(query)) return null;
  const foldedPath = foldForMatch(path.normalize('NFC'));
  for (const part of query.paths) if (!foldedPath.includes(part)) return null;
  const tags = facts.tags.map((tag) => foldForMatch(tag));
  for (const tag of query.tags) if (!tags.some((one) => one === tag || one.startsWith(`${tag}/`))) return null;
  const title = foldForMatch(noteTitle(path).normalize('NFC'));
  const aliases = facts.aliases.map((one) => foldForMatch(one));
  const folded = foldForMatch(text);
  let score = query.tags.length + query.paths.length;
  let count = 0;
  for (const term of query.terms) {
    const inTitle = title.includes(term);
    const inAlias = aliases.some((one) => one.includes(term));
    let n = 0;
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) n += 1;
    if (!inTitle && !inAlias && !n && !foldedPath.includes(term)) return null;
    score += (inTitle ? 100 + (title === term ? 100 : title.startsWith(term) ? 30 : 0) : 0) + (inAlias ? 60 : 0) + Math.min(n, 20);
    count += n;
  }
  const lines: SearchHit['lines'] = [];
  if (query.terms.length) {
    const textLines = text.split('\n');
    const foldedLines = folded.split('\n');
    for (let i = 0; i < foldedLines.length && lines.length < SNIPPETS; i += 1) {
      const line = foldedLines[i];
      const firsts = query.terms.map((term) => line.indexOf(term)).filter((at) => at >= 0);
      if (!firsts.length) continue;
      const first = Math.min(...firsts);
      const from = Math.max(0, Math.min(first - 40, line.length - SNIPPET_WIDTH));
      const to = Math.min(line.length, from + SNIPPET_WIDTH);
      const window = line.slice(from, to);
      const marks: Array<[number, number]> = [];
      for (const term of query.terms) {
        for (let at = window.indexOf(term); at >= 0; at = window.indexOf(term, at + term.length)) marks.push([at, at + term.length]);
      }
      marks.sort((a, b) => a[0] - b[0]);
      const original = textLines[i].slice(from, to);
      lines.push({ line: i, text: `${from > 0 ? '…' : ''}${original}${to < line.length ? '…' : ''}`, marks: marks.map(([a, b]) => [a + (from > 0 ? 1 : 0), b + (from > 0 ? 1 : 0)]) });
    }
  }
  return { path, score, lines, count };
}

/**
 * Whether the letters of `query` appear in `text` in order, and how well: a
 * run of them, the start of a word, the start of the text all count for more,
 * a gap for less. The quick switcher's ranking; `indices` are what it bolds.
 */
export function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const q = foldForMatch(query.normalize('NFC')).replace(/\s+/g, ' ').trim();
  if (!q) return { score: 0, indices: [] };
  const t = foldForMatch(text.normalize('NFC'));
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s/_\-.(]/.test(t[at - 1]);
    return { score: 1000 - at - (t.length - q.length) * 0.5 + (wordStart ? 200 : 0) + (at === 0 ? 100 : 0), indices: Array.from(q, (_c, i) => at + i) };
  }
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let last = -2;
  for (const char of q) {
    if (char === ' ') continue;
    // Prefer the next word that starts with this letter, if it comes before the run would break badly.
    let found = -1;
    for (let i = from; i < t.length; i += 1) {
      if (t[i] !== char) continue;
      if (found < 0) found = i;
      const startsWord = i === 0 || /[\s/_\-.(]/.test(t[i - 1]);
      if (i === last + 1 || startsWord) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const startsWord = found === 0 || /[\s/_\-.(]/.test(t[found - 1]);
    score += found === last + 1 ? 15 : startsWord ? 10 : 1;
    score -= Math.min(found - from, 10) * 0.5;
    indices.push(found);
    last = found;
    from = found + 1;
  }
  return { score: score - t.length * 0.05, indices };
}

/* ------------------------------------------------------------------ */
/* The graph                                                           */
/* ------------------------------------------------------------------ */

/** What the window is told of each note, enough for the tree, the switcher, the tags and the graph. */
export interface IndexedNote {
  path: string;
  modified: number;
  size: number;
  aliases: string[];
  tags: string[];
  /** The files it links to that are there, each once. */
  links: string[];
  /** The names it links to that no file answers to, each once, as written. */
  unresolved: string[];
  /** Too large to read: listed, not opened. */
  tooLarge?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: 'note' | 'file' | 'missing' | 'tag';
  /** How many links touch it, which the drawing sizes it by. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphOptions {
  /** Around one note only, this many links away; the whole vault when null. */
  around: string | null;
  depth: number;
  /** Notes and files no link touches. */
  orphans: boolean;
  /** Names linked to that are not there, drawn as notes waiting to be written. */
  missing: boolean;
  /** Tags as points of their own, each note joined to its own. */
  tags: boolean;
  /** Attachments linked from notes. */
  files: boolean;
}

/** The graph of the vault, or of the part of it around one note, from the index alone. */
export function vaultGraph(notes: readonly IndexedNote[], files: readonly string[], options: GraphOptions): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const notePaths = new Set(notes.map((note) => note.path));
  const node = (id: string, label: string, kind: GraphNode['kind']) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind, degree: 0 });
    return nodes.get(id)!;
  };
  const edge = (a: string, b: string) => {
    if (a === b) return;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source: a, target: b });
  };
  for (const note of notes) {
    node(note.path, noteTitle(note.path), 'note');
    for (const to of note.links) {
      if (notePaths.has(to)) {
        node(to, noteTitle(to), 'note');
        edge(note.path, to);
      } else if (options.files) {
        node(to, baseName(to), 'file');
        edge(note.path, to);
      }
    }
    if (options.missing) {
      for (const name of note.unresolved) {
        const id = `missing:${pathKey(name)}`;
        node(id, name, 'missing');
        edge(note.path, id);
      }
    }
    if (options.tags) {
      for (const tag of note.tags) {
        const id = `tag:${foldForMatch(tag)}`;
        node(id, `#${tag}`, 'tag');
        edge(note.path, id);
      }
    }
  }
  if (options.files) for (const file of files) if (!isNotePath(file) && options.orphans) node(file, baseName(file), 'file');
  for (const one of edges) {
    nodes.get(one.source)!.degree += 1;
    nodes.get(one.target)!.degree += 1;
  }
  let keep: Set<string>;
  if (options.around && nodes.has(options.around)) {
    const near = new Map<string, Set<string>>();
    for (const one of edges) {
      if (!near.has(one.source)) near.set(one.source, new Set());
      if (!near.has(one.target)) near.set(one.target, new Set());
      near.get(one.source)!.add(one.target);
      near.get(one.target)!.add(one.source);
    }
    keep = new Set([options.around]);
    let ring = [options.around];
    for (let step = 0; step < Math.max(1, options.depth); step += 1) {
      const next: string[] = [];
      for (const id of ring) for (const other of near.get(id) ?? []) if (!keep.has(other)) {
        keep.add(other);
        next.push(other);
      }
      ring = next;
    }
  } else {
    keep = new Set([...nodes.values()].filter((one) => options.orphans || one.degree > 0).map((one) => one.id));
  }
  return {
    nodes: [...nodes.values()].filter((one) => keep.has(one.id)),
    edges: edges.filter((one) => keep.has(one.source) && keep.has(one.target)),
  };
}

/* ------------------------------------------------------------------ */
/* Templates and new notes, in Cortex's way                            */
/* ------------------------------------------------------------------ */

/**
 * Whether a folder holds templates: Cortex's `📋 Templates`, Obsidian's
 * `Templates`, or any folder whose name ends so once a leading emoji is set
 * aside.
 */
export function isTemplatesFolder(path: string): boolean {
  return /(^|[^\p{L}\p{N}])templates$/iu.test(baseName(path).normalize('NFC'));
}

/** Where a quick note goes in a Cortex vault: its inbox's dump, else its inbox, else the top (Cortex's own CLAUDE.md routes raw capture so). */
export function captureFolder(folders: readonly string[]): string {
  const inbox = folders.find((folder) => !folder.includes('/') && /(^|\s)000-Inbox$/.test(folder.normalize('NFC')));
  if (!inbox) return '';
  return folders.includes(`${inbox}/Dump`) ? `${inbox}/Dump` : inbox;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayOf = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const timeOf = (now: Date) => `${pad(now.getHours())}:${pad(now.getMinutes())}`;

/** `{{date:YYYY-MM-DD HH:mm}}`'s tokens, the ones Obsidian's templates are written with; anything else in the format stays as written. */
function formatDate(now: Date, format: string): string {
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) =>
    token === 'YYYY' ? String(now.getFullYear()) : token === 'MM' ? pad(now.getMonth() + 1) : token === 'DD' ? pad(now.getDate()) : token === 'HH' ? pad(now.getHours()) : token === 'mm' ? pad(now.getMinutes()) : pad(now.getSeconds()),
  );
}

/**
 * A template's text with its placeholders filled: Cortex's `{{TODAY}}`, and
 * Obsidian's `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}` and
 * `{{title}}`. Cortex's own template leaves `title:` and the first heading
 * empty for the note's name; they are given it.
 */
export function fillTemplate(template: string, title: string, now: Date): string {
  const filled = template
    .replace(/\{\{\s*TODAY\s*\}\}/g, dayOf(now))
    .replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/g, (_match, format: string) => formatDate(now, format))
    .replace(/\{\{\s*time\s*:\s*([^}]+?)\s*\}\}/g, (_match, format: string) => formatDate(now, format))
    .replace(/\{\{\s*date\s*\}\}/g, dayOf(now))
    .replace(/\{\{\s*time\s*\}\}/g, timeOf(now))
    .replace(/\{\{\s*title\s*\}\}/g, title);
  const split = splitProperties(filled);
  const head = split.yaml === null ? '' : filled.slice(0, split.bodyStart).replace(/^title:[ \t]*$/m, `title: ${JSON.stringify(title)}`);
  return head + split.body.replace(/^#[ \t]*$/m, `# ${title}`);
}

/**
 * A template put into a note at the cursor, as Obsidian's Templates puts one:
 * its properties go to the top when the note has none, and are left out when
 * it has its own (one note, one block); the rest goes where the cursor is.
 * Answers the text and where the cursor lands, after what was put in.
 */
export function insertTemplate(note: string, cursor: number, template: string): { text: string; cursor: number } {
  const own = splitProperties(note);
  const added = splitProperties(template);
  const body = added.body;
  if (added.yaml === null || own.yaml !== null) {
    const at = Math.max(cursor, own.bodyStart);
    return { text: note.slice(0, at) + body + note.slice(at), cursor: at + body.length };
  }
  const head = template.slice(0, added.bodyStart);
  const at = cursor + head.length;
  const text = head + note.slice(0, cursor) + body + note.slice(cursor);
  return { text, cursor: at + body.length };
}

/**
 * A renamed note's own name where it repeats it: a `title:` property that was
 * the old name or empty, and a first heading that was the old name. Cortex's
 * notes carry their title so; Obsidian's rename would leave them saying the
 * old one.
 */
export function retitle(text: string, was: string, now: string): string {
  const split = splitProperties(text);
  let head = text.slice(0, split.bodyStart);
  if (split.yaml !== null) {
    head = head.replace(/^title:[ \t]*(.*)$/m, (line, value: string) => {
      const plain = value.trim().replace(/^(["'])(.*)\1$/, '$2');
      return plain === '' || plain === was ? `title: ${JSON.stringify(now)}` : line;
    });
  }
  const body = split.body.replace(/^#[ \t]+(.+?)[ \t]*$/m, (line, heading: string) => (heading === was ? `# ${now}` : line));
  return head + body;
}

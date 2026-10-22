import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bug,
  Check,
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Flame,
  ImageOff,
  Info,
  List,
  Pencil,
  Quote,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { baseName, noteTitle, parseNote, pathKey, splitProperties, type NoteProperty } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { useApp } from '../store/app';
import { messageOf } from '@shared/ipcError';
import { labelOf, useNotes } from './notesStore';
import { remarkObsidian } from './remarkObsidian';
import { imageOf, noteTextOf } from './vaultCache';
import { peekLeave, peekSoon } from './peek';

/**
 * A note drawn for reading, as Obsidian draws it (core/vaultNotes.ts reads it
 * in Obsidian's terms; remarkObsidian.ts carries those into the tree): its
 * properties above it, wiki links that open the note they name or make the
 * one not yet written, `![[embeds]]` drawn in place, tags that search, the
 * callouts, and tasks that tick in the file.
 *
 * An image is drawn only from the vault, through the main process, as a data
 * URL. One on the web is shown as a link and not loaded: the window loads no
 * image from the network (index.html says why), and a note is a page anybody
 * may have pasted into.
 */

/** How deep an embed draws the notes it embeds: Obsidian stops a note that embeds itself the same way. */
const EMBED_DEPTH = 3;

interface Context {
  path: string;
  depth: number;
  onToggleTask?: (line: number) => void;
}

const NoteContext = createContext<Context>({ path: '', depth: 0 });
const LineContext = createContext<number | null>(null);

/** The wiki link's target when written as a name or a path, the way the link would be read. */
function useTarget(target: string, kind: 'wiki' | 'markdown' = 'wiki'): string | null {
  const { path } = useContext(NoteContext);
  const resolve = useNotes((state) => state.resolve);
  return target ? resolve(target, path, kind) : path;
}

const openOptions = (event: { ctrlKey: boolean; metaKey: boolean; button: number }) => ({ newTab: event.ctrlKey || event.metaKey || event.button === 1 });

function WikiLink({ target, subpath, alias }: { target: string; subpath: string; alias: string }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const to = useTarget(target);
  // A link to a receipt reads as its event_id, not as the hash its file is named by.
  const label = useNotes((state) => (to ? state.labels.get(to) : undefined));
  const shown = alias || (label ?? (target ? target.replace(/\.md$/i, '') : '')) + (subpath ? `${target ? ' › ' : ''}${subpath.replace(/^\^/, '')}` : '');
  const open = (event: React.MouseEvent) => {
    event.preventDefault();
    if (to) {
      useNotes.getState().open(to, { ...openOptions(event), subpath: subpath || null });
      return;
    }
    // Not written yet: made at the vault's top under the name the link gives it, as Obsidian makes it, and opened to be written.
    const name = baseName(target).replace(/\.md$/i, '');
    window.cortex.notes.create('', name, { text: '' }).then(
      async (made) => {
        await useNotes.getState().refresh();
        useNotes.getState().open(made.path, { edit: true });
      },
      (err) => toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) }),
    );
  };
  return (
    <a
      href="#"
      className="kg-wikilink"
      data-missing={to ? undefined : ''}
      data-note-link={target}
      data-note-path={to ?? undefined}
      title={to ? undefined : t('notes.link.missing', { name: target })}
      onClick={open}
      onAuxClick={open}
      onMouseEnter={(event) => to && /\.md$/i.test(to) && peekSoon(to, subpath || null, event.currentTarget.getBoundingClientRect())}
      onMouseLeave={peekLeave}
    >
      {shown}
    </a>
  );
}

function TagLink({ tag }: { tag: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="kg-tag"
      data-note-tag={tag}
      onClick={() => useNotes.getState().search(`tag:#${tag}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') useNotes.getState().search(`tag:#${tag}`);
      }}
    >
      #{tag}
    </span>
  );
}

/** `|300` or `|300x200` after an image's name is its size, as Obsidian reads it. */
function sizeOf(alias: string): { width?: number; height?: number } {
  const match = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(alias.trim());
  return match ? { width: Number(match[1]), height: match[2] ? Number(match[2]) : undefined } : {};
}

function VaultImage({ path, alt, size }: { path: string; alt: string; size?: { width?: number; height?: number } }) {
  const t = useT();
  const modified = useNotes((state) => state.index?.files.find((file) => file.path === path)?.modified ?? 0);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void imageOf(path, modified).then((got) => live && setUrl(got));
    return () => {
      live = false;
    };
  }, [path, modified]);
  if (url === undefined) return <span className="inline-block h-24 w-40 animate-pulse rounded-lg bg-zinc-50" aria-hidden="true" />;
  if (url === null)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-50 px-2 py-1 text-[12px] text-zinc-500">
        <ImageOff size={13} />
        {t('notes.image.none', { name: baseName(path) })}
      </span>
    );
  return <img src={url} alt={alt} width={size?.width} height={size?.height} data-note-image={path} />;
}

/** Lines `from` up to `to` of a note: a heading's section, or a block's paragraph, for an embed that names one. */
export function sectionOf(text: string, subpath: string | null): { source: string; offset: number } | null {
  const facts = parseNote(text);
  const lines = text.split('\n');
  if (!subpath) return { source: lines.slice(facts.bodyLine).join('\n'), offset: facts.bodyLine };
  if (subpath.startsWith('^')) {
    const block = facts.blocks.find((one) => one.id === subpath.slice(1));
    if (!block) return null;
    let from = block.line;
    while (from > facts.bodyLine && lines[from - 1].trim() !== '' && !/^\s*([-*+]|\d+\.)\s/.test(lines[from])) from -= 1;
    return { source: lines.slice(from, block.line + 1).join('\n').replace(/\s\^[A-Za-z0-9-]+\s*$/, ''), offset: from };
  }
  // Folded as a link's click finds the heading (NotePane.tsx, `lineOfSubpath`): `Işık` is `ışık` in any locale (core/titles.ts).
  const wanted = pathKey(subpath.split('#').pop()!);
  const at = facts.headings.findIndex((one) => pathKey(one.text) === wanted);
  if (at < 0) return null;
  const heading = facts.headings[at];
  const next = facts.headings.slice(at + 1).find((one) => one.level <= heading.level);
  return { source: lines.slice(heading.line, next ? next.line : lines.length).join('\n'), offset: heading.line };
}

function NoteEmbed({ target, subpath }: { target: string; subpath: string }) {
  const t = useT();
  const { depth, path: from } = useContext(NoteContext);
  const to = useTarget(target);
  const modified = useNotes((state) => (to ? state.index?.notes.find((note) => note.path === to)?.modified ?? 0 : 0));
  const revision = useNotes((state) => state.revision);
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!to || !/\.md$/i.test(to)) return;
    let live = true;
    void noteTextOf(to, modified).then((read) => live && setText(read?.text ?? null));
    return () => {
      live = false;
    };
  }, [to, modified, revision]);
  if (!to) return <WikiLink target={target} subpath={subpath} alias="" />;
  if (!/\.md$/i.test(to)) {
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(to)) return <VaultImage path={to} alt={noteTitle(to)} />;
    return <WikiLink target={target} subpath={subpath} alias="" />;
  }
  if (depth >= EMBED_DEPTH || to === from) return <WikiLink target={target} subpath={subpath} alias="" />;
  const section = text ? sectionOf(text, subpath || null) : null;
  return (
    <div className="kg-embed" data-note-embed={to}>
      <button
        type="button"
        className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-darkDelegation"
        onClick={(event) => useNotes.getState().open(to, { ...openOptions(event), subpath: subpath || null })}
      >
        {labelOf(to)}
        {subpath ? ` › ${subpath.replace(/^\^/, '')}` : ''}
      </button>
      {text === undefined ? (
        <div className="h-10 animate-pulse rounded bg-zinc-50" />
      ) : text === null || !section ? (
        <p className="text-[13px] text-zinc-500">{t('notes.embed.none')}</p>
      ) : (
        <NoteMarkdown path={to} source={section.source} offset={section.offset} depth={depth + 1} />
      )}
    </div>
  );
}

const CALLOUT_KINDS: Record<string, { kind: string; icon: LucideIcon; label: Key }> = {};
const calloutKinds: Array<[string[], string, LucideIcon, Key]> = [
  [['note'], 'note', Pencil, 'notes.callout.note'],
  [['abstract', 'summary', 'tldr'], 'info', ClipboardList, 'notes.callout.abstract'],
  [['info'], 'info', Info, 'notes.callout.info'],
  [['todo'], 'todo', CircleCheck, 'notes.callout.todo'],
  [['tip', 'hint', 'important'], 'tip', Flame, 'notes.callout.tip'],
  [['success', 'check', 'done'], 'success', Check, 'notes.callout.success'],
  [['question', 'help', 'faq'], 'question', CircleHelp, 'notes.callout.question'],
  [['warning', 'caution', 'attention'], 'warning', TriangleAlert, 'notes.callout.warning'],
  [['failure', 'fail', 'missing'], 'failure', X, 'notes.callout.failure'],
  [['danger', 'error'], 'danger', Zap, 'notes.callout.danger'],
  [['bug'], 'bug', Bug, 'notes.callout.bug'],
  [['example'], 'example', List, 'notes.callout.example'],
  [['quote', 'cite'], 'quote', Quote, 'notes.callout.quote'],
];
for (const [names, kind, icon, label] of calloutKinds) for (const name of names) CALLOUT_KINDS[name] = { kind, icon, label };

function Callout({ type, fold, title, children, line }: { type: string; fold: string; title: string; children: ReactNode; line?: unknown }) {
  const t = useT();
  const known = CALLOUT_KINDS[type] ?? CALLOUT_KINDS.note;
  const Icon = known.icon;
  const heading = title || (CALLOUT_KINDS[type] ? t(known.label) : type.charAt(0).toUpperCase() + type.slice(1));
  const head = (
    <>
      <Icon size={15} strokeWidth={2.2} />
      <span>{heading}</span>
    </>
  );
  if (fold === '-' || fold === '+')
    return (
      <details data-callout={type} data-callout-kind={known.kind} data-line={line as number} open={fold === '+'}>
        <summary>{head}</summary>
        {children}
      </details>
    );
  return (
    <div data-callout={type} data-callout-kind={known.kind} data-line={line as number}>
      <div className="kg-callout-title">{head}</div>
      {children}
    </div>
  );
}

/** What react-markdown hands a component: the element's attributes, `data-` ones among them, its children and its hast node. */
type Given = Record<string, unknown> & { node?: unknown; children?: ReactNode };
const text = (props: Given, key: string) => (typeof props[key] === 'string' ? (props[key] as string) : '');
const without = ({ node: _node, ...rest }: Given) => rest as Record<string, unknown>;

function TaskBox(props: Given) {
  const { onToggleTask } = useContext(NoteContext);
  const line = useContext(LineContext);
  if (props.type !== 'checkbox') return <input {...(without(props) as ComponentProps<'input'>)} />;
  const toggle = onToggleTask && line !== null ? () => onToggleTask(line) : undefined;
  return <input type="checkbox" checked={Boolean(props.checked)} disabled={!toggle} onChange={toggle ?? (() => undefined)} data-task-line={line ?? undefined} />;
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

const components = {
  span: (props: Given) => {
    if (typeof props['data-wiki'] === 'string') {
      const [target, subpath, alias] = [text(props, 'data-wiki'), text(props, 'data-subpath'), text(props, 'data-alias')];
      if (props['data-embed']) return IMAGE_NAME.test(target) ? <EmbeddedImage target={target} alias={alias} /> : <NoteEmbed target={target} subpath={subpath} />;
      return <WikiLink target={target} subpath={subpath} alias={alias} />;
    }
    if (typeof props['data-tag'] === 'string') return <TagLink tag={text(props, 'data-tag')} />;
    return <span {...(without(props) as ComponentProps<'span'>)} />;
  },
  div: (props: Given) => {
    if (typeof props['data-wiki'] === 'string') {
      const target = text(props, 'data-wiki');
      return IMAGE_NAME.test(target) ? <EmbeddedImage target={target} alias={text(props, 'data-alias')} /> : <NoteEmbed target={target} subpath={text(props, 'data-subpath')} />;
    }
    if (typeof props['data-callout'] === 'string')
      return (
        <Callout type={text(props, 'data-callout')} fold={text(props, 'data-callout-fold')} title={text(props, 'data-callout-title')} line={props['data-line']}>
          {props.children}
        </Callout>
      );
    return <div {...(without(props) as ComponentProps<'div'>)} />;
  },
  a: (props: Given) => (
    <MarkdownLink href={text(props, 'href')} title={text(props, 'title')}>
      {props.children}
    </MarkdownLink>
  ),
  img: (props: Given) => <MarkdownImage src={text(props, 'src')} alt={text(props, 'alt')} />,
  li: (props: Given) => {
    const line = typeof props['data-line'] === 'number' ? (props['data-line'] as number) : null;
    const { children, ...rest } = without(props) as ComponentProps<'li'>;
    return (
      <li {...rest}>
        <LineContext.Provider value={line}>{children}</LineContext.Provider>
      </li>
    );
  },
  input: (props: Given) => <TaskBox {...props} />,
} as Components;

function EmbeddedImage({ target, alias }: { target: string; alias: string }) {
  const to = useTarget(target);
  if (!to) return <WikiLink target={target} subpath="" alias="" />;
  return <VaultImage path={to} alt={noteTitle(to)} size={sizeOf(alias)} />;
}

const external = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function MarkdownLink({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  let target = href;
  try {
    target = decodeURIComponent(href);
  } catch {
    /* the link as written */
  }
  const [file, subpath] = target.split('#');
  const to = useTarget(file, 'markdown');
  if (external(href)) {
    // To the system's browser (electron/main.ts sends a new window there), and only for the web.
    return /^https?:/i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer" title={title || href}>
        {children}
      </a>
    ) : (
      <span title={href}>{children}</span>
    );
  }
  return (
    <a
      href="#"
      className="kg-wikilink"
      data-missing={to ? undefined : ''}
      data-note-path={to ?? undefined}
      onClick={(event) => {
        event.preventDefault();
        if (to) useNotes.getState().open(to, { ...openOptions(event), subpath: subpath || null });
      }}
    >
      {children}
    </a>
  );
}

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  let target = src;
  try {
    target = decodeURIComponent(src);
  } catch {
    /* as written */
  }
  const to = useTarget(target.split('#')[0], 'markdown');
  if (external(src)) {
    let host = src;
    try {
      host = new URL(src).host;
    } catch {
      /* shown whole */
    }
    return (
      <a href={/^https?:/i.test(src) ? src : undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-zinc-50 px-2 py-1 text-[12px] text-zinc-500 no-underline" title={t('notes.image.web')}>
        <ImageOff size={13} />
        {alt || host}
      </a>
    );
  }
  if (!to) return <span className="text-[12px] text-zinc-400">{t('notes.image.none', { name: target })}</span>;
  return <VaultImage path={to} alt={alt} />;
}

/** The body of a note, or a part of it, drawn; `offset` is the line it starts on in the file. */
export function NoteMarkdown({
  path,
  source,
  offset,
  depth = 0,
  onToggleTask,
}: {
  path: string;
  source: string;
  offset: number;
  depth?: number;
  onToggleTask?: (line: number) => void;
}) {
  const context = useMemo(() => ({ path, depth, onToggleTask }), [path, depth, onToggleTask]);
  const plugins = useMemo(() => [remarkGfm, [remarkObsidian, { offset }]] as NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>, [offset]);
  return (
    <NoteContext.Provider value={context}>
      <div className="kg-note">
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {source}
        </ReactMarkdown>
      </div>
    </NoteContext.Provider>
  );
}

const isUrl = (value: string) => /^https?:\/\/\S+$/i.test(value);

function PropertyValueView({ property }: { property: NoteProperty }) {
  const value = property.value;
  const key = property.key.toLowerCase();
  if (value === null || value === '') return <span className="text-zinc-300">—</span>;
  if (typeof value === 'boolean') return <input type="checkbox" checked={value} disabled className="accent-[var(--color-accent)]" />;
  const items = Array.isArray(value) ? value : [String(value)];
  if (key === 'tags' || key === 'tag')
    return (
      <span className="flex flex-wrap gap-1">
        {items.flatMap((one) => one.split(/[,\s]+/)).filter(Boolean).map((tag) => (
          <TagLink key={tag} tag={tag.replace(/^#/, '')} />
        ))}
      </span>
    );
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {items.map((one, at) => {
        const wiki = /^\[\[([^\]]+)\]\]$/.exec(one.trim());
        if (wiki) {
          const [target, rest] = wiki[1].split('|');
          const [name, subpath] = target.split('#');
          return <WikiLink key={at} target={name} subpath={subpath ?? ''} alias={rest ?? ''} />;
        }
        if (isUrl(one))
          return (
            <a key={at} href={one} target="_blank" rel="noreferrer">
              {one}
            </a>
          );
        return (
          <span key={at} className={Array.isArray(value) ? 'rounded-md bg-zinc-50 px-1.5' : ''}>
            {one}
          </span>
        );
      })}
    </span>
  );
}

/** The note's properties, as Obsidian shows them above a note: a key and its value per row, tags as tags, links as links. */
export function NoteProperties({ properties, broken }: { properties: NoteProperty[]; broken: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  if (!properties.length && !broken) return null;
  return (
    // The page's measure from `kg-note`, and the room under it from the wrapper: `kg-note` sets its own margin, which a utility on it would not undo.
    <div className="kg-note pb-7">
      <section className="rounded-xl border border-zinc-100 px-4 py-2.5 text-[13px]" data-note-properties>
        <button type="button" onClick={() => setOpen(!open)} className="text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-darkDelegation" aria-expanded={open}>
          {t('notes.properties')}
        </button>
        {broken ? <p className="mt-1 text-[12px] text-warn">{t('notes.properties.broken')}</p> : null}
        {open && properties.length ? (
          <dl className="mt-1.5 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1">
            {properties.map((property) => (
              <div key={property.key} className="contents" data-note-property={property.key}>
                <dt className="truncate text-zinc-500">{property.key}</dt>
                <dd className="min-w-0">
                  <PropertyValueView property={property} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>
    </div>
  );
}

/** A whole note: its properties and its body. */
export function NoteDocument({ path, text, onToggleTask }: { path: string; text: string; onToggleTask?: (line: number) => void }) {
  const split = useMemo(() => splitProperties(text), [text]);
  const facts = useMemo(() => parseNote(text), [text]);
  return (
    <>
      <NoteProperties properties={facts.properties} broken={facts.propertiesBroken} />
      <NoteMarkdown path={path} source={split.body} offset={split.bodyLine} onToggleTask={onToggleTask} />
    </>
  );
}

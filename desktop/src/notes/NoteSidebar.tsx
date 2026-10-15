import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ListTree, Network, PanelRightOpen } from 'lucide-react';
import type { NoteBacklinks } from '@shared/notes';
import { folderOf, parseNote, pathKey } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { GraphView } from './GraphView';
import { folderLabel, labelOf, useActiveTab, useNotes } from './notesStore';

/**
 * Beside the note in front: what links to it and what it links to, its
 * outline, and the notes around it as a graph - Obsidian's right sidebar. The
 * outline and the outgoing links are read from the text as it is being
 * written; what links to it is asked of the main process, which has every
 * note, again whenever the vault changes.
 */

type Panel = 'links' | 'outline' | 'graph';

export function NoteSidebar({ onFold }: { onFold: () => void }) {
  const t = useT();
  const [panel, setPanel] = useState<Panel>(() => {
    try {
      const saved = localStorage.getItem('cortex.notes.side');
      return saved === 'outline' || saved === 'graph' ? saved : 'links';
    } catch {
      return 'links';
    }
  });
  const choose = (next: Panel) => {
    setPanel(next);
    try {
      localStorage.setItem('cortex.notes.side', next);
    } catch {
      /* for this run */
    }
  };
  const tabs: Array<{ id: Panel; icon: React.ReactNode; label: Key }> = [
    { id: 'links', icon: <ArrowDownLeft size={14} />, label: 'notes.side.links' },
    { id: 'outline', icon: <ListTree size={14} />, label: 'notes.side.outline' },
    { id: 'graph', icon: <Network size={14} />, label: 'notes.side.graph' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col" data-notes-side={panel}>
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-zinc-100 px-2">
        <button type="button" onClick={onFold} title={t('notes.side.fold')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
          <PanelRightOpen size={14} className="rotate-180" />
        </button>
        {tabs.map((one) => (
          <button
            key={one.id}
            type="button"
            onClick={() => choose(one.id)}
            aria-pressed={panel === one.id}
            title={t(one.label)}
            data-notes-side-tab={one.id}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-bold transition-colors ${panel === one.id ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            {one.icon}
            {/* The tab in front says its name; the others are their icons, with the name on hover. */}
            {panel === one.id ? <span>{t(one.label)}</span> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{panel === 'links' ? <Links /> : panel === 'outline' ? <Outline /> : <GraphView local />}</div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-1 py-1 text-left">
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{title}</span>
        <span className="rounded bg-zinc-50 px-1.5 text-[10.5px] text-zinc-400">{count}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

function Links() {
  const t = useT();
  const path = useActiveTab().path;
  const live = useNotes((state) => state.live);
  const resolve = useNotes((state) => state.resolve);
  const revision = useNotes((state) => state.revision);
  const [back, setBack] = useState<NoteBacklinks | null>(null);

  useEffect(() => {
    if (!path) return setBack(null);
    let current = true;
    window.cortex.notes.backlinks(path).then(
      (got) => current && setBack(got),
      () => current && setBack({ linked: [], unlinked: [] }),
    );
    return () => {
      current = false;
    };
  }, [path, revision]);

  const outgoing = useMemo(() => {
    if (!live || live.path !== path) return { there: [] as string[], missing: [] as string[] };
    const there = new Map<string, string>();
    const missing = new Map<string, string>();
    for (const link of parseNote(live.text).links) {
      if (!link.target) continue;
      const to = resolve(link.target, live.path, link.kind);
      if (to) there.set(to, to);
      else if (link.kind === 'wiki') missing.set(pathKey(link.target), link.target);
    }
    return { there: [...there.values()], missing: [...missing.values()] };
  }, [live, path, resolve]);

  if (!path) return <p className="p-4 text-[12px] text-zinc-400">{t('notes.side.none')}</p>;
  const item = (to: string, lines?: Array<{ line: number; text: string }>) => (
    <li key={to} className="rounded-md px-1 py-1 hover:bg-zinc-50" data-side-link={to}>
      <button type="button" onClick={(event) => useNotes.getState().open(to, { newTab: event.ctrlKey || event.metaKey, line: lines?.[0]?.line ?? null })} className="block w-full text-left">
        <span className="block truncate text-[13px] font-semibold text-darkDelegation">{labelOf(to)}</span>
        {folderOf(to) ? <span className="block truncate text-[10.5px] text-zinc-400">{folderLabel(folderOf(to))}</span> : null}
      </button>
      {lines?.map((line) => (
        <button key={line.line} type="button" onClick={() => useNotes.getState().open(to, { line: line.line })} className="mt-0.5 block w-full text-left text-[11.5px] leading-snug text-zinc-500 hover:text-darkDelegation">
          {line.text}
        </button>
      ))}
    </li>
  );
  return (
    <div className="h-full overflow-y-auto px-2 py-2" data-notes-links>
      <Section title={t('notes.side.backlinks')} count={back?.linked.length ?? 0}>
        {back?.linked.length ? <ul data-backlinks>{back.linked.map((one) => item(one.from, one.lines))}</ul> : <p className="px-1 text-[12px] text-zinc-400">{t('notes.side.noBacklinks')}</p>}
      </Section>
      <Section title={t('notes.side.outgoing')} count={outgoing.there.length + outgoing.missing.length}>
        <ul data-outgoing>
          {outgoing.there.map((to) => item(to))}
          {outgoing.missing.map((name) => (
            <li key={name} className="flex items-center gap-1.5 px-1 py-1 text-[13px] text-zinc-400" data-side-missing={name}>
              <ArrowUpRight size={12} />
              <span className="truncate">{name}</span>
              <span className="ml-auto shrink-0 text-[10.5px]">{t('notes.side.notWritten')}</span>
            </li>
          ))}
        </ul>
        {!outgoing.there.length && !outgoing.missing.length ? <p className="px-1 text-[12px] text-zinc-400">{t('notes.side.noOutgoing')}</p> : null}
      </Section>
      {back?.unlinked.length ? (
        <Section title={t('notes.side.unlinked')} count={back.unlinked.length}>
          <ul data-unlinked>{back.unlinked.map((one) => item(one.from, one.lines))}</ul>
        </Section>
      ) : null}
    </div>
  );
}

function Outline() {
  const t = useT();
  const path = useActiveTab().path;
  const live = useNotes((state) => state.live);
  const headings = useMemo(() => (live && live.path === path ? parseNote(live.text).headings : []), [live, path]);
  if (!headings.length) return <p className="p-4 text-[12px] text-zinc-400">{t('notes.side.noOutline')}</p>;
  const top = Math.min(...headings.map((one) => one.level));
  return (
    <ul className="h-full overflow-y-auto px-2 py-2" data-notes-outline>
      {headings.map((heading) => (
        <li key={heading.line}>
          <button
            type="button"
            onClick={() => path && useNotes.getState().open(path, { line: heading.line })}
            className="block w-full truncate rounded-md py-1 pr-2 text-left text-[13px] text-zinc-600 hover:bg-zinc-50 hover:text-darkDelegation"
            style={{ paddingLeft: `${0.4 + (heading.level - top) * 0.9}rem` }}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

import { useState, type ReactNode } from 'react';
import { ArrowUpRight, PanelRightClose, Sparkles } from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import { folderOf, missingNoteAt, type GraphInsights } from '../../core/vaultNotes';
import { useChat } from '../chat/chatStore';
import { useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { useApp } from '../store/app';
import { useView } from '../store/view';
import { makeMissingNote } from './NoteMarkdown';
import { folderLabel, labelOf, useNotes } from './notesStore';

/**
 * Beside the vault's graph: what it is, what it shows of the vault, and what there is to do from it. 30 October: the
 * graph alone was points and lines, and a person who opened it did not know what it was for. Its lists open a note,
 * write one a link names, or put a request to Pyn in the chat's field, to be read before it is sent; a name hovered
 * lights its point.
 */

/** How many of a list are shown before it is opened whole. */
const FEW = 5;
/** How many unlinked notes a request to Pyn names: enough to start, few enough to read before sending. */
const ASK_AT_MOST = 15;

/** A note opened from the graph, in the notes view: opened behind the graph, nothing was seen to happen (29 October). */
export function openFromGraph(path: string, newTab = false): void {
  useNotes.getState().open(path, { newTab });
  useView.getState().setView('notes');
}

/** A note a link names made where the first note naming it says (missingNoteAt), then opened to be written. */
export function writeMissing(one: { name: string; from: string[] }, t: (key: Key) => string): void {
  const at = missingNoteAt(one.name, one.from[0] ?? '', useNotes.getState().index?.folders ?? []);
  if (!at) return;
  makeMissingNote(at, t).then(
    async (made) => {
      await useNotes.getState().refresh();
      useNotes.getState().open(made.path, { edit: true });
      useView.getState().setView('notes');
    },
    (err) => useApp.getState().toast({ tone: 'error', title: t('notes.create.failed'), detail: messageOf(err) }),
  );
}

const wikiName = (path: string) => path.replace(/[.]md$/i, '');

export function GraphGuide({
  insights,
  colours,
  folder,
  onFolder,
  onPoint,
  onFold,
}: {
  insights: GraphInsights;
  colours: Map<string, string>;
  folder: string | null;
  onFolder: (folder: string | null) => void;
  /** A point lit as if hovered, or none. */
  onPoint: (id: string | null) => void;
  onFold: () => void;
}) {
  const t = useT();
  const [whole, setWhole] = useState<Record<string, boolean>>({});
  const few = <T,>(key: string, list: T[]) => (whole[key] ? list : list.slice(0, FEW));
  const more = (key: string, count: number) =>
    count > FEW ? (
      <button type="button" onClick={() => setWhole({ ...whole, [key]: !whole[key] })} className="mt-1 px-1 text-[11.5px] text-zinc-400 hover:text-darkDelegation" data-graph-more={key}>
        {whole[key] ? t('notes.graph.guide.less') : t('notes.graph.guide.more', { count })}
      </button>
    ) : null;
  const jump = (section: string) => document.querySelector(`[data-graph-section="${section}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const askPyn = async () => {
    const names = insights.unlinked.slice(0, ASK_AT_MOST).map((path) => `[[${wikiName(path)}]]`);
    const rest = insights.unlinked.length - names.length;
    const list = rest > 0 ? `${names.join(', ')} ${t('notes.graph.guide.askRest', { count: rest })}` : names.join(', ');
    await useChat.getState().select(null);
    useChat.getState().setDraft('new', t('notes.graph.guide.askLink', { notes: list }));
    useView.getState().setView('pyn');
    // The field takes the cursor once the chat is in front: the person reads the request, and Enter sends it.
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.focus());
  };

  const note = (path: string, after?: ReactNode) => (
    <li key={path}>
      <button
        type="button"
        onClick={(event) => openFromGraph(path, event.ctrlKey || event.metaKey)}
        onMouseEnter={() => onPoint(path)}
        onMouseLeave={() => onPoint(null)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-zinc-50"
        data-graph-note={path}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-darkDelegation">{labelOf(path)}</span>
          {folderOf(path) ? <span className="block truncate text-[10.5px] text-zinc-400">{folderLabel(folderOf(path))}</span> : null}
        </span>
        {after}
      </button>
    </li>
  );

  const stats: Array<{ key: string; value: number; label: Key; section?: string }> = [
    { key: 'notes', value: insights.notes, label: 'notes.graph.stat.notes' },
    { key: 'links', value: insights.links, label: 'notes.graph.stat.links' },
    { key: 'unlinked', value: insights.unlinked.length, label: 'notes.graph.stat.unlinked', section: 'unlinked' },
    { key: 'missing', value: insights.missing.length, label: 'notes.graph.stat.missing', section: 'missing' },
  ];

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-zinc-200 bg-white" data-graph-guide>
      <div className="flex items-start gap-2 border-b border-zinc-100 px-4 pb-2 pt-4">
        <h2 className="min-w-0 flex-1 font-display text-[18px] leading-tight text-darkDelegation">{t('notes.graph.guide.title')}</h2>
        <button type="button" onClick={onFold} title={t('notes.graph.guide.fold')} aria-label={t('notes.graph.guide.fold')} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-50 hover:text-darkDelegation" data-graph-guide-fold>
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">{t('notes.graph.guide.what')}</p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-400">{t('notes.graph.guide.how')}</p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {stats.map((one) => {
            const body = (
              <>
                <span className="block text-[20px] font-semibold leading-none tabular-nums text-darkDelegation">{one.value}</span>
                <span className="mt-1 block text-[11px] text-zinc-500">{t(one.label)}</span>
              </>
            );
            return one.section && one.value ? (
              <button key={one.key} type="button" onClick={() => jump(one.section!)} className="rounded-lg border border-zinc-200 px-3 py-2 text-left hover:border-zinc-400" data-graph-stat={one.key}>
                {body}
              </button>
            ) : (
              <div key={one.key} className="rounded-lg border border-zinc-200 px-3 py-2" data-graph-stat={one.key}>
                {body}
              </div>
            );
          })}
        </div>
        {!insights.links && insights.notes ? <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-[12px] leading-relaxed text-zinc-500">{t('notes.graph.guide.firstLink')}</p> : null}

        <Section title={t('notes.graph.guide.folders')} count={insights.folders.length} hint={t('notes.graph.guide.foldersHint')} id="folders">
          <ul>
            {insights.folders.map((one) => (
              <li key={one.folder}>
                <button
                  type="button"
                  aria-pressed={folder === one.folder}
                  onClick={() => onFolder(folder === one.folder ? null : one.folder)}
                  className={`flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px] ${folder === one.folder ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-600 hover:bg-zinc-50'}`}
                  data-graph-folder={one.folder}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colours.get(one.folder) ?? '#56524c' }} />
                  <span className="min-w-0 flex-1 truncate">{one.folder ? folderLabel(one.folder) : t('notes.graph.guide.top')}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{one.notes}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('notes.graph.guide.unlinked')} count={insights.unlinked.length} hint={t(insights.unlinked.length ? 'notes.graph.guide.unlinkedHint' : 'notes.graph.guide.allLinked')} id="unlinked">
          {insights.unlinked.length ? (
            <>
              <ul>{few('unlinked', insights.unlinked).map((path) => note(path))}</ul>
              {more('unlinked', insights.unlinked.length)}
              <button
                type="button"
                onClick={() => void askPyn()}
                title={t('notes.graph.guide.askPynHint')}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1.5 text-[12px] text-darkDelegation hover:border-zinc-400"
                data-graph-ask-pyn
              >
                <Sparkles size={13} />
                {t('notes.graph.guide.askPyn')}
              </button>
            </>
          ) : null}
        </Section>

        <Section title={t('notes.graph.guide.missing')} count={insights.missing.length} hint={t(insights.missing.length ? 'notes.graph.guide.missingHint' : 'notes.graph.guide.noMissing')} id="missing">
          {insights.missing.length ? (
            <>
              <ul>
                {few('missing', insights.missing).map((one) => (
                  <li key={one.name}>
                    <button type="button" onClick={() => writeMissing(one, t)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-zinc-50" data-graph-missing={one.name}>
                      <ArrowUpRight size={12} className="shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-600">{one.name}</span>
                      <span className="shrink-0 text-[10.5px] text-zinc-400">{t('notes.graph.guide.missingFrom', { count: one.from.length })}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {more('missing', insights.missing.length)}
            </>
          ) : null}
        </Section>

        {insights.hubs.length ? (
          <Section title={t('notes.graph.guide.hubs')} count={insights.hubs.length} hint={t('notes.graph.guide.hubsHint')} id="hubs">
            <ul>{insights.hubs.map((one) => note(one.path, <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{t('notes.graph.links', { count: one.links })}</span>))}</ul>
          </Section>
        ) : null}
      </div>
    </aside>
  );
}

function Section({ title, count, hint, id, children }: { title: string; count: number; hint: string; id: string; children: ReactNode }) {
  return (
    <section className="mt-5 scroll-mt-2" data-graph-section={id}>
      <div className="flex items-center gap-2 px-1">
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{title}</span>
        <span className="rounded bg-zinc-50 px-1.5 text-[10.5px] text-zinc-400">{count}</span>
      </div>
      <p className="mb-1.5 mt-1 px-1 text-[11.5px] leading-snug text-zinc-500">{hint}</p>
      {children}
    </section>
  );
}

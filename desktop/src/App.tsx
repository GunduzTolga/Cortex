import { useEffect, useState } from 'react';
import { BookOpen, FolderOpen, Network } from 'lucide-react';
import seal from '../../tema/ananas/marka/pyn-muhur.svg';
import { LANGUAGES, type Key, type Language } from './i18n';
import { useLanguage, useT } from './i18n/useT';
import { NotesView } from './notes/NotesView';
import { GraphView } from './notes/GraphView';
import { useApp } from './store/app';
import { Toasts } from './ui/Toasts';
import { Button, Spinner } from './ui/ui';

/**
 * The window: the vault chosen first, then its notes.
 *
 * Krewgent's Cortex side (src/cortex/CortexSide.tsx) without its terminal and
 * install pass, which are the second and third stages here: two views of one
 * vault, the notes (src/notes/) and the vault as a graph, each drawn from the
 * first time it is shown and kept after, so the graph is not laid out again at
 * every switch. Which one is in front is this window's storage, a convenience.
 */

type View = 'notes' | 'graph';
const VIEW_KEY = 'cortex.view';

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'notes';
  } catch {
    return 'notes';
  }
}

export function App() {
  const t = useT();
  const ready = useApp((s) => s.ready);
  const bootError = useApp((s) => s.bootError);
  const vault = useApp((s) => s.vault);
  const unreadable = useApp((s) => s.settingsUnreadable);

  useEffect(() => {
    void useApp.getState().boot();
  }, []);

  // A settings file that would not be read is said once, and stays until it is closed.
  useEffect(() => {
    if (unreadable) useApp.getState().toast({ tone: 'error', title: 'Cortex', detail: t(unreadable === 'copied' ? 'app.settings.copied' : 'app.settings.left'), sticky: true });
    // Once per start: the language changing is not news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadable]);

  return (
    <>
      {bootError ? (
        <p className="p-8 text-[13px] text-bad">{bootError}</p>
      ) : !ready ? (
        <div className="flex h-full items-center justify-center">
          <Spinner label={t('app.loading')} />
        </div>
      ) : !vault.vault ? (
        <Welcome />
      ) : (
        <VaultScreen name={vault.vault.name} missing={vault.missing} />
      )}
      <Toasts />
    </>
  );
}

function LanguagePicker() {
  const t = useT();
  const language = useLanguage();
  return (
    <label className="flex items-center gap-2 text-[11px] text-zinc-500">
      <span className="sr-only">{t('app.language')}</span>
      <select
        value={language}
        onChange={(event) => void useApp.getState().setLanguage(event.target.value as Language)}
        aria-label={t('app.language')}
        data-language
        className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-[11px] text-darkDelegation outline-none focus:border-zinc-400"
      >
        {LANGUAGES.map((one) => (
          <option key={one.id} value={one.id}>
            {one.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The first opening: what the app is, and the vault to choose. The folder comes through the system's dialog, in the main process. */
function Welcome() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-8" data-welcome>
      <div className="flex max-w-xl items-center gap-8">
        <img src={seal} alt="" className="h-32 w-32 shrink-0" />
        <div className="space-y-4">
          <h1 className="font-display text-4xl text-darkDelegation">Cortex</h1>
          <p className="text-[13px] leading-relaxed text-zinc-600">{t('welcome.intro')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="primary" onClick={() => void useApp.getState().chooseVault(t('app.vault.failed'))} data-welcome-choose>
              <FolderOpen size={14} />
              {t('welcome.choose')}
            </Button>
            <LanguagePicker />
          </div>
          <p className="text-[11.5px] text-zinc-400">{t('welcome.private')}</p>
        </div>
      </div>
    </div>
  );
}

function VaultScreen({ name, missing }: { name: string; missing: boolean }) {
  const t = useT();
  const [view, setViewState] = useState<View>(savedView);
  const [shown, setShown] = useState<Set<View>>(() => new Set([savedView()]));
  const setView = (next: View) => {
    setViewState(next);
    setShown((before) => (before.has(next) ? before : new Set([...before, next])));
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* for this run */
    }
  };
  const choose = () => void useApp.getState().chooseVault(t('app.vault.failed'));

  // A vault gone from disk is said when the window comes back to it too, not only at the start.
  useEffect(() => {
    const back = () => void useApp.getState().refreshVault();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, []);

  const views: Array<[View, React.ReactNode, Key]> = [
    ['notes', <BookOpen key="notes" size={13} />, 'app.view.notes'],
    ['graph', <Network key="graph" size={13} />, 'app.view.graph'],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-white" data-vault-screen>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-100 px-3" role="group" aria-label={t('app.view')}>
        <img src={seal} alt="" className="mr-2 h-6 w-6" />
        {views.map(([one, icon, words]) => (
          <button
            key={one}
            type="button"
            onClick={() => setView(one)}
            aria-pressed={view === one}
            data-app-view={one}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-black uppercase tracking-widest transition-colors ${
              view === one ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {icon}
            {t(words)}
          </button>
        ))}
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <span className="truncate text-[11px] text-zinc-400" data-vault-name>
            {name}
          </span>
          <button type="button" onClick={choose} title={t('app.vault.change')} aria-label={t('app.vault.change')} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation" data-vault-change>
            <FolderOpen size={14} />
          </button>
          <LanguagePicker />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {missing ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" data-vault-missing>
            <p className="max-w-md text-[13px] text-zinc-600">{t('app.vault.missing', { name })}</p>
            <Button tone="primary" onClick={choose}>
              <FolderOpen size={14} />
              {t('welcome.choose')}
            </Button>
          </div>
        ) : (
          <>
            {/*
              A view not in front is hidden; the one in front says nothing of
              its visibility, so nothing in the hidden one shows through.
            */}
            {shown.has('notes') ? (
              <div className="kg-layer absolute inset-0" style={view === 'notes' ? undefined : { visibility: 'hidden' }} aria-hidden={view !== 'notes'}>
                <NotesView visible={view === 'notes'} onGraph={() => setView('graph')} />
              </div>
            ) : null}
            {shown.has('graph') ? (
              <div className="kg-layer absolute inset-0" style={view === 'graph' ? undefined : { visibility: 'hidden' }} aria-hidden={view !== 'graph'}>
                <GraphView visible={view === 'graph'} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { BookOpen, Building2, FolderOpen, MessageCircle, Network, Settings } from 'lucide-react';
import seal from '../../tema/ananas/marka/pyn-muhur.svg';
import type { Key } from './i18n';
import { useT } from './i18n/useT';
import { AuthDialog } from './chat/AuthDialog';
import { ChatView } from './chat/ChatView';
import { NotesView } from './notes/NotesView';
import { GraphView } from './notes/GraphView';
import { OfficeView } from './office/OfficeView';
import { Onboarding } from './onboarding/Onboarding';
import { NotesDialogs } from './notes/NotesMenus';
import { useNotes } from './notes/notesStore';
import { refusal, useApp } from './store/app';
import { useSetup } from './store/setup';
import { useView, type View } from './store/view';
import { LanguageSwitch } from './ui/LanguageSwitch';
import { SettingsDialog } from './ui/SettingsDialog';
import { Toasts } from './ui/Toasts';
import { Button, Spinner } from './ui/ui';

/**
 * The window: the first-run screen until it has been gone through once
 * (src/onboarding/), the vault chosen, then its views - Pyn, where the person
 * talks to their own AI (src/chat/), first; the notes (src/notes/); the vault
 * as a graph - each drawn from the first time it is shown and kept after
 * (src/store/view.ts), so the graph is not laid out again at every switch.
 */

export function App() {
  const t = useT();
  const ready = useApp((s) => s.ready);
  const bootError = useApp((s) => s.bootError);
  const vault = useApp((s) => s.vault);
  const unreadable = useApp((s) => s.settingsUnreadable);
  const nameIcons = useApp((s) => s.settings.nameIcons);
  const onboarded = useApp((s) => s.settings.onboarded);

  useEffect(() => {
    void useApp.getState().boot();
  }, []);

  // The notes are named as the settings say, wherever they are shown (src/notes/notesStore.ts).
  useEffect(() => useNotes.getState().setNameIcons(nameIcons), [nameIcons]);

  // A settings file that would not be read is said once, and stays until it is closed.
  useEffect(() => {
    if (unreadable) useApp.getState().toast({ tone: 'error', title: 'Cortex', detail: t(unreadable === 'copied' ? 'app.settings.copied' : 'app.settings.left'), sticky: true });
    // Once per start: the language changing is not news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadable]);

  return (
    <>
      {bootError ? (
        <p className="p-8 text-[13px] text-bad">{refusal(bootError)}</p>
      ) : !ready ? (
        <div className="flex h-full items-center justify-center">
          <Spinner label={t('app.loading')} />
        </div>
      ) : !onboarded ? (
        <Onboarding />
      ) : !vault.vault ? (
        <Welcome />
      ) : (
        <VaultScreen name={vault.vault.name} missing={vault.missing} />
      )}
      {/* The confirmations, prompts and menus every view asks with. */}
      <NotesDialogs />
      <Toasts />
    </>
  );
}

/** The first opening: what the app is, and the vault to choose. The folder comes through the system's dialog, in the main process. */
function Welcome() {
  const t = useT();
  return (
    <div className="relative flex h-full items-center justify-center p-8" data-welcome>
      <div className="absolute right-4 top-3">
        <LanguageSwitch />
      </div>
      <div className="flex max-w-xl items-center gap-8">
        <img src={seal} alt="" className="h-32 w-32 shrink-0" />
        <div>
          <h1 className="font-display text-4xl text-darkDelegation">Cortex</h1>
          <p className="mt-2 text-[15px] text-zinc-700">{t('welcome.tagline')}</p>
          <p className="mt-3 text-[13px] leading-relaxed text-zinc-600">{t('welcome.intro')}</p>
          <Button tone="primary" className="mt-5" onClick={() => void useApp.getState().chooseVault(t('app.vault.failed'))} data-welcome-choose>
            <FolderOpen size={14} />
            {t('welcome.choose')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function VaultScreen({ name, missing }: { name: string; missing: boolean }) {
  const t = useT();
  const view = useView((state) => state.view);
  const shown = useView((state) => state.shown);
  const setView = useView((state) => state.setView);
  const choose = () => void useApp.getState().chooseVault(t('app.vault.failed'));

  // An older Cortex in the vault than the one the app brought: said once, with the button that updates it.
  const updatable = useSetup((s) => {
    const engine = s.status?.engine;
    return Boolean(engine?.installed && engine.bundled && engine.bundled.localeCompare(engine.installed, undefined, { numeric: true }) > 0);
  });
  useEffect(() => {
    void (async () => {
      await useSetup.getState().refresh();
      const engine = useSetup.getState().status?.engine;
      if (!engine?.installed || !engine.bundled || engine.bundled.localeCompare(engine.installed, undefined, { numeric: true }) <= 0) return;
      useApp.getState().toast({
        tone: 'info',
        title: t('setup.update.title', { installed: engine.installed, bundled: engine.bundled }),
        detail: t('setup.update.detail'),
        sticky: true,
        action: { label: t('setup.update.action'), run: () => void useSetup.getState().run('engine') },
      });
    })();
    // Once per vault opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // A vault gone from disk is said when the window comes back to it too, not only at the start.
  useEffect(() => {
    const back = () => void useApp.getState().refreshVault();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, []);

  // Ctrl+, opens the settings, as in most desktop apps.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        useApp.getState().openSettings(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const views: Array<[View, React.ReactNode, Key]> = [
    ['pyn', <MessageCircle key="pyn" size={13} />, 'app.view.pyn'],
    ['notes', <BookOpen key="notes" size={13} />, 'app.view.notes'],
    ['graph', <Network key="graph" size={13} />, 'app.view.graph'],
    ['office', <Building2 key="office" size={13} />, 'app.view.office'],
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
          <button
            type="button"
            onClick={() => useApp.getState().openSettings(true)}
            title={t('app.settings.open')}
            aria-label={t('settings.title')}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation"
            data-settings-open
          >
            <span className="relative block">
              <Settings size={14} />
              {updatable ? (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-darkDelegation bg-gold" title={t('setup.update.dot')} data-settings-update-dot />
              ) : null}
            </span>
          </button>
          <LanguageSwitch />
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
            {shown.has('pyn') ? (
              <div className="kg-layer absolute inset-0" style={view === 'pyn' ? undefined : { visibility: 'hidden' }} aria-hidden={view !== 'pyn'}>
                <ChatView visible={view === 'pyn'} />
              </div>
            ) : null}
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
            {shown.has('office') ? (
              <div className="kg-layer absolute inset-0" style={view === 'office' ? undefined : { visibility: 'hidden' }} aria-hidden={view !== 'office'}>
                <OfficeView visible={view === 'office'} />
              </div>
            ) : null}
          </>
        )}
      </div>
      <SettingsDialog />
      <AuthDialog />
    </div>
  );
}

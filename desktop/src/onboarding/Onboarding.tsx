import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, FolderOpen, Mic, RefreshCw, SkipForward } from 'lucide-react';
import pineapple from '../../../tema/ananas/marka/pyn-ananas-512.png';
import logo from '../../../tema/ananas/marka/pyn-logo-96.png';
import sitting from '../../../tema/ananas/marka/pyn-oturan-512.png';
import type { CliAuth, CliId } from '@shared/chat';
import type { GithubStatus } from '@shared/github';
import { messageOf } from '@shared/ipcError';
import { engineAction, type SetupStatus, wakePhraseLabel } from '@shared/setup';
import { AuthDialog } from '../chat/AuthDialog';
import { useChat } from '../chat/chatStore';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { refusal, useApp } from '../store/app';
import { useSetup } from '../store/setup';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { HotkeyBusy, Progress, VoiceHelperBar, engineButtonText, pythonWantingText } from '../ui/SetupSections';
import { GithubConnect } from '../ui/GithubConnect';
import { Button, Spinner, Switch, inputClass } from '../ui/ui';
import { atMostEvery } from './focusRefresh';
import { Heading } from './Heading';
import { type Installing, ToolsStep, serving } from './ToolsStep';

/**
 * The first thing the app shows, until it has been gone through once: Pyn
 * asks how to address the person, then each thing there is to set up comes
 * in turn - the vault, Python where the machine has none, Pyn's memory in the
 * vault, the AI tools, voice typing - each said in a sentence or two, each
 * done here with one button, the optional ones skippable. Nobody has to find
 * any of it in the settings, or type a command. The settings keep all of it
 * for later (src/ui/SettingsDialog.tsx), and can open this again.
 */

type StepId = 'name' | 'vault' | 'python' | 'engine' | 'tools' | 'voice' | 'backup' | 'done';
const TITLE: Record<StepId, Key> = {
  name: 'onboarding.step.name',
  vault: 'onboarding.step.vault',
  python: 'onboarding.step.python',
  engine: 'onboarding.step.engine',
  tools: 'onboarding.step.tools',
  voice: 'onboarding.step.voice',
  backup: 'onboarding.step.backup',
  done: 'onboarding.step.done',
};

/** Coming back to the window asks again what is installed and signed in, at most this often. */
const FOCUS_REFRESH_EVERY = 10_000;

/** The vault and the name are the person's to give; the rest can wait for the settings. */
const OPTIONAL = new Set<StepId>(['name', 'python', 'engine', 'tools', 'voice', 'backup']);

export function Onboarding() {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const kept = useApp((s) => s.vault);
  // A vault whose folder was moved or removed is not chosen: counted as one, Next and Finish led to the
  // "not where it was" screen (29 October).
  const vault = kept.missing ? null : kept.vault;
  const status = useSetup((s) => s.status);
  const steps = useSetup((s) => s.steps);
  const error = useSetup((s) => s.error);
  const auth = useChat((s) => s.auth);
  // The vault backed up on GitHub (Faz 1): offered as a last, optional step where Cortex can sign in to GitHub.
  const [github, setGithub] = useState<GithubStatus | null>(null);
  useEffect(() => {
    void window.cortex.github.status().then(setGithub, () => setGithub(null));
    return window.cortex.on.github(setGithub);
  }, []);
  const [at, setAt] = useState<StepId>('name');
  const [skipped, setSkipped] = useState<Set<StepId>>(new Set());
  // Python's step stays in the list once it was needed, so it can be seen done.
  const [neededPython, setNeededPython] = useState(false);
  // The tools signed in to from here: a sign-in opened for them, from its button or after its install, that ended signed in.
  const [fresh, setFresh] = useState<Set<CliId>>(new Set());
  const trying = useRef<Set<CliId>>(new Set());
  // A sign-in opened from its button and not yet ended: said on its row, as its console may open behind the window.
  const [signingIn, setSigningIn] = useState<Set<CliId>>(new Set());
  // A sign-in from its button that ended without one (its console closed, or it stopped at once): said on its row,
  // where before nothing changed and nothing told why (29 October).
  const [unfinished, setUnfinished] = useState<Set<CliId>>(new Set());
  const signingRef = useRef(signingIn);
  signingRef.current = signingIn;
  // A tool being installed from here, or its installer ended without it.
  const [installing, setInstalling] = useState<Installing>(null);
  const installRef = useRef(installing);
  installRef.current = installing;
  useEffect(() => {
    // `ended`: told by the main process that an installer closed. Only then is a tool still missing a failed install:
    // read again on coming back to the window, it was said failed while its installer was still running, the console
    // having taken the focus (1 November: "Claude Code kurulamadı" under the button of a fresh install).
    const reread = (ended = false) =>
      useChat
        .getState()
        .loadAuth()
        .then(() => {
          const now = useChat.getState().auth ?? [];
          const signed = [...trying.current].filter((id) => now.find((tool) => tool.id === id)?.signedIn === true);
          // One not signed in yet stays tried: its sign-in may still be going on, or come after its install.
          for (const id of signed) trying.current.delete(id);
          if (signed.length) setFresh((before) => new Set([...before, ...signed]));
          const going = installRef.current;
          if (going && !going.failed) {
            if (now.find((tool) => tool.id === going.id)?.installed) setInstalling(null);
            else if (ended) setInstalling({ id: going.id, failed: true });
          }
          return signed;
        });
    // Told by the main process: a sign-in done (its console may still be open), or its console closed.
    // Either way the sign-in is over on its row; a sign-in closed without one shows the tool signed out again.
    // Only the tool told of is over: with two sign-ins open, the one whose console was still open was said unfinished
    // when the other's closed (30 October).
    const stop = window.cortex.on.authChanged(
      (cli) =>
        void reread(cli === null).then((signed) => {
          const now = useChat.getState().auth ?? [];
          if (cli && signingRef.current.has(cli) && !signed.includes(cli) && now.find((tool) => tool.id === cli)?.signedIn !== true) {
            setUnfinished((before) => new Set(before).add(cli));
          }
          setSigningIn((before) => new Set([...before].filter((id) => id !== cli && !signed.includes(id))));
        }),
    );
    // Back from a terminal or the browser, where a tool or Python was installed or signed in to: asked again,
    // and a sign-in that ended there counted as done here. At most once in a while (focusRefresh.ts): each asking
    // starts a program per tool, PowerShell and the vault's engine, and the focus comes and goes with every click
    // between the window and a browser.
    const back = atMostEvery(() => {
      void reread().then((signed) => {
        if (signed.length) setSigningIn((before) => new Set([...before].filter((id) => !signed.includes(id))));
      });
      void useSetup.getState().refresh();
    }, FOCUS_REFRESH_EVERY);
    window.addEventListener('focus', back.ask);
    return () => {
      stop();
      back.stop();
      window.removeEventListener('focus', back.ask);
    };
  }, []);
  const login = (id: CliId) => {
    trying.current.add(id);
    setUnfinished((before) => new Set([...before].filter((one) => one !== id)));
    setSigningIn((before) => new Set(before).add(id));
    void window.cortex.chat.login(id).catch(() => {
      trying.current.delete(id);
      setSigningIn((before) => new Set([...before].filter((one) => one !== id)));
      setUnfinished((before) => new Set(before).add(id));
    });
  };
  // "Vazgeç" on a sign-in going on: over on its row at once, said unfinished; its hidden console is ended by the main
  // process, which tells how to sign in from a terminal with the statuses it sends after.
  const cancel = (id: CliId) => {
    trying.current.delete(id);
    signingRef.current = new Set([...signingRef.current].filter((one) => one !== id));
    setSigningIn((before) => new Set([...before].filter((one) => one !== id)));
    setUnfinished((before) => new Set(before).add(id));
    void window.cortex.chat.cancelLogin(id).then(
      () => useChat.getState().loadAuth(),
      () => undefined,
    );
  };
  const install = (id: CliId) => {
    trying.current.add(id);
    setInstalling({ id, failed: false });
    void window.cortex.chat
      .install(id)
      .then(async () => {
        // A tool whose only way in is its key (OpenCode): its field opened as soon as it is installed.
        const now = (await window.cortex.chat.auth().catch((): CliAuth[] => [])).find((one) => one.id === id);
        if (now?.installed && !now.canLogin && now.key === 'cortex' && !now.signedIn) useChat.getState().openAuth(id);
      })
      .catch((err: unknown) => {
        trying.current.delete(id);
        setInstalling({ id, failed: true, why: refusal(messageOf(err)) });
      });
  };

  useEffect(() => {
    void useSetup.getState().refresh();
    void useChat.getState().loadAuth();
  }, [vault]);
  useEffect(() => {
    if (status && !status.python) setNeededPython(true);
  }, [status]);

  const order = useMemo<StepId[]>(() => {
    const list: StepId[] = ['name', 'vault'];
    if (neededPython || (status && !status.python)) list.push('python');
    // Voice before the tools (3 November, from Hex's setup order): its model downloads in the background once begun, and
    // signing in to the tools is the longest step, so the download is done by the end instead of starting there.
    list.push('engine');
    if (status?.voiceSupported) list.push('voice');
    list.push('tools');
    // Last before the end: the vault and Pyn's memory are there by then, and it is the one step nobody needs to start.
    if (github?.offered) list.push('backup');
    list.push('done');
    return list;
  }, [neededPython, status, github?.offered]);

  const done: Record<StepId, boolean> = {
    name: Boolean(settings.userName),
    vault: Boolean(vault),
    python: Boolean(status?.python),
    // Installed and nothing to do: not an older one, nor the predecessor's, nor stale against the app's (shared/setup.ts).
    engine: Boolean(status?.engine.installed) && !engineAction(status?.engine),
    tools: fresh.size > 0 || Boolean(auth?.some(serving)),
    voice: Boolean(status?.voice?.installed),
    backup: Boolean(github?.repo),
    done: false,
  };

  // Opened again after a first run was left half way (a name or a vault kept): it goes on at the first step not done,
  // where before it began again at the name (29 October). Placed once, before anything is chosen here. 30 October:
  // a name skipped is a step gone past once the vault is chosen, not one left undone; nothing moves under a person
  // who has begun typing or clicking; and the screen opened again from Settings begins at its start.
  const placed = useRef(false);
  const touched = useRef(false);
  useEffect(() => {
    if (placed.current || !status) return;
    placed.current = true;
    const again = useSetup.getState().again;
    useSetup.setState({ again: false });
    if (again || (!settings.userName && !vault)) return;
    const first = order.find((step) => step !== 'done' && !(step === 'name' && vault) && !done[step]) ?? 'done';
    setAt((now) => (now === 'name' && !touched.current ? first : now));
    // Only once, when the setup's status is first known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const index = Math.max(0, order.indexOf(at));
  const go = (step: StepId) => setAt(step);
  const next = () => go(order[Math.min(order.length - 1, index + 1)]);
  const back = () => go(order[Math.max(0, index - 1)]);
  const skip = () => {
    setSkipped((before) => new Set(before).add(at));
    next();
  };
  const busy = status?.job ?? null;

  return (
    <div
      className="relative flex h-full bg-white"
      data-onboarding
      data-onboarding-step={at}
      onPointerDownCapture={() => (touched.current = true)}
      onKeyDownCapture={() => (touched.current = true)}
    >
      <div className="absolute right-4 top-3">
        <LanguageSwitch />
      </div>
      <nav className="flex w-60 shrink-0 flex-col border-r border-darkDelegation/10 px-4 py-8" aria-label={t('onboarding.title')}>
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src={logo} alt="" className="kg-logo h-9 w-9" />
          <span className="font-display text-xl text-darkDelegation">Cortex</span>
        </div>
        <ol className="space-y-1">
          {order.map((step, i) => {
            const mark = done[step] ? 'done' : skipped.has(step) ? 'skipped' : step === at ? 'here' : 'todo';
            return (
              <li key={step}>
                <button
                  type="button"
                  onClick={() => go(step)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${step === at ? 'bg-white font-semibold text-darkDelegation shadow-sm' : 'text-zinc-600 hover:bg-white/60'}`}
                  data-onboarding-nav={step}
                  data-onboarding-mark={mark}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[10px] font-black ${mark === 'done' ? 'border-darkDelegation bg-gold text-onGold' : 'border-darkDelegation/30 text-zinc-500'}`}
                  >
                    {mark === 'done' ? <Check size={11} strokeWidth={3} /> : mark === 'skipped' ? <SkipForward size={10} /> : i + 1}
                  </span>
                  {t(TITLE[step])}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {/* Centred by the child's margin, not by the scroller: centred by the scroller, a step taller than the window
          lost its top, which no scrolling reached (zoomed, or the least window; 29 October). The top padding keeps the
          language switch off the step. */}
      <main className="flex min-w-0 flex-1 overflow-y-auto px-10 pb-10 pt-16">
        <div className="m-auto w-full max-w-xl">
          {at === 'name' ? <NameStep onNext={next} onSkip={skip} /> : null}
          {at === 'vault' ? <VaultStep name={vault?.name ?? null} missing={kept.missing ? (kept.vault?.name ?? null) : null} /> : null}
          {at === 'python' ? <PythonStep status={status} /> : null}
          {at === 'engine' ? <EngineStep status={status} /> : null}
          {at === 'tools' ? <ToolsStep auth={auth} fresh={fresh} signingIn={signingIn} unfinished={unfinished} installing={installing} onLogin={login} onCancel={cancel} onInstall={install} /> : null}
          {at === 'voice' ? <VoiceStep status={status} onStarted={next} /> : null}
          {at === 'backup' ? <BackupStep status={status} /> : null}
          {at === 'done' ? <DoneStep order={order} done={done} skipped={skipped} canFinish={Boolean(vault)} /> : null}

          {steps && at === steps.job ? <Progress job={steps.job} lines={steps.lines} /> : busy && at === busy ? <Progress job={busy} lines={[]} /> : null}
          {error && at === error.job ? (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700" data-onboarding-error>
              {error.text}
            </p>
          ) : null}

          {at !== 'done' && at !== 'name' ? (
            <div className="mt-8 flex items-center gap-2">
              <Button tone="quiet" onClick={back} data-onboarding-back>
                <ArrowLeft size={13} />
                {t('onboarding.back')}
              </Button>
              <span className="flex-1" />
              {OPTIONAL.has(at) && !done[at] ? (
                <Button tone="quiet" onClick={skip} data-onboarding-skip>
                  {t('onboarding.skip')}
                </Button>
              ) : null}
              <Button tone="primary" onClick={next} disabled={at === 'vault' && !vault} data-onboarding-next>
                {t('onboarding.next')}
                <ArrowRight size={13} />
              </Button>
            </div>
          ) : null}
        </div>
      </main>
      <AuthDialog />
    </div>
  );
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-center gap-2 text-[13px] font-semibold text-darkDelegation" data-onboarding-ready>
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-darkDelegation bg-gold text-onGold">
        <Check size={11} strokeWidth={3} />
      </span>
      {children}
    </p>
  );
}

function NameStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const t = useT();
  const saved = useApp((s) => s.settings.userName);
  const [name, setName] = useState(saved ?? '');
  const word = name.trim();
  // Left by the step list with a name typed and not yet saved: kept, as Next would have (it was dropped; 29 October).
  const decided = useRef(false);
  const typed = useRef(word);
  typed.current = word;
  useEffect(
    () => () => {
      if (!decided.current && typed.current && typed.current !== useApp.getState().settings.userName) void useApp.getState().setSettings({ userName: typed.current });
    },
    [],
  );
  const save = async (value: string | null) => {
    decided.current = true;
    await useApp.getState().setSettings({ userName: value });
    onNext();
  };
  const skipName = async () => {
    decided.current = true;
    await useApp.getState().setSettings({ userName: null });
    onSkip();
  };
  // Bey / Hanım offered only where the whole fits the 40 letters a name is kept to: past it, the kept name was cut
  // mid-word ("… Ha").
  const chips = word && !/\s/.test(word) ? [`${word} Bey`, `${word} Hanım`].filter((one) => one.length <= 40) : [];
  return (
    <div>
      <img src={sitting} alt="" className="mb-4 h-28 w-28" data-onboarding-pyn="sitting" />
      <Heading title={t('onboarding.name.title')}>
        <p>{t('onboarding.name.body')}</p>
      </Heading>
      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (word) void save(word);
        }}
      >
        <label className="mb-1.5 block text-[12px] font-semibold text-darkDelegation" htmlFor="onboarding-name">
          {t('onboarding.name.label')}
        </label>
        <input
          id="onboarding-name"
          className={`${inputClass} h-11 text-[15px]`}
          value={name}
          maxLength={40}
          autoFocus
          placeholder={t('onboarding.name.placeholder')}
          onChange={(event) => setName(event.target.value)}
          data-onboarding-name
        />
        {chips.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((one) => (
              <button
                key={one}
                type="button"
                onClick={() => setName(one)}
                className="rounded-full border border-darkDelegation/20 bg-white px-2.5 py-1 text-[12px] text-zinc-700 hover:border-darkDelegation"
                data-onboarding-name-chip={one}
              >
                {one}
              </button>
            ))}
          </div>
        ) : null}
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">{t('onboarding.name.hint')}</p>
        <div className="mt-8 flex items-center gap-2">
          <span className="flex-1" />
          <Button tone="quiet" onClick={() => void skipName()} data-onboarding-skip>
            {t('onboarding.skip')}
          </Button>
          <Button tone="primary" type="submit" disabled={!word} data-onboarding-next>
            {t('onboarding.next')}
            <ArrowRight size={13} />
          </Button>
        </div>
      </form>
    </div>
  );
}

function VaultStep({ name, missing }: { name: string | null; missing: string | null }) {
  const t = useT();
  const who = useApp((s) => s.settings.userName);
  const choose = () => void useApp.getState().chooseVault(t('app.vault.failed'));
  // No vault yet: made in Documents at once, without a folder dialog; another folder is a button away (1 November:
  // choosing a folder was hard for a first run). Tried once; where it fails, the dialog is what is left.
  const made = useRef(false);
  const [making, setMaking] = useState(false);
  // A vault remembered from an earlier install and gone since (its folder deleted) is no reason to leave the person
  // with nothing: one is made in Documents all the same, and the one not found is named (1 November).
  const [replaced, setReplaced] = useState<string | null>(null);
  useEffect(() => {
    if (name && !missing) return;
    if (made.current) return;
    made.current = true;
    if (missing) setReplaced(missing);
    setMaking(true);
    void useApp
      .getState()
      .createDefaultVault(t('app.vault.failed'))
      .finally(() => setMaking(false));
  }, [name, missing, t]);
  return (
    <div>
      <Heading title={who ? t('onboarding.vault.titleNamed', { name: who }) : t('onboarding.vault.title')}>
        <p>{t('onboarding.vault.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.vault.required')}</p>
      </Heading>
      {missing && !making ? (
        <p className="mt-5 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700" data-onboarding-vault-missing>
          {t('app.vault.missing', { name: missing })}
        </p>
      ) : replaced && name && !missing ? (
        <p className="mt-5 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800" data-onboarding-vault-replaced>
          {t('onboarding.vault.replaced', { name: replaced })}
        </p>
      ) : null}
      {name ? (
        <>
          <Done>{t('onboarding.vault.chosen', { name })}</Done>
          <Button tone="ghost" className="mt-3" onClick={choose} data-onboarding-vault-change>
            <FolderOpen size={13} />
            {t('onboarding.vault.other')}
          </Button>
        </>
      ) : making ? (
        <p className="mt-5 flex items-center gap-2 text-[13px] text-zinc-500" data-onboarding-vault-making>
          <Spinner size={12} />
          {t('onboarding.vault.making')}
        </p>
      ) : (
        <Button tone="primary" className="mt-5" onClick={choose} data-welcome-choose>
          <FolderOpen size={14} />
          {t('welcome.choose')}
        </Button>
      )}
    </div>
  );
}

function PythonStep({ status }: { status: SetupStatus | null }) {
  const t = useT();
  const run = useSetup((s) => s.run);
  // A Python found but not fit - too old, or a launcher with nothing behind it - is said, so the step is not a riddle (desktop-shell-1).
  const wanting = status && !status.python ? pythonWantingText(t, status.pythonWanting) : null;
  return (
    <div>
      <Heading title={t('onboarding.python.title')}>
        <p>{t(wanting ? 'onboarding.python.bodyWanting' : 'onboarding.python.body')}</p>
        {wanting ? (
          <p className="text-[12.5px] font-semibold text-darkDelegation" data-onboarding-python-wanting>
            {wanting}
          </p>
        ) : null}
      </Heading>
      {status?.python ? (
        <Done>{t('onboarding.python.ready')}</Done>
      ) : status?.pythonBundled ? (
        <Button tone="primary" className="mt-5" disabled={Boolean(status.job)} onClick={() => void run('python')} data-onboarding-python>
          <Download size={14} />
          {t('onboarding.python.install', { version: status.pythonBundled })}
        </Button>
      ) : (
        <p className="mt-5 text-[13px] text-zinc-600">
          {t('setup.python.missing')}{' '}
          <a className="font-semibold underline" href="https://www.python.org/downloads/windows/" target="_blank" rel="noreferrer">
            python.org
          </a>
        </p>
      )}
    </div>
  );
}

function EngineStep({ status }: { status: SetupStatus | null }) {
  const t = useT();
  const run = useSetup((s) => s.run);
  const installed = status?.engine.installed ?? null;
  const action = engineAction(status?.engine);
  return (
    <div>
      <Heading title={t('onboarding.engine.title')}>
        <p>{t('onboarding.engine.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.engine.touch')}</p>
        {status && action === 'migrate' ? <p className="text-[12.5px] text-zinc-500">{t('setup.engine.legacy', { installed: installed ?? '', bundled: status.engine.bundled ?? '' })}</p> : null}
      </Heading>
      {!status ? null : !status.python ? (
        <p className="mt-5 text-[13px] text-zinc-600">{t('onboarding.needsPython')}</p>
      ) : installed && !action ? (
        <Done>{t('setup.engine.current', { installed })}</Done>
      ) : action ? (
        <Button tone="primary" className="mt-5" disabled={Boolean(status.job)} onClick={() => void run('engine')} data-onboarding-engine={action}>
          {installed ? <RefreshCw size={14} /> : <Download size={14} />}
          {engineButtonText(t, status.engine)}
        </Button>
      ) : (
        <p className="mt-5 text-[13px] text-zinc-600">{t('setup.engine.noneNoPackage')}</p>
      )}
    </div>
  );
}

/** The vault backed up on GitHub, optional: the same block as Settings › Sunucu (src/ui/GithubConnect.tsx). */
function BackupStep({ status }: { status: SetupStatus | null }) {
  const t = useT();
  return (
    <div>
      <Heading title={t('onboarding.backup.title')}>
        <p>{t('onboarding.backup.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.backup.later')}</p>
      </Heading>
      <div className="mt-5 -mx-3" data-onboarding-backup>
        {status?.engine.installed ? <GithubConnect /> : <p className="px-3 text-[13px] text-zinc-600">{t('onboarding.backup.needsEngine')}</p>}
      </div>
    </div>
  );
}

function VoiceStep({ status, onStarted }: { status: SetupStatus | null; onStarted: () => void }) {
  const t = useT();
  const english = useLanguage() === 'en';
  const wakeConsent = useApp((s) => s.settings.wakeConsent);
  const run = useSetup((s) => s.run);
  const voice = status?.voice ?? null;
  // Its install goes on in the background (the main process): once it has begun - after the microphone question - the
  // next step comes, rather than its progress watched here for minutes (1 November). The end is told by a toast.
  const started = useRef(false);
  useEffect(() => {
    if (started.current && status?.job === 'voice') {
      started.current = false;
      onStarted();
    }
  }, [status?.job, onStarted]);
  return (
    <div>
      <Heading title={t('onboarding.voice.title')}>
        <p>{t('setup.voice.intro')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.voice.later')}</p>
      </Heading>
      {!status ? null : !status.engine.installed ? (
        <p className="mt-5 text-[13px] text-zinc-600">{t('setup.voice.needsEngine')}</p>
      ) : voice?.installed ? (
        <>
          <Done>{t('onboarding.voice.ready')}</Done>
          {/* Set up is not ready: its model loads, the first time downloads, while the app is already open. */}
          <VoiceHelperBar />
          <HotkeyBusy />
          {/* The always-listening mode chosen here, where it is explained: not found later in the settings. */}
          <div className="mt-4 rounded-xl border border-darkDelegation/15 bg-white py-1">
            {/* The phrase as it is set: the words were shown with a "{phrase}" hole in them, and the hint named "Hey Pyn" while it was "Pyn, not al" (windows-e2e-4). */}
            <Switch
              checked={voice.wake && wakeConsent}
              onChange={(wake) => void useSetup.getState().voice({ wake })}
              label={t('setup.voice.wake', { phrase: wakePhraseLabel(voice.wakePhrase, english) })}
              hint={t('setup.voice.wake.hint', { phrase: wakePhraseLabel(voice.wakePhrase, english) })}
              data-onboarding-voice-wake
            />
            <Switch checked={voice.auto} onChange={(auto) => void useSetup.getState().voice({ auto })} label={t('setup.voice.auto')} hint={t('setup.voice.auto.hint')} data-onboarding-voice-auto />
          </div>
        </>
      ) : voice || status.job === 'voice' ? (
        <>
          <Button
            tone="primary"
            className="mt-5"
            disabled={Boolean(status.job)}
            onClick={() => {
              started.current = true;
              void run('voice');
            }}
            data-onboarding-voice
          >
            <Mic size={14} />
            {t('setup.voice.install')}
          </Button>
          {status.job === 'voice' ? (
            <p className="mt-2 text-[12.5px] text-zinc-500" data-onboarding-voice-background>
              {t('onboarding.voice.background')}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-5 text-[13px] text-zinc-600">{t('setup.voice.oldEngine')}</p>
      )}
    </div>
  );
}

function DoneStep({ order, done, skipped, canFinish }: { order: StepId[]; done: Record<StepId, boolean>; skipped: Set<StepId>; canFinish: boolean }) {
  const t = useT();
  const who = useApp((s) => s.settings.userName);
  const job = useSetup((s) => s.status?.job ?? null);
  return (
    <div>
      <img src={pineapple} alt="" className="mb-4 h-24 w-24" data-onboarding-pyn="pineapple" />
      <Heading title={who ? t('onboarding.done.titleNamed', { name: who }) : t('onboarding.done.title')}>
        <p>{t('onboarding.done.body')}</p>
      </Heading>
      <ul className="mt-5 space-y-1.5">
        {order
          .filter((step) => step !== 'done')
          .map((step) => (
            <li key={step} className="flex items-center gap-2 text-[13px] text-zinc-700" data-onboarding-summary={step}>
              {done[step] ? <Check size={13} strokeWidth={3} className="text-darkDelegation" /> : <SkipForward size={13} className="text-zinc-400" />}
              <span className={done[step] ? 'font-semibold text-darkDelegation' : ''}>{t(TITLE[step])}</span>
              {!done[step] ? <span className="text-zinc-400">· {skipped.has(step) ? t('onboarding.skipped') : t('onboarding.notYet')}</span> : null}
            </li>
          ))}
      </ul>
      {job ? <p className="mt-4 text-[12.5px] text-zinc-500">{t('onboarding.done.stillWorking')}</p> : null}
      {!canFinish ? <p className="mt-4 text-[12.5px] text-red-700">{t('onboarding.done.needsVault')}</p> : null}
      <Button
        tone="primary"
        className="mt-7"
        disabled={!canFinish}
        onClick={() => void useApp.getState().setSettings({ onboarded: true })}
        data-onboarding-finish
      >
        {t('onboarding.done.go')}
        <ArrowRight size={13} />
      </Button>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, FolderOpen, KeyRound, LogIn, Mic, RefreshCw, SkipForward } from 'lucide-react';
import face from '../../../tema/ananas/marka/pyn-yuz/pyn-yuz.svg';
import type { CliAuth, CliId } from '@shared/chat';
import type { SetupStatus } from '@shared/setup';
import { AuthDialog, TOOL_NAMES } from '../chat/AuthDialog';
import { useChat } from '../chat/chatStore';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { useSetup } from '../store/setup';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { Progress } from '../ui/SetupSections';
import { Button, Switch, inputClass } from '../ui/ui';

/**
 * The first thing the app shows, until it has been gone through once: Pyn
 * asks how to address the person, then each thing there is to set up comes
 * in turn - the vault, Python where the machine has none, Pyn's memory in the
 * vault, the AI tools, voice typing - each said in a sentence or two, each
 * done here with one button, the optional ones skippable. Nobody has to find
 * any of it in the settings, or type a command. The settings keep all of it
 * for later (src/ui/SettingsDialog.tsx), and can open this again.
 */

type StepId = 'name' | 'vault' | 'python' | 'engine' | 'tools' | 'voice' | 'done';

const TITLE: Record<StepId, Key> = {
  name: 'onboarding.step.name',
  vault: 'onboarding.step.vault',
  python: 'onboarding.step.python',
  engine: 'onboarding.step.engine',
  tools: 'onboarding.step.tools',
  voice: 'onboarding.step.voice',
  done: 'onboarding.step.done',
};

/** The vault and the name are the person's to give; the rest can wait for the settings. */
const OPTIONAL = new Set<StepId>(['name', 'python', 'engine', 'tools', 'voice']);

/**
 * A model server with a model loaded is ready: it was just asked. A sign-in the tool keeps is
 * not proof - it may have run out - so a tool counts only once it is signed in to here.
 */
const serving = (tool: CliAuth) => Boolean(tool.local && tool.signedIn && tool.local.loaded.length);

function newerBundled(status: SetupStatus | null): boolean {
  const { installed, bundled } = status?.engine ?? { installed: null, bundled: null };
  return Boolean(installed && bundled && bundled.localeCompare(installed, undefined, { numeric: true }) > 0);
}

export function Onboarding() {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const vault = useApp((s) => s.vault.vault);
  const status = useSetup((s) => s.status);
  const steps = useSetup((s) => s.steps);
  const error = useSetup((s) => s.error);
  const auth = useChat((s) => s.auth);
  const [at, setAt] = useState<StepId>('name');
  const [skipped, setSkipped] = useState<Set<StepId>>(new Set());
  // Python's step stays in the list once it was needed, so it can be seen done.
  const [neededPython, setNeededPython] = useState(false);
  // The tools signed in to from here: a sign-in opened for them, from its button or after its install, that ended signed in.
  const [fresh, setFresh] = useState<Set<CliId>>(new Set());
  const trying = useRef<Set<CliId>>(new Set());
  // Claude Code being installed from here, or its installer ended without it.
  const [installing, setInstalling] = useState<'running' | 'failed' | null>(null);
  const installRef = useRef(installing);
  installRef.current = installing;
  useEffect(() => {
    const reread = () =>
      useChat
        .getState()
        .loadAuth()
        .then(() => {
          const now = useChat.getState().auth ?? [];
          const signed = [...trying.current].filter((id) => now.find((tool) => tool.id === id)?.signedIn === true);
          // One not signed in yet stays tried: its sign-in may still be going on, or come after its install.
          for (const id of signed) trying.current.delete(id);
          if (signed.length) setFresh((before) => new Set([...before, ...signed]));
          if (installRef.current === 'running') setInstalling(now.find((tool) => tool.id === 'claude')?.installed ? null : 'failed');
        });
    const stop = window.cortex.on.authChanged(() => void reread());
    // Back from a terminal or the browser, where a tool was installed or signed in to: asked again.
    const back = () => void useChat.getState().loadAuth();
    window.addEventListener('focus', back);
    return () => {
      stop();
      window.removeEventListener('focus', back);
    };
  }, []);
  const login = (id: CliId) => {
    trying.current.add(id);
    void window.cortex.chat.login(id).catch(() => trying.current.delete(id));
  };
  const install = (id: CliId) => {
    trying.current.add(id);
    setInstalling('running');
    void window.cortex.chat.install(id).catch(() => {
      trying.current.delete(id);
      setInstalling('failed');
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
    list.push('engine', 'tools');
    if (status?.voiceSupported) list.push('voice');
    list.push('done');
    return list;
  }, [neededPython, status]);

  const done: Record<StepId, boolean> = {
    name: Boolean(settings.userName),
    vault: Boolean(vault),
    python: Boolean(status?.python),
    engine: Boolean(status?.engine.installed) && !newerBundled(status),
    tools: fresh.size > 0 || Boolean(auth?.some(serving)),
    voice: Boolean(status?.voice?.installed),
    done: false,
  };

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
    <div className="relative flex h-full bg-[#f3efe4]" data-onboarding data-onboarding-step={at}>
      <div className="absolute right-4 top-3">
        <LanguageSwitch />
      </div>
      <nav className="flex w-60 shrink-0 flex-col border-r border-darkDelegation/10 px-4 py-8" aria-label={t('onboarding.title')}>
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src={face} alt="" className="h-9 w-9" />
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
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[10px] font-black ${mark === 'done' ? 'border-darkDelegation bg-gold text-darkDelegation' : 'border-darkDelegation/30 text-zinc-500'}`}
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
      <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-10 py-10">
        <div className="w-full max-w-xl">
          {at === 'name' ? <NameStep onNext={next} /> : null}
          {at === 'vault' ? <VaultStep name={vault?.name ?? null} /> : null}
          {at === 'python' ? <PythonStep status={status} /> : null}
          {at === 'engine' ? <EngineStep status={status} /> : null}
          {at === 'tools' ? <ToolsStep auth={auth} fresh={fresh} installing={installing} onLogin={login} onInstall={install} /> : null}
          {at === 'voice' ? <VoiceStep status={status} /> : null}
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

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <>
      <h1 className="font-display text-3xl text-darkDelegation">{title}</h1>
      {children ? <div className="mt-3 space-y-2 text-[14px] leading-relaxed text-zinc-700">{children}</div> : null}
    </>
  );
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-center gap-2 text-[13px] font-semibold text-darkDelegation" data-onboarding-ready>
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-darkDelegation bg-gold">
        <Check size={11} strokeWidth={3} />
      </span>
      {children}
    </p>
  );
}

function NameStep({ onNext }: { onNext: () => void }) {
  const t = useT();
  const saved = useApp((s) => s.settings.userName);
  const [name, setName] = useState(saved ?? '');
  const word = name.trim();
  const save = async (value: string | null) => {
    await useApp.getState().setSettings({ userName: value });
    onNext();
  };
  return (
    <div>
      <img src={face} alt="" className="mb-5 h-24 w-24" />
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
        {word && !/\s/.test(word) ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[`${word} Bey`, `${word} Hanım`].map((one) => (
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
          <Button tone="quiet" onClick={() => void save(null)} data-onboarding-skip>
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

function VaultStep({ name }: { name: string | null }) {
  const t = useT();
  const who = useApp((s) => s.settings.userName);
  const choose = () => void useApp.getState().chooseVault(t('app.vault.failed'));
  return (
    <div>
      <Heading title={who ? t('onboarding.vault.titleNamed', { name: who }) : t('onboarding.vault.title')}>
        <p>{t('onboarding.vault.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.vault.required')}</p>
      </Heading>
      {name ? (
        <>
          <Done>{t('onboarding.vault.chosen', { name })}</Done>
          <Button tone="ghost" className="mt-3" onClick={choose} data-onboarding-vault-change>
            <FolderOpen size={13} />
            {t('settings.vault.change')}
          </Button>
        </>
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
  return (
    <div>
      <Heading title={t('onboarding.python.title')}>
        <p>{t('onboarding.python.body')}</p>
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
  const bundled = status?.engine.bundled ?? null;
  const newer = newerBundled(status);
  return (
    <div>
      <Heading title={t('onboarding.engine.title')}>
        <p>{t('onboarding.engine.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.engine.touch')}</p>
      </Heading>
      {!status ? null : !status.python ? (
        <p className="mt-5 text-[13px] text-zinc-600">{t('onboarding.needsPython')}</p>
      ) : installed && !newer ? (
        <Done>{t('setup.engine.current', { installed })}</Done>
      ) : bundled ? (
        <Button tone="primary" className="mt-5" disabled={Boolean(status.job)} onClick={() => void run('engine')} data-onboarding-engine>
          {installed ? <RefreshCw size={14} /> : <Download size={14} />}
          {installed ? t('setup.engine.update', { bundled }) : t('setup.engine.install')}
        </Button>
      ) : (
        <p className="mt-5 text-[13px] text-zinc-600">{t('setup.engine.noneNoPackage')}</p>
      )}
    </div>
  );
}

function ToolsStep({
  auth,
  fresh,
  installing,
  onLogin,
  onInstall,
}: {
  auth: CliAuth[] | null;
  fresh: Set<CliId>;
  installing: 'running' | 'failed' | null;
  onLogin: (id: CliId) => void;
  onInstall: (id: CliId) => void;
}) {
  const t = useT();
  const refused = useChat((s) => s.authFailed);
  const tools = (auth ?? []).filter((tool) => tool.installed);
  // Claude Code missing, and installable from here (Windows): offered first, with its sign-in after.
  const claude = auth?.find((tool) => tool.id === 'claude');
  const offerInstall = Boolean(claude && !claude.installed && claude.canInstall);
  const state = (tool: CliAuth): [Key, string] =>
    tool.local
      ? serving(tool)
        ? ['onboarding.tools.serving', 'bg-good/15 text-good']
        : ['onboarding.tools.noModel', 'bg-zinc-100 text-zinc-500']
      : fresh.has(tool.id)
        ? ['onboarding.tools.fresh', 'bg-good/15 text-good']
        : refused.includes(tool.id)
          ? ['auth.status.refused', 'bg-bad/10 text-bad']
          : tool.signedIn === true
            ? ['onboarding.tools.kept', 'bg-gold/25 text-darkDelegation']
            : tool.signedIn === false
              ? ['auth.status.out', 'bg-zinc-100 text-zinc-600']
              : ['auth.status.unknown', 'bg-zinc-100 text-zinc-500'];
  return (
    <div>
      <Heading title={t('onboarding.tools.title')}>
        <p>{t('onboarding.tools.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.tools.honest')}</p>
      </Heading>
      {offerInstall ? (
        <div className="mt-5 rounded-xl border border-darkDelegation/25 bg-white px-4 py-3.5" data-onboarding-install="claude">
          <p className="text-[13.5px] font-semibold text-darkDelegation">{t('onboarding.tools.install.title')}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-600">{t('onboarding.tools.install.body')}</p>
          <Button tone="primary" className="mt-3" disabled={installing === 'running'} onClick={() => onInstall('claude')} data-onboarding-install-start>
            <Download size={14} />
            {t('onboarding.tools.install')}
          </Button>
          {installing === 'running' ? <p className="mt-2 text-[12px] text-zinc-500" data-onboarding-installing>{t('onboarding.tools.installing')}</p> : null}
          {installing === 'failed' ? <p className="mt-2 text-[12px] font-semibold text-bad" data-onboarding-install-failed>{t('onboarding.tools.installFailed')}</p> : null}
        </div>
      ) : auth && !tools.length ? (
        <p className="mt-5 text-[13px] text-zinc-600">{t('onboarding.tools.none')}</p>
      ) : null}
      <ul className={`mt-5 divide-y divide-zinc-100 rounded-xl border border-darkDelegation/15 bg-white${tools.length ? '' : ' hidden'}`} data-onboarding-tool-list>
        {tools.map((tool) => {
          const [words, colours] = state(tool);
          return (
            <li key={tool.id} className="flex items-center gap-3 px-3 py-2.5" data-onboarding-tool={tool.id}>
              <span className="min-w-0 flex-1 text-[13px] font-semibold text-darkDelegation">{TOOL_NAMES[tool.id] ?? tool.id}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${colours}`} data-onboarding-tool-state={words}>
                {t(words)}
              </span>
              {tool.canLogin && !fresh.has(tool.id) ? (
                <Button tone={tool.signedIn === true ? 'ghost' : 'primary'} className="h-8 shrink-0" onClick={() => onLogin(tool.id)} data-onboarding-tool-login={tool.id}>
                  <LogIn size={12} />
                  {t(tool.signedIn === true ? 'onboarding.tools.again' : 'onboarding.tools.signIn')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button tone="quiet" className="mt-3" onClick={() => useChat.getState().openAuth()} data-onboarding-tools>
        <KeyRound size={13} />
        {t('onboarding.tools.keys')}
      </Button>
    </div>
  );
}

function VoiceStep({ status }: { status: SetupStatus | null }) {
  const t = useT();
  const run = useSetup((s) => s.run);
  const voice = status?.voice ?? null;
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
          {/* The always-listening mode chosen here, where it is explained: not found later in the settings. */}
          <div className="mt-4 rounded-xl border border-darkDelegation/15 bg-white py-1">
            <Switch checked={voice.wake} onChange={(wake) => void useSetup.getState().voice({ wake })} label={t('setup.voice.wake')} hint={t('setup.voice.wake.hint')} data-onboarding-voice-wake />
            <Switch checked={voice.auto} onChange={(auto) => void useSetup.getState().voice({ auto })} label={t('setup.voice.auto')} hint={t('setup.voice.auto.hint')} data-onboarding-voice-auto />
          </div>
        </>
      ) : voice || status.job === 'voice' ? (
        <Button tone="primary" className="mt-5" disabled={Boolean(status.job)} onClick={() => void run('voice')} data-onboarding-voice>
          <Mic size={14} />
          {t('setup.voice.install')}
        </Button>
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
      <img src={face} alt="" className="mb-5 h-20 w-20" />
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

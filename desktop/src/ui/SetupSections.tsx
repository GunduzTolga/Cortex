import { useEffect } from 'react';
import { Download, Mic, RefreshCw } from 'lucide-react';
import type { SetupJob, SetupStatus } from '@shared/setup';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { useSetup } from '../store/setup';
import { Section } from './settingsParts';
import { Button, Spinner, Switch } from './ui';

/**
 * Cortex set up from the settings window (shared/setup.ts): the memory
 * engine in the vault, installed or updated from the package that came with
 * the app, and voice typing for yakala, with its steps shown as they come.
 * What is there to do is one button; nothing is asked of a terminal.
 */

const ENGINE_NAME: Record<'cuda' | 'vulkan' | 'islemci', Key> = {
  cuda: 'setup.voice.engine.cuda',
  vulkan: 'setup.voice.engine.vulkan',
  islemci: 'setup.voice.engine.islemci',
};

function Note({ children, tone = 'muted', data }: { children: React.ReactNode; tone?: 'muted' | 'error'; data?: string }) {
  return (
    <p className={`px-3 text-[11.5px] leading-relaxed ${tone === 'error' ? 'text-red-700' : 'text-zinc-500'}`} data-setup-note={data}>
      {children}
    </p>
  );
}

/** What a job said last, its spinner beside it. */
export function Progress({ job, lines }: { job: SetupJob; lines: string[] }) {
  const t = useT();
  return (
    <div className="mx-3 mt-2 rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2" data-setup-progress={job}>
      <div className="flex items-center gap-2 text-[12px] font-semibold text-darkDelegation">
        <Spinner size={12} label={t('setup.working')} />
        {t(job === 'python' ? 'setup.python.working' : job === 'engine' ? 'setup.engine.working' : 'setup.voice.working')}
      </div>
      {lines.length ? (
        <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-zinc-500">
          {lines.map((line, i) => (
            <li key={i} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EngineSection({ status }: { status: SetupStatus }) {
  const t = useT();
  const steps = useSetup((s) => s.steps);
  const error = useSetup((s) => s.error);
  const run = useSetup((s) => s.run);
  const { installed, bundled } = status.engine;
  const busy = status.job !== null;
  const newer = Boolean(installed && bundled && bundled.localeCompare(installed, undefined, { numeric: true }) > 0);
  return (
    <Section title={t('setup.engine')} data="cortex">
      {!status.python ? (
        <Note tone="error" data="no-python">
          {t('setup.python.missing')}{' '}
          <a className="font-semibold underline" href="https://www.python.org/downloads/windows/" target="_blank" rel="noreferrer">
            python.org
          </a>
        </Note>
      ) : installed ? (
        <Note data="installed">{newer ? t('setup.engine.older', { installed, bundled: bundled ?? '' }) : t('setup.engine.current', { installed })}</Note>
      ) : (
        <Note data="none">{bundled ? t('setup.engine.none') : t('setup.engine.noneNoPackage')}</Note>
      )}
      {status.python && bundled && (!installed || newer) ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" disabled={busy} onClick={() => void run('engine')} data-setup-engine>
            {installed ? <RefreshCw size={13} /> : <Download size={13} />}
            {installed ? t('setup.engine.update', { bundled }) : t('setup.engine.install')}
          </Button>
        </div>
      ) : null}
      {steps?.job === 'engine' ? <Progress job="engine" lines={steps.lines} /> : null}
      {error?.job === 'engine' ? (
        <div className="mt-2">
          <Note tone="error" data="engine-error">
            {error.text}
          </Note>
        </div>
      ) : null}
    </Section>
  );
}

function VoiceSection({ status }: { status: SetupStatus }) {
  const t = useT();
  const steps = useSetup((s) => s.steps);
  const error = useSetup((s) => s.error);
  const run = useSetup((s) => s.run);
  const set = useSetup((s) => s.voice);
  const voice = status.voice;
  const busy = status.job !== null;
  return (
    <Section title={t('setup.voice')} data="voice">
      {!status.engine.installed ? (
        <Note data="needs-engine">{t('setup.voice.needsEngine')}</Note>
      ) : !voice ? (
        status.job === 'voice' ? null : <Note data="old-engine">{t('setup.voice.oldEngine')}</Note>
      ) : voice.installed ? (
        <>
          <Switch checked={voice.on} onChange={(on) => void set({ on })} label={t('setup.voice.on')} hint={t('setup.voice.on.hint')} data-setup-voice-on />
          <Switch checked={voice.auto} onChange={(auto) => void set({ auto })} label={t('setup.voice.auto')} hint={t('setup.voice.auto.hint')} data-setup-voice-auto />
          <Switch checked={voice.wake} onChange={(wake) => void set({ wake })} label={t('setup.voice.wake')} hint={t('setup.voice.wake.hint')} data-setup-voice-wake />
          <Note data="engine">{t('setup.voice.engine', { engine: t(ENGINE_NAME[voice.engine]), model: voice.model ?? '' })}</Note>
        </>
      ) : (
        <Note data="not-installed">{t('setup.voice.intro')}</Note>
      )}
      {status.engine.installed && status.python && (status.job === 'voice' || (voice && !voice.installed)) ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" disabled={busy} onClick={() => void run('voice')} data-setup-voice>
            <Mic size={13} />
            {t('setup.voice.install')}
          </Button>
        </div>
      ) : null}
      {steps?.job === 'voice' ? <Progress job="voice" lines={steps.lines} /> : status.job === 'voice' ? <Progress job="voice" lines={[]} /> : null}
      {error?.job === 'voice' ? (
        <div className="mt-2">
          <Note tone="error" data="voice-error">
            {error.text}
          </Note>
        </div>
      ) : null}
    </Section>
  );
}

export function SetupSections({ open }: { open: boolean }) {
  const status = useSetup((s) => s.status);
  const refresh = useSetup((s) => s.refresh);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  if (!status || !status.vault) return null;
  return (
    <>
      <EngineSection status={status} />
      {status.voiceSupported ? <VoiceSection status={status} /> : null}
    </>
  );
}

import { useEffect, useState } from 'react';
import { Download, Mic, RefreshCw, RotateCcw } from 'lucide-react';
import { COMMAND_WORDS, VOICE_COMMANDS, WAKE_PHRASES, wakePhraseLabel } from '@shared/setup';
import type { SetupJob, SetupStatus, VoiceCommands, WakePhrase } from '@shared/setup';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { useSetup } from '../store/setup';
import { Row, SaveButton, Section, Segments } from './settingsParts';
import { Button, Spinner, Switch, inputClass } from './ui';

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

/** A command's words, comma separated; kept when the field is left or Enter is pressed. */
function CommandWords({ name, words, busy }: { name: keyof VoiceCommands; words: string[]; busy: boolean }) {
  const set = useSetup((s) => s.voice);
  const shown = words.join(', ');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const asked = text
    .split(',')
    .map((one) => one.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const changed = asked.join(', ') !== shown;
  const keep = () => {
    if (changed) void set({ commands: { [name]: asked } });
    else setText(shown);
  };
  return (
    <>
    {changed ? <SaveButton onSave={keep} data="setup-voice-command-save" /> : null}
    <input
      className={`${inputClass.replace('w-full', '')} h-8 w-56 shrink-0`}
      value={text}
      disabled={busy}
      maxLength={COMMAND_WORDS.most * (COMMAND_WORDS.longest + 2)}
      onChange={(event) => setText(event.target.value)}
      onBlur={keep}
      onKeyDown={(event) => {
        if (event.key === 'Enter') keep();
      }}
      data-setup-voice-command={name}
    />
    </>
  );
}

/** What can be said into yakala's window, each command's words editable. */
function VoiceCommandsBlock({ commands, busy }: { commands: VoiceCommands; busy: boolean }) {
  const t = useT();
  const set = useSetup((s) => s.voice);
  return (
    <div className="mt-3" data-setup-voice-commands>
      <h4 className="px-3 text-[12px] font-bold text-darkDelegation">{t('setup.voice.commands')}</h4>
      <Note>{t('setup.voice.commands.intro')}</Note>
      {VOICE_COMMANDS.map((name) => (
        <div key={name} className="flex items-start gap-3 px-3 py-1.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-darkDelegation">{t(`setup.voice.cmd.${name}` as Key)}</span>
            <span className="block text-[11.5px] leading-snug text-zinc-500">{t(`setup.voice.cmd.${name}.hint` as Key)}</span>
          </span>
          <CommandWords name={name} words={commands[name]} busy={busy} />
        </div>
      ))}
      <div className="mt-1 px-3">
        <Button tone="ghost" disabled={busy} onClick={() => void set({ defaultCommands: true })} data-setup-voice-commands-reset>
          <RotateCcw size={13} />
          {t('setup.voice.commands.reset')}
        </Button>
      </div>
    </div>
  );
}

function VoiceSection({ status }: { status: SetupStatus }) {
  const t = useT();
  const english = useLanguage() === 'en';
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
          <Switch
            checked={voice.wake}
            onChange={(wake) => void set({ wake })}
            label={t('setup.voice.wake', { phrase: wakePhraseLabel(voice.wakePhrase, english) })}
            hint={t('setup.voice.wake.hint', { phrase: wakePhraseLabel(voice.wakePhrase, english) })}
            data-setup-voice-wake
          />
          <Row label={t('setup.voice.phrase')}>
            <Segments<WakePhrase>
              label={t('setup.voice.phrase')}
              data="setup-voice-phrase"
              chosen={voice.wakePhrase}
              onChoose={(wakePhrase) => void set({ wakePhrase })}
              options={WAKE_PHRASES.map((phrase) => ({ id: phrase, label: phrase === 'ikisi' ? t('setup.voice.phrase.both') : wakePhraseLabel(phrase) }))}
            />
          </Row>
          <Note data="phrase">{t(voice.wakePhrase === 'hey pyn' ? 'setup.voice.phrase.hey' : voice.wakePhrase === 'ikisi' ? 'setup.voice.phrase.ikisi' : 'setup.voice.phrase.notAl')}</Note>
          <Note data="engine">{t('setup.voice.engine', { engine: t(ENGINE_NAME[voice.engine]), model: voice.model ?? '' })}</Note>
          {voice.commands ? <VoiceCommandsBlock commands={voice.commands} busy={busy} /> : null}
          {voice.readsFiles === false ? <Note data="update">{t('setup.voice.update.hint')}</Note> : null}
        </>
      ) : (
        <Note data="not-installed">{t('setup.voice.intro')}</Note>
      )}
      {status.engine.installed && status.python && (status.job === 'voice' || (voice && (!voice.installed || voice.readsFiles === false))) ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" disabled={busy} onClick={() => void run('voice')} data-setup-voice>
            <Mic size={13} />
            {t(voice?.installed ? 'setup.voice.update' : 'setup.voice.install')}
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

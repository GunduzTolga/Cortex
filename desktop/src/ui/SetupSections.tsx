import { useEffect, useState } from 'react';
import { Check, Download, Keyboard, Mic, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { COMMAND_WORDS, CPU_MODELS, HOTKEYS, VOICE_COMMANDS, WAKE_PHRASES, engineAction, hotkeyLabel, percentOfStep, wakePhraseLabel } from '@shared/setup';
import type { CpuModel, Hotkey, ListenerWord, SetupJob, SetupStatus, VoiceCommands, WakePhrase, WakeTrouble } from '@shared/setup';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { useApp } from '../store/app';
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

/** A bar: how far, or, without a percent, that something is going on. */
export function Bar({ percent }: { percent: number | null }) {
  return (
    <div
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      data-setup-bar={percent ?? 'busy'}
    >
      <div className={`h-full rounded-full bg-darkDelegation transition-[width] duration-500 ${percent === null ? 'w-1/3 animate-pulse' : ''}`} style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

/** What a job said last, its spinner beside it; a download's percent as a bar. */
export function Progress({ job, lines }: { job: SetupJob; lines: string[] }) {
  const t = useT();
  const last = lines.length ? percentOfStep(lines[lines.length - 1]) : null;
  return (
    <div className="mx-3 mt-2 rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2" data-setup-progress={job}>
      <div className="flex items-center gap-2 text-[12px] font-semibold text-darkDelegation">
        <Spinner size={12} label={t('setup.working')} />
        {t(job === 'python' ? 'setup.python.working' : job === 'engine' ? 'setup.engine.working' : 'setup.voice.working')}
      </div>
      <Bar percent={last} />
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

/** Why the Pythons found are not used, said before what to do about it: one too old, or a launcher with nothing behind it. */
export function pythonWantingText(t: ReturnType<typeof useT>, wanting: string | null): string | null {
  if (wanting === 'broken') return t('setup.python.broken');
  return wanting ? t('setup.python.tooOld', { version: wanting }) : null;
}

/** The engine's button, as there is something to do about it (shared/setup.ts, engineAction). */
export function engineButtonText(t: ReturnType<typeof useT>, engine: SetupStatus['engine']): string {
  const action = engineAction(engine);
  const bundled = engine.bundled ?? '';
  return action === 'update' ? t('setup.engine.update', { bundled }) : action === 'refresh' ? t('setup.engine.refresh') : action === 'migrate' ? t('setup.engine.migrate', { bundled }) : t('setup.engine.install');
}

function EngineSection({ status }: { status: SetupStatus }) {
  const t = useT();
  const steps = useSetup((s) => s.steps);
  const error = useSetup((s) => s.error);
  const run = useSetup((s) => s.run);
  const { installed, bundled } = status.engine;
  const busy = status.job !== null;
  const action = engineAction(status.engine);
  const wanting = pythonWantingText(t, status.pythonWanting);
  return (
    <Section title={t('setup.engine')} data="cortex">
      {!status.python ? (
        // Python offered here too, not only on the first-run screen: someone past it has nowhere else to find it (desktop-shell-1).
        <>
          <Note tone="error" data="no-python">
            {/* Why first - one too old, a launcher with nothing behind it, or none at all - then what the app can do. */}
            {wanting ? `${wanting} ` : status.pythonBundled ? `${t('setup.python.none')} ` : null}
            {status.pythonBundled ? (
              t('setup.python.bundled', { version: status.pythonBundled })
            ) : (
              <>
                {wanting ? null : `${t('setup.python.missing')} `}
                <a className="font-semibold underline" href="https://www.python.org/downloads/windows/" target="_blank" rel="noreferrer">
                  python.org
                </a>
              </>
            )}
          </Note>
          {status.pythonBundled ? (
            <div className="mt-2 px-3">
              <Button tone="ghost" disabled={busy} onClick={() => void run('python')} data-setup-python>
                <Download size={13} />
                {t('onboarding.python.install', { version: status.pythonBundled })}
              </Button>
            </div>
          ) : null}
        </>
      ) : installed ? (
        <Note data="installed">
          {action === 'update'
            ? t('setup.engine.older', { installed, bundled: bundled ?? '' })
            : action === 'refresh'
              ? t('setup.engine.stale', { installed })
              : action === 'migrate' || status.engine.legacy
                ? t('setup.engine.legacy', { installed, bundled: bundled ?? '' })
                : t('setup.engine.current', { installed })}
        </Note>
      ) : (
        <Note data="none">{bundled ? t('setup.engine.none') : t('setup.engine.noneNoPackage')}</Note>
      )}
      {status.python && action ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" disabled={busy} onClick={() => void run('engine')} data-setup-engine={action}>
            {installed ? <RefreshCw size={13} /> : <Download size={13} />}
            {engineButtonText(t, status.engine)}
          </Button>
        </div>
      ) : null}
      {steps?.job === 'python' ? <Progress job="python" lines={steps.lines} /> : null}
      {steps?.job === 'engine' ? <Progress job="engine" lines={steps.lines} /> : null}
      {error?.job === 'engine' || error?.job === 'python' ? (
        <div className="mt-2">
          <Note tone="error" data={`${error.job}-error`}>
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

const WAKE_TROUBLE: Record<WakeTrouble, Key> = {
  mikrofon: 'setup.voice.wake.trouble.mikrofon',
  sessiz: 'setup.voice.wake.trouble.sessiz',
  model: 'setup.voice.wake.trouble.model',
};

/**
 * The voice getting ready, as yakala's listener says it: a model being fetched (how far), loading,
 * ready, or failed and tried again. The app opens at once while this goes on in the background:
 * here it is seen, not a voice that seems not to work. And what keeps it from working though it is
 * set up: no listener running, the wake phrase not hearing its microphone. The key another app holds
 * is said apart (`HotkeyBusy`): it is there with voice typing off too.
 */
export function VoiceHelperBar() {
  const t = useT();
  const english = useLanguage() === 'en';
  const listener = useSetup((s) => s.listener);
  const busy = useSetup((s) => s.listenerBusy);
  const restart = useSetup((s) => s.restartListener);
  const phrase = wakePhraseLabel(useSetup((s) => s.status?.voice?.wakePhrase), english);
  if (listener.missing) {
    // Nothing runs that hears the key, the phrase or the microphone: set up again, it starts (windows-e2e-5).
    return (
      <div className="mx-3 mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5" data-setup-voice-helper="calismiyor">
        <p className="text-[12px] font-semibold text-red-700">{t('setup.voice.listener.missing')}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-600">{t('setup.voice.listener.missingHint', { phrase })}</p>
        <Button tone="ghost" className="mt-1.5" disabled={busy} onClick={() => void restart()} data-setup-voice-listener-restart>
          {busy ? <Spinner size={12} label={t('setup.working')} /> : <Play size={13} />}
          {t('setup.voice.listener.restart')}
        </Button>
      </div>
    );
  }
  const word = listener.word;
  if (!word || word.ses === 'yok' || word.ses === 'kapali') return null;
  return (
    <>
      <HelperState word={word} phrase={phrase} />
      <WakeTroubleNote word={word} english={english} />
    </>
  );
}

function HelperState({ word, phrase }: { word: ListenerWord; phrase: string }) {
  const t = useT();
  if (word.ses === 'hazir') {
    return (
      <p className="mx-3 mt-1 flex items-center gap-1.5 text-[12px] font-semibold text-good" data-setup-voice-helper="hazir">
        <Check size={13} strokeWidth={3} />
        {word.model ? t('setup.voice.helper.ready', { model: word.model }) : t('setup.voice.helper.readyBare')}
      </p>
    );
  }
  if (word.ses === 'hata') {
    return (
      <div className="mt-1" data-setup-voice-helper="hata">
        <Note tone="error">{t('setup.voice.helper.error', { message: word.mesaj })}</Note>
      </div>
    );
  }
  const percent = word.mb !== null && word.toplam ? Math.min(100, Math.floor((word.mb * 100) / word.toplam)) : null;
  return (
    <div className="mx-3 mt-2 rounded-xl border border-gold/50 bg-gold/10 px-3 py-2.5" data-setup-voice-helper="yukleniyor">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-darkDelegation">
        <Spinner size={12} label={t('setup.working')} />
        {percent !== null ? t('setup.voice.helper.downloading', { mb: word.mb ?? 0, total: word.toplam ?? 0, percent }) : t('setup.voice.helper.loading')}
      </div>
      <Bar percent={percent} />
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-500">{t('setup.voice.helper.hint', { phrase })}</p>
    </div>
  );
}

/** The wake phrase that cannot hear, and why (voice-4). */
function WakeTroubleNote({ word, english }: { word: ListenerWord; english: boolean }) {
  const t = useT();
  if (!word.uyandirma_sorun) return null;
  // The engine's sentence says what to do, Windows' privacy switch by name; it is Turkish.
  const why = !english && word.uyandirma_mesaj ? word.uyandirma_mesaj : t(WAKE_TROUBLE[word.uyandirma_sorun]);
  return (
    <div className="mt-1" data-setup-voice-wake-trouble={word.uyandirma_sorun}>
      <Note tone="error">{t('setup.voice.wake.trouble', { why })}</Note>
    </div>
  );
}

/**
 * The key another app holds, and the keys yakala can move to (yakala-6). Said with voice typing or without it: yakala's
 * listener holds the key either way, and the key is how most people take a note. Where the vault has its engine, which
 * sets yakala up again on the key chosen.
 */
export function HotkeyBusy() {
  const t = useT();
  const listener = useSetup((s) => s.listener);
  const busy = useSetup((s) => s.listenerBusy);
  const move = useSetup((s) => s.hotkey);
  if (listener.missing || listener.word?.kisayol !== 'mesgul') return null;
  const key = listener.hotkey ?? hotkeyLabel(HOTKEYS[0]);
  return (
    <div className="mx-3 mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5" data-setup-voice-key-busy>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-red-700">
        <Keyboard size={13} />
        {t('setup.voice.key.busy', { key })}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-600">{t('setup.voice.key.busyHint')}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <Segments<Hotkey>
          label={t('setup.voice.key.choose')}
          data="setup-voice-key"
          chosen={HOTKEYS.find((one) => hotkeyLabel(one) === key) ?? null}
          onChoose={(spec) => {
            if (!busy && hotkeyLabel(spec) !== key) void move(spec);
          }}
          options={HOTKEYS.map((one) => ({ id: one, label: hotkeyLabel(one) }))}
        />
        {busy ? <Spinner size={12} label={t('setup.working')} /> : null}
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
  // Listening all the time counts once it is allowed here: on in the engine without it, the microphone does not listen.
  const wakeConsent = useApp((s) => s.settings.wakeConsent);
  // The voice helper failing to start, again and again (an environment left half built, a Python removed since): set
  // up again from here, which mends its environment, where before nothing in the app could (voice-8).
  const helperFailing = useSetup((s) => s.listener.word?.ses === 'hata');
  return (
    <Section title={t('setup.voice')} data="voice">
      {status.engine.installed ? <HotkeyBusy /> : null}
      {!status.engine.installed ? (
        <Note data="needs-engine">{t('setup.voice.needsEngine')}</Note>
      ) : !voice ? (
        status.job === 'voice' ? null : <Note data="old-engine">{t('setup.voice.oldEngine')}</Note>
      ) : voice.installed ? (
        <>
          {voice.on ? <VoiceHelperBar /> : null}
          <Switch checked={voice.on} onChange={(on) => void set({ on })} label={t('setup.voice.on')} hint={t('setup.voice.on.hint')} data-setup-voice-on />
          <Switch checked={voice.auto} onChange={(auto) => void set({ auto })} label={t('setup.voice.auto')} hint={t('setup.voice.auto.hint')} data-setup-voice-auto />
          <Switch
            checked={voice.wake && wakeConsent}
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
          {voice.engine === 'islemci' && voice.cpuModel ? (
            // On the processor, the model is a choice between quick and accurate: large-v3-turbo took half a minute a sentence on a laptop.
            <>
              <Row label={t('setup.voice.cpuModel')}>
                <Segments<CpuModel>
                  label={t('setup.voice.cpuModel')}
                  data="setup-voice-cpu-model"
                  chosen={voice.cpuModel}
                  onChoose={(cpuModel) => void set({ cpuModel })}
                  options={CPU_MODELS.map((one) => ({ id: one, label: t(one === 'small' ? 'setup.voice.cpuModel.small' : 'setup.voice.cpuModel.large') }))}
                />
              </Row>
              <Note data="cpu-model">{t('setup.voice.cpuModel.hint')}</Note>
            </>
          ) : null}
          {voice.commands ? <VoiceCommandsBlock commands={voice.commands} busy={busy} /> : null}
          {voice.readsFiles === false ? <Note data="update">{t('setup.voice.update.hint')}</Note> : null}
        </>
      ) : (
        <Note data="not-installed">{t('setup.voice.intro')}</Note>
      )}
      {voice?.installed && voice.readsFiles !== false && helperFailing ? <Note data="repair">{t('setup.voice.repair.hint')}</Note> : null}
      {status.engine.installed && status.python && (status.job === 'voice' || (voice && (!voice.installed || voice.readsFiles === false || helperFailing))) ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" disabled={busy} onClick={() => void run('voice')} data-setup-voice>
            <Mic size={13} />
            {t(!voice?.installed ? 'setup.voice.install' : voice.readsFiles === false ? 'setup.voice.update' : 'setup.voice.repair')}
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
    if (!open) return;
    void refresh();
    // Back from where Python or a model was installed: read again, not at the app's next start.
    const back = () => void refresh();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [open, refresh]);
  if (!status || !status.vault) return null;
  return (
    <>
      <EngineSection status={status} />
      {status.voiceSupported ? <VoiceSection status={status} /> : null}
    </>
  );
}

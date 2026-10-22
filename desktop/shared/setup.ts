/**
 * Setting Cortex up from the app, never from a terminal: the vault's memory
 * engine, installed or updated from the package that came with the app, and
 * voice typing for yakala (Windows). Each job runs the vault's own engine
 * (`beyin.py`) in the main process (electron/services/setup.ts); the window
 * starts it and is told how it goes.
 */

/** What writes speech: an NVIDIA card (CUDA), an AMD or Intel Arc card (Vulkan, whisper.cpp), or the processor. */
export type VoiceEngine = 'cuda' | 'vulkan' | 'islemci';

/** What writes on the processor: `small`, quick, or `large-v3-turbo`, more accurate and far slower there (beyin_v3_ses.CPU_MODELS). */
export type CpuModel = 'small' | 'large-v3-turbo';
export const CPU_MODELS: readonly CpuModel[] = ['small', 'large-v3-turbo'];

export interface VoiceStatus {
  installed: boolean;
  /** Voice typing on in yakala. */
  on: boolean;
  /** "Pyn, not al" opens yakala; while on, the microphone listens all the time. */
  wake: boolean;
  /** Yakala's window listens as it opens; typing lets the microphone go. */
  auto: boolean;
  engine: VoiceEngine;
  /** The model and where it runs, as the engine says it: `large-v3-turbo (ekran kartı, Vulkan)`. */
  model: string | null;
  /** The spoken commands' words; null from an engine that cannot set them yet. */
  commands: VoiceCommands | null;
  /** What opens yakala while the microphone listens all the time. */
  wakePhrase: WakePhrase;
  /** A recorded file can be written out (a Telegram voice note); false for a whisper.cpp setup from before 1.0.26, which `kur` again mends. */
  readsFiles?: boolean;
  /** On the processor, which model writes (`ses ayar --islemci-modeli`); null from an engine that cannot choose. */
  cpuModel?: CpuModel | null;
}

/** The wake phrases there are: Pyn's name first, or last, or either of the two ('ikisi'). */
export type WakePhrase = 'pyn not al' | 'hey pyn' | 'ikisi';
export const WAKE_PHRASES: readonly WakePhrase[] = ['pyn not al', 'hey pyn', 'ikisi'];

/** A wake phrase as a person says it, in quotes: “Pyn, not al”, “Hey Pyn”, or both. */
export function wakePhraseLabel(phrase: WakePhrase | null | undefined, english = false): string {
  if (phrase === 'ikisi') return `“Hey Pyn” ${english ? 'or' : 'ya da'} “Pyn, not al”`;
  return phrase === 'hey pyn' ? '“Hey Pyn”' : '“Pyn, not al”';
}

/** What can be said into yakala's window, each by the words set for it (`ses ayar --komutlar`). */
export interface VoiceCommands {
  /** Writes and saves; at a sentence's end too ("…, kaydet"). */
  kaydet: string[];
  /** The picture copied last goes with the note; at a sentence's end too. */
  resim_ekle: string[];
  /** Save too, but only right after Pyn's name ("Pyn, gönder"): anywhere else they are the note's words. */
  adla_kaydet: string[];
  /** Takes the last word back; at a sentence's end too. */
  kelime_sil: string[];
  /** Takes the last sentence back; at a sentence's end too. */
  cumle_sil: string[];
  /** Empties the field, said alone. */
  sil: string[];
  /** Closes the window without saving, said alone. */
  iptal: string[];
}

export const VOICE_COMMANDS = ['kaydet', 'adla_kaydet', 'resim_ekle', 'kelime_sil', 'cumle_sil', 'sil', 'iptal'] as const;

/** A command's words as a person may set them; the engine checks them again. */
export const COMMAND_WORDS = { most: 8, longest: 40 } as const;

export interface VoicePatch {
  on?: boolean;
  wake?: boolean;
  auto?: boolean;
  /** Each command given takes these words; the others keep theirs. */
  commands?: Partial<VoiceCommands>;
  /** Every command back to its first words. */
  defaultCommands?: boolean;
  wakePhrase?: WakePhrase;
  cpuModel?: CpuModel;
}

export type SetupJob = 'python' | 'engine' | 'voice';

export interface SetupStatus {
  /** A Python the engine can run on was found - one that runs, 3.11 or newer; without one nothing below can run. */
  python: boolean;
  /**
   * Why the Pythons found are not used, when none is: the newest one's version where it is too old ("3.10"), 'broken'
   * where they do not run (a `py` launcher left behind when Python was uninstalled); null when none was found.
   */
  pythonWanting: string | null;
  /** The version of the Python the app came with, to install where there is none; null when it has none with it. */
  pythonBundled: string | null;
  /** A vault is chosen. */
  vault: boolean;
  engine: EngineStatus;
  /** Voice typing as the vault's engine reports it; null where its engine has none (or there is no engine). */
  voice: VoiceStatus | null;
  /** Voice typing is for Windows only (yakala's window and hotkey are). */
  voiceSupported: boolean;
  /** The job going on, one at a time. */
  job: SetupJob | null;
}

export interface EngineStatus {
  /** The version of the vault's engine; null where the vault has none. */
  installed: string | null;
  /** The version that came with the app, to install or update from; null when the app has none with it. */
  bundled: string | null;
  /**
   * The vault's engine is the predecessor project's (stamped 2.x or 3.x, before Cortex began again at 1.0): it looks
   * newer than any Cortex, and its updater refuses Cortex's package, so it moves to Cortex once by the package's own
   * installer (beyin.md, 3a).
   */
  legacy?: boolean;
  /**
   * The vault's engine has the version that came with the app but not its files: a build given out under an unchanged
   * version (the package's digests against what the vault's installer last wrote, `<state>/v3-install.json`).
   */
  stale?: boolean;
}

/**
 * What there is to do about the vault's engine, one answer for every place that offers it (the settings, the first-run
 * screen, the toast at the start): install it, update it to a newer version, refresh it to the files that came with the
 * app under the same version, move a predecessor's to Cortex; null when nothing.
 */
export function engineAction(engine: EngineStatus | null | undefined): 'install' | 'update' | 'refresh' | 'migrate' | null {
  if (!engine?.bundled) return null;
  if (!engine.installed) return 'install';
  if (engine.legacy) return 'migrate';
  if (engine.bundled.localeCompare(engine.installed, undefined, { numeric: true }) > 0) return 'update';
  return engine.stale ? 'refresh' : null;
}

/** How a job goes: a step as the engine says it, then its end. */
export type SetupPush = { job: SetupJob; step: string } | { job: SetupJob; done: true; ok: boolean; error?: string };

/** How far a download step has come, in percent ("%40 (650 / 1624 MB)", or "40% (…)" in English); null for any other step. */
export function percentOfStep(line: string): number | null {
  const found = /^%?(\d+)%? \(\d+ \/ \d+ MB\)$/.exec(line.trim());
  return found ? Math.min(100, Number(found[1])) : null;
}

/** How yakala's listener says its voice helper is (beyin_v3_ses.say_listener): loading - fetching a model, with how much has come - ready, or failed. */
export type HelperState = 'yok' | 'yukleniyor' | 'hazir' | 'hata' | 'kapali';

export interface ListenerWord {
  ses: HelperState;
  /** The model it writes with, once ready ("small (işlemci)"). */
  model: string;
  /** Why it failed, while it is being started again. */
  mesaj: string;
  /** Whether it listens for the wake phrase now. */
  uyandirma: boolean;
  /** A model being fetched: MB come, and MB in all; null when none is. */
  mb: number | null;
  toplam: number | null;
}

export interface SetupApi {
  status(): Promise<SetupStatus>;
  /**
   * The vault just opened bound to where it is now - moved, renamed or copied, its engine still named the old place
   * (`beyin.py relocate`): once per opening, in the background. The failure's sentence, or null.
   */
  settle(): Promise<string | null>;
  /** How the voice helper is now (the settings' bar); null without a listener running. */
  helper(): Promise<ListenerWord | null>;
  /** The Python that came with the app installed for this user (Windows): quietly, without asking for an administrator. */
  installPython(): Promise<SetupStatus>;
  /** The vault's engine installed, or updated, from the package that came with the app. */
  installEngine(): Promise<SetupStatus>;
  /** Voice typing set up: its own environment, its models, the engine fit for the graphics card. */
  installVoice(): Promise<SetupStatus>;
  voice(patch: VoicePatch): Promise<SetupStatus>;
}

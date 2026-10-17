/**
 * Setting Cortex up from the app, never from a terminal: the vault's memory
 * engine, installed or updated from the package that came with the app, and
 * voice typing for yakala (Windows). Each job runs the vault's own engine
 * (`beyin.py`) in the main process (electron/services/setup.ts); the window
 * starts it and is told how it goes.
 */

/** What writes speech: an NVIDIA card (CUDA), an AMD or Intel Arc card (Vulkan, whisper.cpp), or the processor. */
export type VoiceEngine = 'cuda' | 'vulkan' | 'islemci';

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
}

export type SetupJob = 'python' | 'engine' | 'voice';

export interface SetupStatus {
  /** A Python the engine can run on was found; without one nothing below can run. */
  python: boolean;
  /** The version of the Python the app came with, to install where there is none; null when it has none with it. */
  pythonBundled: string | null;
  /** A vault is chosen. */
  vault: boolean;
  engine: {
    /** The version of the vault's engine; null where the vault has none. */
    installed: string | null;
    /** The version that came with the app, to install or update from; null when the app has none with it. */
    bundled: string | null;
  };
  /** Voice typing as the vault's engine reports it; null where its engine has none (or there is no engine). */
  voice: VoiceStatus | null;
  /** Voice typing is for Windows only (yakala's window and hotkey are). */
  voiceSupported: boolean;
  /** The job going on, one at a time. */
  job: SetupJob | null;
}

/** How a job goes: a step as the engine says it, then its end. */
export type SetupPush = { job: SetupJob; step: string } | { job: SetupJob; done: true; ok: boolean; error?: string };

export interface SetupApi {
  status(): Promise<SetupStatus>;
  /** The Python that came with the app installed for this user (Windows): quietly, without asking for an administrator. */
  installPython(): Promise<SetupStatus>;
  /** The vault's engine installed, or updated, from the package that came with the app. */
  installEngine(): Promise<SetupStatus>;
  /** Voice typing set up: its own environment, its models, the engine fit for the graphics card. */
  installVoice(): Promise<SetupStatus>;
  voice(patch: VoicePatch): Promise<SetupStatus>;
}

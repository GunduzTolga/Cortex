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
  engine: VoiceEngine;
  /** The model and where it runs, as the engine says it: `large-v3-turbo (ekran kartı, Vulkan)`. */
  model: string | null;
}

export type SetupJob = 'engine' | 'voice';

export interface SetupStatus {
  /** A Python the engine can run on was found; without one nothing below can run. */
  python: boolean;
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
  /** The vault's engine installed, or updated, from the package that came with the app. */
  installEngine(): Promise<SetupStatus>;
  /** Voice typing set up: its own environment, its models, the engine fit for the graphics card. */
  installVoice(): Promise<SetupStatus>;
  voice(patch: { on?: boolean; wake?: boolean }): Promise<SetupStatus>;
}

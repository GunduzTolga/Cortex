import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HelperState, ListenerWord, WakeTrouble } from '../../shared/setup';
import { renameRetrying } from './fileWrite';
import { readSettings } from './settings';

/**
 * The microphone listens all the time for the wake phrase only while Cortex
 * runs, and only once the person allowed it here. Yakala's listener, which
 * holds the microphone, starts with Windows on its own: with the app quit,
 * "Hey Pyn" still opened a window (21 October).
 *
 * So the app says, every few seconds while it runs, that it runs and whether
 * the person allowed it (`wakeConsent`), in one file beside every vault's
 * state: `%LOCALAPPDATA%\beyin-v3\masaustu.json`. The listener reads it every
 * two seconds and keeps the microphone open only while it is fresh and says
 * yes (beyin_v3_ses.wake_allowed); quitting writes that the app is closed, and
 * an app that crashed stops saying it runs, which the listener takes as closed.
 * The window's language goes with it (`dil`): yakala's own window, opened by
 * the key or the icon's "Not al", speaks it too, and keeps it after the app
 * has quit (yakala-14). Windows only: the listener is.
 */

/** How often the app says it runs; the listener takes it as closed after 20 seconds without a word. */
export const BEAT_EVERY = 5_000;

/** Where the app says it, as the engine's default state is kept (scripts/beyin_v3.py, default_state). */
export function microphoneFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'beyin-v3', 'masaustu.json');
}

/** What the app says: that it runs now and whether the microphone may listen all the time, or that it has quit; and its language. */
export function microphoneWord(allowed: boolean, closed: boolean, at: number = Date.now(), language: 'tr' | 'en' = 'tr'): string {
  const word = closed ? { surum: 1, pid: process.pid, at: at / 1000, kapali: true, dil: language } : { surum: 1, pid: process.pid, at: at / 1000, dinle: allowed, dil: language };
  return `${JSON.stringify(word)}\n`;
}

const languageNow = (): 'tr' | 'en' => (readSettings().language === 'en' ? 'en' : 'tr');

/**
 * Written whole or not at all: the listener never reads half a word. A beat is written once - the next one tries
 * again; the last word, that the app has quit, has no next beat, and Windows refuses the rename while the listener
 * has the file open (it reads it every two seconds), so that one is tried again for a moment (`patient`): without
 * it the microphone stayed open up to twenty seconds after Cortex quit.
 */
function write(text: string, file = microphoneFile(), patient = false): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    if (patient) renameRetrying(temp, file);
    else fs.renameSync(temp, file);
  } catch {
    // Not written this time: the next beat tries again, and a stale word lets the microphone go.
  }
}

let timer: NodeJS.Timeout | null = null;

/** Said now, with the settings as they are: at every beat, and at once when the person allows it or takes it back, or changes the language. */
export function sayMicrophone(): void {
  if (process.platform !== 'win32' || !timer) return;
  write(microphoneWord(readSettings().wakeConsent, false, Date.now(), languageNow()));
}

/** Saying it, from the app's start until it quits. */
export function startMicrophoneWord(): void {
  if (process.platform !== 'win32' || timer) return;
  timer = setInterval(sayMicrophone, BEAT_EVERY);
  timer.unref();
  sayMicrophone();
}

/** The app quits: the listener lets the microphone go within two seconds. */
export function stopMicrophoneWord(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  write(microphoneWord(false, true, Date.now(), languageNow()), microphoneFile(), true);
}

/** How the listener's voice helper is, as the listener says it (beyin_v3_ses.say_listener). */
export type { HelperState, ListenerWord } from '../../shared/setup';

const HELPER_STATES: readonly HelperState[] = ['yok', 'yukleniyor', 'hazir', 'hata', 'kapali'];
const WAKE_TROUBLES: readonly WakeTrouble[] = ['mikrofon', 'sessiz', 'model'];

/** The listener's word, beside the app's own. */
export function listenerFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(microphoneFile(env)), 'dinleyici.json');
}

/**
 * Whether a listener on this computer has said a word, ever: the file stays when it ends. One from an engine before
 * the word (1.0.32 and earlier, until the vault's engine is updated) never writes it, and listens all the same.
 */
export function listenerHasSpoken(file: string = listenerFile()): boolean {
  return fs.existsSync(file);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What the listener last said of its voice; null without a listener running (none, or one that died without a word). */
export function readListener(file: string = listenerFile(), alive: (pid: number) => boolean = running): ListenerWord | null {
  let said: Record<string, unknown>;
  try {
    said = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!said || typeof said !== 'object' || !HELPER_STATES.includes(said.ses as HelperState)) return null;
  if (typeof said.pid !== 'number' || !alive(said.pid)) return null;
  const megabytes = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  const total = megabytes(said.toplam);
  return {
    ses: said.ses as HelperState,
    model: typeof said.model === 'string' ? said.model.slice(0, 120) : '',
    mesaj: typeof said.mesaj === 'string' ? said.mesaj.slice(0, 200) : '',
    uyandirma: said.uyandirma === true,
    mb: total ? megabytes(said.mb) : null,
    toplam: total || null,
    uyandirma_sorun: WAKE_TROUBLES.includes(said.uyandirma_sorun as WakeTrouble) ? (said.uyandirma_sorun as WakeTrouble) : null,
    uyandirma_mesaj: typeof said.uyandirma_mesaj === 'string' ? said.uyandirma_mesaj.slice(0, 300) : '',
    kisayol: said.kisayol === 'tamam' || said.kisayol === 'mesgul' ? said.kisayol : null,
  };
}

/**
 * Which vault yakala serves - its key, the listener with its voice, "Not al", Send To - as `beyin.py yakala kur` last
 * wrote it, beside the app's word (`yakala-sahip.json`: {surum, vault, state, tus, at}); one for the person, whichever
 * vault each of their apps has open. Null where none is, or none whole.
 */
export interface YakalaOwner {
  vault: string;
  /** The key as `kur --tus` takes it ("ctrl+alt+c"); null where the record names none. */
  tus: string | null;
}

export function ownerFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(microphoneFile(env)), 'yakala-sahip.json');
}

export function readOwner(file: string = ownerFile()): YakalaOwner | null {
  try {
    const said = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!said || typeof said !== 'object' || typeof said.vault !== 'string' || !said.vault) return null;
    return { vault: said.vault, tus: typeof said.tus === 'string' && said.tus.trim() ? said.tus.trim() : null };
  } catch {
    return null;
  }
}

/**
 * Work that stops the listener and starts it again (`yakala kur`, `ses kur`, `ses ayar`): while it goes on, for
 * LISTENER_COMES_UP after it, and for the grace after that (services/tray.ts), no listener running is not "the listener
 * does not run". The work can end before the listener it started says a word: `ses ayar` does not wait for it, and
 * `yakala kur` waits 8 seconds, where a cold start on a slow laptop, the virus scanner reading every file, takes longer.
 * Without the wait after, "Dinleyici çalışmıyor" was said over a listener still coming up, and its "Dinleyiciyi başlat"
 * stopped that one and started it again.
 */
let restarting = 0;
let restartEnded = Number.NEGATIVE_INFINITY;

/** As long as the engine waits for a listener it started (beyin_v3_ses.LISTENER_WAIT_SN). */
export const LISTENER_COMES_UP = 20_000;

export function listenerRestarting(now: number = Date.now()): boolean {
  return restarting > 0 || now - restartEnded < LISTENER_COMES_UP;
}

export async function restartingListener<T>(work: () => Promise<T>): Promise<T> {
  restarting += 1;
  try {
    return await work();
  } finally {
    restarting -= 1;
    restartEnded = Date.now();
  }
}

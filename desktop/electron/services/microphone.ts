import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HelperState, ListenerWord } from '../../shared/setup';
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
 * Windows only: the listener is.
 */

/** How often the app says it runs; the listener takes it as closed after 20 seconds without a word. */
export const BEAT_EVERY = 5_000;

/** Where the app says it, as the engine's default state is kept (scripts/beyin_v3.py, default_state). */
export function microphoneFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'beyin-v3', 'masaustu.json');
}

/** What the app says: that it runs now and whether the microphone may listen all the time, or that it has quit. */
export function microphoneWord(allowed: boolean, closed: boolean, at: number = Date.now()): string {
  const word = closed ? { surum: 1, pid: process.pid, at: at / 1000, kapali: true } : { surum: 1, pid: process.pid, at: at / 1000, dinle: allowed };
  return `${JSON.stringify(word)}\n`;
}

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

/** Said now, with the settings as they are: at every beat, and at once when the person allows it or takes it back. */
export function sayMicrophone(): void {
  if (process.platform !== 'win32' || !timer) return;
  write(microphoneWord(readSettings().wakeConsent, false));
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
  write(microphoneWord(false, true), microphoneFile(), true);
}

/** How the listener's voice helper is, as the listener says it (beyin_v3_ses.say_listener). */
export type { HelperState, ListenerWord } from '../../shared/setup';

const HELPER_STATES: readonly HelperState[] = ['yok', 'yukleniyor', 'hazir', 'hata', 'kapali'];

/** The listener's word, beside the app's own. */
export function listenerFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(microphoneFile(env)), 'dinleyici.json');
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
  };
}

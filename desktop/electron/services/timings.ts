import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How long the steps a person waits for took, for a slow machine to be measured where it runs: the
 * first install on another computer took about a minute from "Hey Pyn" to the window (1 November)
 * and nothing said which part was slow. The engine's voice helper and yakala's listener write their
 * steps into the same file (beyin_v3_ses.TIMES_FILE: `ses_modeli`, `uyandirma_dogrulama`,
 * `uyandirma_pencere`, `yazi`); the app writes its own opening (`acilis`). One JSON line a step:
 * when, the step's name and how long, never anything said or written.
 */

/** The file, beside every vault's state as the engine keeps it (beyin_v3_ses.user_base). `BEYIN_SURELER` names another (the tests'). */
export function timingsFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.BEYIN_SURELER) return env.BEYIN_SURELER;
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'beyin-v3', 'sureler.jsonl');
}

/** Past this the file is kept as `.1` and begun anew (the engine's TIMES_MAX). */
export const TIMINGS_MAX = 256 * 1024;

/** The steps the app times; the engine's own are its (beyin_v3_ses.TIME_STEPS). */
export type AppStep = 'acilis';

/** A moment as the engine writes it: local time with its offset, to the second ("2026-11-24T10:12:03+03:00"). */
export function localMoment(at: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/** One step's line, or null for a time that could not be one (not a number, below zero, over a day). */
export function timingLine(step: AppStep, ms: number, at: Date = new Date()): string | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 3600_000) return null;
  return `${JSON.stringify({ at: localMoment(at), adim: step, ms: Math.round(ms) })}\n`;
}

/** Writes one step's time; true when it was. A full disk or a locked file is not the app's trouble: nothing is raised. */
export function recordTime(step: AppStep, ms: number, file: string = timingsFile(), at: Date = new Date()): boolean {
  const line = timingLine(step, ms, at);
  if (line === null) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > TIMINGS_MAX) fs.renameSync(file, `${file}.1`);
    } catch {
      // not there yet
    }
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

let openingTimed = false;

/**
 * The app's opening, once a run: from the process's start (`performance.now()`, counted from it in
 * the main process) to its window's first frame being shown. A window made again later (closed to
 * the tray, opened from it) is not an opening.
 */
export function recordOpening(sinceStart: number = performance.now(), file?: string): boolean {
  if (openingTimed) return false;
  openingTimed = true;
  return recordTime('acilis', sinceStart, file);
}

/** For the tests: a run begun anew. */
export function resetOpeningForTests(): void {
  openingTimed = false;
}

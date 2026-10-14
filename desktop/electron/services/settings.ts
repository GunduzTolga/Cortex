import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppLanguage } from '../../shared/language';

/**
 * The app's own settings file: which vault is open and which language the
 * window speaks. In the app's data folder (`%APPDATA%\Cortex` on Windows),
 * never in the vault: the vault stays the person's Markdown and nothing else.
 *
 * Krewgent kept the same two facts in its state file (`cortexVault`, the
 * language in its settings); this is that file cut down to what this app
 * has, with its rules kept, each of which cost Krewgent a library:
 *
 * - Only a missing file is a first run. One the disk would not hand over -
 *   busy, locked, its permissions taken away - is not damaged, and nothing is
 *   written over it in this run (`keepOff`).
 * - One that was read and would not parse is copied beside itself
 *   (`.corrupt-<time>`) before an empty one is saved, so the way back is kept.
 * - Every write goes through a temporary renamed into place, so a crash
 *   mid-write leaves the old file whole.
 *
 * The vault's path is written only by the main process, when the person has
 * chosen a folder through the system's dialog (`setVault`); the window can
 * patch the language and nothing else (electron/ipc.ts).
 */

export interface Settings {
  /** The vault by its real path, or null before one is chosen. */
  vault: string | null;
  /** Null until somebody picks; read through `appLanguage` (shared/language.ts). */
  language: AppLanguage | null;
}

const EMPTY: Settings = { vault: null, language: null };

let cache: Settings | null = null;
let keepOff = false;
let unreadable: 'copied' | 'left' | null = null;

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function hydrate(raw: Record<string, unknown>): Settings {
  return {
    vault: typeof raw.vault === 'string' && raw.vault ? raw.vault : null,
    language: raw.language === 'en' || raw.language === 'tr' ? raw.language : null,
  };
}

export function readSettings(): Settings {
  if (cache) return cache;
  let text: string | null = null;
  try {
    text = fs.readFileSync(settingsPath(), 'utf8');
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the settings file holds no object');
    cache = hydrate(raw as Record<string, unknown>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      cache = { ...EMPTY };
      return cache;
    }
    console.error('[settings] the settings file could not be read', err);
    if (text === null) {
      keepOff = true;
      unreadable = 'left';
    } else {
      try {
        fs.copyFileSync(settingsPath(), `${settingsPath()}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        unreadable = 'copied';
      } catch {
        keepOff = true;
        unreadable = 'left';
      }
    }
    cache = { ...EMPTY };
  }
  return cache;
}

/** Whether this start began empty because the file would not be read: a copy kept beside it, or the file left as it was. */
export function settingsUnreadable(): 'copied' | 'left' | null {
  readSettings();
  return unreadable;
}

/** A rename tried again for a moment while Windows says the file is busy: an antivirus or the indexer opens a file just written. */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/** Change the settings and write them at once: two small facts, written rarely, need no debounce. */
export function updateSettings(change: (settings: Settings) => void): Settings {
  const settings = readSettings();
  change(settings);
  if (keepOff) return settings;
  const file = settingsPath();
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
    renameRetrying(temp, file);
  } catch (err) {
    console.error('[settings] the settings could not be saved', err);
  }
  return settings;
}

/** For the tests: forget what was read, so the next read is from disk. */
export function forgetSettings(): void {
  cache = null;
  keepOff = false;
  unreadable = null;
}

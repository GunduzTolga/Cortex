import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppLanguage } from '../../shared/language';
import { renameRetrying } from './fileWrite';

/**
 * The app's own settings file: which vault is open, which language the
 * window speaks, and how the notes tree shows the vault. In the app's data folder (`%APPDATA%\Cortex` on Windows),
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
 * patch the rest and nothing else (electron/ipc.ts).
 */

export interface Settings {
  /** The vault by its real path, or null before one is chosen. */
  vault: string | null;
  /** Null until somebody picks; read through `appLanguage` (shared/language.ts). */
  language: AppLanguage | null;
  /** The notes tree lists every kind of file; off by default (shared/api.ts). */
  allFiles: boolean;
  /** Names are shown with the emoji they start with; off by default. */
  nameIcons: boolean;
  /** How Pyn and the office address the person ("Tolga", "Tolga Bey"); null until they say. */
  userName: string | null;
  /** The first-run screen has been gone through; until then it is what the app opens on. */
  onboarded: boolean;
  /** The window closed, Cortex stays in the notification area, and starts there with Windows; on by default. */
  background: boolean;
  /** The person let voice typing use the microphone, asked before it is set up (src/ui/MicConsent.tsx). */
  voiceConsent: boolean;
  /** The person let the microphone listen all the time for the wake phrase, while Cortex runs (services/microphone.ts). */
  wakeConsent: boolean;
}

/** The longest name kept: a way of addressing somebody, not a paragraph. */
export const NAME_LIMIT = 40;

/** A name as it is kept: its spaces tidied, cut to the limit; nothing for an empty one. */
export function tidyName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT).trim();
  return name || null;
}

const EMPTY: Settings = { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false };

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
    allFiles: raw.allFiles === true,
    nameIcons: raw.nameIcons === true,
    userName: tidyName(raw.userName),
    onboarded: raw.onboarded === true,
    background: raw.background !== false,
    voiceConsent: raw.voiceConsent === true,
    wakeConsent: raw.wakeConsent === true,
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

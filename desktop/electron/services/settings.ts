import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ThemeChoice } from '../../shared/api';
import type { CliId } from '../../shared/chat';
import { HERMES_PROFILE, hermesAddress } from '../../shared/hermes';
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
  /** Light, dark, or as the system is (shared/api.ts); the system's by default. Applied through nativeTheme (services/theme.ts). */
  theme: ThemeChoice;
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
  /** A Hermes Agent's API server on another machine (`https://host:8642`), for the chat; null until given. Its key is in keys.ts. */
  hermesUrl: string | null;
  /** The Hermes profile served under `/p/<profile>/` on that address; null for the server's own. */
  hermesProfile: string | null;
  /** The vault kept in step with its git remote (services/vaultSync.ts, Settings › Sunucu); off by default. */
  vaultSync: boolean;
  /**
   * The AI tools offered in the chat: those the person signed in to, installed or gave a key to from Cortex
   * (chooseChatTool). Null: every one installed, as before the list was kept (an install from before it, or a first run
   * through which none was set up).
   */
  chatTools: CliId[] | null;
}

/** The tools the person chooses among; a model server, Hermes and the tests' stand-ins are offered as before. */
export const CHAT_TOOLS: readonly CliId[] = ['claude', 'codex', 'opencode', 'gemini', 'qwen'];

/** The longest name kept: a way of addressing somebody, not a paragraph. */
export const NAME_LIMIT = 40;

/** A name as it is kept: its spaces tidied, cut to the limit; nothing for an empty one. */
export function tidyName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT).trim();
  return name || null;
}

const EMPTY: Settings = { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null };

let cache: Settings | null = null;
let keepOff = false;
let unreadable: 'copied' | 'left' | null = null;

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function hydrate(raw: Record<string, unknown>): Settings {
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    vault: typeof raw.vault === 'string' && raw.vault ? raw.vault : null,
    language: raw.language === 'en' || raw.language === 'tr' ? raw.language : null,
    allFiles: raw.allFiles === true,
    nameIcons: raw.nameIcons === true,
    userName: tidyName(raw.userName),
    onboarded: raw.onboarded === true,
    background: raw.background !== false,
    voiceConsent: raw.voiceConsent === true,
    wakeConsent: raw.wakeConsent === true,
    hermesUrl: typeof raw.hermesUrl === 'string' ? hermesAddress(raw.hermesUrl) : null,
    hermesProfile: typeof raw.hermesProfile === 'string' && HERMES_PROFILE.test(raw.hermesProfile) ? raw.hermesProfile : null,
    vaultSync: raw.vaultSync === true,
    chatTools: Array.isArray(raw.chatTools) ? [...new Set(raw.chatTools as unknown[])].filter((id): id is CliId => CHAT_TOOLS.includes(id as CliId)) : null,
  };
}

export function readSettings(): Settings {
  if (cache) return cache;
  let text: string | null = null;
  try {
    text = fs.readFileSync(settingsPath(), 'utf8');
    // A BOM in front (Notepad's "UTF-8 with BOM", PowerShell 5.1's Set-Content) is not JSON: read as damaged, the
    // settings were set aside and the app started as on a first run (29 October).
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
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

/**
 * A tool the person signed in to, installed or gave a key to from Cortex: one they use, offered in the chat. 1 November:
 * on a first run only OpenCode was signed in to, and the chat offered Claude Code too, signed in on that computer
 * long before ("girişte sadece opencode ile açtım… chat ekranında claude code falan da açık"). So on a first run the
 * list begins with the first tool set up there, and only what is set up from Cortex joins it; after a first run
 * through which nothing was set up, or for an install from before the list, every installed tool stays offered.
 */
export function chooseChatTool(id: CliId): void {
  if (!CHAT_TOOLS.includes(id)) return;
  const now = readSettings();
  if (now.chatTools ? now.chatTools.includes(id) : now.onboarded) return;
  updateSettings((settings) => {
    settings.chatTools = [...(settings.chatTools ?? []), id];
  });
}

/**
 * A tool added to the chat, or taken from it, from the AI tools window (1 November: Codex, signed in only in a
 * terminal, said "Giriş kayıtlı" there and was missing from the chat). A list not begun yet - every installed tool
 * offered - is begun with the installed ones, so that only the one taken away goes.
 */
export function setChatTool(id: CliId, offered: boolean, installed: readonly CliId[]): void {
  if (!CHAT_TOOLS.includes(id)) return;
  updateSettings((settings) => {
    const now = settings.chatTools ?? CHAT_TOOLS.filter((one) => installed.includes(one));
    settings.chatTools = offered ? (now.includes(id) ? now : [...now, id]) : now.filter((one) => one !== id);
  });
}

import type { ChatApi, ChatPush } from './chat';
import type { AppLanguage } from './language';
import type { NoteBacklinks, NoteRead, NoteSaved, SearchHit, TextRead, TrashItem, VaultIndex } from './notes';
import type { OfficeApi } from './office';
import type { ListenerWord, SetupApi, SetupPush, VoiceStatus } from './setup';
import type { TelegramApi } from './telegram';

/**
 * Everything the window can ask of the main process: the object the preload
 * puts on `window.cortex` (electron/preload.ts), answered in electron/ipc.ts.
 * No call takes or returns a path outside the vault.
 */

/** What the window may change of the settings. The vault is not here: it comes through the system's dialog. */
export interface WindowSettings {
  language: AppLanguage | null;
  /** The tree lists every kind of file, scripts and JSON with the notes; off, only notes and what notes show. */
  allFiles: boolean;
  /** Names are shown with the emoji they start with on disk (`📥 000-Inbox`); off, without it. */
  nameIcons: boolean;
  /** How Pyn and the office address the person ("Tolga Bey"); null until they say. */
  userName: string | null;
  /** The first-run screen has been gone through. */
  onboarded: boolean;
  /** The window closed, Cortex stays in the notification area (the microphone switched from there), and starts there with Windows. */
  background: boolean;
  /** The person let voice typing use the microphone. */
  voiceConsent: boolean;
  /** The person let the microphone listen all the time for the wake phrase while Cortex runs; until then it does not. */
  wakeConsent: boolean;
}

/** The vault by its folder's name, and whether that folder is still there; never its path. */
export interface VaultStatus {
  vault: { name: string } | null;
  missing: boolean;
}

export interface BootstrapPayload {
  settings: WindowSettings;
  vault: VaultStatus;
  /** The settings file would not be read at this start: a copy was kept beside it, or it was left as it was and nothing is written over it. */
  settingsUnreadable: 'copied' | 'left' | null;
  version: string;
}

/** What a move or a rename came to: where the thing is now, the notes whose links were pointed at it, and those that could not be. */
export interface Moved {
  path: string;
  updated: string[];
  skipped: string[];
}

export interface NotesApi {
  index(): Promise<VaultIndex>;
  read(path: string): Promise<NoteRead>;
  /** A file that is not a note, as text to be shown: read only, never run. */
  text(path: string): Promise<TextRead>;
  save(path: string, text: string, base: string): Promise<NoteSaved>;
  create(folder: string, name: string, options?: { text?: string; unique?: boolean; template?: string }): Promise<{ path: string }>;
  createFolder(parent: string, name: string): Promise<{ path: string }>;
  rename(path: string, name: string): Promise<Moved>;
  move(path: string, folder: string): Promise<Moved>;
  /** Into the vault's bin (`.trash/`), to be taken back from there; its id there. */
  trash(path: string): Promise<{ id: string }>;
  binList(): Promise<TrashItem[]>;
  /** Put back where it was, or beside it under a free name; where it is now. */
  binRestore(id: string): Promise<{ path: string }>;
  /** Sent on to the system's bin. */
  binDelete(id: string): Promise<void>;
  /** Everything sent on to the system's bin; how many went. */
  binEmpty(): Promise<number>;
  backlinks(path: string): Promise<NoteBacklinks>;
  search(query: string): Promise<{ hits: SearchHit[]; more: boolean }>;
  asset(path: string): Promise<string | null>;
  open(path: string, how: 'obsidian' | 'folder'): Promise<{ opened: boolean; reason?: 'no-obsidian' }>;
}

export interface CortexApi {
  bootstrap(): Promise<BootstrapPayload>;
  settings: {
    set(patch: Partial<WindowSettings>): Promise<WindowSettings>;
  };
  vault: {
    status(): Promise<VaultStatus>;
    /** The system's folder dialog; null when it was closed without a choice. */
    choose(): Promise<VaultStatus | null>;
  };
  notes: NotesApi;
  /** The chat with the person's own AI CLIs (shared/chat.ts). */
  chat: ChatApi;
  /** Cortex's engine and voice typing set up from the app (shared/setup.ts). */
  setup: SetupApi;
  /** The office's live conversations, written by the model chosen in its settings (shared/office.ts). */
  office: OfficeApi;
  /** Notes from the phone through the person's own Telegram bot (shared/telegram.ts). */
  telegram: TelegramApi;
  on: {
    /** The vault changed on disk, or another vault was chosen: read the index again. */
    notesChanged(handler: () => void): () => void;
    /** A chat going on: an event, its state, its list entry. */
    chat(handler: (push: ChatPush) => void): () => void;
    /** A sign-in window was closed: ask the tools' statuses again. */
    authChanged(handler: () => void): () => void;
    /** A setup job going on: a step, or its end. */
    setup(handler: (push: SetupPush) => void): () => void;
    /** The voice status read anew (the notification-area icon switched it): the settings show it as it is. */
    voiceStatus(handler: (voice: VoiceStatus | null) => void): () => void;
    /** The voice helper's word changed: fetching a model (how far), loading, ready, failed. */
    voiceHelper(handler: (word: ListenerWord | null) => void): () => void;
    /** The notification-area icon's "Ayarlar": open the settings. */
    openSettings(handler: () => void): () => void;
    /** The notification-area icon's "listen all the time", asked of a person who has not allowed it yet: the window asks. */
    askWake(handler: () => void): () => void;
    /** The window is going for good: what the page holds unsaved is saved, and the main process told once it is (electron/main.ts). */
    flush(handler: () => Promise<void>): () => void;
  };
}

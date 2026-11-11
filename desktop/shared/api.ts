import type { BrowserLinkApi, BrowserLinkStatus } from './browserLink';
import type { ChatApi, ChatPush, CliId } from './chat';
import type { GithubApi, GithubStatus } from './github';
import type { HermesApi } from './hermes';
import type { TailnetApi, TailnetStatus } from './pairing';
import type { AppLanguage } from './language';
import type { McpApi } from './mcp';
import type { NoteBacklinks, NoteRead, NoteSaved, SearchHit, TextRead, TrashItem, VaultIndex } from './notes';
import type { OfficeApi } from './office';
import type { ListenerSeen, SetupApi, SetupPush, VoiceStatus } from './setup';
import type { TelegramApi } from './telegram';
import type { SyncStatus, VaultSyncApi } from './vaultSync';

/**
 * Everything the window can ask of the main process: the object the preload
 * puts on `window.cortex` (electron/preload.ts), answered in electron/ipc.ts.
 * No call takes a path outside the vault. One returns one: `mcp.status`, the
 * lines that connect the vault to an AI tool, to be shown and copied as they
 * are - the vault's own folder and the Python that runs its engine.
 */

/** How the window is drawn: the system's light or dark, or one kept whatever the system says (Settings › General). */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** What the window may change of the settings. The vault is not here: it comes through the system's dialog. */
export interface WindowSettings {
  /** Light, dark, or as the system is; the system's by default (2 November notes: "koyu mod yok"). */
  theme: ThemeChoice;
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
  /** A newer Cortex is asked for on GitHub and downloaded unasked; on by default. Off, nothing is asked at all (Settings › Hakkında). */
  autoUpdate: boolean;
}

/** A word from the main process for a toast, from work the window did not ask for and does not wait on (yakala moved to another vault). */
export interface AppNotice {
  tone: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
}

/** Where the installers are, for a person who fetches one themselves (Settings › Hakkında, README). */
export const RELEASES_PAGE = 'https://github.com/GunduzTolga/Cortex/releases/latest';

/** A newer Cortex downloaded from the releases and checked, waiting to be installed (electron/services/updater.ts). */
export interface AppUpdate {
  version: string;
}

/** What asking to install it now came to: installed (the app quits), or not now because a setup runs, or none waiting. */
export interface UpdateInstall {
  installed: boolean;
  reason?: 'busy' | 'none';
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
  /** `whole`: the folders walked again (the window come back to), not only what was said changed. */
  index(whole?: boolean): Promise<VaultIndex>;
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
    /** `Cortex` made in the person's Documents and taken as the vault: the first run's default. */
    createDefault(): Promise<VaultStatus>;
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
  /** The vault kept in step with its git remote (shared/vaultSync.ts, Settings › Sunucu). */
  vaultSync: VaultSyncApi;
  /** The vault kept on GitHub: signed in with a code, a repository made or picked (shared/github.ts, Settings › Sunucu). */
  github: GithubApi;
  /** A Hermes Agent on another machine as a chat engine: its address, profile and key (shared/hermes.ts). */
  hermes: HermesApi;
  /** The vault connected to the person's AI tools through its MCP gate (shared/mcp.ts, Settings). */
  mcp: McpApi;
  /** The same server reached with a pairing code and nothing installed (shared/pairing.ts, Settings › Sunucu). */
  tailnet: TailnetApi;
  /** Cortex Browser on this computer, let in to ask Pyn here (shared/browserLink.ts, Settings). */
  browserLink: BrowserLinkApi;
  /** The app's own update from the releases (electron/services/updater.ts). */
  update: {
    /** The one downloaded and waiting, if any: a window opened after it was told asks. */
    ready(): Promise<AppUpdate | null>;
    /** Installed now: the app quits and opens again on the new version. */
    install(): Promise<UpdateInstall>;
  };
  on: {
    /** The vault changed on disk, or another vault was chosen: read the index again. */
    notesChanged(handler: () => void): () => void;
    /** The vault's sync with its git remote: every change of its status. */
    vaultSync(handler: (status: SyncStatus) => void): () => void;
    github(handler: (status: GithubStatus) => void): () => void;
    /** The pairing's connection: every change of its state. */
    tailnet(handler: (status: TailnetStatus) => void): () => void;
    /** Cortex Browser's link: a browser waiting to be let in, connected, gone; the leave given or taken back. */
    browserLink(handler: (status: BrowserLinkStatus) => void): () => void;
    /** A chat going on: an event, its state, its list entry. */
    chat(handler: (push: ChatPush) => void): () => void;
    /** A sign-in window was closed, or a sign-in done (the tool's), or an install ended (null): ask the tools' statuses again. */
    authChanged(handler: (cli: CliId | null) => void): () => void;
    /** The PATH read again behind an answer already given, with folders it did not have: ask about the tools again. Nothing ended. */
    toolsFound(handler: () => void): () => void;
    /** A setup job going on: a step, or its end. */
    setup(handler: (push: SetupPush) => void): () => void;
    /** The voice status read anew (the notification-area icon switched it): the settings show it as it is. */
    voiceStatus(handler: (voice: VoiceStatus | null) => void): () => void;
    /** The listener's word changed - its voice helper fetching a model (how far), loading, ready, failed; the wake phrase heard or not; its key - or it was found not running. */
    voiceHelper(handler: (seen: ListenerSeen) => void): () => void;
    /** A newer Cortex is downloaded and waiting to be installed. */
    update(handler: (update: AppUpdate) => void): () => void;
    /** Something done in the background, said once (shared/api.ts, AppNotice). */
    notice(handler: (word: AppNotice) => void): () => void;
    /** The notification-area icon's "Ayarlar": open the settings. */
    openSettings(handler: () => void): () => void;
    /** The notification-area icon's "listen all the time", asked of a person who has not allowed it yet: the window asks. */
    askWake(handler: () => void): () => void;
    /** The window is going for good: what the page holds unsaved is saved, and the main process told once it is (electron/main.ts). */
    flush(handler: () => Promise<void>): () => void;
  };
}

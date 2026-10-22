import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AppNotice, BootstrapPayload, WindowSettings } from '../shared/api';
import { readSettings, settingsUnreadable, tidyName, updateSettings } from './services/settings';
import { sayMicrophone } from './services/microphone';
import { currentListener, expectVoiceTurn, onHelperChange, startWithWindows, trayChanged } from './services/tray';
import { setVault, vaultStatus } from './services/vault';
import * as auth from './services/auth';
import * as chat from './services/chat';
import { captureToInbox } from './services/inbox';
import * as officeTalk from './services/officeTalk';
import * as setup from './services/setup';
import * as telegram from './services/telegram';
import * as vaultNotes from './services/vaultNotes';

/**
 * What the window can ask, and nothing else (shared/api.ts, electron/preload.ts).
 *
 * Every argument arrives as `unknown` and is checked by the service that takes
 * it: the window is not a boundary, and what it sends is read as if anybody
 * had written it. No channel takes a path outside the vault; the vault itself
 * comes through the system's dialog, here.
 */

/** The address this app's own page is served from: its built files, or the dev server while developing. */
let pageOrigin: (url: string) => boolean = () => false;

export function trustPagesWhere(test: (url: string) => boolean): void {
  pageOrigin = test;
}

/**
 * A channel answered only for the app's own page in its own window: a frame
 * that is not the top one, or a page that got there by some way round the
 * navigation rules in main.ts, is refused before its arguments are read.
 */
function handle(channel: string, listener: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !pageOrigin(frame.url)) throw new Error('Refused: not the app’s own page.');
    return listener(...args);
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** A word for the window from work it did not ask for and does not wait on (yakala moved): said in a toast. */
function notice(word: AppNotice): void {
  broadcast('app:notice', word);
}

/**
 * Yakala moved to the vault open now, in the background, where it served another (services/setup.ts, repointYakala):
 * said once it has moved - the notes taken with the key go somewhere else from now on - or when it could not.
 */
function moveYakala(): void {
  const say = (tr: string, en: string) => (readSettings().language === 'en' ? en : tr);
  void setup.repointYakala().then(
    (key) => {
      if (!key) return;
      notice({
        tone: 'success',
        title: say('Not alma bu kasaya taşındı', 'Note taking moved to this vault'),
        detail: say(`${key}, uyandırma sözü ve Gönder → Beyne At ile alınan notlar artık bu kasaya kaydediliyor.`, `Notes taken with ${key}, the wake phrase and Send to → Beyne At now go into this vault.`),
      });
    },
    (err: unknown) =>
      notice({
        tone: 'error',
        title: say('Not alma bu kasaya taşınamadı', 'Note taking could not be moved to this vault'),
        detail: `${err instanceof Error ? err.message : String(err)} ${say('Kısayolla alınan notlar hâlâ önceki kasaya gidiyor.', 'Notes taken with the key still go into the vault before.')}`,
      }),
  );
}

function windowSettings(): WindowSettings {
  const { language, allFiles, nameIcons, userName, onboarded, background, voiceConsent, wakeConsent } = readSettings();
  return { language, allFiles, nameIcons, userName, onboarded, background, voiceConsent, wakeConsent };
}

export function registerIpc(): void {
  handle('app:bootstrap', async (): Promise<BootstrapPayload> => ({
    settings: windowSettings(),
    vault: await vaultStatus(),
    settingsUnreadable: settingsUnreadable(),
    version: app.getVersion(),
  }));

  // The language and how the tree shows the vault, each only as a value it can have: the vault is not the window's to set.
  handle('settings:set', (patch: unknown) => {
    const asked = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
    const change: Partial<WindowSettings> = {};
    if (asked.language === 'en' || asked.language === 'tr' || asked.language === null) change.language = asked.language;
    if (typeof asked.allFiles === 'boolean') change.allFiles = asked.allFiles;
    if (typeof asked.nameIcons === 'boolean') change.nameIcons = asked.nameIcons;
    if (typeof asked.userName === 'string' || asked.userName === null) change.userName = tidyName(asked.userName);
    if (typeof asked.onboarded === 'boolean') change.onboarded = asked.onboarded;
    if (typeof asked.background === 'boolean') change.background = asked.background;
    if (typeof asked.voiceConsent === 'boolean') change.voiceConsent = asked.voiceConsent;
    if (typeof asked.wakeConsent === 'boolean') change.wakeConsent = asked.wakeConsent;
    if (Object.keys(change).length) updateSettings((settings) => Object.assign(settings, change));
    if (change.background !== undefined) startWithWindows(change.background);
    // The listener hears it within two seconds: allowed, the microphone listens; taken back, it lets go. Yakala's
    // window takes the language from the same word.
    if (change.wakeConsent !== undefined || change.language !== undefined) sayMicrophone();
    // The icon's words follow: leave given or taken back, or another language.
    if (change.wakeConsent !== undefined || change.language !== undefined) trayChanged();
    return windowSettings();
  });

  handle('vault:status', () => vaultStatus());
  // The system's dialog, in the main process: the window names no folder, and learns the chosen one's name only.
  handle('vault:choose', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = { title: 'Cortex', properties: ['openDirectory', 'createDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!dir) return null;
    const before = readSettings().vault;
    const status = await setVault(dir);
    const changed = before !== readSettings().vault;
    // The notes screen reads the vault now chosen, watched from its next read (services/vaultNotes.ts).
    if (changed) {
      vaultNotes.stopWatchingVault();
      // The CLIs were started in the vault left: ended, to start again in this one.
      chat.shutdownChats();
      broadcast('notes:changed', null);
    }
    // Its engine bound to where the folder is now (a vault moved, renamed or copied), in the background; the
    // Telegram listener writes into the vault chosen now once that is done (services/setup.ts, settleVault).
    const settled = setup.settleVault();
    if (changed) void settled.then(() => telegram.restartTelegram());
    // Yakala - the key, "Pyn, not al", Send To - kept writing into the vault left (yakala-3): it follows, once bound.
    // Chosen again, the same vault tries again where moving it failed; where it is this vault's already, nothing runs.
    void settled.then(() => moveYakala());
    return status;
  });

  // The whole vault, for the person's own notes screen (services/vaultNotes.ts): a reader nothing else is given.
  handle('notes:index', () => {
    vaultNotes.watchVault(() => broadcast('notes:changed', null));
    return vaultNotes.vaultIndex();
  });
  handle('notes:read', (file) => vaultNotes.readVaultNote(file));
  handle('notes:text', (file) => vaultNotes.readVaultText(file));
  handle('notes:save', (file, text, base) => vaultNotes.saveVaultNote(file, text, base));
  handle('notes:create', (folder, name, options) =>
    vaultNotes.createVaultNote(folder, name, (options ?? {}) as { text?: unknown; unique?: unknown; template?: unknown }),
  );
  handle('notes:createFolder', (parent, name) => vaultNotes.createVaultFolder(parent, name));
  handle('notes:rename', (file, name) => vaultNotes.renameVaultEntry(file, name));
  handle('notes:move', (file, folder) => vaultNotes.moveVaultEntry(file, folder));
  handle('notes:trash', (file) => vaultNotes.trashVaultEntry(file));
  handle('notes:binList', () => vaultNotes.listVaultTrash());
  handle('notes:binRestore', (id) => vaultNotes.restoreVaultTrash(id));
  handle('notes:binDelete', (id) => vaultNotes.deleteVaultTrash(id));
  handle('notes:binEmpty', () => vaultNotes.emptyVaultTrash());
  handle('notes:backlinks', (file) => vaultNotes.vaultBacklinks(file));
  handle('notes:search', (query) => vaultNotes.searchVault(query));
  handle('notes:asset', (file) => vaultNotes.vaultAsset(file));
  handle('notes:open', (file, how) => vaultNotes.openVaultEntry(file, how));

  // The chat with the person's own AI CLIs (services/chat.ts): the window names a CLI from the list it is given, never a program.
  chat.onChatPush((payload) => broadcast('chat:event', payload));
  handle('chat:clis', () => chat.listChatClis());
  handle('chat:list', () => chat.listChats());
  handle('chat:open', (id) => chat.openChat(id));
  handle('chat:send', (id, cli, text) => chat.sendChat(id, cli, text));
  handle('chat:cancel', (id) => chat.cancelChat(id));
  handle('chat:answer', (id, permission, option) => chat.answerChat(id, permission, option));
  handle('chat:setOption', (id, option, value) => chat.setChatOption(id, option, value));
  handle('chat:rename', (id, title) => chat.renameChat(id, title));
  handle('chat:remove', (id) => chat.removeChat(id));
  // A message kept for later in the vault's inbox (services/inbox.ts): words go in, a card's place comes back.
  handle('chat:toInbox', (text) => captureToInbox({ text }, 'pyn'));

  // Signing in to those tools (services/auth.ts): a key goes in and is never sent back.
  auth.onAuthChanged(() => {
    // A sign-in or an install ended: CLIs started before it start again with it at their next message.
    chat.restartIdleChats();
    broadcast('chat:authChanged', null);
  });
  handle('chat:auth', () => auth.authStatuses());
  handle('chat:login', (cli) => auth.startLogin(cli));
  handle('chat:install', (cli) => auth.installTool(cli));
  handle('chat:setKey', async (cli, key, baseUrl) => {
    await auth.setToolKey(cli, key, baseUrl);
    chat.restartIdleChats();
    return auth.authStatuses();
  });
  handle('chat:forgetKey', (cli) => {
    auth.forgetToolKey(cli);
    chat.restartIdleChats();
    return auth.authStatuses();
  });

  // The office's live conversations (services/officeTalk.ts): the window names a tool and a model it was offered.
  handle('office:models', (tool) => officeTalk.talkModels(tool));
  handle('office:talk', (request) => officeTalk.officeTalk(request));

  // Cortex's engine and voice typing set up from the app (services/setup.ts): the window names a job, never a program or a file.
  setup.onSetupPush((payload) => broadcast('setup:event', payload));
  // Switched from the notification-area icon: the settings, open or not, show the voice as it is now.
  setup.onVoiceStatus((voice) => broadcast('setup:voice', voice));
  // The voice helper fetching a model, loading it, ready or failed, the listener not running: the settings' bar follows.
  onHelperChange((seen) => broadcast('setup:helper', seen));
  handle('setup:helper', () => currentListener());
  // The listener found not running started again; the key another app holds changed (yakala kur).
  handle('setup:restartListener', () => {
    expectVoiceTurn();
    return setup.restartListener();
  });
  handle('setup:hotkey', (spec) => {
    expectVoiceTurn();
    return setup.changeHotkey(spec);
  });
  handle('setup:status', () => setup.setupStatus());
  // The vault opened bound to where it is now: the window says a failure once (src/App.tsx).
  handle('setup:settle', () => setup.settleVault());
  // What was set up is taken up now, not at the next start: the Telegram listener starts (or starts
  // again on the new engine), and the chats' CLIs take the engine's new hooks at their next message.
  handle('setup:installPython', async () => {
    const status = await setup.installPython();
    void telegram.restartTelegram();
    return status;
  });
  handle('setup:installEngine', async () => {
    const status = await setup.installEngine();
    chat.restartIdleChats();
    void telegram.restartTelegram();
    // A vault chosen before it had an engine: yakala moves to it now (yakala-3).
    moveYakala();
    return status;
  });
  handle('setup:installVoice', () => {
    // The voice getting ready is said in the notification area: asked for now.
    expectVoiceTurn();
    return setup.installVoice();
  });
  handle('setup:voice', (patch) => {
    expectVoiceTurn();
    return setup.setVoice(patch);
  });

  // Notes from the phone through the person's own Telegram bot (services/telegram.ts): a key goes in and is never sent back.
  handle('telegram:status', () => telegram.telegramStatus());
  handle('telegram:connect', (key) => telegram.connectTelegram(key));
  handle('telegram:pairAgain', () => telegram.pairTelegramAgain());
  handle('telegram:disconnect', () => telegram.disconnectTelegram());
}

export function stopWatching(): void {
  vaultNotes.stopWatchingVault();
  // No CLI outlives the app, nor the Telegram listener.
  chat.shutdownChats();
  void telegram.stopTelegram();
}

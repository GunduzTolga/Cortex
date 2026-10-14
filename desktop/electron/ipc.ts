import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { BootstrapPayload, WindowSettings } from '../shared/api';
import { readSettings, settingsUnreadable, updateSettings } from './services/settings';
import { setVault, vaultStatus } from './services/vault';
import * as chat from './services/chat';
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

function windowSettings(): WindowSettings {
  return { language: readSettings().language };
}

export function registerIpc(): void {
  handle('app:bootstrap', async (): Promise<BootstrapPayload> => ({
    settings: windowSettings(),
    vault: await vaultStatus(),
    settingsUnreadable: settingsUnreadable(),
    version: app.getVersion(),
  }));

  // The language, and nothing else: the vault is not the window's to set.
  handle('settings:set', (patch: unknown) => {
    const language = (patch as { language?: unknown } | null)?.language;
    if (language === 'en' || language === 'tr' || language === null) {
      updateSettings((settings) => {
        settings.language = language;
      });
    }
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
    // The notes screen reads the vault now chosen, watched from its next read (services/vaultNotes.ts).
    if (before !== readSettings().vault) {
      vaultNotes.stopWatchingVault();
      // The CLIs were started in the vault left: ended, to start again in this one.
      chat.shutdownChats();
      broadcast('notes:changed', null);
    }
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
}

export function stopWatching(): void {
  vaultNotes.stopWatchingVault();
  // No CLI outlives the app.
  chat.shutdownChats();
}

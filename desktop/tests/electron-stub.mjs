import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The electron module, as much of it as the code under test calls, so the
 * main process's services run under node:test (Krewgent's
 * tests/electron-stub.mjs, cut to this app).
 *
 * One data folder per test file: `node --test` runs each file in its own
 * process, several at once, and two writing one settings file would be
 * testing each other. Named after the running bundle, and emptied as the file
 * loads, so a run starts from nothing and the set of folders stays bounded.
 */
const noop = () => undefined;
const bundle = (process.argv[1] || '').split(/[\\/]/).pop().replace(/\.mjs$/, '');
const userData = path.join(os.tmpdir(), 'cortex-desktop-test', bundle || 'shared');
if (bundle) fs.rmSync(userData, { recursive: true, force: true });

export const app = {
  getPath: () => userData,
  getVersion: () => '0.0.0-test',
  // Where the app's own files are: an empty folder here, so nothing beside it is taken for the app's.
  getAppPath: () => path.join(userData, 'app'),
  on: noop,
  whenReady: async () => undefined,
  requestSingleInstanceLock: () => true,
  quit: noop,
  isPackaged: false,
  loginItems: [],
  setLoginItemSettings(settings) {
    this.loginItems.push(settings);
  },
  // Whether a program is registered for a link's scheme; a test sets it.
  protocolApps: {},
  getApplicationNameForProtocol(url) {
    return this.protocolApps[url] ?? '';
  },
};

/** The handlers registered by electron/ipc.ts, by channel, for a test to call as the window would. */
export const handlers = new Map();
export const ipcMain = {
  handle: (channel, listener) => void handlers.set(channel, listener),
};

/** What the system's folder dialog answers next; a test sets it. */
export const dialogAnswer = { value: { canceled: true, filePaths: [] } };
export const dialog = { showOpenDialog: async () => dialogAnswer.value };

/** What the bin and the outside openings did, for a test to read; the real ones touch the desktop. */
export const shellCalls = [];
export const shell = {
  openExternal: async (url) => void shellCalls.push(['openExternal', url]),
  showItemInFolder: (file) => void shellCalls.push(['showItemInFolder', file]),
  trashItem: async (file) => {
    shellCalls.push(['trashItem', file]);
    fs.rmSync(file, { recursive: true, force: true });
  },
};

/** The system's encrypted store, as safeStorage is: reversible, and never the text it was given. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`sealed:${Buffer.from(text, 'utf8').toString('hex')}`, 'utf8'),
  decryptString: (sealed) => Buffer.from(sealed.toString('utf8').slice('sealed:'.length), 'hex').toString('utf8'),
};

export const sent = [];
export class BrowserWindow {
  static getAllWindows() {
    return [{ isDestroyed: () => false, webContents: { send: (channel, payload) => void sent.push([channel, payload]) } }];
  }
}
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
export const nativeImage = { createEmpty: () => ({ addRepresentation: noop }) };
export class Tray {
  on() {}
  setImage() {}
  setToolTip() {}
  popUpContextMenu() {}
  displayBalloon() {}
}
export const session = {};
export const contextBridge = { exposeInMainWorld: noop };
export const ipcRenderer = { invoke: async () => undefined, on: noop, removeListener: noop };
export default { app, ipcMain, dialog, shell, safeStorage, BrowserWindow, Menu, nativeImage, Tray, session, contextBridge, ipcRenderer };

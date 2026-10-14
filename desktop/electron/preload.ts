import { contextBridge, ipcRenderer } from 'electron';
import type { CortexApi } from '../shared/api';
import { plainIpcMessage, rejectionText } from '../shared/ipcError';

/**
 * Nothing but this object crosses into the window. No ipcRenderer, no node
 * globals: the window can only call the channels named here. The preload runs
 * sandboxed (electron/main.ts), so it is bundled whole and requires nothing
 * but `electron`.
 *
 * A call that is refused rejects with the sentence the handler wrote and not
 * with Electron's wrapping of it (`plainIpcMessage`). Every call passes here,
 * so it is done once, and no screen has to know the wrapping exists.
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  (ipcRenderer.invoke(channel, ...args) as Promise<T>).catch((err: unknown) => {
    throw new Error(plainIpcMessage(rejectionText(err)));
  });

const subscribe = (channel: string, handler: () => void): (() => void) => {
  // The event is not handed on: it carries the sender, which the window has no use for.
  const listener = () => handler();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: CortexApi = {
  bootstrap: () => invoke('app:bootstrap'),
  settings: {
    set: (patch) => invoke('settings:set', patch),
  },
  vault: {
    status: () => invoke('vault:status'),
    choose: () => invoke('vault:choose'),
  },
  notes: {
    index: () => invoke('notes:index'),
    read: (path) => invoke('notes:read', path),
    text: (path) => invoke('notes:text', path),
    save: (path, text, base) => invoke('notes:save', path, text, base),
    create: (folder, name, options) => invoke('notes:create', folder, name, options),
    createFolder: (parent, name) => invoke('notes:createFolder', parent, name),
    rename: (path, name) => invoke('notes:rename', path, name),
    move: (path, folder) => invoke('notes:move', path, folder),
    trash: (path) => invoke('notes:trash', path),
    binList: () => invoke('notes:binList'),
    binRestore: (id) => invoke('notes:binRestore', id),
    binDelete: (id) => invoke('notes:binDelete', id),
    binEmpty: () => invoke('notes:binEmpty'),
    backlinks: (path) => invoke('notes:backlinks', path),
    search: (query) => invoke('notes:search', query),
    asset: (path) => invoke('notes:asset', path),
    open: (path, how) => invoke('notes:open', path, how),
  },
  on: {
    notesChanged: (handler) => subscribe('notes:changed', handler),
  },
};

contextBridge.exposeInMainWorld('cortex', api);

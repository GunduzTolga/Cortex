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

/** A channel that carries data: the payload is handed on, the event that brought it is not. */
const listen = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
  const listener = (_event: unknown, payload: T) => handler(payload);
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
  chat: {
    clis: () => invoke('chat:clis'),
    list: () => invoke('chat:list'),
    open: (id) => invoke('chat:open', id),
    send: (id, cli, text) => invoke('chat:send', id, cli, text),
    cancel: (id) => invoke('chat:cancel', id),
    answer: (id, permission, option) => invoke('chat:answer', id, permission, option),
    setOption: (id, option, value) => invoke('chat:setOption', id, option, value),
    rename: (id, title) => invoke('chat:rename', id, title),
    remove: (id) => invoke('chat:remove', id),
    auth: () => invoke('chat:auth'),
    login: (cli) => invoke('chat:login', cli),
    install: (cli) => invoke('chat:install', cli),
    setKey: (cli, key, baseUrl) => invoke('chat:setKey', cli, key, baseUrl),
    forgetKey: (cli) => invoke('chat:forgetKey', cli),
    toInbox: (text) => invoke('chat:toInbox', text),
  },
  office: {
    models: (tool) => invoke('office:models', tool),
    talk: (request) => invoke('office:talk', request),
  },
  telegram: {
    status: () => invoke('telegram:status'),
    connect: (key) => invoke('telegram:connect', key),
    pairAgain: () => invoke('telegram:pairAgain'),
    disconnect: () => invoke('telegram:disconnect'),
  },
  setup: {
    status: () => invoke('setup:status'),
    installPython: () => invoke('setup:installPython'),
    installEngine: () => invoke('setup:installEngine'),
    installVoice: () => invoke('setup:installVoice'),
    voice: (patch) => invoke('setup:voice', patch),
  },
  on: {
    notesChanged: (handler) => subscribe('notes:changed', handler),
    chat: (handler) => listen('chat:event', handler),
    authChanged: (handler) => subscribe('chat:authChanged', handler),
    setup: (handler) => listen('setup:event', handler),
    openSettings: (handler) => subscribe('app:openSettings', handler),
  },
};

contextBridge.exposeInMainWorld('cortex', api);

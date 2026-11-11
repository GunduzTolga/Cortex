import { contextBridge, ipcRenderer } from 'electron';
import type { CortexApi } from '../shared/api';
import type { CliId } from '../shared/chat';
import type { GithubStatus } from '../shared/github';
import type { TailnetStatus } from '../shared/pairing';
import type { SyncStatus } from '../shared/vaultSync';
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

/*
  The notification-area icon's "Ayarlar", asked as the page finishes loading (a reload, the window made again, a start
  hidden at sign-in): main sends it then, before the app has begun to listen, and it was dropped (30 October). Kept
  until something listens, and handed to it then.
*/
let settingsAsked = false;
const settingsHeard = new Set<() => void>();
ipcRenderer.on('app:openSettings', () => {
  if (!settingsHeard.size) settingsAsked = true;
  for (const handler of settingsHeard) handler();
});

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
    createDefault: () => invoke('vault:createDefault'),
  },
  notes: {
    index: (whole?: boolean) => invoke('notes:index', whole === true),
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
    send: (id, cli, text, attachments) => invoke('chat:send', id, cli, text, attachments),
    attach: (name, data) => invoke('chat:attach', name, data),
    cancel: (id) => invoke('chat:cancel', id),
    answer: (id, permission, option) => invoke('chat:answer', id, permission, option),
    setOption: (id, option, value) => invoke('chat:setOption', id, option, value),
    offer: (cli) => invoke('chat:offer', cli),
    begin: (cli, option, value) => invoke('chat:begin', cli, option, value),
    rename: (id, title) => invoke('chat:rename', id, title),
    remove: (id) => invoke('chat:remove', id),
    auth: () => invoke('chat:auth'),
    login: (cli) => invoke('chat:login', cli),
    cancelLogin: (cli) => invoke('chat:cancelLogin', cli),
    install: (cli) => invoke('chat:install', cli),
    installProgress: (cli) => invoke('chat:installProgress', cli),
    setKey: (cli, key, baseUrl) => invoke('chat:setKey', cli, key, baseUrl),
    addTool: (cli) => invoke('chat:addTool', cli),
    removeTool: (cli) => invoke('chat:removeTool', cli),
    toInbox: (text) => invoke('chat:toInbox', text),
  },
  office: {
    models: (tool) => invoke('office:models', tool),
    talk: (request) => invoke('office:talk', request),
  },
  hermes: {
    status: () => invoke('hermes:status'),
    save: (setup) => invoke('hermes:save', setup),
    forget: () => invoke('hermes:forget'),
    test: () => invoke('hermes:test'),
  },
  mcp: {
    status: () => invoke('mcp:status'),
    addToClaude: () => invoke('mcp:addToClaude'),
  },
  tailnet: {
    status: () => invoke('tailnet:status'),
    pair: (code) => invoke('tailnet:pair', code),
    forget: () => invoke('tailnet:forget'),
  },
  github: {
    status: () => invoke('github:status'),
    start: () => invoke('github:start'),
    openVerify: () => invoke('github:openVerify'),
    repos: () => invoke('github:repos'),
    openInstall: () => invoke('github:openInstall'),
    create: (name) => invoke('github:create', name),
    connect: (fullName) => invoke('github:connect', fullName),
    disconnect: () => invoke('github:disconnect'),
  },
  vaultSync: {
    status: () => invoke('vaultSync:status'),
    setOn: (on) => invoke('vaultSync:setOn', on),
    now: () => invoke('vaultSync:now'),
    installGit: () => invoke('vaultSync:installGit'),
  },
  telegram: {
    status: () => invoke('telegram:status'),
    connect: (key) => invoke('telegram:connect', key),
    pairAgain: () => invoke('telegram:pairAgain'),
    disconnect: () => invoke('telegram:disconnect'),
  },
  setup: {
    status: () => invoke('setup:status'),
    settle: () => invoke('setup:settle'),
    installPython: () => invoke('setup:installPython'),
    installEngine: () => invoke('setup:installEngine'),
    installVoice: () => invoke('setup:installVoice'),
    voice: (patch) => invoke('setup:voice', patch),
    helper: () => invoke('setup:helper'),
    restartListener: () => invoke('setup:restartListener'),
    hotkey: (spec) => invoke('setup:hotkey', spec),
  },
  update: {
    ready: () => invoke('update:ready'),
    install: () => invoke('update:install'),
  },
  on: {
    notesChanged: (handler) => subscribe('notes:changed', handler),
    vaultSync: (handler) => listen<SyncStatus>('vaultSync:status', handler),
    github: (handler) => listen<GithubStatus>('github:status', handler),
    tailnet: (handler) => listen<TailnetStatus>('tailnet:status', handler),
    chat: (handler) => listen('chat:event', handler),
    authChanged: (handler) => listen<CliId | null>('chat:authChanged', (cli) => handler(typeof cli === 'string' ? cli : null)),
    toolsFound: (handler) => subscribe('chat:toolsFound', handler),
    setup: (handler) => listen('setup:event', handler),
    voiceStatus: (handler) => listen('setup:voice', handler),
    voiceHelper: (handler) => listen('setup:helper', handler),
    update: (handler) => listen('app:update', handler),
    notice: (handler) => listen('app:notice', handler),
    openSettings: (handler) => {
      settingsHeard.add(handler);
      if (settingsAsked) {
        settingsAsked = false;
        handler();
      }
      return () => void settingsHeard.delete(handler);
    },
    askWake: (handler) => subscribe('app:askWake', handler),
    flush: (handler) => {
      // Answered whatever the save came to: the window waits for the answer, not for the save to succeed.
      const listener = () => void handler().catch(() => undefined).finally(() => ipcRenderer.send('app:flushed'));
      ipcRenderer.on('app:flush', listener);
      return () => ipcRenderer.removeListener('app:flush', listener);
    },
  },
};

contextBridge.exposeInMainWorld('cortex', api);

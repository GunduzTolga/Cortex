import { BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import { type Capture, MicLink, micMayAsk, micMayCheck, micUrlAllowed } from './micCapture';
import { readSettings } from './settings';

/**
 * The window that records, never shown (micCapture.ts says why Cortex holds the microphone). It is made when the
 * helper first wants sound and closed a minute after it last did, so a machine with little memory does not keep a
 * page open for nothing; the wake listener keeps it while it listens. Where the person let the microphone listen
 * all the time it is made as the app starts (`startMicCapture`): the wake listener asks for sound within seconds,
 * and a window made only then, cold, took longer to send its first sound than the helper waited for it.
 *
 * It runs in a session of its own (PARTITION, kept in memory only): the app's session refuses every permission and
 * stays that way, and this one grants the microphone to this window and nothing else to anything.
 */
const PARTITION = 'cortex-mikrofon';
/** How long the window stays after the helper last wanted sound: the wake listener opens it again within seconds. */
const IDLE_CLOSE = 60_000;

let win: BrowserWindow | null = null;
let ready = false;
let pending: { microphone: string | null } | null = null;
let idle: NodeJS.Timeout | null = null;
let link: MicLink | null = null;
let sessionHeld = false;

function holdMicSession(): Electron.Session {
  const own = session.fromPartition(PARTITION, { cache: false });
  if (sessionHeld) return own;
  sessionHeld = true;
  const isOwn = (contents: Electron.WebContents | null) => !!contents && !!win && !win.isDestroyed() && contents === win.webContents;
  own.setPermissionRequestHandler((contents, permission, answer, details) =>
    answer(micMayAsk(permission, (details as Electron.MediaAccessPermissionRequest).mediaTypes, isOwn(contents))),
  );
  own.setPermissionCheckHandler((contents, permission, _origin, details) => micMayCheck(permission, details.mediaType, isOwn(contents)));
  own.setDevicePermissionHandler(() => false);
  own.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !micUrlAllowed(details.url) }));
  return own;
}

function make(): BrowserWindow {
  ready = false;
  const made = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    skipTaskbar: true,
    title: 'Cortex',
    webPreferences: {
      session: holdMicSession(),
      preload: path.join(__dirname, 'mic-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Hidden, its sound must not stop when Chromium slows pages nobody sees.
      backgroundThrottling: false,
    },
  });
  const contents = made.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('render-process-gone', () => {
    // The page died: the helper is told, records itself for a while, and the next request makes a new window.
    link?.word({ hata: 'kayıt penceresi kapandı' });
    if (win === made) win = null;
    if (!made.isDestroyed()) made.destroy();
  });
  made.on('closed', () => {
    if (win === made) win = null;
  });
  void made.loadFile(path.join(__dirname, 'mic.html'));
  return made;
}

const fromWindow = (event: Electron.IpcMainEvent) => !!win && !win.isDestroyed() && event.sender === win.webContents;

/** What the recording window says: registered once, when recording starts (a test loading this module registers nothing). */
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  ipcMain.on('mic:ready', (event) => {
    if (!fromWindow(event)) return;
    ready = true;
    if (pending) event.sender.send('mic:start', pending.microphone);
    pending = null;
  });

  ipcMain.on('mic:sound', (event, data: unknown) => {
    if (!fromWindow(event)) return;
    if (data instanceof Float32Array) link?.sound(data);
    else if (data instanceof ArrayBuffer && data.byteLength % 4 === 0) link?.sound(new Float32Array(data));
  });

  ipcMain.on('mic:word', (event, word: unknown) => {
    if (!fromWindow(event) || !word || typeof word !== 'object') return;
    const { aygit, hata } = word as Record<string, unknown>;
    if (typeof aygit === 'string') link?.word({ aygit: aygit.slice(0, 120) });
    if (typeof hata === 'string' && hata) link?.word({ hata: hata.slice(0, 200) });
  });
}

const windowCapture: Capture = {
  start(microphone) {
    if (idle) clearTimeout(idle);
    idle = null;
    if (!win || win.isDestroyed()) win = make();
    if (ready) win.webContents.send('mic:start', microphone);
    else pending = { microphone };
  },
  stop() {
    pending = null;
    if (win && !win.isDestroyed() && ready) win.webContents.send('mic:stop');
    closeWhenIdle();
  },
};

/** The window closed once the helper has not wanted sound for IDLE_CLOSE. */
function closeWhenIdle(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    idle = null;
    if (link?.wanted) return;
    const closing = win;
    win = null;
    if (closing && !closing.isDestroyed()) closing.destroy();
  }, IDLE_CLOSE);
  idle.unref?.();
}

/** Whether the recording window is made as the app starts: where the wake listener will ask for sound at once. */
export function madeAtStart(platform: NodeJS.Platform, wakeConsent: boolean): boolean {
  return platform === 'win32' && wakeConsent;
}

/** Whether a window is the hidden one that records: the app's own code looking for its window passes it by. */
export function isMicWindow(one: BrowserWindow): boolean {
  return one === win;
}

/** From the app's start until it quits; Windows only, where the listener is. */
export function startMicCapture(): void {
  if (process.platform !== 'win32' || link) return;
  listen();
  link = new MicLink(windowCapture);
  link.start();
  // Made now, its page loaded before sound is asked for; unused for a minute, it closes as any idle one does.
  if (madeAtStart(process.platform, readSettings().wakeConsent) && (!win || win.isDestroyed())) {
    win = make();
    closeWhenIdle();
  }
}

/** The app quits: the microphone let go at once, the helper takes it back when it next needs it. */
export function stopMicCapture(): void {
  link?.stop();
  link = null;
  if (idle) clearTimeout(idle);
  idle = null;
  const closing = win;
  win = null;
  if (closing && !closing.isDestroyed()) closing.destroy();
}

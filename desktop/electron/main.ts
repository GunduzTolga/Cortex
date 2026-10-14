import { app, BrowserWindow, Menu, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc, stopWatching, trustPagesWhere } from './ipc';
import { readSettings } from './services/settings';

const DEV_SERVER = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER);

/*
  CORTEX_HIDDEN=1 never shows the window: the e2e run (e2e/smoke.mjs) drives
  the app and photographs it with `capturePage` without a window appearing
  over whatever the person at the machine is doing. The page is then drawn
  offscreen, because a window that is only `show: false` is barely painted
  and a picture of it is whatever frame came last (Krewgent learnt it).
*/
const HIDDEN = process.env.CORTEX_HIDDEN === '1';

/** The paper the window is drawn on before the page paints (tema/ananas: --ananas-paper). */
const PAPER = '#f3efe4';

/*
  Windows names a notification, and groups the taskbar button, by this id; it
  is `build.appId` in package.json, written twice because electron-builder
  reads it from there and this process cannot.
*/
if (process.platform === 'win32') app.setAppUserModelId('com.soleluna.cortex');

// __dirname exists because the main bundle is emitted as CommonJS: dist-electron/, so its parent is desktop/.
const rootDir = path.join(__dirname, '..');
const pageFile = path.join(rootDir, 'dist', 'index.html');
const pageUrl = pathToFileURL(pageFile).href;

let window: BrowserWindow | null = null;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Whether an address is the app's own page: its built file, or the dev server while developing. */
function isOwnPage(url: string): boolean {
  if (DEV_SERVER) return sameOrigin(url, DEV_SERVER);
  return url.split(/[?#]/)[0] === pageUrl;
}

/** Pyn's seal (tema/ananas/marka), beside the bundle when packaged and in the repository when run from source. Linux reads it at runtime; Windows takes the exe's. */
function windowIcon(): string | undefined {
  const candidates = [path.join(process.resourcesPath ?? '', 'pyn-muhur-200.png'), path.join(rootDir, '..', 'tema', 'ananas', 'marka', 'pyn-muhur-200.png')];
  return candidates.find((file) => fs.existsSync(file));
}

/**
 * What any page of this app is held to, whatever made it: no new window, no
 * navigation away, no webview. A link in a note with `target=_blank` is the
 * person's click on an address they wrote, and goes to the system's browser,
 * as in Krewgent; nothing opens inside the app.
 */
function holdContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    // Compared as origins, not as text: `startsWith` let `http://localhost:5274.evil.example` through in Krewgent's first version.
    if (isOwnPage(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * The session the window runs in asks for nothing and reaches nothing. Every
 * permission - camera, microphone, notifications, the clipboard API, the
 * location - is refused without a question, and a request for anything but
 * the app's own files (and the dev server while developing) is cancelled
 * before it leaves: the page's own policy (index.html) says the same, and
 * this holds even for what a policy does not cover.
 */
function holdSession(): void {
  const own = session.defaultSession;
  own.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  own.setPermissionCheckHandler(() => false);
  own.setDevicePermissionHandler(() => false);
  /*
    Chromium fetches its spellchecker's Hunspell dictionaries from Google's
    servers (redirector.gvt1.com) the first time a text field is focused: a
    request that says this app ran, from this address. It is pointed at a port
    on this machine that answers nothing, so nothing leaves; the price is no
    Hunspell dictionary, and spelling is checked only where the platform's own
    checker is used.
  */
  own.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
  own.webRequest.onBeforeRequest((details, answer) => {
    const url = details.url;
    const allowed =
      url.startsWith('file:') ||
      url.startsWith('data:') ||
      url.startsWith('devtools:') ||
      url.startsWith('chrome-extension:') ||
      (DEV_SERVER ? sameOrigin(url, DEV_SERVER) || sameOrigin(url.replace(/^ws/, 'http'), DEV_SERVER) : false);
    answer({ cancel: !allowed });
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: PAPER,
    title: 'Cortex',
    icon: windowIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Hidden, the page is drawn offscreen: see HIDDEN above.
      ...(HIDDEN ? { offscreen: true } : {}),
    },
  });
  if (HIDDEN) window.webContents.setFrameRate(30);

  window.once('ready-to-show', () => {
    if (!HIDDEN) window?.show();
  });

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(pageFile);
  }

  window.on('closed', () => {
    window = null;
  });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('web-contents-created', (_event, contents) => holdContents(contents));

// One instance only: a second launch brings the window that is there to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    holdSession();
    trustPagesWhere(isOwnPage);
    registerIpc();
    buildMenu();
    // Read once at start, so a settings file that will not be read is found before the window asks.
    readSettings();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopWatching());

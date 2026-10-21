import { app, BrowserWindow, Menu, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc, stopWatching, trustPagesWhere } from './ipc';
import { readSettings } from './services/settings';
import { startTelegram } from './services/telegram';
import { startMicrophoneWord, stopMicrophoneWord } from './services/microphone';
import { listeningNow, startTray, startWithWindows, trayNotice } from './services/tray';

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

/*
  Started with Windows (the `background` setting): only the icon at the bottom
  right, the window when asked for. And with `background` on, closing the
  window only hides it: Cortex quits from the icon's menu.
*/
const START_HIDDEN = process.argv.includes('--gizli');
let quitting = false;
let toldOfTray = false;

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

/**
 * Pyn's seal (tema/ananas/marka), beside the bundle when packaged and in the
 * repository when run from source. Windows gets the .ico: it holds every size
 * from 16 to 256 already smoothed, and the frame takes the one that fits,
 * where the 200px PNG was shrunk to 16-20px without smoothing and showed
 * every pixel in the title bar.
 */
function windowIcon(): string | undefined {
  const file = process.platform === 'win32' ? 'pyn.ico' : 'pyn-muhur-200.png';
  const candidates = [path.join(process.resourcesPath ?? '', file), path.join(rootDir, '..', 'tema', 'ananas', 'marka', file)];
  return candidates.find((one) => fs.existsSync(one));
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

function createWindow(showNow = true): void {
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
    if (!HIDDEN && showNow) window?.show();
  });

  // Windows shutting down or signing out: the window closes for good, nothing holds the session up.
  window.on('query-session-end', () => {
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting || HIDDEN || !readSettings().background) return;
    event.preventDefault();
    window?.hide();
    // The microphone still listening is said every time: the window gone is not the microphone off.
    if (listeningNow()) {
      const english = readSettings().language === 'en';
      trayNotice(
        'Cortex',
        english
          ? 'Cortex keeps running at the bottom right, and the microphone still listens for the wake phrase. To stop it, turn listening off from the icon, or Quit.'
          : 'Cortex sağ altta çalışıyor ve mikrofon uyandırma sözünü dinlemeye devam ediyor. Durdurmak için simgeden sürekli dinlemeyi kapat ya da Çık.',
      );
      toldOfTray = true;
    } else if (!toldOfTray) {
      toldOfTray = true;
      const english = readSettings().language === 'en';
      trayNotice(
        'Cortex',
        english
          ? 'Cortex keeps running at the bottom right. Open it, or switch the microphone, from the icon.'
          : 'Cortex sağ altta çalışmaya devam ediyor. Simgeden açabilir, mikrofonu açıp kapatabilirsin.',
      );
    }
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

/** The window brought back and told something (the icon's "Ayarlar", its "listen all the time"), once its page is there to be told. */
function showAndTell(channel: string): void {
  showWindow();
  const contents = window?.webContents;
  if (!contents) return;
  const tell = () => contents.send(channel);
  if (contents.isLoading()) contents.once('did-finish-load', tell);
  else tell();
}

const showSettings = () => showAndTell('app:openSettings');

/** The window brought back: from the icon, or a second launch; made again if it was closed for good. */
function showWindow(): void {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(() => {
    holdSession();
    trustPagesWhere(isOwnPage);
    registerIpc();
    buildMenu();
    // Read once at start, so a settings file that will not be read is found before the window asks.
    readSettings();
    createWindow(!START_HIDDEN);
    if (!HIDDEN) {
      // The microphone listens all the time only while Cortex runs: said from now until it quits.
      startMicrophoneWord();
      startTray({
        open: showWindow,
        settings: showSettings,
        // "Listen all the time" from the icon, not allowed yet: asked in the window, where it is explained.
        askWake: () => showAndTell('app:askWake'),
        quit: () => {
          quitting = true;
          app.quit();
        },
      });
      startWithWindows(readSettings().background);
      // Notes from the phone keep coming in while Cortex runs, in the notification area too.
      startTelegram();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  stopMicrophoneWord();
  stopWatching();
});

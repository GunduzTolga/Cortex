import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { moveYakala, registerIpc, startAppUpdates, stopWatching, trustPagesWhere } from './ipc';
import { readSettings } from './services/settings';
import { settleVault, setupBusy, whenSetupIdle } from './services/setup';
import { startTelegram } from './services/telegram';
import { startVaultSync, syncBeforeQuit } from './services/vaultSync';
import { startTailnet } from './services/tailnet';
import { startMicrophoneWord, stopMicrophoneWord } from './services/microphone';
import { startMicCapture, stopMicCapture } from './services/micWindow';
import { keepStartWithWindows, listeningNow, startTray, trayNotice } from './services/tray';
import { WINDOW_DEFAULT, WINDOW_MIN, keepWindowState, readWindowState, windowSizesFor } from './services/windowState';
import { SHOW_ANYWAY_MS, failedLoadStep } from './services/pageLoad';
import { applyTheme } from './services/theme';
import { startedByQuietInstall } from './services/updater';

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
/** The dark theme's paper (src/index.css), the window's colour before the page is drawn. */
const NIGHT_PAPER = '#1c1a16';

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
const START_HIDDEN = [process.argv.includes('--gizli'), startedByQuietInstall()].some(Boolean);
/*
  A newer Cortex waiting is installed unasked only here (services/updater.ts): started with Windows, the window not
  opened since, in the first minutes - later, someone may be talking to the voice helper with the window closed.
*/
const QUIET_UPDATE_WITHIN = 10 * 60;
let seen = false;
let quitting = false;
let toldOfTray = false;

/*
  The page saves what it holds before its window goes for good. A note is
  saved a second after its last key, and a window closed within that second
  (background off, Quit from the icon, Windows shutting down) took the last
  words with it (desktop-ui-8). The close is held once, the page asked
  (src/notes/openNotes.ts, through the preload), and made again when it
  answers, or after FLUSH_MS when it cannot.
*/
const FLUSH_MS = 1500;
let flushed: 'no' | 'asking' | 'done' = 'no';

function flushPage(contents: Electron.WebContents): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener('app:flushed', heard);
      done();
    };
    const heard = (event: Electron.IpcMainEvent) => {
      if (event.sender === contents) finish();
    };
    const timer = setTimeout(finish, FLUSH_MS);
    ipcMain.on('app:flushed', heard);
    try {
      contents.send('app:flush');
    } catch {
      finish();
    }
  });
}

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
 * An address for the system's browser, at most one every 300 ms and five in ten seconds: a page made to open them in a
 * loop (a note's script would be one, were scripts let run) put five tabs up at once (29 October), and one a little
 * slower than the gap went on opening a tab every third of a second (30 October). At one a second, a person's second
 * link clicked quickly was lost; a person does not click two links within 300 ms, nor six within ten seconds.
 */
const opened: number[] = [];
function openOutside(url: string): void {
  const now = Date.now();
  while (opened.length && now - opened[0] > 10_000) opened.shift();
  if (opened.length >= 5 || (opened.length && now - opened[opened.length - 1] < 300)) return;
  opened.push(now);
  void shell.openExternal(url);
}

/**
 * What any page of this app is held to, whatever made it: no new window, no
 * navigation away, no webview. A link in a note with `target=_blank` is the
 * person's click on an address they wrote, and goes to the system's browser,
 * as in Krewgent; nothing opens inside the app.
 */
function holdContents(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    // Compared as origins, not as text: `startsWith` let `http://localhost:5274.evil.example` through in Krewgent's first version.
    if (isOwnPage(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) openOutside(url);
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

/*
  A page that died - out of memory on a large vault, the GPU process gone on a
  laptop - is loaded again: left, the window stayed a blank sheet of paper, and
  with `background` on, closing it only hid it, so "Cortex'i aç" brought the
  same blank page back (desktop-shell-9). At most CRASHES_PER_MINUTE times a
  minute; past that the person is asked, rather than the page dying and coming
  back for ever. What the main process holds - the chats, a setup going on,
  Telegram - goes on; the page reads it again as it starts.
*/
const CRASHES_PER_MINUTE = 3;
let crashes: number[] = [];
let askingAfterCrash = false;

async function pageGone(contents: Electron.WebContents, details: Electron.RenderProcessGoneDetails): Promise<void> {
  if (details.reason === 'clean-exit' || quitting || contents.isDestroyed()) return;
  const now = Date.now();
  crashes = [...crashes.filter((at) => now - at < 60_000), now];
  if (crashes.length <= CRASHES_PER_MINUTE) {
    contents.reload();
    return;
  }
  if (askingAfterCrash || HIDDEN) return;
  askingAfterCrash = true;
  const english = readSettings().language === 'en';
  try {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Cortex',
      message: english ? 'Cortex’s window stopped working several times in a short while.' : 'Cortex’in penceresi kısa sürede birkaç kez çöktü.',
      detail: english ? 'Try once more; if it goes on, quit Cortex and open it again.' : 'Bir kez daha dene; sürerse Cortex’i kapatıp yeniden aç.',
      buttons: english ? ['Try again', 'Quit'] : ['Yeniden dene', 'Çık'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) void quitWhenSetupAllows();
    else if (!contents.isDestroyed()) {
      crashes = [];
      contents.reload();
    }
  } finally {
    askingAfterCrash = false;
  }
}

/*
  The app's own page would not load (services/pageLoad.ts): loaded once more by itself, then the person is told and
  asked, on a window that is shown. At a start with Windows nothing is put on the screen for it: the page is loaded
  again when the window is asked for (`showWindow`), and said then if it fails again.
*/
let loadFailures = 0;
let loadFailedUnseen = false;
let askingAfterLoad = false;

function loadPage(win: BrowserWindow): void {
  // A load that fails is heard as `did-fail-load`; its promise says the same and is not waited on.
  void (DEV_SERVER ? win.loadURL(DEV_SERVER) : win.loadFile(pageFile)).catch(() => undefined);
}

async function pageNotLoaded(win: BrowserWindow): Promise<void> {
  if (HIDDEN || quitting || askingAfterLoad || win.isDestroyed()) return;
  if (!win.isVisible()) {
    // Started in the notification area, or closed to it since: nothing appears by itself; tried again when it is opened.
    if (START_HIDDEN || seen) {
      loadFailedUnseen = true;
      return;
    }
    reveal(win);
  }
  askingAfterLoad = true;
  const english = readSettings().language === 'en';
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Cortex',
      message: english ? 'Cortex could not open its window.' : 'Cortex penceresini açamadı.',
      detail: english
        ? 'Try again; if it goes on, quit Cortex and start it again, and if that fails too, install Cortex again.'
        : 'Yeniden dene; sürerse Cortex’i kapatıp yeniden başlat, yine olmazsa Cortex’i yeniden kur.',
      buttons: english ? ['Try again', 'Quit'] : ['Yeniden dene', 'Çık'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) void quitWhenSetupAllows();
    else if (!win.isDestroyed()) {
      loadFailures = 0;
      loadPage(win);
    }
  } finally {
    askingAfterLoad = false;
  }
}

/** Maximized as it is first shown, where it was left so (maximizing shows it too). */
let maximizeOnShow = false;
/** Whether the window made last has been shown yet: its first frame, or the wait for it, shows it once. */
let firstShown = false;
function reveal(win: BrowserWindow): void {
  seen = true;
  firstShown = true;
  if (maximizeOnShow) {
    maximizeOnShow = false;
    win.maximize();
  }
  win.show();
}

function createWindow(showNow = true): void {
  flushed = 'no';
  // Where it was left; filling the screen at the first opening (services/windowState.ts). The e2e run's hidden window keeps the default.
  const kept = HIDDEN ? { bounds: null, maximized: false } : readWindowState();
  maximizeOnShow = kept.maximized;
  // Never larger than the screen it opens on: at 1366x768 and 125-150% the old least size (1040x680) lay partly off it.
  const sizes = HIDDEN ? { min: WINDOW_MIN, open: WINDOW_DEFAULT } : windowSizesFor(kept.bounds);
  window = new BrowserWindow({
    width: kept.bounds?.width ?? sizes.open.width,
    height: kept.bounds?.height ?? sizes.open.height,
    ...(kept.bounds ? { x: kept.bounds.x, y: kept.bounds.y } : {}),
    minWidth: sizes.min.width,
    minHeight: sizes.min.height,
    backgroundColor: nativeTheme.shouldUseDarkColors ? NIGHT_PAPER : PAPER,
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
  else keepWindowState(window);
  const contents = window.webContents;
  contents.on('render-process-gone', (_event, details) => void pageGone(contents, details));
  const made = window;
  loadFailures = 0;
  loadFailedUnseen = false;
  contents.on('did-finish-load', () => {
    loadFailures = 0;
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const step = failedLoadStep(loadFailures, errorCode, isMainFrame);
    if (step === 'ignore' || made.isDestroyed()) return;
    console.error('[window] the page could not be loaded', errorCode, errorDescription, validatedURL);
    loadFailures += 1;
    if (step === 'reload') loadPage(made);
    else void pageNotLoaded(made);
  });

  // Shown at its first frame; where that has not come after a while, shown anyway rather than never (services/pageLoad.ts).
  firstShown = false;
  const showFirst = () => {
    if (firstShown || HIDDEN || !showNow || made.isDestroyed() || window !== made) return;
    reveal(made);
  };
  made.once('ready-to-show', showFirst);
  const showAnyway = setTimeout(showFirst, SHOW_ANYWAY_MS);

  // Windows shutting down or signing out: the window closes for good, nothing holds the session up.
  window.on('query-session-end', () => {
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting || HIDDEN || !readSettings().background) {
      // Closed for good with a setup going on: asked first (`quitWhenSetupAllows`). Not when Windows signs out.
      if (!quitting && !HIDDEN && setupBusy()) {
        event.preventDefault();
        void quitWhenSetupAllows();
        return;
      }
      // Closed for good: the page is asked to save what it holds first (`flushPage`).
      const closing = window;
      if (flushed === 'done' || !closing || closing.webContents.isDestroyed() || closing.webContents.isCrashed()) return;
      event.preventDefault();
      if (flushed === 'asking') return;
      flushed = 'asking';
      // Quitting, what was written goes to the vault's remote too, waited for a few seconds at most (services/vaultSync.ts).
      void flushPage(closing.webContents)
        .then(() => (quitting ? syncBeforeQuit() : undefined))
        .then(() => {
          flushed = 'done';
          if (quitting) app.quit();
          else if (!closing.isDestroyed()) closing.close();
        });
      return;
    }
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

  loadPage(made);
  if (DEV_SERVER) made.webContents.openDevTools({ mode: 'detach' });

  // This window's going, not one made after it: a window whose page died is replaced (`showWindow`), and its end comes after.
  made.on('closed', () => {
    clearTimeout(showAnyway);
    if (window === made) window = null;
    // Closed for good (Windows signing out): the hidden recording window must not keep the app from quitting.
    if (quitting) stopMicCapture();
  });
}

/**
 * Quitting while a setup job runs (services/setup.ts) cut it short without a word: the engine's update half
 * applied, a 2 GB download stopped, voice typing said installed without its model (desktop-shell-5). The person
 * is asked first: quit once it is done (the window goes, the job goes on), quit anyway, or stay. A Windows
 * sign-out or shutdown is never held up by it (`quitting` is already set then).
 */
let askingToQuit = false;
async function quitWhenSetupAllows(): Promise<void> {
  if (setupBusy() && !askingToQuit) {
    askingToQuit = true;
    const english = readSettings().language === 'en';
    let response: number;
    try {
      ({ response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Cortex',
        message: english ? 'A setup is still going on.' : 'Bir kurulum hâlâ sürüyor.',
        detail: english ? 'Quitting now leaves it half done. Cortex can quit by itself once it has finished.' : 'Şimdi çıkarsan yarıda kalır. Cortex, bitince kendiliğinden kapanabilir.',
        buttons: english ? ['Quit when it is done', 'Quit anyway', 'Cancel'] : ['Bitince çık', 'Yine de çık', 'Vazgeç'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }));
    } finally {
      askingToQuit = false;
    }
    if (response === 2) return;
    if (response === 0) {
      window?.hide();
      await whenSetupIdle();
    }
  } else if (askingToQuit) {
    return;
  }
  quitting = true;
  app.quit();
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

/** The window brought back: from the icon, or a second launch; made again if it was closed for good, or its page died and stayed dead. */
function showWindow(): void {
  if (window && !window.isDestroyed() && window.webContents.isCrashed()) {
    window.destroy();
    window = null;
  }
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  reveal(window);
  window.focus();
  // Its page had not loaded while nobody looked (a start with Windows): tried again now, and said if it fails again.
  if (loadFailedUnseen) {
    loadFailedUnseen = false;
    loadFailures = 0;
    loadPage(window);
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        // Reloading the page drops what a note holds unsaved, with no question: only while developing (desktop-ui-8).
        ...(isDev ? [{ role: 'reload' as const }, { role: 'forceReload' as const }, { type: 'separator' as const }] : []),
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
    // The theme is set before the window is made: a dark choice did not open on a light frame first.
    applyTheme(readSettings().theme);
    createWindow(!START_HIDDEN);
    if (!HIDDEN) {
      // The microphone listens all the time only while Cortex runs: said from now until it quits.
      startMicrophoneWord();
      // While it runs, Cortex records for the voice helper: Windows names Cortex on the microphone, not Python.
      startMicCapture();
      startTray({
        open: showWindow,
        settings: showSettings,
        // "Listen all the time" from the icon, not allowed yet: asked in the window, where it is explained.
        askWake: () => showAndTell('app:askWake'),
        quit: () => void quitWhenSetupAllows(),
      });
      // Written where it is missing, not at every start: a person who turned Cortex off in Windows' own start-up list keeps it off.
      keepStartWithWindows(readSettings().background);
      // A newer Cortex from the releases, fetched in the background and installed when the person says, at the next
      // quit, or unasked at a start with Windows nobody has seen yet.
      startAppUpdates(trayNotice, () => START_HIDDEN && !seen && process.uptime() < QUIET_UPDATE_WITHIN);
    }
    // The vault kept from the last run bound to where it is now, in the background (services/setup.ts); notes
    // from the phone then keep coming in while Cortex runs, in the notification area too. Yakala, where it was left
    // on a vault no longer there (this one, before it moved), comes to this one.
    const settled = settleVault();
    // Pyn's server paired by code (services/tailnet.ts): its helper back up as the same device, or the address reached straight.
    void startTailnet();
    if (!HIDDEN) {
      void settled.then(() => {
        startTelegram();
        moveYakala(true);
        // Kept in step with its git remote, where the switch is on (services/vaultSync.ts).
        startVaultSync();
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // Quit from elsewhere (the menu's Exit) while a setup runs: asked first, as from the icon. Windows signing
  // out has set `quitting` already (the window's query-session-end), and is not held up.
  if (!quitting && !HIDDEN && setupBusy()) {
    event.preventDefault();
    void quitWhenSetupAllows();
    return;
  }
  quitting = true;
  stopMicrophoneWord();
  stopMicCapture();
  stopWatching();
});

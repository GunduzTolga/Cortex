import { _electron as electron } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distinctColours, encodedCommand, installLayout, probeScript, readArgs, readProbe, resourceProblems, samePath, tasklistPids, waitFor } from '../scripts/kurulu-yardimci.mjs';

/**
 * The installer itself, tried as a person's first day goes: `Cortex-Setup-<version>.exe` installed on this Windows,
 * the installed Cortex.exe opened, its first screen seen, closed, and the app uninstalled again.
 *
 * e2e/smoke.mjs walks the app from the source tree (`electron .`), and the build only looked whether an installer came
 * out (.github/workflows/desktop.yml). Neither sees what only the packaged app has: the bundle read from app.asar, the
 * engine and Python the installer lays down beside it, the shortcuts, the uninstaller, the first start of the .exe a
 * person double-clicks (the review before the public release, K6).
 *
 *   node e2e/kurulu.mjs [--motor] [--gizli] [--kurucu <Cortex-Setup-….exe>]
 *
 * - `--motor`: the first-run screen's "set Pyn's memory up" step too, into a vault of this run's own, with the engine
 *   package the installed app carries. It needs a Python 3.11+ (BEYIN_PYTHON, or one the app finds) and writes that
 *   vault's state under %LOCALAPPDATA%\beyin-v3, which the run takes away again. CI runs with it.
 * - `--gizli`: the window never shown (CORTEX_HIDDEN=1, as e2e/smoke.mjs runs), where a window in front of the person
 *   is not wanted. Without it the app starts as a person starts it: window shown, notification-area icon, and the
 *   "start with Windows" entry written, which the uninstall is then seen to take away.
 *
 * Windows only, and only where Cortex is not installed: the run installs and uninstalls the real app for this user,
 * and refuses to do so over a person's own Cortex. The app's own data is kept in folders of this run
 * (`--user-data-dir`, Documents redirected in the main process, as e2e/smoke.mjs does); the person's %APPDATA%\Cortex
 * and %LOCALAPPDATA%\beyin-v3 each get one marker file, to see that a silent uninstall leaves them, and lose it again.
 *
 * Not tried here: the Python the app carries being installed (the first-run screen's Python step). The app offers it
 * only where the machine has no Python fit for the engine, and a CI runner has several; `--motor` runs the engine on
 * the runner's. That the installer is carried whole is checked by its bytes, and that the app finds it by asking it.
 *
 * What it saw is kept in e2e/screenshots/kurulu/: pictures of the window, and `uygulama.log` - the checks, what the
 * app wrote to its console and what its page logged. The app keeps no log file of its own.
 */
const options = readArgs(process.argv.slice(2));
if (process.platform !== 'win32') {
  console.error('e2e/kurulu.mjs yalnız Windows\'ta çalışır: kurucu bir Windows programıdır.');
  process.exit(2);
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const pythonPin = JSON.parse(fs.readFileSync(path.join(desktop, 'python.json'), 'utf8'));
const out = path.join(desktop, 'e2e', 'screenshots', 'kurulu');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const logFile = path.join(out, 'uygulama.log');
const note = (text) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
const say = (text) => {
  console.log(text);
  note(text.trim());
};

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) say(`  ok   ${label}`);
  else {
    say(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
    failures.push(label);
  }
  return Boolean(condition);
};
/** A step without which the rest cannot be tried: the run goes to its tidying up, failed. */
class Stopped extends Error {}
const must = (label, condition, detail = '') => {
  if (!check(label, condition, detail)) throw new Stopped(label);
};

const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const layout = installLayout(pkg, process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'));
const installer = path.resolve(desktop, options.installer ?? path.join('release', layout.installer));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** What Windows says of the install now (scripts/kurulu-yardimci.mjs, `probeScript`); null where PowerShell did not answer. */
function probe() {
  const asked = spawnSync(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(probeScript(layout, pkg.build.appId))], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const answer = readProbe(asked.stdout);
  if (!answer) note(`probe: no answer (status ${asked.status}, ${asked.error?.message ?? String(asked.stderr ?? '').slice(0, 400)})`);
  return answer;
}

/** A program run and waited for, without a shell and without a window: its exit code, or why there is none. */
const run = (file, args, timeout) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ code: null, why: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, why: `not done after ${Math.round(timeout / 1000)} s` });
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, why: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, why: '' });
    });
  });

/** The installed app's processes still running, by the name of its .exe. */
function running() {
  const image = path.win32.basename(layout.exe);
  const listed = spawnSync(path.join(system32, 'tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'latin1', windowsHide: true, timeout: 30_000 });
  return tasklistPids(String(listed.stdout ?? ''), image);
}

const temporary = [];
const ownFolder = (name) => {
  // The long name: Windows' temp folder is often given by its short one (RUNNER~1), and the app says the long one back.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `cortex-kurulu-${name}-`)));
  temporary.push(dir);
  return dir;
};

let installed = false;
// Whether the installer was started at all, and whether its copy of itself for the updater was there before it.
let installedOnce = false;
let cacheWasThere = true;
let app = null;
let page = null;
let placed = { dir: layout.instDir, exe: layout.exe, uninstaller: layout.uninstaller, resources: layout.resources };
const markers = [];
let engineState = null;

/**
 * A picture of the window and how many colours it holds, taken in the main process (a hidden window does not answer
 * `page.screenshot`); where the main process is handed no frame of a shown window, the page's own screenshot instead.
 */
async function shoot(name) {
  let taken = null;
  try {
    taken = await app.evaluate(async ({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows();
      const win = all.find((one) => one.webContents.getURL().includes('index.html')) ?? all[0];
      const image = await win.webContents.capturePage();
      return { png: image.toPNG().toString('base64'), small: image.isEmpty() ? '' : image.resize({ width: 64 }).toBitmap().toString('base64'), size: image.getSize() };
    });
  } catch (err) {
    note(`picture ${name}: capturePage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ((!taken || !taken.small) && page) {
    try {
      const png = (await page.screenshot({ timeout: 15_000 })).toString('base64');
      taken = await app.evaluate(({ nativeImage }, data) => {
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
        return { png: data, small: image.isEmpty() ? '' : image.resize({ width: 64 }).toBitmap().toString('base64'), size: image.getSize() };
      }, png);
    } catch (err) {
      note(`picture ${name}: page.screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!taken) return { colours: 0, size: { width: 0, height: 0 } };
  if (taken.png) fs.writeFileSync(path.join(out, name), Buffer.from(taken.png, 'base64'));
  return { colours: taken.small ? distinctColours(Buffer.from(taken.small, 'base64')) : 0, size: taken.size };
}

const shownSoon = (locator, timeout = 10_000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
/** Asked of the main process once more where Playwright lost the answer (e2e/smoke.mjs, `setInMain`). */
const inMain = async (fn, arg) => {
  try {
    return await app.evaluate(fn, arg);
  } catch (err) {
    if (!/garbage collected/i.test(String(err))) throw err;
    return app.evaluate(fn, arg);
  }
};
const within = (promise, ms, otherwise = null) => Promise.race([promise, sleep(ms).then(() => otherwise)]);
/** What the page shows now, in words: a picture alone may be an earlier frame. */
const pageNow = async () => {
  if (!page) return 'no page';
  return within(
    page.evaluate(() => `step=${document.querySelector('[data-onboarding]')?.getAttribute('data-onboarding-step') ?? '-'} | ${document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 600) ?? ''}`).catch((err) => `unreadable: ${err.message}`),
    10_000,
    'no answer',
  );
};

async function stopApp() {
  if (!app) return;
  const child = app.process();
  const closing = app;
  app = null;
  page = null;
  const closed = await within(closing.close().then(() => true, () => false), 60_000, false);
  if (!closed || child.exitCode === null) {
    // Started through a shell on Windows (Playwright): the tree under it is what must go.
    spawnSync(path.join(system32, 'taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 30_000 });
  }
  return { closed, code: child.exitCode };
}

try {
  say(`\nCortex ${layout.version}, installed from ${installer}`);
  say(`${options.hidden ? 'window hidden' : 'window shown'}, ${options.engine ? 'with' : 'without'} the engine set up in a vault`);

  say('\nBefore');
  must('the installer is there', fs.existsSync(installer) && fs.statSync(installer).size > 0, installer);
  const before = probe();
  must('Windows answers what is asked of it (PowerShell)', before !== null);
  must(
    'Cortex is not installed here: the run installs and uninstalls for this user, never over a person’s own Cortex',
    !before.installLocation && !before.machineLocation && !fs.existsSync(layout.instDir),
    `found: ${before.installLocation ?? before.machineLocation ?? layout.instDir}`,
  );

  cacheWasThere = fs.existsSync(layout.updaterCache);

  say('\nInstalled silently');
  // `/S` alone, as a silent install is: per user, into the user's program folder (assistedInstaller.nsh, multiUser.nsh).
  installed = true;
  installedOnce = true;
  const setup = await run(installer, ['/S'], 5 * 60_000);
  must('the installer ends by itself, well', setup.code === 0, `exit code ${setup.code}${setup.why ? ` (${setup.why})` : ''}`);
  const after = probe();
  if (after?.installLocation) placed = { dir: after.installLocation, exe: path.win32.join(after.installLocation, path.win32.basename(layout.exe)), uninstaller: path.win32.join(after.installLocation, path.win32.basename(layout.uninstaller)), resources: path.win32.join(after.installLocation, 'resources') };
  // A scanner may hold the last files a moment after the installer is gone.
  const laid = await waitFor(() => fs.existsSync(placed.exe) && fs.existsSync(placed.uninstaller), { timeout: 60_000 });
  must('the app and its uninstaller are where the installer says', laid, `${placed.exe} | ${placed.uninstaller}`);
  check(
    'for this user only, in the user’s program folder, with no entry for every user',
    after !== null && samePath(after.installLocation ?? '', layout.instDir) && !after.machineLocation,
    `installed at ${after?.installLocation ?? '?'}, expected ${layout.instDir}; for every user: ${after?.machineLocation ?? 'no'}`,
  );
  check(
    'Windows lists it among the programs, with its version and a way to uninstall it quietly',
    after?.displayVersion === layout.version && String(after?.displayName ?? '').includes(layout.product) && String(after?.quietUninstall ?? '').includes(path.win32.basename(layout.uninstaller)),
    JSON.stringify({ name: after?.displayName, version: after?.displayVersion, quiet: after?.quietUninstall }),
  );
  const links = [layout.desktopShortcut && after?.desktop ? path.win32.join(after.desktop, layout.desktopShortcut) : null, layout.menuShortcut && after?.programs ? path.win32.join(after.programs, layout.menuShortcut) : null];
  check(
    'a shortcut on the desktop and one in the Start menu',
    links.every((link, at) => (link ? fs.existsSync(link) : !(at ? layout.menuShortcut : layout.desktopShortcut))),
    links.map((link) => `${link ?? '(folder not known)'}: ${link && fs.existsSync(link) ? 'there' : 'missing'}`).join(' | '),
  );
  check('the bundle is packed beside it', fs.existsSync(path.join(placed.resources, 'app.asar')), path.join(placed.resources, 'app.asar'));
  // Everything the build was given to carry (package.json, extraResources: the engine package, Python's installer, the
  // voice's Vulkan build, the seal, the licences), byte for byte: what scripts/check-resources.cjs asks of the build.
  const wrong = resourceProblems(desktop, pkg.build.extraResources, placed.resources);
  check('what the installer carries is installed, byte for byte: the engine package, Python, the voice’s build, the seal', wrong.length === 0, wrong.join('\n       '));

  say('\nOpened');
  const userData = ownFolder('veri');
  const documents = ownFolder('belgeler');
  const env = {};
  // One Path, and nothing that would make the .exe start as plain node or hidden unasked.
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CORTEX_HIDDEN'].includes(key.toUpperCase())) env[key] = value;
  // Never the releases: a run does not download, nor install, another Cortex (electron/services/updater.ts).
  env.CORTEX_NO_UPDATE = '1';
  if (options.hidden) env.CORTEX_HIDDEN = '1';
  app = await electron.launch({
    executablePath: placed.exe,
    // Started from its own folder, as its shortcut starts it.
    cwd: placed.dir,
    args: [`--user-data-dir=${userData}`, ...(process.env.CORTEX_SOFTWARE === '1' ? ['--disable-gpu'] : [])],
    env,
    timeout: 120_000,
  });
  const child = app.process();
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream?.on('data', (chunk) => note(`app ${name}: ${String(chunk).trimEnd()}`));
  page = await app.firstWindow({ timeout: 120_000 });
  const pageErrors = [];
  page.on('console', (message) => {
    note(`page ${message.type()}: ${message.text()}`);
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    note(`page error: ${error.stack ?? String(error)}`);
    pageErrors.push(String(error));
  });
  await page.waitForLoadState('domcontentloaded');
  const facts = await inMain(({ app: own, BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const win = all.find((one) => one.webContents.getURL().includes('index.html')) ?? all[0];
    return { packaged: own.isPackaged, exe: own.getPath('exe'), resources: process.resourcesPath, version: own.getVersion(), userData: own.getPath('userData'), windows: all.length, title: win?.getTitle() ?? null, visible: win?.isVisible() ?? false, url: win?.webContents.getURL() ?? null };
  });
  note(`main process: ${JSON.stringify(facts)}`);
  // Before anything is written: a run that reached the person's own settings would be worse than one that stops.
  must('the app keeps its data in the run’s own folder', samePath(facts.userData, userData), `${facts.userData} is not ${userData}`);
  check(
    'it is the installed app that runs: packaged, from the install folder, of this version',
    facts.packaged === true && samePath(facts.exe, placed.exe) && samePath(facts.resources, placed.resources) && facts.version === layout.version,
    JSON.stringify(facts),
  );
  const firstRun = await shownSoon(page.locator('[data-onboarding-step="name"]'), 60_000);
  check('a first start opens on the first-run screen', firstRun, firstRun ? '' : await pageNow());
  check(
    'its pictures are drawn from the bundle',
    await page.waitForFunction(() => [...document.querySelectorAll('[data-onboarding] nav img, [data-onboarding-pyn]')].some((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15_000 }).then(() => true, () => false),
  );
  // Once the page has drawn: `ready-to-show` is what shows the window (electron/main.ts).
  const shown = options.hidden || (await waitFor(() => inMain(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((one) => one.isVisible())), { timeout: 20_000 }));
  check(options.hidden ? 'the window stays hidden, as asked' : 'the window is shown, titled Cortex', shown && facts.title === 'Cortex', `title ${facts.title}, shown ${shown}`);
  const first = await shoot('01-ilk-ekran.png');
  check('and the window really drew: its picture is not one flat colour', first.colours >= 4, `${first.colours} colour(s) in ${first.size.width}x${first.size.height}`);
  // What the app itself finds beside it, asked as its own settings screen asks (electron/services/setup.ts).
  const seen = await within(page.evaluate(async () => ({ version: (await window.cortex.bootstrap()).version, setup: await window.cortex.setup.status() })).catch((err) => ({ failed: String(err) })), 120_000, { failed: 'no answer in two minutes' });
  note(`the app's own status: ${JSON.stringify(seen)}`);
  check(
    'the app finds the engine package and Python’s installer it came with',
    seen.version === layout.version && seen.setup?.engine?.bundled === layout.version && seen.setup?.pythonBundled === pythonPin.version,
    JSON.stringify(seen.failed ?? { version: seen.version, engine: seen.setup?.engine, pythonBundled: seen.setup?.pythonBundled }),
  );

  say('\nThe first run');
  // Documents is a folder of this run's: the first run makes its vault there without a dialog (electron/services/vault.ts).
  await inMain(({ app: own }, dir) => own.setPath('documents', dir), documents);
  await page.locator('[data-onboarding-name]').fill('Deneme');
  await page.locator('[data-onboarding-next]').click();
  const vault = path.join(documents, 'Cortex');
  const vaultMade = (await shownSoon(page.locator('[data-onboarding-step="vault"] [data-onboarding-ready]'), 30_000)) && fs.existsSync(vault);
  check('the name is taken and a vault is made in Documents', vaultMade, vaultMade ? '' : await pageNow());
  await shoot('02-kasa.png');

  if (options.engine && vaultMade) {
    await page.locator('[data-onboarding-next]').click();
    await page.waitForFunction(() => ['python', 'engine'].includes(document.querySelector('[data-onboarding]')?.getAttribute('data-onboarding-step') ?? ''), null, { timeout: 15_000 }).catch(() => undefined);
    const install = page.locator('[data-onboarding-step="engine"] [data-onboarding-engine="install"]');
    // Offered once the app has asked for a Python: none fit, it offers its own installer instead, which a run does not start.
    const offered = await shownSoon(install, 60_000);
    check('with a Python on the machine, Pyn’s memory is offered to be set up from the package the app carries', offered, offered ? '' : await pageNow());
    if (offered) {
      await install.click();
      const timeout = 6 * 60_000;
      const ended = await Promise.race([
        page.locator('[data-onboarding-step="engine"] [data-onboarding-ready]').waitFor({ timeout }).then(() => 'done', () => 'not done in six minutes'),
        page.locator('[data-onboarding-error]').waitFor({ timeout }).then(() => 'failed', () => 'not done in six minutes'),
      ]);
      const version = fs.existsSync(path.join(vault, '.beyin-version')) ? fs.readFileSync(path.join(vault, '.beyin-version'), 'utf8').trim() : null;
      try {
        const pin = JSON.parse(fs.readFileSync(path.join(vault, '.beyin-runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
        engineState = typeof pin.state === 'string' && path.isAbsolute(pin.state) ? pin.state : null;
      } catch {
        engineState = null;
      }
      check(
        'the engine is set up in the vault from the installed package: its entry point, its version, its state on this machine',
        ended === 'done' && fs.existsSync(path.join(vault, 'beyin.py')) && version === layout.version && engineState !== null && fs.existsSync(engineState),
        `the setup ${ended}; .beyin-version ${version}; state ${engineState}; ${await pageNow()}`,
      );
      await shoot('03-motor.png');
      // Quitting while a setup runs is asked about first (electron/main.ts): the run waits for none to be going on. Asked
      // every few seconds, not at every frame: with an engine in the vault each asking starts a Python.
      await waitFor(() => within(page.evaluate(async () => (await window.cortex.setup.status()).job === null).catch(() => false), 60_000, false), { timeout: 120_000, every: 3000 });
    }
  }
  check('the page logged no errors', pageErrors.length === 0, pageErrors.slice(0, 5).join('\n       '));

  say('\nClosed');
  const stopped = await stopApp();
  check('the app quits when asked, with exit code 0', stopped.closed && stopped.code === 0, `closed ${stopped.closed}, exit code ${stopped.code}`);
  const gone = await waitFor(() => running().length === 0, { timeout: 30_000, every: 1000 });
  check('and leaves no process of its own behind', gone, `still running: ${running().join(', ')}`);
  check('what it kept is in the run’s own folder', fs.existsSync(path.join(userData, 'settings.json')), userData);

  say('\nUninstalled silently');
  // A person's data, stood in for where the person's own is kept: a silent uninstall asks nothing and takes none of it
  // (build/installer.nsh: the question's silent answer is no).
  for (const dir of [path.join(process.env.APPDATA ?? '', 'Cortex'), path.join(process.env.LOCALAPPDATA ?? '', 'beyin-v3')]) {
    if (!path.isAbsolute(dir)) continue;
    const made = !fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `kurulu-deneme-${process.pid}.isaret`);
    fs.writeFileSync(file, 'e2e/kurulu.mjs: bu dosya silinebilir.\n');
    markers.push({ dir, file, made });
  }
  const beforeUninstall = probe();
  note(`before the uninstall: ${JSON.stringify(beforeUninstall)}`);
  // Written at the first start where the window is a person's (electron/services/tray.ts, keepStartWithWindows), under
  // the name installer.nsh takes away: seen there first, or its going after the uninstall would say nothing.
  if (!options.hidden) check('started as a person starts it, Cortex is set to start with Windows', Boolean(beforeUninstall?.startsWithWindows), `the Run value: ${beforeUninstall?.startsWithWindows ?? 'not written'}`);
  // As Windows' list of programs has it (QuietUninstallString: installer.nsh, registryAddInstallInfo).
  const removal = await run(placed.uninstaller, ['/currentuser', '/S'], 2 * 60_000);
  check('the uninstaller starts and ends well', removal.code === 0, `exit code ${removal.code}${removal.why ? ` (${removal.why})` : ''}`);
  // It goes on from a copy of itself in the temp folder, so its end is the folder's: waited for, not slept through.
  const removed = await waitFor(() => !fs.existsSync(placed.dir), { timeout: 3 * 60_000, every: 1000 });
  check('the install folder is gone', removed, removed ? '' : `left in ${placed.dir}: ${fs.readdirSync(placed.dir).slice(0, 20).join(', ')}`);
  installed = !removed;
  // The registry and the shortcuts go after the files, in the same run of the uninstaller.
  let afterUninstall = null;
  const forgotten = await waitFor(
    () => {
      afterUninstall = probe();
      return afterUninstall !== null && !afterUninstall.installLocation && !afterUninstall.displayName && !afterUninstall.startsWithWindows && links.every((link) => !link || !fs.existsSync(link));
    },
    { timeout: 60_000, every: 2000 },
  );
  check(
    'with its entry among the programs, its shortcuts, and its start with Windows',
    forgotten,
    `${JSON.stringify(afterUninstall)} | ${links.map((link) => `${link}: ${link && fs.existsSync(link) ? 'still there' : 'gone'}`).join(' | ')}`,
  );
  // Not a check: electron-builder's installer keeps a copy of itself for the updater, and its uninstaller leaves it.
  if (fs.existsSync(layout.updaterCache)) say(`       note: the installer’s own copy stays after the uninstall, in ${layout.updaterCache}`);
  check(
    'and nothing of the person’s is touched: the app’s data, the engine’s state, the vault',
    markers.every((one) => fs.existsSync(one.file)) && fs.existsSync(path.join(userData, 'settings.json')) && (!vaultMade || fs.existsSync(vault)) && (!engineState || fs.existsSync(engineState)),
    markers.map((one) => `${one.file}: ${fs.existsSync(one.file) ? 'kept' : 'GONE'}`).join(' | '),
  );
} catch (err) {
  if (!(err instanceof Stopped)) {
    say(`  FAIL the run stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    failures.push('the run stopped');
  }
  if (app) {
    if (page) say(`       the page then: ${await pageNow()}`);
    await shoot('hata.png').catch(() => undefined);
  }
} finally {
  // Tidied up whatever happened: a run on a person's own machine leaves no Cortex installed, and none of its folders.
  const tidy = async (what, work) => {
    try {
      await work();
    } catch (err) {
      note(`tidying up (${what}): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await tidy('the app', () => stopApp());
  await tidy('the install', async () => {
    if (!installed || !fs.existsSync(placed.uninstaller)) return;
    await run(placed.uninstaller, ['/currentuser', '/S'], 2 * 60_000);
    await waitFor(() => !fs.existsSync(placed.dir), { timeout: 2 * 60_000, every: 1000 });
  });
  // The installer's copy of itself (see above), where this run's install made it.
  await tidy('the installer’s copy', () => {
    if (installedOnce && !cacheWasThere) fs.rmSync(layout.updaterCache, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  for (const one of markers) {
    await tidy('a marker', () => {
      fs.rmSync(one.file, { force: true });
      // Only a folder this run made, and only while nothing else is in it.
      if (one.made && fs.readdirSync(one.dir).length === 0) fs.rmdirSync(one.dir);
    });
  }
  // The engine's state for this run's vault only: a folder of its own under beyin-v3, named by the vault's path.
  await tidy('the engine’s state', () => {
    if (engineState && /[\\/]beyin-v3[\\/][^\\/]+$/.test(engineState)) fs.rmSync(engineState, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  for (const dir of temporary) await tidy('a folder', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }));
}

say(`\n${failures.length ? `${failures.length} check(s) failed` : 'All installed-app checks passed'}; what the run saw: ${out}`);
process.exit(failures.length ? 1 : 0);

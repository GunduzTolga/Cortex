import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distinctColours, resourceProblems, waitFor } from '../scripts/kurulu-yardimci.mjs';

/**
 * The Linux package, tried as a person's first day goes: the .deb already installed on this machine (`apt install
 * ./release/cortex_<version>_amd64.deb`, which needs root and is the caller's), what it laid down looked at, the
 * installed `cortex` opened, its first screen seen, a vault made and - with `--motor` - the engine set up in it from
 * the package the app carries, on the system's own Python (the .deb's `python3` dependency), and one engine command
 * run in that vault. The Linux twin of e2e/kurulu.mjs, which tries the Windows installer.
 *
 *   node e2e/kurulu-linux.mjs [--motor] [--cikti <klasör>]
 *
 * Under X (`xvfb-run -a` on a runner or in a container): the window is shown as a person's is, as a person runs it -
 * not as root, with Chromium's sandbox on (the .deb's own: SUID chrome-sandbox or its AppArmor profile).
 *
 * What it saw is kept in e2e/screenshots/kurulu-linux/ (or `--cikti`): pictures of the window, and `uygulama.log` - the
 * checks, what the app wrote to its console, what its page logged and what the engine answered.
 */
const options = { engine: false, out: null };
for (let at = 2; at < process.argv.length; at += 1) {
  const arg = process.argv[at];
  if (arg === '--motor') options.engine = true;
  else if (arg === '--cikti' && process.argv[at + 1]) options.out = path.resolve(process.argv[(at += 1)]);
  else {
    console.error(`Bilinmeyen seçenek: ${arg} (bilinenler: --motor, --cikti <klasör>)`);
    process.exit(2);
  }
}
if (process.platform !== 'linux') {
  console.error('e2e/kurulu-linux.mjs yalnız Linux\'ta çalışır: .deb paketini dener.');
  process.exit(2);
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('e2e/kurulu-linux.mjs root olarak çalışmaz: uygulama bir kişinin açtığı gibi, kum havuzu açık denenir. Root olmayan bir kullanıcıyla çalıştır.');
  process.exit(2);
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const linux = pkg.build.linux;
const product = pkg.build.productName;
const version = pkg.version;
// Where electron-builder's .deb puts the app (/opt/<productName>), its command and its menu entry.
const placed = { dir: `/opt/${product}`, exe: `/opt/${product}/${linux.executableName}`, resources: `/opt/${product}/resources`, command: `/usr/bin/${linux.executableName}` };
const entryFile = `/usr/share/applications/${linux.executableName}.desktop`;
const iconFile = `/usr/share/icons/hicolor/512x512/apps/${linux.executableName}.png`;

const out = options.out ?? path.join(desktop, 'e2e', 'screenshots', 'kurulu-linux');
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
class Stopped extends Error {}
const must = (label, condition, detail = '') => {
  if (!check(label, condition, detail)) throw new Stopped(label);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const within = (promise, ms, otherwise = null) => Promise.race([promise, sleep(ms).then(() => otherwise)]);

const temporary = [];
const ownFolder = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cortex-kurulu-${name}-`)));
  temporary.push(dir);
  return dir;
};

let app = null;
let page = null;
let engineState = null;

/** A picture of the window, taken in the main process, and how many colours it holds (one: nothing was drawn). */
async function shoot(name) {
  try {
    const taken = await app.evaluate(async ({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows();
      const win = all.find((one) => one.webContents.getURL().includes('index.html')) ?? all[0];
      const image = await win.webContents.capturePage();
      return { png: image.toPNG().toString('base64'), small: image.isEmpty() ? '' : image.resize({ width: 64 }).toBitmap().toString('base64'), size: image.getSize() };
    });
    fs.writeFileSync(path.join(out, name), Buffer.from(taken.png, 'base64'));
    return { colours: taken.small ? distinctColours(Buffer.from(taken.small, 'base64')) : 0, size: taken.size };
  } catch (err) {
    note(`picture ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { colours: 0, size: { width: 0, height: 0 } };
  }
}

const shownSoon = (locator, timeout = 10_000) => locator.first().waitFor({ timeout }).then(() => true, () => false);
const inMain = async (fn, arg) => {
  try {
    return await app.evaluate(fn, arg);
  } catch (err) {
    if (!/garbage collected/i.test(String(err))) throw err;
    return app.evaluate(fn, arg);
  }
};
const pageNow = async () => {
  if (!page) return 'no page';
  return within(
    page.evaluate(() => `step=${document.querySelector('[data-onboarding]')?.getAttribute('data-onboarding-step') ?? '-'} | ${document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 600) ?? ''}`).catch((err) => `unreadable: ${err.message}`),
    10_000,
    'no answer',
  );
};

async function stopApp() {
  if (!app) return { closed: true, code: 0 };
  const child = app.process();
  const closing = app;
  app = null;
  page = null;
  const closed = await within(closing.close().then(() => true, () => false), 60_000, false);
  if (!closed || child.exitCode === null) child.kill('SIGKILL');
  return { closed, code: child.exitCode };
}

try {
  say(`\nCortex ${version}, the .deb installed on this machine`);

  say('\nInstalled');
  const listed = spawnSync('dpkg-query', ['-W', '-f', '${Version} ${db:Status-Status}', pkg.build.deb.packageName], { encoding: 'utf8' });
  must('dpkg knows the package, installed, of this version', listed.status === 0 && listed.stdout.trim() === `${version} installed`, `${listed.stdout}${listed.stderr}`.trim());
  must('the app is in its folder, runnable', fs.existsSync(placed.exe) && (fs.statSync(placed.exe).mode & 0o111) !== 0, placed.exe);
  check(`\`${linux.executableName}\` on the PATH starts it`, fs.existsSync(placed.command) && fs.realpathSync(placed.command) === placed.exe, placed.command);
  const entry = fs.existsSync(entryFile) ? fs.readFileSync(entryFile, 'utf8') : '';
  check(
    'the menu entry names Cortex, starts the installed app, with its icon and a Turkish comment',
    /^Name=Cortex$/m.test(entry) && entry.includes(`Exec=${placed.exe} %U`) && new RegExp(`^Icon=${linux.executableName}$`, 'm').test(entry) && /^Comment\[tr\]=.+$/m.test(entry) && new RegExp(`^StartupWMClass=${linux.executableName}$`, 'm').test(entry),
    entry || `${entryFile} is not there`,
  );
  check('the 512px icon is installed', fs.existsSync(iconFile), iconFile);
  check('the bundle is packed beside it', fs.existsSync(path.join(placed.resources, 'app.asar')));
  // Everything the build was given to carry (package.json, extraResources), byte for byte; Windows' own are not asked.
  const wrong = resourceProblems(desktop, [...pkg.build.extraResources, ...(linux.extraResources ?? [])], placed.resources);
  check('what the package carries is installed, byte for byte: the engine package, the seal, the licences', wrong.length === 0, wrong.join('\n       '));
  check('neither Python’s Windows installer nor the Windows voice build came with it', !fs.existsSync(path.join(placed.resources, 'python')) && !fs.existsSync(path.join(placed.resources, 'whisper-vulkan')));
  const python = spawnSync('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
  check('the system’s Python 3, which the package asks for, is there and new enough (3.11+)', python.status === 0 && Number(python.stdout.trim().split('.')[1]) >= 11, `${python.stdout}${python.stderr}`.trim());

  say('\nOpened');
  const userData = ownFolder('veri');
  const documents = ownFolder('belgeler');
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CORTEX_HIDDEN'].includes(key)) env[key] = value;
  env.CORTEX_NO_UPDATE = '1';
  app = await electron.launch({
    executablePath: placed.exe,
    cwd: os.homedir(),
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
    return { packaged: own.isPackaged, exe: own.getPath('exe'), resources: process.resourcesPath, version: own.getVersion(), userData: own.getPath('userData'), title: win?.getTitle() ?? null, platform: process.platform };
  });
  note(`main process: ${JSON.stringify(facts)}`);
  must('the app keeps its data in the run’s own folder', facts.userData === userData, `${facts.userData} is not ${userData}`);
  check('it is the installed app that runs: packaged, from /opt, of this version', facts.packaged === true && facts.exe === placed.exe && facts.resources === placed.resources && facts.version === version, JSON.stringify(facts));
  const firstRun = await shownSoon(page.locator('[data-onboarding-step="name"]'), 60_000);
  check('a first start opens on the first-run screen', firstRun, firstRun ? '' : await pageNow());
  const shown = await waitFor(() => inMain(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((one) => one.isVisible())), { timeout: 20_000 });
  check('the window is shown, titled Cortex', shown && facts.title === 'Cortex', `title ${facts.title}, shown ${shown}`);
  const first = await shoot('01-ilk-ekran.png');
  check('and the window really drew: its picture is not one flat colour', first.colours >= 4, `${first.colours} colour(s) in ${first.size.width}x${first.size.height}`);
  note(`the first screen says: ${await pageNow()}`);
  const seen = await within(page.evaluate(async () => ({ version: (await window.cortex.bootstrap()).version, setup: await window.cortex.setup.status() })).catch((err) => ({ failed: String(err) })), 120_000, { failed: 'no answer in two minutes' });
  note(`the app's own status: ${JSON.stringify(seen)}`);
  // No Python of its own on Linux: the system's is the one (pythonBundled null), and the engine package is found.
  check('the app finds the engine package it came with, and brings no Python of its own', seen.version === version && seen.setup?.engine?.bundled === version && seen.setup?.pythonBundled === null, JSON.stringify(seen.failed ?? { version: seen.version, engine: seen.setup?.engine, pythonBundled: seen.setup?.pythonBundled }));

  say('\nThe first run');
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
    const offered = await shownSoon(install, 60_000);
    check('with the system’s Python, Pyn’s memory is offered to be set up from the package the app carries', offered, offered ? '' : await pageNow());
    if (offered) {
      await install.click();
      const timeout = 6 * 60_000;
      const ended = await Promise.race([
        page.locator('[data-onboarding-step="engine"] [data-onboarding-ready]').waitFor({ timeout }).then(() => 'done', () => 'not done in six minutes'),
        page.locator('[data-onboarding-error]').waitFor({ timeout }).then(() => 'failed', () => 'not done in six minutes'),
      ]);
      const written = fs.existsSync(path.join(vault, '.beyin-version')) ? fs.readFileSync(path.join(vault, '.beyin-version'), 'utf8').trim() : null;
      try {
        const pin = JSON.parse(fs.readFileSync(path.join(vault, '.beyin-runtime.json'), 'utf8').replace(/^﻿/, ''));
        engineState = typeof pin.state === 'string' && path.isAbsolute(pin.state) ? pin.state : null;
      } catch {
        engineState = null;
      }
      check(
        'the engine is set up in the vault from the installed package: its entry point, its version, its state on this machine',
        ended === 'done' && fs.existsSync(path.join(vault, 'beyin.py')) && written === version && engineState !== null && fs.existsSync(engineState),
        `the setup ${ended}; .beyin-version ${written}; state ${engineState}; ${await pageNow()}`,
      );
      await shoot('03-motor.png');
      // The engine answering in the vault, on the system's Python, as the app and a person's own terminal run it.
      const doctor = spawnSync('python3', ['beyin.py', 'doctor'], { cwd: vault, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONUTF8: '1' } });
      note(`python3 beyin.py doctor (exit ${doctor.status}):\n${doctor.stdout}${doctor.stderr}`);
      fs.writeFileSync(path.join(out, 'motor-doctor.txt'), `$ python3 beyin.py doctor   (exit ${doctor.status})\n${doctor.stdout}${doctor.stderr}`);
      check('the engine answers in the vault: `python3 beyin.py doctor` ends well', doctor.status === 0, `exit ${doctor.status}: ${String(doctor.stderr || doctor.stdout).slice(0, 400)}`);
      await waitFor(() => within(page.evaluate(async () => (await window.cortex.setup.status()).job === null).catch(() => false), 60_000, false), { timeout: 120_000, every: 3000 });
    }
  }
  check('the page logged no errors', pageErrors.length === 0, pageErrors.slice(0, 5).join('\n       '));

  say('\nClosed');
  const stopped = await stopApp();
  check('the app quits when asked, with exit code 0', stopped.closed && stopped.code === 0, `closed ${stopped.closed}, exit code ${stopped.code}`);
  check('what it kept is in the run’s own folder', fs.existsSync(path.join(userData, 'settings.json')), userData);
} catch (err) {
  if (!(err instanceof Stopped)) {
    say(`  FAIL the run stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    failures.push('the run stopped');
  }
  if (app) {
    if (page) say(`       the page then: ${await pageNow()}`);
    await shoot('hata.png');
  }
} finally {
  await stopApp().catch(() => undefined);
  // The engine's state for this run's vault only: a folder of its own under beyin-v3, named by the vault's path.
  if (engineState && /[\\/]beyin-v3[\\/][^\\/]+$/.test(engineState)) fs.rmSync(engineState, { recursive: true, force: true });
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
}

say(`\n${failures.length ? `${failures.length} check(s) failed` : 'All installed-app checks passed'}; what the run saw: ${out}`);
process.exit(failures.length ? 1 : 0);

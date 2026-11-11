import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What the installed-app run (e2e/kurulu.mjs) works out before it touches Windows: where the installer puts the app,
 * what it must have laid down there, and how what Windows says back is read. Kept apart from the run so that it is
 * tested where the run itself cannot be (tests/kurulu.test.ts; this repository's tests also run on Linux).
 *
 * Every rule here is electron-builder's own, read from its NSIS templates (node_modules/app-builder-lib/templates/nsis)
 * and from the code that fills them (out/targets/nsis/NsisTarget.js), named beside each.
 */

/** The namespace electron-builder derives an app's install id from (NsisTarget.js, ELECTRON_BUILDER_NS_UUID). */
const BUILDER_NAMESPACE = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

/** A name's UUID (version 5, SHA-1) in a namespace, as builder-util-runtime's `UUID.v5` writes it. */
export function uuidV5(name, namespace = BUILDER_NAMESPACE) {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a UUID: ${namespace}`);
  const hash = createHash('sha1').update(Buffer.from(hex, 'hex')).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const text = hash.subarray(0, 16).toString('hex');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** A name electron-builder takes as a folder's as it is (targetUtil.js, getWindowsInstallationDirName). */
const PLAIN_NAME = /^[-_+0-9a-zA-Z .]+$/;

/**
 * Where a silent install (`/S`) of this package's installer puts the app, and what it writes beside it.
 *
 * - `perMachine` is false and nothing is installed yet: `initMultiUser` (assistedInstaller.nsh) ends in
 *   `setInstallModePerUser`, for this user only, with no elevation; `/allusers` alone changes that.
 * - `setInstallModePerUser` (multiUser.nsh): `$INSTDIR` is the user's program folder (FOLDERID_UserProgramFiles,
 *   `%LOCALAPPDATA%\Programs` unless the person moved it) and APP_FILENAME under it.
 * - APP_FILENAME (NsisTarget.js): the product's name where the installer is assisted or per-machine and the name is
 *   plain, else the package's.
 * - The app is `<product>.exe`, its uninstaller `Uninstall <product>.exe` (common.nsh).
 * - Its place is kept under HKCU `Software\<guid>` (InstallLocation), and Windows' own list of programs under
 *   `...\Uninstall\<guid>` (multiUser.nsh, installer.nsh `registryAddInstallInfo`); the guid is `nsis.guid`, or the
 *   appId's UUID in electron-builder's namespace.
 * - One shortcut on the desktop and one in the Start menu, named `nsis.shortcutName` (common.nsh `setLinkVars`).
 * - The installer keeps a copy of itself for the updater in `%LOCALAPPDATA%\<package>-updater` (installer.nsh
 *   `installApplicationFiles`, appInfo.js `updaterCacheDirName`), which no uninstall takes away.
 */
export function installLayout(pkg, localAppData) {
  const build = pkg.build ?? {};
  const nsis = build.nsis ?? {};
  if (nsis.perMachine === true) throw new Error('nsis.perMachine is on: a silent install then goes to Program Files with elevation, which this run does not do.');
  const product = build.productName ?? pkg.productName ?? pkg.name;
  if (!PLAIN_NAME.test(product)) throw new Error(`The product's name (${product}) is not one electron-builder uses as a file's name as it is; say here what it is made into.`);
  const oneClick = nsis.oneClick !== false;
  const appFilename = !oneClick ? product : pkg.name;
  const guid = nsis.guid ?? uuidV5(build.appId);
  const win = path.win32;
  const instDir = win.join(localAppData, 'Programs', appFilename);
  const shortcut = `${nsis.shortcutName ?? product}.lnk`;
  return {
    product,
    version: pkg.version,
    installer: (nsis.artifactName ?? '${productName} Setup ${version}.${ext}').replace(/\$\{(\w+)\}/g, (whole, key) => ({ version: pkg.version, ext: 'exe', productName: product, name: pkg.name })[key] ?? whole),
    instDir,
    exe: win.join(instDir, `${product}.exe`),
    uninstaller: win.join(instDir, `Uninstall ${product}.exe`),
    resources: win.join(instDir, 'resources'),
    updaterCache: win.join(localAppData, `${pkg.name.toLowerCase()}-updater`),
    guid,
    // Under the user's desktop and Start-menu folders, which Windows is asked for (`probeScript`); null where the build makes none.
    desktopShortcut: nsis.createDesktopShortcut === false ? null : shortcut,
    menuShortcut: nsis.createStartMenuShortcut === false ? null : shortcut,
  };
}

/** A filter of `extraResources` as a test of a file's path under its folder; only a name with `*` is known here. */
export function filterTest(pattern) {
  if (/[!?{}[\]]|\*\*/.test(pattern)) throw new Error(`An extraResources filter this run does not know how to read: ${pattern}`);
  const source = pattern.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const test = new RegExp(`^${source}$`);
  return (relative) => test.test(relative);
}

function filesUnder(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(path.join(dir, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

/**
 * Each file the installer is to carry beside the app (package.json, `build.extraResources`), as the build has it now
 * (`source`) and where it lies once installed, under the app's `resources` (`target`, with `/`). A source that is not
 * there is named in `missing`: electron-builder only warns of one, and builds without it (scripts/check-resources.cjs).
 */
export function resourcePairs(desktop, extraResources) {
  const pairs = [];
  const missing = [];
  for (const one of extraResources ?? []) {
    const entry = typeof one === 'string' ? { from: one, to: one } : one;
    const from = path.resolve(desktop, entry.from);
    const to = (entry.to ?? entry.from).replace(/\\/g, '/').replace(/\/+$/, '');
    let stat;
    try {
      stat = fs.statSync(from);
    } catch {
      missing.push(entry.from);
      continue;
    }
    if (stat.isFile()) {
      pairs.push({ source: from, target: to });
      continue;
    }
    const tests = (entry.filter ?? []).map(filterTest);
    const taken = filesUnder(from).filter((relative) => !tests.length || tests.some((test) => test(relative)));
    if (!taken.length) missing.push(entry.filter?.length ? `${entry.from} (${entry.filter.join(', ')})` : entry.from);
    for (const relative of taken) pairs.push({ source: path.join(from, ...relative.split('/')), target: `${to}/${relative}` });
  }
  return { pairs, missing };
}

export const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * What is wrong with an installed app's `resources` against what the build was given to carry: a file not there, or
 * there with other bytes. Empty when the installed app has every one of them, byte for byte.
 */
export function resourceProblems(desktop, extraResources, resources) {
  const { pairs, missing } = resourcePairs(desktop, extraResources);
  const found = missing.map((name) => `the build has no ${name} to carry`);
  for (const { source, target } of pairs) {
    const installed = path.join(resources, ...target.split('/'));
    if (!fs.existsSync(installed)) found.push(`resources/${target} is not installed`);
    else if (sha256Of(installed) !== sha256Of(source)) found.push(`resources/${target} is not the file the build carried (its SHA-256 differs)`);
  }
  return found;
}

/**
 * Whether `test` comes true within `timeout` ms, asked every `every` ms and once more at the end: for what the run
 * waits on outside the app (a folder made, a folder gone, a process ended). The clock is given, for the tests.
 */
export async function waitFor(test, { timeout = 30_000, every = 250, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const end = now() + timeout;
  for (;;) {
    if (await test()) return true;
    if (now() >= end) return false;
    await sleep(Math.min(every, Math.max(0, end - now())));
  }
}

/**
 * What Windows is asked about the install, as one PowerShell script that answers with one line of JSON: the user's
 * desktop and Start-menu folders (where they really are: a desktop moved to OneDrive is not under the profile), where
 * the installer wrote that the app is (HKCU for this user, HKLM for every user), its entry in Windows' list of
 * programs, and whether Cortex is set to start with Windows (the Run value named by the app's id, which the app
 * writes and installer.nsh takes away). A value that is not there is null. Single quotes only: it is handed over
 * encoded (`encodedCommand`), and reads no input.
 */
export function probeScript(layout, appId) {
  const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`;
  const key = (hive) => quoted(`${hive}:\\Software\\${layout.guid}`);
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$r = [ordered]@{}',
    "$r.desktop = [Environment]::GetFolderPath('DesktopDirectory')",
    "$r.programs = [Environment]::GetFolderPath('Programs')",
    `$r.installLocation = (Get-ItemProperty -LiteralPath ${key('HKCU')}).InstallLocation`,
    `$r.machineLocation = (Get-ItemProperty -LiteralPath ${key('HKLM')}).InstallLocation`,
    `$u = Get-ItemProperty -LiteralPath ${quoted(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${layout.guid}`)}`,
    '$r.displayName = $u.DisplayName',
    '$r.displayVersion = $u.DisplayVersion',
    '$r.quietUninstall = $u.QuietUninstallString',
    `$r.startsWithWindows = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').${quoted(appId)}`,
    '$r | ConvertTo-Json -Compress',
  ].join('\n');
}

/** A script as `powershell -EncodedCommand` takes it: no quoting of it is left to the command line. */
export const encodedCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** The probe's answer read: the last line that is a JSON object; null where there is none (PowerShell did not run). */
export function readProbe(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'));
  try {
    const value = JSON.parse(lines[lines.length - 1] ?? '');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The process ids in what `tasklist /FI "IMAGENAME eq <image>" /FO CSV /NH` wrote. Read by the rows of that image:
 * with none running tasklist writes a sentence instead, in Windows' own language.
 */
export function tasklistPids(output, image) {
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
    if (cells.length >= 2 && cells[0].toLowerCase() === image.toLowerCase() && /^\d+$/.test(cells[1])) pids.push(Number(cells[1]));
  }
  return pids;
}

/** How many colours a picture's raw pixels hold (four bytes each): a window that drew nothing holds one. */
export function distinctColours(bitmap) {
  const seen = new Set();
  for (let at = 0; at + 4 <= bitmap.length; at += 4) seen.add(bitmap.readUInt32LE(at));
  return seen.size;
}

/** Whether two Windows paths name one place: letters' case and a trailing separator apart. */
export function samePath(a, b) {
  const tidy = (one) => path.win32.normalize(String(one)).replace(/[\\/]+$/, '').toLowerCase();
  return tidy(a) === tidy(b);
}

/** The run's options, from its command line. */
export function readArgs(argv) {
  const options = { engine: false, hidden: false, installer: null };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--motor') options.engine = true;
    else if (arg === '--gizli') options.hidden = true;
    else if (arg === '--kurucu' && argv[at + 1]) options.installer = argv[(at += 1)];
    else throw new Error(`Bilinmeyen seçenek: ${arg} (bilinenler: --motor, --gizli, --kurucu <dosya>)`);
  }
  return options;
}

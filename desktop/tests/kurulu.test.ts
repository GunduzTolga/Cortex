import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// Plain JavaScript, as the run that uses it is (e2e/kurulu.mjs): its shapes are said below.
import * as kurulu from '../scripts/kurulu-yardimci.mjs';

/**
 * The installed-app run (e2e/kurulu.mjs) installs the real installer on Windows, which only CI's Windows runner does.
 * What it works out before it touches Windows is tested here, wherever the tests run: where a silent install puts the
 * app, what the installer must have carried, how it waits, and how what Windows answers is read
 * (scripts/kurulu-yardimci.mjs). The rules are electron-builder's; the lines of its templates they are read from are
 * held here too, so that an electron-builder that installs elsewhere fails this test and not, twenty minutes into a
 * build, the Windows run.
 */
const {
  distinctColours,
  encodedCommand,
  filterTest,
  installLayout,
  probeScript,
  readArgs,
  readProbe,
  resourcePairs,
  resourceProblems,
  samePath,
  tasklistPids,
  uuidV5,
  waitFor,
} = kurulu as {
  distinctColours: (bitmap: Buffer) => number;
  encodedCommand: (script: string) => string;
  filterTest: (pattern: string) => (relative: string) => boolean;
  installLayout: (pkg: unknown, localAppData: string) => Record<string, string | null>;
  probeScript: (layout: unknown, appId: string) => string;
  readArgs: (argv: string[]) => { engine: boolean; hidden: boolean; installer: string | null };
  readProbe: (output: unknown) => Record<string, unknown> | null;
  resourcePairs: (desktop: string, extra: unknown) => { pairs: Array<{ source: string; target: string }>; missing: string[] };
  resourceProblems: (desktop: string, extra: unknown, resources: string) => string[];
  samePath: (a: string, b: string) => boolean;
  tasklistPids: (output: string, image: string) => number[];
  uuidV5: (name: string, namespace?: string) => string;
  waitFor: (test: () => boolean | Promise<boolean>, options?: { timeout?: number; every?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) => Promise<boolean>;
};

const require = createRequire(import.meta.url);
const packaged = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  name: string;
  version: string;
  build: { appId: string; productName: string; nsis: Record<string, unknown>; extraResources: Array<{ from: string; to: string; filter?: string[] }> };
};
const LOCAL = 'C:\\Users\\deneme\\AppData\\Local';
const template = (name: string) => fs.readFileSync(path.join('node_modules', 'app-builder-lib', 'templates', 'nsis', name), 'utf8');

test('the install id is the one electron-builder gives the app', () => {
  // The standard's own example (RFC 4122's DNS namespace, as Python's uuid5 documents it).
  assert.equal(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  // And electron-builder's, by its own code and in its own namespace (NsisTarget.js).
  const { UUID } = require(path.resolve('node_modules', 'builder-util-runtime')) as { UUID: { v5: (name: string, namespace: Buffer) => string; parse: (text: string) => Buffer } };
  const target = fs.readFileSync(path.join('node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
  const namespace = /ELECTRON_BUILDER_NS_UUID = [\w.]+\.UUID\.parse\("([0-9a-f-]{36})"\)/.exec(target)?.[1];
  assert.ok(namespace, 'electron-builder still derives the id from a namespace of its own');
  assert.match(target, /options\.guid \|\| [\w.]+\.UUID\.v5\(appInfo\.id, ELECTRON_BUILDER_NS_UUID\)/);
  assert.equal(uuidV5(packaged.build.appId), UUID.v5(packaged.build.appId, UUID.parse(namespace)));
  assert.equal(installLayout(packaged, LOCAL).guid, uuidV5(packaged.build.appId));
  assert.equal(installLayout({ ...packaged, build: { ...packaged.build, nsis: { ...packaged.build.nsis, guid: 'kendi-kimligi' } } }, LOCAL).guid, 'kendi-kimligi');
});

test('a silent install of this app goes where the run looks for it: this user’s program folder, under the product’s name', () => {
  const layout = installLayout(packaged, LOCAL);
  assert.equal(layout.instDir, 'C:\\Users\\deneme\\AppData\\Local\\Programs\\Cortex');
  assert.equal(layout.exe, 'C:\\Users\\deneme\\AppData\\Local\\Programs\\Cortex\\Cortex.exe');
  assert.equal(layout.uninstaller, 'C:\\Users\\deneme\\AppData\\Local\\Programs\\Cortex\\Uninstall Cortex.exe');
  assert.equal(layout.resources, 'C:\\Users\\deneme\\AppData\\Local\\Programs\\Cortex\\resources');
  // The name the build's own check and the release look for (.github/workflows/desktop.yml, release.yml).
  assert.equal(layout.installer, `Cortex-Setup-${packaged.version}.exe`);
  assert.equal(layout.desktopShortcut, 'Cortex.lnk');
  assert.equal(layout.menuShortcut, 'Cortex.lnk');
  // The installer's copy of itself, which stays after an uninstall: the run takes it away where it made it.
  assert.equal(layout.updaterCache, `C:\\Users\\deneme\\AppData\\Local\\${packaged.name}-updater`);

  // A one-click installer keeps the package's name for the folder; no shortcut where the build makes none.
  const oneClick = installLayout({ ...packaged, build: { ...packaged.build, nsis: { ...packaged.build.nsis, oneClick: true, createDesktopShortcut: false } } }, LOCAL);
  assert.equal(oneClick.instDir, `C:\\Users\\deneme\\AppData\\Local\\Programs\\${packaged.name}`);
  assert.equal(oneClick.desktopShortcut, null);
  // For every user it would go to Program Files, elevated: said, not guessed at.
  assert.throws(() => installLayout({ ...packaged, build: { ...packaged.build, nsis: { ...packaged.build.nsis, perMachine: true } } }, LOCAL), /perMachine/);
  assert.throws(() => installLayout({ ...packaged, build: { ...packaged.build, productName: 'Cortex: Beyin' } }, LOCAL), /name/);
});

test('electron-builder’s installer still installs by the rules the run was written from', () => {
  // Silent, nothing installed, perMachine off: per user (assistedInstaller.nsh, the end of initMultiUser).
  const assisted = template('assistedInstaller.nsh');
  assert.match(assisted, /!ifdef INSTALL_MODE_PER_ALL_USERS_DEFAULT\s+!insertmacro setInstallModePerAllUsers\s+!else\s+!insertmacro setInstallModePerUser\s+!endif/);
  assert.match(assisted, /\$\{GetOptions\} \$R0 "\/currentuser" \$R1/);
  // Into the user's program folder, under APP_FILENAME (multiUser.nsh), kept under HKCU Software\<guid>.
  const multiUser = template('multiUser.nsh');
  assert.ok(multiUser.includes('StrCpy $0 "$LocalAppData\\Programs"'));
  assert.ok(multiUser.includes('StrCpy $INSTDIR "$0\\${APP_FILENAME}"'));
  assert.ok(multiUser.includes('!define /ifndef INSTALL_REGISTRY_KEY "Software\\${APP_GUID}"'));
  assert.ok(multiUser.includes('!define /ifndef UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_APP_KEY}"'));
  // The app's and the uninstaller's names (common.nsh), and the shortcuts (setLinkVars).
  const common = template('common.nsh');
  assert.ok(common.includes('!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"'));
  assert.ok(common.includes('!define UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"'));
  assert.ok(common.includes('StrCpy $newDesktopLink "$DESKTOP\\${SHORTCUT_NAME}.lnk"'));
  assert.ok(common.includes('StrCpy $newStartMenuLink "$SMPROGRAMS\\${SHORTCUT_NAME}.lnk"'));
  // What the run reads back from Windows' list of programs, and uninstalls with (installer.nsh).
  const installer = template(path.join('include', 'installer.nsh'));
  assert.ok(installer.includes(`WriteRegStr SHELL_CONTEXT "\${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$2" $0 /S'`));
  assert.ok(installer.includes('StrCpy $0 "/currentuser"'));
  assert.ok(installer.includes('WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"'));
  assert.ok(installer.includes('!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"'));
  assert.match(fs.readFileSync(path.join('node_modules', 'app-builder-lib', 'out', 'appInfo.js'), 'utf8'), /return this\.sanitizedName\.toLowerCase\(\) \+ "-updater";/);
  // A silent install does not start the app unless told to: the run starts it itself (installSection.nsh).
  assert.match(template('installSection.nsh'), /\$\{if\} \$\{isForceRun\}\s+\$\{andIf\} \$\{Silent\}\s+!insertmacro doStartApp/);
  // The folder's name: the product's for an assisted installer (NsisTarget.js, targetUtil.js).
  const target = fs.readFileSync(path.join('node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
  assert.match(target, /APP_FILENAME: \(0, targetUtil_1\.getWindowsInstallationDirName\)\(appInfo, !oneClick \|\| isPerMachine\)/);
  // And Cortex's own part: a silent uninstall is asked nothing and answers no (build/installer.nsh), so it takes no data.
  const own = fs.readFileSync(path.join('build', 'installer.nsh'), 'utf8');
  assert.match(own, /\/SD IDNO IDYES/);
  assert.ok(own.includes(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${packaged.build.appId}"`));
});

test('what the installer carries is listed from the build’s own settings, and a file missing or changed once installed is named', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurulu-'));
  const desktop = path.join(root, 'desktop');
  const resources = path.join(root, 'kurulu', 'resources');
  const write = (base: string, relative: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
    fs.writeFileSync(path.join(base, relative), text);
  };
  write(desktop, 'licenses/a.txt', 'a');
  write(desktop, 'licenses/alt/b.txt', 'b');
  write(root, 'LICENSE', 'mit');
  write(desktop, 'cortex-paket/beyin-v3-1.2.3.zip', 'zip');
  write(desktop, 'cortex-paket/beyin-v3-1.2.3.manifest.json', '{}');
  write(desktop, 'cortex-paket/notlar.txt', 'left out by the filter');
  const extra = [
    { from: 'licenses', to: 'licenses' },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: 'cortex-paket', to: 'cortex', filter: ['beyin-v3-*.zip', 'beyin-v3-*.manifest.json'] },
    { from: 'python-paket', to: 'python', filter: ['python-*.exe.paket'] },
  ];
  const { pairs, missing } = resourcePairs(desktop, extra);
  assert.deepEqual(pairs.map((one) => one.target).sort(), ['LICENSE', 'cortex/beyin-v3-1.2.3.manifest.json', 'cortex/beyin-v3-1.2.3.zip', 'licenses/a.txt', 'licenses/alt/b.txt']);
  assert.deepEqual(missing, ['python-paket'], 'a folder the build was to carry and does not have is said, as electron-builder only warns of it');

  // Nothing installed: each file is named, and the one the build never had.
  const none = resourceProblems(desktop, extra, resources);
  assert.equal(none.length, 6);
  assert.match(none[0], /python-paket/);
  assert.ok(none.includes('resources/cortex/beyin-v3-1.2.3.zip is not installed'));

  write(desktop, 'python-paket/python-3.12.10-amd64.exe.paket', 'python');
  for (const { source, target } of resourcePairs(desktop, extra).pairs) write(resources, target, fs.readFileSync(source, 'utf8'));
  assert.deepEqual(resourceProblems(desktop, extra, resources), []);

  // Other bytes under the same name: an engine package of another build, a Python installer cut short.
  write(resources, 'python/python-3.12.10-amd64.exe.paket', 'pyth');
  assert.deepEqual(resourceProblems(desktop, extra, resources), ['resources/python/python-3.12.10-amd64.exe.paket is not the file the build carried (its SHA-256 differs)']);
  // A folder there with nothing the filter takes is as good as not there.
  fs.rmSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.zip'));
  fs.rmSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'));
  assert.deepEqual(resourcePairs(desktop, extra).missing, ['cortex-paket (beyin-v3-*.zip, beyin-v3-*.manifest.json)']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every filter in the build’s settings is one the run can read, and one it cannot is refused, not passed over', () => {
  for (const one of packaged.build.extraResources) for (const pattern of one.filter ?? []) assert.doesNotThrow(() => filterTest(pattern), pattern);
  const zip = filterTest('beyin-v3-*.zip');
  assert.ok(zip('beyin-v3-1.0.61.zip'));
  assert.ok(!zip('beyin-v3-1.0.61.zip.sha256') && !zip('alt/beyin-v3-1.0.61.zip') && !zip('beyin-v3-1x0.manifest.json'));
  assert.ok(!filterTest('python-*.exe.paket')('python-3.12.10-amd64-exe.paket'), 'a dot is a dot');
  for (const pattern of ['**/*', '!*.map', '*.{zip,json}', 'a?.zip']) assert.throws(() => filterTest(pattern), /does not know how to read/, pattern);
});

test('waiting is asking again until the time is up, once more at the end, never past it', async () => {
  const clock = { at: 0, slept: [] as number[] };
  const options = { now: () => clock.at, sleep: async (ms: number) => void (clock.slept.push(ms), (clock.at += ms)) };

  let asked = 0;
  assert.equal(await waitFor(() => (asked += 1) === 1, { ...options, timeout: 1000 }), true);
  assert.deepEqual([asked, clock.slept.length], [1, 0], 'true at once: nothing is waited for');

  asked = 0;
  assert.equal(await waitFor(async () => (asked += 1) === 3, { ...options, timeout: 1000, every: 250 }), true);
  assert.deepEqual([asked, clock.slept], [3, [250, 250]]);

  asked = 0;
  clock.at = 0;
  clock.slept = [];
  assert.equal(await waitFor(() => ((asked += 1), false), { ...options, timeout: 1000, every: 400 }), false);
  assert.deepEqual(clock.slept, [400, 400, 200], 'the last wait ends at the end, not after it');
  assert.equal(asked, 4, 'and it is asked once more when the time is up');

  // What only comes true at the very end is still seen.
  clock.at = 0;
  assert.equal(await waitFor(() => clock.at >= 1000, { ...options, timeout: 1000, every: 300 }), true);
});

test('Windows is asked about the install in one script that needs no quoting, and its answer is read as it comes', () => {
  const layout = installLayout(packaged, LOCAL);
  const script = probeScript(layout, packaged.build.appId);
  assert.ok(!script.includes('"'), 'single quotes only');
  assert.ok(script.includes(`'HKCU:\\Software\\${layout.guid}'`) && script.includes(`'HKLM:\\Software\\${layout.guid}'`));
  assert.ok(script.includes(`'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${layout.guid}'`));
  assert.ok(script.includes(`.'${packaged.build.appId}'`), 'the Run value the app writes and installer.nsh removes');
  assert.ok(script.includes("GetFolderPath('DesktopDirectory')") && script.includes("GetFolderPath('Programs')"));
  assert.ok(probeScript({ guid: "o'neil" }, 'a').includes("'HKCU:\\Software\\o''neil'"), 'a quote in a name does not end the literal');
  // As -EncodedCommand takes it: UTF-16LE, base64.
  assert.equal(Buffer.from(encodedCommand(script), 'base64').toString('utf16le'), script);

  const answer = '{"desktop":"C:\\\\Users\\\\Gündüz\\\\Desktop","programs":"C:\\\\p","installLocation":null,"machineLocation":null,"displayName":null,"displayVersion":null,"quietUninstall":null,"startsWithWindows":null}';
  assert.equal(readProbe(`\uFEFF\r\n${answer}\r\n`)?.installLocation, null);
  assert.equal(readProbe(`a warning first\r\n${answer}\r\n`)?.desktop, 'C:\\Users\\Gündüz\\Desktop');
  assert.equal(readProbe(''), null);
  assert.equal(readProbe(undefined), null);
  assert.equal(readProbe('{not json'), null);
});

test('the app’s processes are read from tasklist by their rows, whatever language its "none" is said in', () => {
  const rows = '"Cortex.exe","4120","Console","1","212,344 K"\r\n"Cortex.exe","5532","Console","1","88,120 K"\r\n';
  assert.deepEqual(tasklistPids(rows, 'Cortex.exe'), [4120, 5532]);
  assert.deepEqual(tasklistPids(rows, 'cortex.EXE'), [4120, 5532]);
  assert.deepEqual(tasklistPids('INFO: No tasks are running which match the specified criteria.\r\n', 'Cortex.exe'), []);
  assert.deepEqual(tasklistPids('BİLGİ: Belirtilen ölçütlerle eşleşen çalışan görev yok.\r\n', 'Cortex.exe'), []);
  assert.deepEqual(tasklistPids('"CortexHelper.exe","77","Console","1","1 K"\r\n', 'Cortex.exe'), []);
  assert.deepEqual(tasklistPids('', 'Cortex.exe'), []);
});

test('a picture of one flat colour is told from one that was drawn', () => {
  const pixel = (b: number, g: number, r: number) => [b, g, r, 255];
  assert.equal(distinctColours(Buffer.from([...pixel(243, 239, 228), ...pixel(243, 239, 228), ...pixel(243, 239, 228)])), 1);
  assert.equal(distinctColours(Buffer.from([...pixel(243, 239, 228), ...pixel(0, 0, 0), ...pixel(243, 239, 228), ...pixel(1, 0, 0)])), 3);
  assert.equal(distinctColours(Buffer.alloc(0)), 0);
});

test('two spellings of one Windows folder are one place', () => {
  assert.ok(samePath('C:\\Users\\Deneme\\AppData\\Local\\Programs\\Cortex\\', 'c:\\users\\deneme\\appdata\\local\\programs\\cortex'));
  assert.ok(samePath('C:/Users/x/Cortex/resources', 'C:\\Users\\x\\Cortex\\resources'));
  assert.ok(!samePath('C:\\Users\\x\\Cortex', 'C:\\Users\\x\\Cortex 2'));
  assert.ok(!samePath('', 'C:\\Users\\x\\Cortex'));
});

test('the run’s options are the three it knows, and a mistyped one stops it', () => {
  assert.deepEqual(readArgs([]), { engine: false, hidden: false, installer: null });
  assert.deepEqual(readArgs(['--motor', '--gizli', '--kurucu', 'release\\Cortex-Setup-1.0.0.exe']), { engine: true, hidden: true, installer: 'release\\Cortex-Setup-1.0.0.exe' });
  assert.throws(() => readArgs(['--moter']), /Bilinmeyen seçenek: --moter/);
  assert.throws(() => readArgs(['--kurucu']), /Bilinmeyen seçenek/);
});

test('what the run presses and waits for on the first-run screen is still there to press', () => {
  // The run is not tried anywhere but on Windows: a name changed in the screen would be found only there.
  const run = fs.readFileSync(path.join('e2e', 'kurulu.mjs'), 'utf8');
  const screen = fs.readFileSync(path.join('src', 'onboarding', 'Onboarding.tsx'), 'utf8');
  const used = [...new Set([...run.matchAll(/\[(data-onboarding[a-z-]*)/g)].map((found) => found[1]))].sort();
  assert.deepEqual(used, ['data-onboarding', 'data-onboarding-engine', 'data-onboarding-error', 'data-onboarding-name', 'data-onboarding-next', 'data-onboarding-pyn', 'data-onboarding-ready', 'data-onboarding-step']);
  for (const name of used) assert.match(screen, new RegExp(`\\b${name}(=|\\b)`), name);
  // And what it asks the app through the window's bridge (electron/preload.ts).
  const preload = fs.readFileSync(path.join('electron', 'preload.ts'), 'utf8');
  assert.match(preload, /bootstrap: \(\) => invoke\('app:bootstrap'\)/);
  assert.match(preload, /status: \(\) => invoke\('setup:status'\)/);
  // The switches it starts the app with are ones the app knows.
  assert.match(fs.readFileSync(path.join('electron', 'services', 'updater.ts'), 'utf8'), /!env\.CORTEX_HIDDEN && !env\.CORTEX_NO_UPDATE/);
  assert.match(fs.readFileSync(path.join('electron', 'main.ts'), 'utf8'), /process\.env\.CORTEX_HIDDEN === '1'/);
});

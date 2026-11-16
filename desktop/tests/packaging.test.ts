import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * The installer carries the engine, Python and the voice's Vulkan build, or is
 * not built (scripts/check-resources.cjs, package.json): a local `npm run
 * package` made an installer without the first two, with only electron-builder's
 * warning, and the first-run setup on a friend's computer could do nothing
 * (desktop-shell-7).
 */

// Loaded as electron-builder loads it, from where it lies: CommonJS, not bundled into the test.
const { problems } = createRequire(import.meta.url)(path.resolve('scripts', 'check-resources.cjs')) as { problems: (desktop: string, platform?: string) => string[] };
type Resource = { from: string; to: string; filter?: string[] };
const packaged = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  desktopName?: string;
  homepage?: string;
  build: {
    appId: string;
    productName: string;
    beforePack?: string;
    nsis: { include?: string };
    extraResources: Resource[];
    win: { extraResources?: Resource[] };
    linux: {
      target: string[];
      executableName: string;
      icon: string;
      category: string;
      maintainer: string;
      syncDesktopName?: boolean;
      extraResources?: Resource[];
      desktop: { entry: Record<string, string> };
    };
    deb: { packageName: string; depends: string[]; recommends?: string[] };
  };
};

test('packaging builds the engine package and fetches Python first, and checks them before anything is packed, in CI too', () => {
  for (const name of ['package', 'package:dir']) {
    const steps = packaged.scripts[name].split('&&').map((one) => one.trim());
    assert.ok(steps.indexOf('npm run cortex-paket') >= 0 && steps.indexOf('npm run python-paket') >= 0 && steps.indexOf('npm run vulkan-paket') >= 0, name);
    assert.ok(steps.indexOf('npm run python-paket') < steps.findIndex((one) => one.startsWith('electron-builder')), name);
    assert.ok(steps.indexOf('npm run vulkan-paket') < steps.findIndex((one) => one.startsWith('electron-builder')), name);
  }
  // A hook in the build's own settings: CI runs electron-builder directly, not `npm run package`.
  assert.equal(packaged.build.beforePack, './scripts/check-resources.cjs');
  const engine = packaged.build.extraResources.find((one) => one.from === 'cortex-paket');
  assert.deepEqual(engine?.filter, ['beyin-v3-*.zip', 'beyin-v3-*.manifest.json'], 'the package’s digests go with it');
  // Where electron/services/setup.ts looks for it (vulkanPackage).
  // What the Windows installer carries is what it carried before Linux was added: the shared list and Windows' own,
  // the same nine, from the same places to the same places.
  const windows = [...packaged.build.extraResources, ...(packaged.build.win.extraResources ?? [])].map((one) => `${one.from} -> ${one.to}`).sort();
  assert.deepEqual(windows, [
    '../LICENSE -> LICENSE',
    '../MARKA.md -> MARKA.md',
    '../tema/ananas/marka/pyn-muhur-200.png -> pyn-muhur-200.png',
    '../tema/ananas/marka/pyn.ico -> pyn.ico',
    '../tema/ananas/marka/tepsi -> tepsi',
    'cortex-paket -> cortex',
    'licenses -> licenses',
    'python-paket -> python',
    'vulkan-paket -> whisper-vulkan',
  ]);
  // Windows' own (whisper-vulkan-win-x64): carried by the installer only, where setup.ts looks for it (vulkanPackage).
  assert.deepEqual(packaged.build.win.extraResources?.find((one) => one.from === 'vulkan-paket'), { from: 'vulkan-paket', to: 'whisper-vulkan', filter: ['whisper-vulkan-*.zip'] });
  assert.deepEqual(packaged.build.win.extraResources?.find((one) => one.from === 'python-paket'), { from: 'python-paket', to: 'python', filter: ['python-*.exe.paket'] });
});

test('the Linux package carries the engine but neither Python’s Windows installer nor the Windows voice build, and asks the system for Python', () => {
  const every = [...packaged.build.extraResources, ...(packaged.build.linux.extraResources ?? [])];
  assert.ok(every.some((one) => one.from === 'cortex-paket'), 'the engine package, set up in a vault from the app');
  assert.ok(!every.some((one) => ['python-paket', 'vulkan-paket'].includes(one.from)), every.map((one) => one.from).join(', '));
  // The script builds what it carries and nothing it does not: no python.org .exe fetched for a Linux package.
  const steps = packaged.scripts['package:linux'].split('&&').map((one) => one.trim());
  const builder = steps.findIndex((one) => one.startsWith('electron-builder'));
  assert.ok(steps.indexOf('npm run cortex-paket') >= 0 && steps.indexOf('npm run cortex-paket') < builder, steps.join(' | '));
  assert.ok(!steps.includes('npm run python-paket') && !steps.includes('npm run vulkan-paket'), steps.join(' | '));
  assert.equal(steps[builder], 'electron-builder --linux deb --publish never');
  // The files in the .deb are 0644/0755 whatever the builder's umask.
  assert.equal(steps[0], 'umask 022');
  // The .deb only: an AppImage does not start on Ubuntu 24.04 and later (AppArmor keeps Chromium's sandbox from user
  // namespaces, its chrome-sandbox cannot be SUID, libfuse2 is not installed), where the .deb brings its own profile.
  assert.deepEqual(packaged.build.linux.target, ['deb']);
  // The engine runs on the system's Python (electron/services/localChat.ts, pythonCandidates: python3 first), as new as
  // the engine needs (3.11, the engine's floor); Debian 13 and Ubuntu 24.04 name some libraries with a t64 suffix, older
  // ones without: either is taken.
  const depends = packaged.build.deb.depends;
  assert.ok(depends.includes('python3 (>= 3.11)'), depends.join(', '));
  for (const name of ['libgtk-3-0', 'libasound2', 'libatspi2.0-0']) assert.ok(depends.includes(`${name}t64 | ${name}`), name);
  for (const name of ['libnss3', 'libgbm1', 'libxss1', 'libxtst6', 'libsecret-1-0', 'xdg-utils']) assert.ok(depends.includes(name), name);
  assert.deepEqual(packaged.build.deb.recommends, ['git'], 'the vault syncs with git when there is one');
});

test('on Linux the app is `cortex`, with Pyn’s 512px seal, listed as Cortex with a Turkish comment, its windows tied to that entry', () => {
  const linux = packaged.build.linux;
  assert.equal(packaged.build.deb.packageName, 'cortex');
  assert.equal(linux.executableName, 'cortex');
  // Electron names a Linux window by desktopName: the same name as the entry's file, so a dock shows the app's icon.
  assert.equal(packaged.desktopName, `${linux.executableName}.desktop`);
  assert.equal(linux.syncDesktopName, true);
  assert.equal(linux.icon, '../tema/ananas/marka/pyn-logo-512.png');
  const icon = fs.readFileSync(linux.icon);
  assert.equal(icon.subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual([icon.readUInt32BE(16), icon.readUInt32BE(20)], [512, 512]);
  assert.equal(linux.category, 'Office');
  assert.equal(linux.desktop.entry.Name, packaged.build.productName);
  assert.match(linux.desktop.entry['Comment[tr]'], /kasanı/);
  // electron-builder writes the entry's Exec itself (linux.executableName): one given here would make the build fail.
  assert.ok(!('Exec' in linux.desktop.entry));
  // A .deb names who keeps it and where it lives; electron-builder refuses one without (FpmTarget).
  assert.match(linux.maintainer, /^[^<]+ <[^@\s]+@[^>\s]+>$/);
  assert.match(packaged.homepage ?? '', /^https:\/\/github\.com\/GunduzTolga\/Cortex$/);
});

test('what is missing, stale or not the pinned file is named, and nothing when all is there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paketle-'));
  const desktop = path.join(root, 'desktop');
  fs.mkdirSync(desktop);
  fs.writeFileSync(path.join(root, 'VERSION'), '1.2.3\n');
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const installer = Buffer.from('python.org installer');
  const pin = { file: 'python-3.12.10-amd64.exe', sha256: createHash('sha256').update(installer).digest('hex') };
  fs.writeFileSync(path.join(desktop, 'python.json'), JSON.stringify(pin));
  // The engine's pin of the Vulkan build, as beyin_v3_ses.py writes it.
  const build = Buffer.from('whisper.cpp for Vulkan');
  const scripts = path.join(root, 'template', '.claude', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const pinned = ['VULKAN_BUILD = {', "    'surum': '1.9.5',", "    'url': 'https://github.com/o/r/releases/download/v/whisper-vulkan-win-x64.zip',", `    'sha256': '${createHash('sha256').update(build).digest('hex')}',`, '}', ''];
  fs.writeFileSync(path.join(scripts, 'beyin_v3_ses.py'), pinned.join(String.fromCharCode(10)));

  const missing = problems(desktop);
  assert.equal(missing.length, 3);
  assert.match(missing[0], /npm run cortex-paket/);
  assert.match(missing[1], /npm run python-paket/);
  assert.match(missing[2], /vulkan-paket.whisper-vulkan-win-x64.zip yok; önce: npm run vulkan-paket/);

  fs.mkdirSync(path.join(desktop, 'cortex-paket'));
  fs.mkdirSync(path.join(desktop, 'python-paket'));
  fs.mkdirSync(path.join(desktop, 'vulkan-paket'));
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.2.zip'), '');
  fs.writeFileSync(path.join(desktop, 'python-paket', `${pin.file}.paket`), 'something else');
  fs.writeFileSync(path.join(desktop, 'vulkan-paket', 'whisper-vulkan-win-x64.zip'), 'another build');
  const stale = problems(desktop);
  assert.match(stale[0], /beyin-v3-1\.2\.3\.zip.*bulunan: beyin-v3-1\.2\.2\.zip/, 'the package of a version bumped since is not shipped');
  assert.match(stale[1], /SHA-256/);
  assert.match(stale[2], /motorun SHA-256'sıyla tutmuyor/, 'a build the engine does not pin is not shipped');

  fs.rmSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.2.zip'));
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.zip'), '');
  assert.match(problems(desktop)[0], /manifest\.json yok/);
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'), '{}');
  fs.writeFileSync(path.join(desktop, 'python-paket', `${pin.file}.paket`), installer);
  fs.writeFileSync(path.join(desktop, 'vulkan-paket', 'whisper-vulkan-win-x64.zip'), build);
  assert.deepEqual(problems(desktop), []);

  // A Linux package carries neither: what they would have said is not asked of it, the engine still is.
  fs.rmSync(path.join(desktop, 'python-paket'), { recursive: true });
  fs.rmSync(path.join(desktop, 'vulkan-paket'), { recursive: true });
  assert.equal(problems(desktop).length, 2, 'Windows still wants them');
  assert.deepEqual(problems(desktop, 'linux'), []);
  fs.rmSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'));
  assert.match(problems(desktop, 'linux')[0], /manifest\.json yok/);
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'), '{}');

  // The app's version is the engine's: one bumped without the other is caught.
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.2.2' }));
  assert.match(problems(desktop)[0], /package\.json sürümü \(1\.2\.2\)/);
  assert.match(problems(desktop, 'linux')[0], /package\.json sürümü \(1\.2\.2\)/);
});

test('electron-builder hands the hook the platform it packs for, and the hook checks for that one', async () => {
  const hook = createRequire(import.meta.url)(path.resolve('scripts', 'check-resources.cjs')) as (context?: { electronPlatformName?: string }) => Promise<void>;
  assert.equal(typeof hook, 'function');
  // The hook as electron-builder loads it, from a scripts/ folder of a desktop/ that has the engine package and
  // neither Python's installer nor the Vulkan build: what a Linux build has.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paketle-kanca-'));
  const desktop = path.join(root, 'desktop');
  fs.mkdirSync(path.join(desktop, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join('scripts', 'check-resources.cjs'), path.join(desktop, 'scripts', 'check-resources.cjs'));
  fs.writeFileSync(path.join(root, 'VERSION'), '1.2.3\n');
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(desktop, 'python.json'), JSON.stringify({ file: 'python-3.12.10-amd64.exe', sha256: '0'.repeat(64) }));
  fs.mkdirSync(path.join(desktop, 'cortex-paket'));
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.zip'), '');
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'), '{}');
  const copied = createRequire(import.meta.url)(path.join(desktop, 'scripts', 'check-resources.cjs')) as (context?: { electronPlatformName?: string }) => Promise<void>;
  await copied({ electronPlatformName: 'linux' });
  await assert.rejects(copied({ electronPlatformName: 'win32' }), /python-paket\/python-3\.12\.10-amd64\.exe\.paket yok/);
  // A context without the name (an older electron-builder) is checked as Windows was before: nothing less is asked.
  await assert.rejects(copied(), /python-paket/);
  fs.rmSync(root, { recursive: true, force: true });
  // The same name electron-builder's own BeforePackContext gives it.
  const types = fs.readFileSync(path.join('node_modules', 'app-builder-lib', 'out', 'configuration.d.ts'), 'utf8');
  assert.match(types, /interface PackContext \{[^}]*readonly electronPlatformName: string;/);
  assert.match(types, /type BeforePackContext = PackContext;/);
});

test('uninstalled, Cortex no longer starts with Windows; updated, it still does (desktop-shell-6)', () => {
  assert.equal(packaged.build.nsis.include, 'build/installer.nsh');
  const script = fs.readFileSync(packaged.build.nsis.include, 'utf8');
  // The value Electron writes is named after the app's id (electron/main.ts sets it as the AppUserModelId).
  assert.match(fs.readFileSync('electron/main.ts', 'utf8'), new RegExp(`setAppUserModelId\\('${packaged.build.appId.replace(/\./g, '\\.')}'\\)`));
  const macro = /!macro customUnInstall([\s\S]*?)!macroend/.exec(script)?.[1] ?? '';
  const guarded = /\$\{ifNot\} \$\{isUpdated\}([\s\S]*?)\$\{endIf\}/.exec(macro)?.[1] ?? '';
  for (const key of ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run']) {
    assert.ok(guarded.includes(`DeleteRegValue HKCU "${key}" "${packaged.build.appId}"`), key);
  }
  assert.ok(!macro.replace(guarded, '').includes('DeleteRegValue'), 'nothing deleted outside the guard: an update keeps it');
});

test('uninstalled, the person is asked whether everything Cortex kept goes too; updated or silent, nothing is asked or taken', () => {
  const script = fs.readFileSync(packaged.build.nsis.include, 'utf8');
  const macro = /!macro customUnInstall([\s\S]*?)!macroend/.exec(script)?.[1] ?? '';
  const guarded = /\$\{ifNot\} \$\{isUpdated\}([\s\S]*)\$\{endIf\}/.exec(macro)?.[1] ?? '';
  const asked = /\$\{If\} \$\{Cmd\} `MessageBox ([^`]*)`([\s\S]*?)\$\{EndIf\}/.exec(guarded);
  assert.ok(asked, 'asked first');
  // "No" is the default, and the answer of a silent uninstall.
  assert.match(asked[1], /MB_DEFBUTTON2/);
  assert.match(asked[1], /\/SD IDNO IDYES$/);
  assert.match(asked[1], /Notların \(kasa klasörün\) silinmez/);
  const removed = asked[2];
  for (const line of ['RMDir /r "$APPDATA\\Cortex"', 'RMDir /r "$LOCALAPPDATA\\beyin-v3"', 'RMDir /r "$LOCALAPPDATA\\Cortex\\tools"', 'Delete "$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Pyn Yakala.lnk"', 'Delete "$APPDATA\\Microsoft\\Windows\\SendTo\\Beyne At.lnk"']) {
    assert.ok(removed.includes(line), line);
  }
  // The listener and the voice helper stopped first, the uninstaller's own PowerShell spared.
  assert.ok(removed.indexOf('Stop-Process') < removed.indexOf('RMDir'));
  assert.match(removed, /\$\$_\.ProcessId -ne \$\$PID/);
  // A tool Cortex installed, running from its folder, is stopped with them; the folder above goes only if it is empty.
  assert.ok(removed.includes("-like '*\\Cortex\\tools\\*'"));
  assert.ok(removed.includes('RMDir "$LOCALAPPDATA\\Cortex"') && !removed.includes('RMDir /r "$LOCALAPPDATA\\Cortex"\n'));
  // Nothing of the person's notes: no Documents, no vault.
  assert.doesNotMatch(removed, /DOCUMENTS|Belgeler|\$PROFILE/i);
  assert.ok(!macro.replace(guarded, '').includes('RMDir'), 'nothing taken outside the guard: an update keeps it');
  // The folders it takes are the ones the app and the engine write (electron settings, beyin_v3 default_state).
  assert.equal(packaged.build.productName, 'Cortex');
  const tools = /export function toolsDir[\s\S]*?\n\}/.exec(fs.readFileSync('electron/services/toolPackages.ts', 'utf8'))?.[0] ?? '';
  assert.ok(tools.includes('env.LOCALAPPDATA') && tools.includes("'Cortex', 'tools')"), tools);
  const states = /def default_state[\s\S]*?return base \/ "beyin-v3"/.exec(fs.readFileSync('../template/.claude/scripts/beyin_v3.py', 'utf8'))?.[0] ?? '';
  assert.match(states, /LOCALAPPDATA/);
});

test('a first install asks nobody "only me or everybody": it is for the person who runs it, with no administrator (G7)', () => {
  // The assisted installer shows that page unless the build is for the whole computer, and "everybody" asks for an
  // administrator; the README says none is needed.
  const nsis = (packaged.build as unknown as { nsis: { oneClick?: boolean; perMachine?: boolean } }).nsis;
  assert.deepEqual([nsis.oneClick, nsis.perMachine], [false, false]);
  const script = fs.readFileSync(packaged.build.nsis.include!, 'utf8');
  const macro = /!macro customInstallMode([\s\S]*?)!macroend/.exec(script)?.[1] ?? '';
  assert.match(macro, /StrCpy \$isForceCurrentInstall "1"/);
  assert.doesNotMatch(macro, /isForceMachineInstall/);
  // Only where no Cortex is installed for the whole computer already: that one is updated where it is.
  assert.match(macro, /\$\{if\} \$hasPerMachineInstallation != "1"\s+StrCpy \$isForceCurrentInstall "1"\s+\$\{endif\}/);
  // What it leans on in electron-builder's own script, so that an upgrade that renames either is caught here: the
  // page is there for this build, reads the macro before it draws, and is skipped for the current user when told.
  const templates = path.join('node_modules', 'app-builder-lib', 'templates', 'nsis');
  const assisted = fs.readFileSync(path.join(templates, 'assistedInstaller.nsh'), 'utf8');
  assert.match(assisted, /!ifndef INSTALL_MODE_PER_ALL_USERS\s+!insertmacro PAGE_INSTALL_MODE/);
  const page = fs.readFileSync(path.join(templates, 'multiUserUi.nsh'), 'utf8');
  assert.match(page, /!ifmacrodef customInstallmode\s+!insertmacro customInstallMode\s+!endif/i);
  assert.match(page, /\$\{if\} \$isForceCurrentInstall == "1"[\s\S]{0,200}?!insertmacro setInstallModePerUser\s+Abort/);
  assert.match(fs.readFileSync(path.join(templates, 'multiUser.nsh'), 'utf8'), /Var hasPerMachineInstallation/);
});

/** The MIT License as GitHub's licence detection knows it (choosealicense.com), with this repository's copyright line. */
const MIT = `MIT License

Copyright (c) 2026 Tolga Gündüz

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

test('the installer CI builds is installed, opened and uninstalled on the same runner, after it is built and kept (K6)', () => {
  // The build only looked whether an installer came out; what a person gets from it - the packaged app on a Windows
  // it was just installed on - was never started anywhere (e2e/kurulu.mjs says what the run does).
  const workflow = fs.readFileSync(path.join('..', '.github', 'workflows', 'desktop.yml'), 'utf8').replace(/\r\n/g, '\n');
  const names = [...workflow.matchAll(/^      - (?:name: (.+)|uses: (\S+))$/gm)].map((found) => found[1] ?? found[2]);
  const built = names.indexOf('Kurulum dosyasi');
  const tried = names.indexOf('Kurulu uygulama');
  assert.ok(built >= 0 && tried > built, names.join(' | '));
  const step = workflow.slice(workflow.indexOf('- name: Kurulu uygulama'));
  const own = step.slice(0, step.indexOf('\n      - ', 1));
  // With the engine set up from the package the installed app carries, by the Python the other steps use; the window
  // shown as a person's is, or hidden (--gizli) where a runner will not show one.
  assert.match(own, /^\s+run: node e2e\/kurulu\.mjs --motor( --gizli)?$/m);
  assert.match(own, /BEYIN_PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}/);
  // It cannot hold the job for ever, and what it saw is kept whether it passed or not: a Windows runner cannot be watched.
  assert.match(own, /^\s+timeout-minutes: \d+$/m);
  const kept = step.slice(own.length);
  assert.match(kept, /^\n      - uses: actions\/upload-artifact@v4\n\s+if: \$\{\{ !cancelled\(\) \}\}\n\s+with:\n\s+name: desktop-kurulu-uygulama\n\s+path: desktop\/e2e\/screenshots\/kurulu\/\n/);
  // The installer itself is kept before the run, as it was: a run that fails does not take the week's copy with it.
  const uploads = [...workflow.matchAll(/name: (cortex-setup-windows|desktop-kurulu-uygulama|desktop-smoke-screenshots)/g)].map((found) => found[1]);
  assert.deepEqual(uploads, ['desktop-smoke-screenshots', 'cortex-setup-windows', 'desktop-kurulu-uygulama']);
  assert.ok(workflow.indexOf('name: cortex-setup-windows') < workflow.indexOf('- name: Kurulu uygulama'));
  // The run is there to be run, and reads the installer's name from where the build writes it.
  const run = fs.readFileSync(path.join('e2e', 'kurulu.mjs'), 'utf8');
  assert.match(run, /path\.join\('release', layout\.installer\)/);
  assert.equal((packaged.build.nsis as { artifactName?: string }).artifactName, 'Cortex-Setup-${version}.${ext}');
});

test('CI builds the Linux packages, keeps them, then installs the .deb with apt and walks the installed app’s first day', () => {
  const workflow = fs.readFileSync(path.join('..', '.github', 'workflows', 'desktop-linux.yml'), 'utf8').replace(/\r\n/g, '\n');
  const names = [...workflow.matchAll(/^      - (?:name: (.+)|uses: (\S+))$/gm)].map((found) => found[1] ?? found[2]);
  const order = ['Cortex paketi', 'Linux paketi', 'Kurulum (apt)', 'Kurulu uygulama'].map((name) => names.indexOf(name));
  assert.ok(order.every((at, n) => at >= 0 && (n === 0 || at > order[n - 1])), names.join(' | '));
  assert.match(workflow, /run: umask 022 && npx electron-builder --linux deb --publish never/);
  assert.doesNotMatch(workflow, /AppImage|--no-sandbox/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  // Kept before it is tried, as desktop.yml keeps the installer: a failed try does not take the week's copy with it.
  assert.ok(workflow.indexOf('name: cortex-linux') < workflow.indexOf('- name: Kurulum (apt)'));
  assert.match(workflow, /run: xvfb-run -a .*node e2e\/kurulu-linux\.mjs --motor/);
  assert.match(workflow, /name: desktop-linux-kurulu-uygulama\n\s+path: desktop\/e2e\/screenshots\/kurulu-linux\//);
  // Not a release: nothing here publishes (release.yml is the one that does, for Windows).
  assert.doesNotMatch(workflow, /gh release|--publish always|contents: write/);
  assert.ok(fs.existsSync(path.join('e2e', 'kurulu-linux.mjs')));
});

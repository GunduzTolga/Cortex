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
const { problems } = createRequire(import.meta.url)(path.resolve('scripts', 'check-resources.cjs')) as { problems: (desktop: string) => string[] };
const packaged = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  build: { appId: string; beforePack?: string; nsis: { include?: string }; extraResources: Array<{ from: string; to: string; filter?: string[] }> };
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
  assert.deepEqual(packaged.build.extraResources.find((one) => one.from === 'vulkan-paket'), { from: 'vulkan-paket', to: 'whisper-vulkan', filter: ['whisper-vulkan-*.zip'] });
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

  // The app's version is the engine's: one bumped without the other is caught.
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.2.2' }));
  assert.match(problems(desktop)[0], /package\.json sürümü \(1\.2\.2\)/);
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

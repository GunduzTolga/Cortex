import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * The installer carries the engine and Python, or is not built
 * (scripts/check-resources.cjs, package.json): a local `npm run package` made
 * an installer without either, with only electron-builder's warning, and the
 * first-run setup on a friend's computer could do nothing (desktop-shell-7).
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
    assert.ok(steps.indexOf('npm run cortex-paket') >= 0 && steps.indexOf('npm run python-paket') >= 0, name);
    assert.ok(steps.indexOf('npm run python-paket') < steps.findIndex((one) => one.startsWith('electron-builder')), name);
  }
  // A hook in the build's own settings: CI runs electron-builder directly, not `npm run package`.
  assert.equal(packaged.build.beforePack, './scripts/check-resources.cjs');
  const engine = packaged.build.extraResources.find((one) => one.from === 'cortex-paket');
  assert.deepEqual(engine?.filter, ['beyin-v3-*.zip', 'beyin-v3-*.manifest.json'], 'the package’s digests go with it');
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

  const missing = problems(desktop);
  assert.equal(missing.length, 2);
  assert.match(missing[0], /npm run cortex-paket/);
  assert.match(missing[1], /npm run python-paket/);

  fs.mkdirSync(path.join(desktop, 'cortex-paket'));
  fs.mkdirSync(path.join(desktop, 'python-paket'));
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.2.zip'), '');
  fs.writeFileSync(path.join(desktop, 'python-paket', `${pin.file}.paket`), 'something else');
  const stale = problems(desktop);
  assert.match(stale[0], /beyin-v3-1\.2\.3\.zip.*bulunan: beyin-v3-1\.2\.2\.zip/, 'the package of a version bumped since is not shipped');
  assert.match(stale[1], /SHA-256/);

  fs.rmSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.2.zip'));
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.zip'), '');
  assert.match(problems(desktop)[0], /manifest\.json yok/);
  fs.writeFileSync(path.join(desktop, 'cortex-paket', 'beyin-v3-1.2.3.manifest.json'), '{}');
  fs.writeFileSync(path.join(desktop, 'python-paket', `${pin.file}.paket`), installer);
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

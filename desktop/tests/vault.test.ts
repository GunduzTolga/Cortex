import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { forgetSettings, readSettings, settingsPath } from '../electron/services/settings';
import { defaultVaultDir, ownDataTouchedBy, setVault, vaultStatus } from '../electron/services/vault';
import { turkishOf } from '../shared/refusalsTr';

/**
 * Which folder is the vault (electron/services/vault.ts): a folder, by its
 * real path, never one reached through a link and never the app's own data or
 * one around it; and the window is told its name, never where it is.
 */

/** Each test from a first run: no settings file, nothing remembered. */
function firstRun(): void {
  fs.rmSync(settingsPath(), { force: true });
  forgetSettings();
}

const links = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-probe-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  }
})();

test('a folder chosen is kept by its real path, and the window is told its name alone', async () => {
  firstRun();
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
  const status = await setVault(dir);
  assert.deepEqual(status, { vault: { name: path.basename(dir) }, missing: false });
  assert.ok(!JSON.stringify(status).includes(path.dirname(dir)), 'no path in what the window is told');
  assert.equal(readSettings().vault, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(await vaultStatus(), { vault: { name: path.basename(dir) }, missing: true }, 'a vault gone from disk is said, not forgotten');
});

/*
  GitHub's Windows runner names its temporary folder by its 8.3 short name
  (C:\Users\RUNNER~1\...), which is what a folder named as spelled there
  looks like: a path whose real one differs with no link on the way. Elsewhere
  a temporary folder whose real path differs is reached through a link (macOS's
  /var), which is refused, so this is Windows's alone.
*/
test('a folder named through a short alias, which is not a link, is taken and kept by its real path', { skip: process.platform !== 'win32' && 'Windows names folders through 8.3 aliases' }, async () => {
  firstRun();
  const spelled = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-'));
  const real = fs.realpathSync.native(spelled);
  assert.deepEqual(await setVault(spelled), { vault: { name: path.basename(real) }, missing: false });
  assert.equal(readSettings().vault, real);
});

test('what is not a folder, and a folder reached through a link, are refused', async () => {
  firstRun();
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
  fs.writeFileSync(path.join(dir, 'not-a-folder.md'), '# x\n');
  await assert.rejects(setVault(path.join(dir, 'not-a-folder.md')), /Not a folder/);
  await assert.rejects(setVault(path.join(dir, 'gone')), /Not a folder/);
  if (links) {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
    await assert.rejects(setVault(path.join(dir, 'link')), /link/);
  }
  assert.equal(readSettings().vault, null, 'nothing kept from a refusal');
});

test("the app's own data folder, one inside it and one holding it are refused", async () => {
  firstRun();
  const data = app.getPath('userData');
  fs.mkdirSync(path.join(data, 'inside'), { recursive: true });
  assert.ok(ownDataTouchedBy(data));
  assert.ok(ownDataTouchedBy(path.join(data, 'inside')));
  assert.ok(ownDataTouchedBy(path.dirname(data)), 'a folder around it, as a home folder or a drive root would be');
  assert.equal(ownDataTouchedBy(fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'))), null);
  await assert.rejects(setVault(data), /cannot be the vault/);
  await assert.rejects(setVault(path.dirname(data)), /cannot be the vault/);
});

test('the first run’s vault is made as Cortex in Documents; one holding other things is left alone and Cortex 2 made', async () => {
  const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'belgeler-'));
  const first = await defaultVaultDir(documents);
  assert.equal(first, path.join(documents, 'Cortex'));
  assert.ok(fs.statSync(first).isDirectory(), 'made');
  assert.equal(await defaultVaultDir(documents), first, 'an empty Cortex there already is taken');
  fs.writeFileSync(path.join(first, 'beyin.py'), '');
  assert.equal(await defaultVaultDir(documents), first, 'a vault there already is taken');
  fs.rmSync(path.join(first, 'beyin.py'));
  fs.writeFileSync(path.join(first, 'baska.txt'), 'someone else’s');
  const second = await defaultVaultDir(documents);
  assert.equal(second, path.join(documents, 'Cortex 2'), 'a Cortex holding other things is left alone');
  assert.equal(fs.readFileSync(path.join(first, 'baska.txt'), 'utf8'), 'someone else’s', 'and nothing in it touched');
});

test('K11: Documents not letting Cortex make the vault’s folder is said as that, with what to do, not as Node’s EPERM and the path', async () => {
  // "Controlled folder access" keeping Documents, or a Documents the account may not write in: the toast read
  // "EPERM: operation not permitted, mkdir 'C:\\Users\\…\\Documents\\Cortex'".
  const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'belgeler-korumali-'));
  const promises = fs.promises as { mkdir: typeof fs.promises.mkdir };
  const mkdir = promises.mkdir;
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...said: unknown[]) => void logged.push(said.join(' '));
  promises.mkdir = (async (dir: fs.PathLike) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(dir)}'`), { code: 'EPERM' });
  }) as typeof fs.promises.mkdir;
  try {
    await assert.rejects(defaultVaultDir(documents), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Cortex could not make a folder for the vault in Documents: Windows did not allow it (the folder may be protected). Choose another folder.');
      assert.ok(!err.message.includes(documents) && !/EPERM|mkdir/.test(err.message), 'no path and no system error in what the window shows');
      return true;
    });
    assert.ok(logged.some((line) => line.includes('EPERM')), 'the system’s own word goes to the log');
    assert.ok(!fs.existsSync(path.join(documents, 'Cortex')));
  } finally {
    promises.mkdir = mkdir;
    console.warn = warn;
    fs.rmSync(documents, { recursive: true, force: true });
  }
  // In Turkish, as the window shows it (shared/refusalsTr.ts).
  assert.equal(
    turkishOf('Cortex could not make a folder for the vault in Documents: Windows did not allow it (the folder may be protected). Choose another folder.'),
    'Cortex, Belgeler içinde kasa için klasör açamadı: Windows izin vermedi (klasör korumalı olabilir); Kasayı seç ile başka bir klasör seç.',
  );
});

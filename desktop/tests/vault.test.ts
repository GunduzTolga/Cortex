import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { forgetSettings, readSettings, settingsPath } from '../electron/services/settings';
import { ownDataTouchedBy, setVault, vaultStatus } from '../electron/services/vault';

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

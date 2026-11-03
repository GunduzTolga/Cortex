import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateSettings } from '../electron/services/settings';
import { gitProgram, setVaultSync, setVaultSyncEngine, syncVaultNow, vaultSyncStatus } from '../electron/services/vaultSync';

/**
 * The vault kept in step with its git remote (electron/services/vaultSync.ts), against real repositories: a bare
 * remote and two clones of it, as a PC and a server keep them. Nothing leaves while the switch is off; a note goes
 * across; a conflict loses nothing on either side; a secret stops it before anything is sent.
 */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// The folders here have no engine installed: the sync runs the engine's source module (the scan, the rules), as the
// vault's own `beyin.py esitle` would. Its secret cases are tested in tests/v3_esitle_test.py.
setVaultSyncEngine(path.resolve('..', 'template', '.claude', 'scripts', 'beyin_v3_esitle.py'));
const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const NL = String.fromCharCode(10);
// Made here, not written whole in the source: a token-shaped string in a file is what the scan is for.
const fakeToken = () => ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

function setUp() {
  const root = temp('cortex-sync-');
  const remote = path.join(root, 'remote.git');
  const a = path.join(root, 'pc');
  const b = path.join(root, 'sunucu');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  for (const [dir, name] of [
    [a, 'PC'],
    [b, 'Sunucu'],
  ] as const) {
    if (dir === b) git(root, 'clone', '-q', remote, dir);
    else {
      git(root, 'clone', '-q', remote, dir);
    }
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.com`);
    git(dir, 'config', 'core.autocrlf', 'false');
    if (dir === a) {
      fs.writeFileSync(path.join(a, 'Plan.md'), ['# Plan', '', 'ilk satır', ''].join(NL));
      git(a, 'add', '-A');
      git(a, 'commit', '-q', '-m', 'ilk');
      git(a, 'push', '-q', '-u', 'origin', 'main');
    }
  }
  git(b, 'pull', '-q', 'origin', 'main');
  git(b, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  updateSettings((settings) => {
    settings.vault = a;
    settings.vaultSync = false;
  });
  return { root, remote, a, b };
}

test('a vault that is no git repository is not offered the switch', { skip: !hasGit }, async () => {
  updateSettings((settings) => {
    settings.vault = temp('cortex-sync-plain-');
  });
  const status = await vaultSyncStatus();
  assert.equal(status.available, false);
  assert.equal(status.missing, 'repo');
});

test('off, nothing leaves; on, a note written here reaches the other copy', { skip: !hasGit }, async () => {
  const { a, b } = setUp();
  assert.equal((await vaultSyncStatus()).available, true);
  fs.writeFileSync(path.join(a, 'Yeni.md'), ['# Yeni', '', 'PC\'de yazıldı', ''].join(NL));
  await syncVaultNow();
  git(b, 'pull', '-q');
  assert.equal(fs.existsSync(path.join(b, 'Yeni.md')), false, 'off: nothing went');

  await setVaultSync(true);
  const status = await syncVaultNow();
  assert.equal(status.state, 'synced');
  assert.ok(status.lastSyncedAt);
  git(b, 'pull', '-q');
  assert.ok(fs.readFileSync(path.join(b, 'Yeni.md'), 'utf8').includes("PC'de yazıldı"));

  // And back: written on the other side, it comes here.
  fs.writeFileSync(path.join(b, 'Sunucudan.md'), '# Sunucudan' + NL);
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'sunucu');
  git(b, 'push', '-q');
  assert.equal((await syncVaultNow()).state, 'synced');
  assert.ok(fs.existsSync(path.join(a, 'Sunucudan.md')));
});

test('a conflict is backed out of and said: both sides keep what they wrote', { skip: !hasGit }, async () => {
  const { a, b } = setUp();
  await setVaultSync(true);
  fs.writeFileSync(path.join(b, 'Plan.md'), ['# Plan', '', 'sunucunun satırı', ''].join(NL));
  git(b, 'commit', '-q', '-am', 'sunucu');
  git(b, 'push', '-q');
  fs.writeFileSync(path.join(a, 'Plan.md'), ['# Plan', '', 'PC\'nin satırı', ''].join(NL));

  const status = await syncVaultNow();
  assert.equal(status.state, 'conflict');
  assert.ok(status.detail.includes('Plan.md'), status.detail.join(' | '));
  assert.ok(fs.readFileSync(path.join(a, 'Plan.md'), 'utf8').includes("PC'nin satırı"), 'what was written here is here');
  assert.equal(fs.existsSync(path.join(a, '.git', 'rebase-merge')), false, 'no rebase left standing');
  git(b, 'pull', '-q');
  assert.ok(fs.readFileSync(path.join(b, 'Plan.md'), 'utf8').includes('sunucunun satırı'), 'the other side is untouched');
});

test('a secret in a new line stops the sync before anything is committed or sent', { skip: !hasGit }, async () => {
  const { a, b } = setUp();
  await setVaultSync(true);
  fs.writeFileSync(path.join(a, 'Sır.md'), ['# Not', '', `anahtar: ${fakeToken()}`, ''].join(NL));

  const status = await syncVaultNow();
  assert.equal(status.state, 'secret');
  assert.ok(status.detail[0].startsWith('Sır.md:3 '), status.detail.join(' | '));
  assert.ok(!status.detail.join('').includes(fakeToken()), 'the secret itself is never said');
  assert.match(git(a, 'status', '--porcelain', '-uall'), /^\?\? /m, 'the file stays, uncommitted');
  git(b, 'pull', '-q');
  assert.equal(fs.existsSync(path.join(b, 'Sır.md')), false, 'nothing was sent');
});

test('git is never run from inside the vault, even with the vault on the PATH', { skip: !hasGit }, () => {
  // 30 October (security review): run by its bare name with the vault as its folder, Windows looks there first.
  const vault = temp('cortex-sync-planted-');
  const planted = path.join(vault, process.platform === 'win32' ? 'git.exe' : 'git');
  fs.writeFileSync(planted, '');
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const before = process.env[key];
  process.env[key] = `${vault}${path.delimiter}${before ?? ''}`;
  try {
    const found = gitProgram(vault);
    assert.ok(found, 'the real git is still found');
    assert.notEqual(path.resolve(found), path.resolve(planted));
    assert.ok(!path.resolve(found).startsWith(path.resolve(vault)));
  } finally {
    process.env[key] = before;
  }
});

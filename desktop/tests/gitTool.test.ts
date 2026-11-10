import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MINGIT, installGit, ownGit, setGitToolForTests } from '../electron/services/gitTool';
import { pythonOf } from '../electron/services/localChat';

/**
 * Git brought by Cortex on Windows (electron/services/gitTool.ts): the download kept only when it is the pinned bytes,
 * unpacked into a folder beside its place and put there whole; nothing left behind from a download that was not.
 * A local server stands in for GitHub's releases and serves packages made here.
 */

const python = pythonOf();
const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const work = temp('cortex-gittool-');

/** A zip made with Python's zipfile, holding these files (name → text). */
function zipOf(name: string, files: Record<string, string>): Buffer {
  const file = path.join(work, name);
  execFileSync(python?.command ?? 'python3', [...(python?.args ?? []), '-I', '-c', 'import sys, json, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    for n, t in json.loads(sys.argv[2]).items(): z.writestr(n, t)', file, JSON.stringify(files)]);
  return fs.readFileSync(file);
}
const pinOf = (bytes: Buffer, file: string) => ({ file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

const served = new Map<string, Buffer>();
const server = http.createServer((request, response) => {
  const bytes = served.get((request.url ?? '').slice(1));
  if (!bytes) {
    response.writeHead(404);
    return response.end();
  }
  response.writeHead(200, { 'Content-Length': bytes.length });
  response.end(bytes);
});
server.listen(0, '127.0.0.1');
await new Promise((done) => server.once('listening', done));
const releases = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
test.after(() => server.close());

const good = zipOf('good.zip', { 'cmd/git.exe': 'git', 'ucrt64/bin/git.exe': 'git', 'etc/gitconfig': '[core]\n' });
served.set('MinGit-good.zip', good);

/** Nothing of a download left in the tools folder: no zip, no half-unpacked folder. */
const leftovers = (dir: string) => fs.readdirSync(dir).filter((name) => name.includes('indiriliyor'));

test('the pins are the release’s: two packages, each a size and a SHA-256', () => {
  for (const pin of [MINGIT.x64, MINGIT.arm64]) {
    assert.match(pin.file, /^MinGit-2\.56\.0\.4-(64-bit|arm64)\.zip$/);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.size > 30e6 && pin.size < 45e6);
  }
});

test('not on Windows, nothing is downloaded: the person is told where to get git', async () => {
  setGitToolForTests({ releases, platform: 'linux', pin: pinOf(good, 'MinGit-good.zip') });
  const dir = temp('cortex-tools-');
  await assert.rejects(() => installGit(undefined, { dir }), /git-scm\.com/);
  assert.deepEqual(fs.readdirSync(dir), []);
  setGitToolForTests(null);
});

test('the pinned package is unpacked and put in place whole; its program is the one used', { skip: !python }, async () => {
  setGitToolForTests({ releases, platform: 'win32', pin: pinOf(good, 'MinGit-good.zip') });
  const dir = temp('cortex-tools-');
  assert.equal(ownGit(dir), null);
  const said: string[] = [];
  const program = await installGit((step) => said.push(step), { dir });
  assert.equal(program, path.join(dir, 'git', 'cmd', 'git.exe'));
  assert.equal(ownGit(dir), program);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'git', 'cortex-tool.json'), 'utf8')).name, 'MinGit');
  assert.deepEqual(leftovers(dir), []);
  assert.ok(said.some((one) => /indiriliyor/.test(one)) && said.some((one) => /kuruluyor/.test(one)));
  setGitToolForTests(null);
});

test('bytes that are not the pinned ones - changed, cut short or longer - install nothing and leave nothing', { skip: !python }, async () => {
  const dir = temp('cortex-tools-');
  // Changed: the same size, another hash.
  const changed = Buffer.from(good);
  changed[changed.length - 30] ^= 0xff;
  served.set('MinGit-changed.zip', changed);
  setGitToolForTests({ releases, platform: 'win32', pin: { ...pinOf(good, 'MinGit-changed.zip') } });
  await assert.rejects(() => installGit(undefined, { dir }), /SHA-256 tutmadı/);
  // Cut short.
  served.set('MinGit-short.zip', good.subarray(0, good.length - 10));
  setGitToolForTests({ releases, platform: 'win32', pin: { ...pinOf(good, 'MinGit-short.zip') } });
  await assert.rejects(() => installGit(undefined, { dir }), /SHA-256 tutmadı/);
  // Longer than the package: stopped as it comes.
  served.set('MinGit-long.zip', Buffer.concat([good, Buffer.alloc(4096)]));
  setGitToolForTests({ releases, platform: 'win32', pin: { ...pinOf(good, 'MinGit-long.zip') } });
  await assert.rejects(() => installGit(undefined, { dir }), /beklenen Git paketi değil/);
  // Not there.
  setGitToolForTests({ releases, platform: 'win32', pin: { ...pinOf(good, 'MinGit-yok.zip') } });
  await assert.rejects(() => installGit(undefined, { dir }), /404/);
  assert.equal(ownGit(dir), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  setGitToolForTests(null);
});

test('a package reaching out of its folder, or with no git.exe, installs nothing, even with its hash pinned', { skip: !python }, async () => {
  const dir = temp('cortex-tools-');
  const outside = zipOf('outside.zip', { 'cmd/git.exe': 'git', '../../kacak.txt': 'x' });
  served.set('MinGit-outside.zip', outside);
  setGitToolForTests({ releases, platform: 'win32', pin: pinOf(outside, 'MinGit-outside.zip') });
  await assert.rejects(
    () => installGit(undefined, { dir }),
    (err: Error) => {
      assert.match(err.message, /^Git paketi açılamadı; diskte yer olduğunu ve Python’un kurulu olduğunu \(Ayarlar → Cortex\) kontrol edip yeniden dene\.$/);
      // G5: what Python said (the path inside the package, a traceback) is for the console, not the window.
      assert.doesNotMatch(err.message, /bad path|kacak|Traceback|SystemExit/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(dir, '..', 'kacak.txt')), false);
  const empty = zipOf('empty.zip', { 'README.txt': 'no git here' });
  served.set('MinGit-empty.zip', empty);
  setGitToolForTests({ releases, platform: 'win32', pin: pinOf(empty, 'MinGit-empty.zip') });
  await assert.rejects(() => installGit(undefined, { dir }), /git\.exe yok/);
  assert.equal(ownGit(dir), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  setGitToolForTests(null);
});

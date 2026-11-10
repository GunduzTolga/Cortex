import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { programOf } from '../electron/services/clis';
import { PACKAGES, PackageRefusal, installPackage, ownProgram, toolsDir, untar } from '../electron/services/toolPackages';

/**
 * OpenCode, Codex, Gemini CLI and Qwen Code installed by Cortex itself (electron/services/toolPackages.ts): their
 * makers' npm packages downloaded, checked against the registry's SHA-512 and unpacked, with no npm and no Node.js.
 */

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tools-'));

/** A tar header as npm's tar writes one (ustar). */
function header(name: string, size: number, type = '0', prefix = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  if (prefix) block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}
const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

interface Entry {
  name: string;
  data?: string | Buffer;
  type?: string;
  prefix?: string;
  pax?: string;
  long?: string;
}
function tarOf(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const one of entries) {
    if (one.pax) {
      const body = Buffer.from(paxRecord('path', one.pax));
      parts.push(header('PaxHeader', body.length, 'x'), padded(body));
    }
    if (one.long) {
      const body = Buffer.from(`${one.long}\0`);
      parts.push(header('././@LongLink', body.length, 'L'), padded(body));
    }
    const data = Buffer.from(one.data ?? '');
    parts.push(header(one.name, data.length, one.type ?? '0', one.prefix), padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Fed in pieces that cut through headers and files, as a download comes. */
async function unpack(tar: Buffer, dest: string, piece = 313): Promise<void> {
  const chunks: Buffer[] = [];
  for (let at = 0; at < tar.length; at += piece) chunks.push(tar.subarray(at, at + piece));
  await pipeline(Readable.from(chunks), untar(dest));
}

test('a package unpacks without its top folder: ustar names and prefixes, POSIX and GNU long names, folders; a link is passed over', async () => {
  const dest = temp();
  try {
    const deep = `package/${'uzun-klasör/'.repeat(12)}son.js`;
    await unpack(
      tarOf([
        { name: 'package/', type: '5' },
        { name: 'package/package.json', data: '{"name":"x"}' },
        { name: 'bin/opencode.exe', prefix: 'package', data: Buffer.alloc(5000, 7) },
        { name: 'ignored', pax: deep, data: 'pax' },
        { name: 'ignored-too', long: 'package/gnu/long/name.txt', data: 'gnu' },
        { name: 'package/empty.txt', data: '' },
        { name: 'package/link', type: '2' },
      ]),
      dest,
    );
    assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
    assert.deepEqual(fs.readFileSync(path.join(dest, 'bin', 'opencode.exe')), Buffer.alloc(5000, 7));
    assert.equal(fs.readFileSync(path.join(dest, ...deep.split('/').slice(1)), 'utf8'), 'pax');
    assert.equal(fs.readFileSync(path.join(dest, 'gnu', 'long', 'name.txt'), 'utf8'), 'gnu');
    assert.equal(fs.readFileSync(path.join(dest, 'empty.txt'), 'utf8'), '');
    assert.ok(!fs.existsSync(path.join(dest, 'link')));
    assert.ok(!fs.existsSync(path.join(dest, 'ignored')) && !fs.existsSync(path.join(dest, 'package')));
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('a tarball made by this system’s own tar unpacks the same', async () => {
  const work = temp();
  try {
    const name = `${'a'.repeat(60)}/${'b'.repeat(60)}/dosya.txt`;
    fs.mkdirSync(path.join(work, 'src', 'package', ...name.split('/').slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'package', ...name.split('/')), 'merhaba');
    const tgz = path.join(work, 'paket.tgz');
    execFileSync('tar', ['-czf', 'paket.tgz', '-C', 'src', 'package'], { cwd: work });
    const dest = path.join(work, 'açılan');
    await pipeline(fs.createReadStream(tgz), (await import('node:zlib')).createGunzip(), untar(dest));
    assert.equal(fs.readFileSync(path.join(dest, ...name.split('/')), 'utf8'), 'merhaba');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a package naming a file outside its folder, or cut short, is refused', async () => {
  const dest = temp();
  try {
    await assert.rejects(unpack(tarOf([{ name: 'package/../../dışarı.txt', data: 'x' }]), dest), (err) => err instanceof PackageRefusal && /outside its folder/.test(err.message));
    await assert.rejects(unpack(tarOf([{ name: 'package/C:/Windows/x.txt', data: 'x' }]), dest), /outside its folder/);
    assert.ok(!fs.existsSync(path.join(dest, '..', 'dışarı.txt')));
    const whole = tarOf([{ name: 'package/a.txt', data: 'x'.repeat(2000) }]);
    await assert.rejects(unpack(whole.subarray(0, 1200), path.join(dest, 'kısa')), /did not finish/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

/** A registry of one package, as registry.npmjs.org answers: its manifest, and its tarball. */
async function registry(tar: Buffer, integrity?: string): Promise<{ url: string; close: () => Promise<void>; asked: string[] }> {
  const tgz = gzipSync(tar);
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    if (req.url === '/files/paket.tgz') {
      res.end(tgz);
      return;
    }
    const { port } = server.address() as AddressInfo;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'paket', version: '1.2.3', dist: { tarball: `http://127.0.0.1:${port}/files/paket.tgz`, integrity: integrity ?? `sha512-${createHash('sha512').update(tgz).digest('base64')}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('a tool is downloaded, checked and put in place: its program, and what it is, in a folder of its own', async () => {
  const dir = temp();
  const served = await registry(tarOf([{ name: 'package/bin/opencode.exe', data: 'MZ yeni' }, { name: 'package/package.json', data: '{}' }]));
  try {
    // An older one there is replaced whole.
    fs.mkdirSync(path.join(dir, 'opencode', 'eski'), { recursive: true });
    const program = await installPackage('opencode', { dir, registry: served.url, arch: 'x64' });
    assert.equal(program, path.join(dir, 'opencode', 'bin', 'opencode.exe'));
    assert.equal(fs.readFileSync(program, 'utf8'), 'MZ yeni');
    assert.ok(!fs.existsSync(path.join(dir, 'opencode', 'eski')));
    assert.ok(!fs.existsSync(path.join(dir, 'opencode-indiriliyor')), 'nothing half-done left');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'opencode', 'cortex-tool.json'), 'utf8')), { name: 'paket', version: '1.2.3', program: 'bin/opencode.exe' });
    assert.deepEqual(served.asked[0], '/opencode-windows-x64/latest', 'its maker’s package for Windows');
    assert.deepEqual(ownProgram('opencode', dir), { command: program, args: [] });
  } finally {
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a download whose SHA-512 is not the registry’s, or a package without the program, installs nothing and leaves the one there', async () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, 'gemini', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gemini', 'bundle', 'gemini.js'), 'önceki');
  fs.writeFileSync(path.join(dir, 'gemini', 'cortex-tool.json'), JSON.stringify({ program: 'bundle/gemini.js' }));
  const tampered = await registry(tarOf([{ name: 'package/bundle/gemini.js', data: 'başka' }]), `sha512-${Buffer.alloc(64).toString('base64')}`);
  const empty = await registry(tarOf([{ name: 'package/README.md', data: 'yok' }]));
  try {
    await assert.rejects(installPackage('gemini', { dir, registry: tampered.url }), (err) => err instanceof PackageRefusal && /SHA-512 differs/.test(err.message));
    await assert.rejects(installPackage('gemini', { dir, registry: empty.url }), /no program in it/);
    assert.equal(fs.readFileSync(path.join(dir, 'gemini', 'bundle', 'gemini.js'), 'utf8'), 'önceki');
    assert.ok(!fs.existsSync(path.join(dir, 'gemini-indiriliyor')));
    await assert.rejects(installPackage('gemini', { dir, registry: 'http://127.0.0.1:9/' }), /did not start/);
  } finally {
    await tampered.close();
    await empty.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K4: a download from which nothing comes any more is given up and said so, not waited on for its half hour', async () => {
  // A connection gone quiet (a proxy, a Wi-Fi that dropped): the window said "installing" for thirty minutes.
  const dir = temp();
  // Not to be squeezed small: the first piece is sent, the rest never comes.
  const tgz = gzipSync(tarOf([{ name: 'package/bin/opencode.exe', data: randomBytes(60_000) }]));
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    if (req.url === '/files/paket.tgz') {
      res.writeHead(200, { 'content-length': String(tgz.length) });
      res.write(tgz.subarray(0, 2000));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'paket', version: '1.2.3', dist: { tarball: `http://127.0.0.1:${port}/files/paket.tgz`, integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const heard: number[] = [];
  try {
    const began = Date.now();
    const ended = await Promise.race([
      installPackage('opencode', { dir, registry: `http://127.0.0.1:${port}/`, arch: 'x64', idle: 400, progress: (got) => heard.push(got) }).then(
        () => 'installed',
        (err: unknown) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting after 6 s'), 6_000)),
    ]);
    assert.ok(ended instanceof PackageRefusal, String(ended));
    assert.match(ended.message, /^The download stalled: nothing came for a while\./);
    assert.ok(Date.now() - began < 5_000, 'given up a moment after it went quiet');
    assert.ok(heard.length > 0 && heard.at(-1) === 2000, 'what did come was counted');
    assert.ok(!fs.existsSync(path.join(dir, 'opencode-indiriliyor')), 'nothing half-done left');
    assert.ok(!fs.existsSync(path.join(dir, 'opencode')));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K4: a download tells how far it is: the bytes come so far, of how many', async () => {
  const dir = temp();
  const tar = tarOf([{ name: 'package/bin/opencode.exe', data: randomBytes(300_000) }]);
  const size = gzipSync(tar).length;
  const served = await registry(tar);
  const steps: Array<[number, number | null]> = [];
  try {
    await installPackage('opencode', { dir, registry: served.url, arch: 'x64', progress: (got, total) => steps.push([got, total]) });
    assert.ok(steps.length > 0, 'told as the download comes');
    assert.deepEqual(steps.at(-1), [size, size], 'all of it at the end, of the length the server gave');
    assert.ok(steps.every(([got], at) => at === 0 || got > steps[at - 1][0]), 'only ever further');
    assert.ok(steps.every(([, total]) => total === size));
  } finally {
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('K4: Windows refusing the last rename for a moment (an antivirus reading the new program) is tried again; refused for good, it is said as that', async () => {
  const dir = temp();
  const served = await registry(tarOf([{ name: 'package/bin/opencode.exe', data: 'MZ yeni' }]));
  const rename = fs.renameSync;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let refusals = 2;
  let tried = 0;
  // As Windows refuses it while a scanner holds a file in the folder; only there is it tried again (fileWrite.ts).
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) !== path.join(dir, 'opencode')) return rename(from, to);
    tried += 1;
    if (tried <= refusals) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM' });
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    const program = await installPackage('opencode', { dir, registry: served.url, arch: 'x64' });
    assert.equal(tried, 3, 'refused twice, in place at the third');
    assert.equal(fs.readFileSync(program, 'utf8'), 'MZ yeni');
    assert.ok(!fs.existsSync(path.join(dir, 'opencode-indiriliyor')));

    // Held for good: not "close it where it is open" - it is not open anywhere, it was never there.
    fs.rmSync(path.join(dir, 'opencode'), { recursive: true, force: true });
    refusals = Infinity;
    tried = 0;
    await assert.rejects(installPackage('opencode', { dir, registry: served.url, arch: 'x64' }), (err: unknown) => {
      assert.ok(err instanceof PackageRefusal);
      assert.match(err.message, /another program \(an antivirus, perhaps\) is holding its new files\. Try again in a moment\.$/);
      assert.doesNotMatch(err.message, /EPERM|rename/);
      return true;
    });
    assert.ok(tried > 3, 'after trying for a moment');
    assert.ok(!fs.existsSync(path.join(dir, 'opencode-indiriliyor')), 'nothing half-done left');
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = rename;
    if (platform) Object.defineProperty(process, 'platform', platform);
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each tool’s package is its maker’s own for Windows; a script is run by Electron’s own node; only OpenCode has an older build', () => {
  assert.equal(PACKAGES.opencode?.meta('x64'), 'opencode-windows-x64/latest');
  assert.equal(PACKAGES.opencode?.meta('arm64'), 'opencode-windows-arm64/latest');
  assert.equal(PACKAGES.opencode?.older?.('x64'), 'opencode-windows-x64-baseline/latest');
  assert.equal(PACKAGES.codex?.meta('x64'), '@openai%2Fcodex/win32-x64');
  assert.equal(PACKAGES.codex?.program('arm64'), 'vendor/aarch64-pc-windows-msvc/bin/codex.exe');
  assert.equal(PACKAGES.gemini?.meta('x64'), '@google%2Fgemini-cli/latest');
  assert.equal(PACKAGES.qwen?.program('x64'), 'cli-entry.js');
  assert.equal(PACKAGES.claude, undefined, 'Claude Code keeps Anthropic’s installer');
  assert.ok(toolsDir({ LOCALAPPDATA: 'C:\\Users\\Kişi\\AppData\\Local' }).endsWith(path.join('Cortex', 'tools')));

  const dir = temp();
  try {
    fs.mkdirSync(path.join(dir, 'qwen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'qwen', 'cli-entry.js'), '');
    fs.writeFileSync(path.join(dir, 'qwen', 'cortex-tool.json'), JSON.stringify({ program: 'cli-entry.js' }));
    assert.deepEqual(ownProgram('qwen', dir), { command: process.execPath, args: [path.join(dir, 'qwen', 'cli-entry.js')], env: { ELECTRON_RUN_AS_NODE: '1' } });
    fs.writeFileSync(path.join(dir, 'qwen', 'cortex-tool.json'), JSON.stringify({ program: '../../başka.js' }));
    assert.equal(ownProgram('qwen', dir), null, 'a record pointing outside is no program');
    assert.equal(ownProgram('codex', dir), null, 'none installed');
    assert.equal(ownProgram('claude', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool on the PATH is the person’s and comes first; without one, the one Cortex installed is found; OpenCode is only ever Cortex’s', () => {
  const local = temp();
  try {
    const ownOf = (id: 'codex' | 'opencode') => {
      const own = path.join(toolsDir({ LOCALAPPDATA: local }), id);
      fs.mkdirSync(path.join(own, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(own, 'bin', `${id}.exe`), '');
      fs.writeFileSync(path.join(own, 'cortex-tool.json'), JSON.stringify({ program: `bin/${id}.exe` }));
      return path.join(own, 'bin', `${id}.exe`);
    };
    const onPath = path.join(local, 'yol');
    fs.mkdirSync(onPath);
    const theirs = (id: string) => {
      const file = path.join(onPath, process.platform === 'win32' ? `${id}.exe` : id);
      fs.writeFileSync(file, '');
      fs.chmodSync(file, 0o755);
      return file;
    };
    const codex = ownOf('codex');
    assert.deepEqual(programOf('codex', { PATH: '', LOCALAPPDATA: local }), { command: codex, args: [] });
    const theirCodex = theirs('codex');
    assert.deepEqual(programOf('codex', { PATH: onPath, LOCALAPPDATA: local }), { command: theirCodex, args: [] });
    // OpenCode: only the one Cortex installed, which the key given in Cortex reaches (2 November: OpenCode 2.0.27 on the
    // PATH went on with its own sign-in's expired key).
    theirs('opencode');
    assert.equal(programOf('opencode', { PATH: onPath, LOCALAPPDATA: local }), null, 'the person’s is not used');
    const opencode = ownOf('opencode');
    assert.deepEqual(programOf('opencode', { PATH: onPath, LOCALAPPDATA: local }), { command: opencode, args: [] });
  } finally {
    fs.rmSync(local, { recursive: true, force: true });
  }
});

// The real packages, from registry.npmjs.org, downloaded, checked and unpacked on Windows: on the CI runner only. Not
// run here: what they are is their makers' code (1 November, on this machine: all four, OpenCode in 3 s, Codex in 10 s).
test('OpenCode and Gemini CLI install from their makers’ packages on Windows, with no Node.js of their own (Windows CI)', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true', timeout: 10 * 60_000 }, async () => {
  const dir = temp();
  try {
    for (const id of ['opencode', 'gemini'] as const) {
      const program = await installPackage(id, { dir });
      // OpenCode's program is the whole tool; Gemini CLI's is a small entry beside the chunks it loads.
      assert.ok(id === 'opencode' ? fs.statSync(program).size > 100_000_000 : fs.readdirSync(path.dirname(program)).some((one) => one.startsWith('chunk-')), `${id}: ${program}`);
      const own = ownProgram(id, dir);
      assert.ok(own && (own.command === program || own.args[0] === program), id);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

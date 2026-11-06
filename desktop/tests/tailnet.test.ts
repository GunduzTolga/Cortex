import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { PAIRING_PREFIX } from '../shared/pairing';
import { forgetHermes, hermesStatus, testHermes } from '../electron/services/hermesChat';
import { deviceName, forgetTailnet, pairTailnet, setTailnetForTests, startTailnet, stopTailnet, tailnetRoute, tailnetStatus } from '../electron/services/tailnet';
import { TAILNET_HELPER, UNPUBLISHED, downloadPinned, tailnetPin } from '../electron/services/toolPackages';

/**
 * "Kodla bağlan" (electron/services/tailnet.ts) with a stand-in helper (tests/fixtures/fake-tailnet.mjs: the same
 * stdin/env/stdout contract as tools/cortex-tailnet, with a proxy to a stand-in agent and no tailnet behind it), and
 * the pinned download of the real one (toolPackages.ts, downloadPinned) against a local server.
 *
 * The keys here are made up; what is held is where they go: the auth key on the helper's stdin and nowhere else, the
 * agent's key encrypted and in the Authorization header alone, the code nowhere at all.
 */

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const AUTHKEY = 'tskey-auth-kCANARY1CNTRL-auth0123456789abcdefghij';
const HERMES_KEY = 'hermes-canary-key-9f8e7d6c5b4a3210';
const HELPER = path.resolve('tests/fixtures/fake-tailnet.mjs');

const codeOf = (patch: Record<string, unknown> = {}) =>
  PAIRING_PREFIX +
  Buffer.from(JSON.stringify({ v: 1, url: 'https://pyn.tailnet-ornek.ts.net:8642', profile: 'pyn', authkey: AUTHKEY, hermesKey: HERMES_KEY, exp: '2026-11-06T13:00:00Z', ...patch }), 'utf8').toString('base64url');
const CODE = codeOf();
const SECRETS = [AUTHKEY, HERMES_KEY, CODE, CODE.slice(PAIRING_PREFIX.length, PAIRING_PREFIX.length + 32)];

const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tailnet-')));
// A folder name that is not ASCII, as a Windows user's can be: given to the helper in its environment, never its argv.
const stateDir = path.join(work, 'Ayşe’nin Kasası', 'tailnet');
const helperLog = path.join(work, 'helper.log');

/* The agent the proxy reaches: it answers its session list to its key, and notes what came and how. */
interface Seen {
  path: string;
  auth: string | undefined;
  viaProxy: boolean;
  token: string | undefined;
}
const seen: Seen[] = [];
const agent = http.createServer((request, response) => {
  seen.push({ path: request.url ?? '', auth: request.headers.authorization, viaProxy: request.headers['x-fake-tailnet'] === '1', token: request.headers['x-cortex-tailnet'] as string | undefined });
  if (request.headers.authorization !== `Bearer ${HERMES_KEY}`) {
    response.writeHead(401, { 'content-type': 'application/json' });
    return response.end('{"error":{"message":"Invalid API key"}}');
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ object: 'list', data: [{ id: 'telefondan', title: 'Telefondan' }] }));
});
await new Promise<void>((done) => agent.listen(0, '127.0.0.1', done));
const agentBase = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;

let reachesStraight = false;
process.env.FAKE_TAILNET_LOG = helperLog;
process.env.FAKE_TAILNET_UPSTREAM = agentBase;
setTailnetForTests({ dir: () => stateDir, helper: () => HELPER, probe: async () => reachesStraight, readyTimeout: 2000, now: () => NOW });

test.after(async () => {
  stopTailnet();
  agent.close();
  setTailnetForTests(null);
});

interface Launch {
  command: string;
  argv: string[];
  env: Record<string, string>;
  first?: string;
  dirExists?: boolean;
}
const launches = (): Launch[] => (fs.existsSync(helperLog) ? fs.readFileSync(helperLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Launch) : []);

async function until<T>(find: () => T | undefined | false | null, what: string, ms = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() - started > ms) throw new Error(`Waited for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Each test from nothing paired: no helper, no state, no server set, the log empty. */
async function fresh(mode = 'ready'): Promise<void> {
  process.env.FAKE_TAILNET_MODE = mode;
  reachesStraight = false;
  await forgetTailnet();
  forgetHermes();
  fs.rmSync(helperLog, { force: true });
  seen.length = 0;
}

/** Every file under a folder, read as text. */
function filesUnder(dir: string): Array<[string, string]> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [[full, fs.readFileSync(full, 'utf8')]];
  });
}

const leaks = (text: string) => SECRETS.filter((secret) => text.includes(secret));

test('the device is named after the computer, in the letters a host name may have', () => {
  assert.equal(deviceName('AYŞE-PC'), 'cortex-ayse-pc');
  assert.equal(deviceName('Işıl’ın Dizüstü'), 'cortex-isil-in-dizustu');
  assert.equal(deviceName('İZMİR_01'), 'cortex-izmir-01');
  assert.equal(deviceName('---'), 'cortex');
  assert.ok(deviceName('x'.repeat(200)).length <= 57);
});

test('a code pairs: the helper gets its settings in its environment and the key on stdin; the chat goes through its proxy', async () => {
  await fresh();
  const status = await pairTailnet(CODE);
  assert.deepEqual(status, { state: 'bagli', message: null, direct: false });
  const [up] = launches();
  assert.equal(up.command, 'up');
  assert.deepEqual(up.argv, ['up'], 'nothing but the command in argv');
  assert.equal(up.first, AUTHKEY, 'the auth key is the first line of stdin');
  assert.equal(up.env.CORTEX_TAILNET_DIR, stateDir);
  assert.equal(up.dirExists, true, 'the state folder is there before the helper starts');
  assert.equal(up.env.CORTEX_TAILNET_TARGET, 'https://pyn.tailnet-ornek.ts.net:8642');
  assert.match(up.env.CORTEX_TAILNET_HOSTNAME, /^cortex(-[a-z0-9-]+)?$/);
  assert.deepEqual(leaks(JSON.stringify([up.argv, up.env])), [], 'no key or code in argv or the environment');

  // Kept: the address and profile as settings, the agent's key encrypted.
  assert.deepEqual(hermesStatus(), { url: 'https://pyn.tailnet-ornek.ts.net:8642', profile: 'pyn', key: true });
  // The chat asks through the proxy: the agent's key as it was, the proxy's token taken off on the way.
  assert.deepEqual(await testHermes(), { sessions: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { path: '/p/pyn/api/sessions?limit=20', auth: `Bearer ${HERMES_KEY}`, viaProxy: true, token: undefined });
  const route = tailnetRoute('https://pyn.tailnet-ornek.ts.net:8642');
  assert.ok(route && 'port' in route);
  assert.equal(tailnetRoute('https://another.ts.net:8642'), null, 'another address goes as it is');

  // What is on disk holds none of it: the record names the address and the device, the key is sealed.
  const written = [...filesUnder(stateDir), ...filesUnder(app.getPath('userData'))];
  assert.ok(written.some(([file]) => file.endsWith('cortex-eslesme.json')));
  for (const [file, text] of written) assert.deepEqual(leaks(text), [], file);
});

test('a key the tailnet refused is said as a code used already, and nothing is kept', async () => {
  await fresh('error');
  await assert.rejects(pairTailnet(CODE), { message: 'Bu kod daha önce kullanılmış. Yeni kod al.' });
  assert.equal(tailnetStatus().state, 'hata');
  assert.equal(tailnetStatus().message, 'Bu kod daha önce kullanılmış. Yeni kod al.');
  assert.equal(fs.existsSync(stateDir), false, 'the half-made state is deleted');
  assert.deepEqual(hermesStatus(), { url: null, profile: null, key: false }, 'no server kept');
});

test('a helper that says nothing is given up after its time', async () => {
  await fresh('silent');
  await assert.rejects(pairTailnet(CODE), /Bağlantı aracı zamanında yanıt vermedi/);
  assert.equal(tailnetStatus().state, 'hata');
  assert.equal(hermesStatus().url, null);
});

test('a helper gone before a word is said in one sentence', async () => {
  await fresh('exit');
  await assert.rejects(pairTailnet(CODE), /Bağlantı aracı başlamadı/);
  assert.equal(hermesStatus().url, null);
});

test('a code that is not one, or is stale, never starts the helper', async () => {
  await fresh();
  await assert.rejects(pairTailnet('merhaba'), { message: "Bu bir Cortex eşleştirme kodu değil. Telefondaki 'Bilgisayar ekle'den yeni kod al." });
  await assert.rejects(pairTailnet(codeOf({ exp: '2026-11-06T11:59:59Z' })), { message: 'Kodun süresi dolmuş. Yeni kod al.' });
  assert.deepEqual(launches(), []);
});

test('crashed once it is up, the helper is started again once, as the same device, with no key', async () => {
  await fresh('crash-once');
  await pairTailnet(CODE);
  const again = await until(() => launches().length === 2 && launches()[1], 'the restart');
  assert.equal(again.first, '', 'no key the second time: the node is joined already');
  await until(() => tailnetStatus().state === 'bagli' && tailnetRoute('https://pyn.tailnet-ornek.ts.net:8642'), 'the proxy back');
  assert.deepEqual(await testHermes(), { sessions: 1 });
});

test('falling again, it is not started a third time: the status and the chat say so', async () => {
  await fresh('crash-always');
  await pairTailnet(CODE);
  await until(() => tailnetStatus().state === 'hata', 'the second fall');
  assert.equal(launches().length, 2);
  assert.equal(tailnetStatus().message, "Bağlantı aracı durdu. Cortex'i yeniden başlat.");
  await assert.rejects(testHermes(), { message: "Bağlantı aracı durdu. Cortex'i yeniden başlat." });
});

test('at the next start the helper comes back with an empty first line', async () => {
  await fresh();
  await pairTailnet(CODE);
  stopTailnet();
  await until(() => !tailnetRoute('https://pyn.tailnet-ornek.ts.net:8642') || 'trouble' in (tailnetRoute('https://pyn.tailnet-ornek.ts.net:8642') ?? {}), 'the proxy gone');
  assert.deepEqual(await startTailnet(), { state: 'bagli', message: null, direct: false });
  const [, later] = launches();
  assert.equal(later.first, '');
  assert.deepEqual(await testHermes(), { sessions: 1 });
});

test('a computer that reaches the server itself pairs without the helper, and asks it straight', async () => {
  await fresh();
  reachesStraight = true;
  const status = await pairTailnet(codeOf({ url: agentBase }));
  assert.deepEqual(status, { state: 'bagli', message: null, direct: true });
  assert.deepEqual(launches(), [], 'no helper, no second device');
  assert.equal(tailnetRoute(agentBase), null);
  assert.deepEqual(await testHermes(), { sessions: 1 });
  assert.equal(seen[0].viaProxy, false);
  // Forgotten without a logout: there was no node.
  await forgetTailnet();
  assert.deepEqual(launches(), []);
});

test('a new code over an earlier pairing: the earlier device logs out before the new one joins', async () => {
  await fresh();
  await pairTailnet(CODE);
  await pairTailnet(CODE);
  assert.deepEqual(launches().map((one) => [one.command, one.first ?? null]), [['up', AUTHKEY], ['logout', null], ['up', AUTHKEY]]);
  assert.equal(tailnetStatus().state, 'bagli');
});

test('“Bağlantıyı kaldır”: the helper logs out, its state is deleted, the server is forgotten', async () => {
  await fresh();
  await pairTailnet(CODE);
  assert.ok(fs.existsSync(stateDir));
  assert.deepEqual(await forgetTailnet(), { state: 'kapali', message: null, direct: false });
  const out = launches().find((one) => one.command === 'logout');
  assert.ok(out, 'logout was run');
  assert.deepEqual(out.argv, ['logout']);
  assert.equal(out.env.CORTEX_TAILNET_DIR, stateDir);
  assert.equal(fs.existsSync(stateDir), false);
  assert.deepEqual(hermesStatus(), { url: null, profile: null, key: false });
  assert.equal(tailnetRoute('https://pyn.tailnet-ornek.ts.net:8642'), null);
});

test('canary: the code, the auth key and the agent’s key never reach the log', async () => {
  const said: string[] = [];
  const kept = { log: console.log, error: console.error, warn: console.warn, info: console.info, out: process.stdout.write, err: process.stderr.write };
  const note = (...parts: unknown[]) => void said.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  console.log = note;
  console.error = note;
  console.warn = note;
  console.info = note;
  // Still written where they go (the test runner reads this process's stdout); heard on the way.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (said.push(String(chunk)), kept.out.call(process.stdout, chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => (said.push(String(chunk)), kept.err.call(process.stderr, chunk, ...rest))) as typeof process.stderr.write;
  const refusals: string[] = [];
  try {
    for (const mode of ['ready', 'error', 'silent', 'crash-always']) {
      await fresh(mode);
      await pairTailnet(CODE).catch((err: Error) => refusals.push(`${err.message}\n${err.stack}`));
      if (mode === 'crash-always') await until(() => tailnetStatus().state === 'hata', 'the second fall');
      await testHermes().catch((err: Error) => refusals.push(err.message));
    }
    for (const bad of [codeOf({ v: 9 }), codeOf({ exp: '2020-01-01T00:00:00Z' }), `${CODE}x`]) await pairTailnet(bad).catch((err: Error) => refusals.push(`${err.message}\n${err.stack}`));
    await forgetTailnet();
  } finally {
    Object.assign(console, { log: kept.log, error: kept.error, warn: kept.warn, info: kept.info });
    process.stdout.write = kept.out;
    process.stderr.write = kept.err;
  }
  assert.ok(said.some((line) => line.includes('[tailnet]')), 'the helper’s own lines are logged');
  assert.ok(said.some((line) => line.includes('tskey-…')), 'with the key in them taken out');
  assert.deepEqual(leaks(said.join('\n')), []);
  assert.deepEqual(leaks(refusals.join('\n')), []);
  assert.deepEqual(leaks(JSON.stringify(tailnetStatus())), []);
});

/* ------------------------------------------------------------------ */
/* The real helper's download                                          */
/* ------------------------------------------------------------------ */

test('the helper is pinned per platform from its pre-release, each by its SHA-256 and size', () => {
  assert.equal(TAILNET_HELPER.version, '0.1.0');
  assert.equal(TAILNET_HELPER.releases, 'https://github.com/GunduzTolga/Cortex/releases/download/cortex-tailnet-0.1.0/');
  assert.deepEqual(tailnetPin('win32', 'x64')?.file, 'cortex-tailnet-windows-amd64.exe');
  assert.deepEqual(tailnetPin('win32', 'arm64')?.file, 'cortex-tailnet-windows-arm64.exe');
  assert.deepEqual(tailnetPin('darwin', 'arm64')?.file, 'cortex-tailnet-darwin-arm64');
  assert.deepEqual(tailnetPin('linux', 'x64')?.file, 'cortex-tailnet-linux-amd64');
  assert.equal(tailnetPin('linux', 'arm64'), null, 'not built');
  // Published 2026-11-06: every platform is pinned by a real SHA-256 and its size, none is left at UNPUBLISHED.
  for (const pin of Object.values(TAILNET_HELPER.pins)) assert.ok(/^[0-9a-f]{64}$/.test(pin.sha256) && (pin.size ?? 0) > 1_000_000, pin.file);
});

test('a pin that is the placeholder downloads nothing at all', async () => {
  let asked = 0;
  const target = path.join(work, 'tools', 'placeholder', 'cortex-tailnet');
  const got = await downloadPinned('http://127.0.0.1:9/x', { file: 'x', sha256: UNPUBLISHED }, target, {
    fetch: async () => {
      asked += 1;
      throw new Error('asked');
    },
  });
  assert.deepEqual(got, { ok: false, reason: 'unpublished' });
  assert.equal(asked, 0);
  assert.equal(fs.existsSync(target), false);
});

test('when the helper cannot be downloaded, pairing says so in one sentence and never spends the key', async () => {
  await fresh();
  const asked: string[] = [];
  setTailnetForTests({
    dir: () => stateDir, helper: () => null, probe: async () => false, readyTimeout: 2000, now: () => NOW,
    download: async (url) => {
      asked.push(url);
      return { ok: false, reason: 'network' } as Awaited<ReturnType<typeof downloadPinned>>;
    },
  });
  try {
    await assert.rejects(pairTailnet(CODE), { message: 'Bağlantı aracı indirilemedi. İnternet bağlantısını kontrol edip yeniden dene.' });
    // The pinned file of this platform, from the published pre-release.
    assert.deepEqual(asked.length, 1);
    assert.ok(asked[0].startsWith('https://github.com/GunduzTolga/Cortex/releases/download/cortex-tailnet-0.1.0/cortex-tailnet-'), asked[0]);
    assert.deepEqual(launches(), []);
    assert.equal(hermesStatus().url, null);
  } finally {
    setTailnetForTests({ dir: () => stateDir, helper: () => HELPER, probe: async () => reachesStraight, readyTimeout: 2000, now: () => NOW });
  }
});

test('the download is kept only when it is the pinned bytes; anything else leaves nothing behind', async () => {
  const good = Buffer.from('#!/bin/sh\necho cortex-tailnet\n');
  const served = new Map<string, Buffer>([['good', good], ['bad', Buffer.from('#!/bin/sh\necho something else\n')], ['long', Buffer.alloc(4096, 1)]]);
  const server = http.createServer((request, response) => {
    const bytes = served.get((request.url ?? '').slice(1));
    if (!bytes) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { 'content-length': bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const pin = { file: 'cortex-tailnet', sha256: createHash('sha256').update(good).digest('hex'), size: good.length };
  const dir = path.join(work, 'tools', 'cortex-tailnet');
  const target = path.join(dir, 'cortex-tailnet');
  try {
    assert.deepEqual(await downloadPinned(`${base}bad`, pin, target, { fetch }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing of it left');
    assert.deepEqual(await downloadPinned(`${base}long`, pin, target, { fetch }), { ok: false, reason: 'mismatch' });
    assert.deepEqual(await downloadPinned(`${base}missing`, pin, target, { fetch }), { ok: false, reason: 'network' });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(await downloadPinned(`${base}good`, pin, target, { fetch }), { ok: true, file: target });
    assert.deepEqual(fs.readFileSync(target), good);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  } finally {
    server.close();
  }
});

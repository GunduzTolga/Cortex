import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { type TailnetStatus, pairingRefusalText, parsePairing } from '../../shared/pairing';
import { forgetHermes, saveHermes } from './hermesChat';
import { readSettings } from './settings';
import { TAILNET_HELPER, downloadPinned, pinned, sha256Of, tailnetPin } from './toolPackages';

/**
 * "Kodla bağlan": Cortex reaching Pyn on the person's own server with nothing installed
 * (docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md).
 *
 * A pairing code (shared/pairing.ts) carries the agent's address in the person's tailnet, its key and a one-off
 * Tailscale auth key. The small helper (tools/cortex-tailnet), downloaded and pinned by its SHA-256 (toolPackages.ts),
 * joins the tailnet as a device of its own and opens a proxy on 127.0.0.1 to that one address; hermesChat.ts sends its
 * requests there (tailnetRoute) with the proxy's per-launch token, and nothing else of the chat changes.
 *
 * - The helper's settings go in its environment, never its argv; the auth key goes on the first line of its stdin,
 *   which then stays open: the helper lives until Cortex closes it (or goes).
 * - It says one JSON line: `{"ready":true,"port":N,"token":"…"}` or `{"error":"<code>","message":"…"}`.
 * - Its state (the node's key) is in `%LOCALAPPDATA%\Cortex\tailnet` (the app's data folder elsewhere), user-only,
 *   beside a record of what was paired (`cortex-eslesme.json`: the address, the device's name; no secret). At the next
 *   start the helper comes back with an empty first line, as the same device.
 * - A computer that reaches the address itself (Tailscale installed, in the same tailnet) uses no helper at all.
 * - Crashed once it is up, the helper is started again once; a second fall is said in the status and in the chat.
 *
 * The code, the auth key and the agent's key are never written to a log, a file or a sentence here: the code is read
 * and dropped, the agent's key is kept encrypted (keys.ts), and the auth key goes to the helper's stdin alone.
 */

const say = (tr: string, en: string) => (readSettings().language === 'en' ? en : tr);

/** A refusal said to the window in its language, in one sentence. */
export class TailnetRefusal extends Error {}

/** Why the connection is not up, each said in one sentence (`sentence`). */
type Trouble = 'used' | 'unreachable' | 'download' | 'unpublished' | 'platform' | 'blocked' | 'timeout' | 'crashed' | 'failed' | 'connecting' | 'noSafeStorage';

function sentence(trouble: Trouble): string {
  switch (trouble) {
    case 'used':
      return say('Bu kod daha önce kullanılmış. Yeni kod al.', 'This code has been used already. Get a new code.');
    case 'unreachable':
      return say('Sunucuya ulaşılamıyor. Sunucu açık mı? Bu bilgisayar Tailscale panelinden çıkarılmış olabilir.', 'The server cannot be reached. Is it on? This computer may have been removed in the Tailscale admin panel.');
    case 'download':
      return say('Bağlantı aracı indirilemedi. İnternet bağlantısını kontrol edip yeniden dene.', 'The connection tool could not be downloaded. Check the internet connection and try again.');
    case 'unpublished':
      return say('Bağlantı aracı bu Cortex sürümünde henüz yok. Sonraki sürümü bekle.', 'The connection tool is not in this version of Cortex yet. Wait for the next version.');
    case 'platform':
      return say('Bağlantı aracı bu bilgisayarın türü için yok.', 'There is no connection tool for this kind of computer.');
    case 'blocked':
      return say('Bağlantı aracını antivirüs engelledi. Cortex klasörünü izinli listeye ekle.', 'An antivirus blocked the connection tool. Add the Cortex folder to its allowed list.');
    case 'timeout':
      return say('Bağlantı aracı zamanında yanıt vermedi. İnternet bağlantısını kontrol edip yeniden dene.', 'The connection tool did not answer in time. Check the internet connection and try again.');
    case 'crashed':
      return say("Bağlantı aracı durdu. Cortex'i yeniden başlat.", 'The connection tool stopped. Restart Cortex.');
    case 'failed':
      return say("Bağlantı aracı başlamadı. Cortex'i yeniden başlatıp yeniden dene.", 'The connection tool did not start. Restart Cortex and try again.');
    case 'connecting':
      return say('Sunucuya bağlanılıyor. Birkaç saniye sonra yeniden dene.', 'Connecting to the server. Try again in a few seconds.');
    case 'noSafeStorage':
      return say('Bu bilgisayar anahtarı saklayacak güvenli bir yer sunmuyor; kod kullanılmadı.', 'This computer offers no safe place to keep the key; the code was not used.');
  }
}

/* ------------------------------------------------------------------ */
/* Where things are                                                    */
/* ------------------------------------------------------------------ */

/** Cortex's local (not roaming) data: `%LOCALAPPDATA%\Cortex` on Windows, the app's data folder elsewhere. */
function localDir(): string {
  return process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Cortex') : app.getPath('userData');
}

interface Hooks {
  /** The node's state folder. */
  dir: () => string;
  /** The helper's program: a test's stand-in (CORTEX_TAILNET_HELPER), or the pinned one downloaded. */
  helper: () => string | null;
  /** Whether this computer reaches the address itself. */
  probe: (url: string) => Promise<boolean>;
  readyTimeout: number;
  now: () => number;
}

const defaults = (): Hooks => ({
  dir: () => path.join(localDir(), 'tailnet'),
  helper: () => process.env.CORTEX_TAILNET_HELPER || null,
  probe: reachable,
  // The helper gives up joining after 90 seconds (main.go, joinTimeout) and says so: a little longer here.
  readyTimeout: 120_000,
  now: () => Date.now(),
});
let hooks: Hooks = defaults();

/** The tests' stand-ins: a state folder, a helper script, a probe, a shorter wait. Null puts the real ones back. */
export function setTailnetForTests(next: Partial<Hooks> | null): void {
  hooks = next ? { ...defaults(), ...next } : defaults();
}

const RECORD = 'cortex-eslesme.json';

interface Record_ {
  /** The address paired with (hermesAddress's form). */
  target: string;
  hostname: string;
  /** Paired without the helper: this computer reached the address itself. */
  direct: boolean;
}

let record: Record_ | null | undefined;

function readRecord(): Record_ | null {
  if (record !== undefined) return record;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hooks.dir(), RECORD), 'utf8')) as Partial<Record_>;
    record = typeof raw.target === 'string' && typeof raw.hostname === 'string' ? { target: raw.target, hostname: raw.hostname, direct: raw.direct === true } : null;
  } catch {
    record = null;
  }
  return record;
}

function writeRecord(next: Record_): void {
  const dir = hooks.dir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  record = next;
}

function clearState(): void {
  fs.rmSync(hooks.dir(), { recursive: true, force: true });
  record = null;
}

/** The device's name in the tailnet: `cortex-<this computer's name>`, in the letters a host name may have. */
export function deviceName(computer: string = os.hostname()): string {
  const plain = computer
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');
  return plain ? `cortex-${plain}` : 'cortex';
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

let state: TailnetStatus['state'] = 'kapali';
let trouble: Trouble | null = null;
/** Bağlı without the helper. */
let direct = false;
const listeners = new Set<(status: TailnetStatus) => void>();

export function tailnetStatus(): TailnetStatus {
  return { state, message: trouble ? sentence(trouble) : null, direct };
}

export function onTailnet(listener: (status: TailnetStatus) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function setState(next: TailnetStatus['state'], why: Trouble | null = null, straight = false): void {
  state = next;
  trouble = why;
  direct = straight;
  const status = tailnetStatus();
  for (const listener of listeners) listener(status);
}

/* ------------------------------------------------------------------ */
/* The helper                                                          */
/* ------------------------------------------------------------------ */

interface Proxy {
  port: number;
  token: string;
  target: string;
}

let child: ChildProcessWithoutNullStreams | null = null;
let proxy: Proxy | null = null;
/** Restarts after a crash in this run: one is made, the next fall is said. */
let restarts = 0;
let pairing = false;

/** How the helper failed to come up: its own error code, or what the app saw. */
class HelperFailure extends Error {
  constructor(readonly kind: 'error' | 'timeout' | 'exit' | 'spawn', readonly code: string) {
    super(kind);
  }
}

/** The helper's program here, checked against its pin before it is run; null where none is downloaded (or it changed). */
function ownHelper(): string | null {
  const stand = hooks.helper();
  if (stand) return stand;
  const pin = tailnetPin();
  if (!pin || !pinned(pin)) return null;
  const file = path.join(localDir(), 'tools', 'cortex-tailnet', pin.file);
  return sha256Of(file) === pin.sha256 ? file : null;
}

/** The helper, downloaded where it is not here yet; or why there is none. */
async function ensureHelper(): Promise<{ program: string } | { trouble: Trouble }> {
  const own = ownHelper();
  if (own) return { program: own };
  const pin = tailnetPin();
  if (!pin) return { trouble: 'platform' };
  const got = await downloadPinned(TAILNET_HELPER.releases + pin.file, pin, path.join(localDir(), 'tools', 'cortex-tailnet', pin.file));
  if (got.ok) return { program: got.file };
  console.error(`[tailnet] the helper was not downloaded (${got.reason})`);
  return { trouble: got.reason === 'unpublished' ? 'unpublished' : 'download' };
}

/** How a program is started: a script stand-in with this app's own node (ELECTRON_RUN_AS_NODE), a program as it is. */
function commandOf(program: string, command: string): { file: string; args: string[]; env: Record<string, string> } {
  if (/\.[cm]?js$/i.test(program)) return { file: process.execPath, args: [program, command], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { file: program, args: [command], env: {} };
}

function helperEnv(target: string, hostname: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, CORTEX_TAILNET_DIR: hooks.dir(), CORTEX_TAILNET_HOSTNAME: hostname, CORTEX_TAILNET_TARGET: target };
}

/** A line the helper wrote to stderr, for the log: an auth key, were one ever in it, taken out. */
const logLine = (line: string) => line.replace(/tskey-[A-Za-z0-9_-]+/g, 'tskey-…').slice(0, 300);

/**
 * `up` started: the first line of its stdin is `firstLine` (the auth key, or empty once joined), and its stdin stays
 * open. Resolves once it says it is ready, with its proxy; rejects with how it failed, and nothing of it left running.
 */
function launch(program: string, target: string, hostname: string, firstLine: string): Promise<Proxy> {
  return new Promise((resolve, reject) => {
    const { file, args, env } = commandOf(program, 'up');
    let started: ChildProcessWithoutNullStreams;
    try {
      started = spawn(file, args, { env: helperEnv(target, hostname, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(new HelperFailure('spawn', String((err as NodeJS.ErrnoException).code ?? 'spawn')));
    }
    let settled = false;
    let out = '';
    const timer = setTimeout(() => fail(new HelperFailure('timeout', 'timeout')), hooks.readyTimeout);
    const fail = (failure: HelperFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      started.stdin.destroy();
      started.kill();
      reject(failure);
    };
    started.on('error', (err: NodeJS.ErrnoException) => fail(new HelperFailure('spawn', String(err.code ?? 'spawn'))));
    // A helper gone before its stdin is written to: said by its exit, not thrown here.
    started.stdin.on('error', () => undefined);
    started.stderr.setEncoding('utf8');
    let err = '';
    started.stderr.on('data', (chunk: string) => {
      err += chunk;
      let at: number;
      while ((at = err.indexOf('\n')) >= 0) {
        const line = err.slice(0, at).trim();
        err = err.slice(at + 1);
        if (line) console.log(`[tailnet] ${logLine(line)}`);
      }
      if (err.length > 8000) err = '';
    });
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk: string) => {
      if (settled) return;
      out += chunk;
      const at = out.indexOf('\n');
      if (at < 0) {
        if (out.length > 64 * 1024) fail(new HelperFailure('exit', 'output'));
        return;
      }
      let said: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(out.slice(0, at)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) said = parsed as Record<string, unknown>;
      } catch {
        /* said below */
      }
      const { port, token } = said;
      if (said.ready === true && typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 && typeof token === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(token)) {
        settled = true;
        clearTimeout(timer);
        child = started;
        resolve({ port, token, target });
        return;
      }
      const code = typeof said.error === 'string' && /^[a-z_-]{1,40}$/.test(said.error) ? said.error : 'output';
      fail(new HelperFailure('error', code));
    });
    started.on('exit', (code) => {
      if (!settled) return fail(new HelperFailure('exit', String(code ?? 'signal')));
      if (child === started) crashed(started);
    });
    started.stdin.write(`${firstLine}\n`);
  });
}

/** What a failure to come up is told as: with a new key, a refused join is a code used already. */
function troubleOf(failure: unknown, withKey: boolean): Trouble {
  if (!(failure instanceof HelperFailure)) return 'failed';
  if (failure.kind === 'timeout') return 'timeout';
  if (failure.kind === 'spawn') return /^(EPERM|EACCES|ENOENT|UNKNOWN)$/.test(failure.code) ? 'blocked' : 'failed';
  if (failure.kind === 'error' && failure.code === 'baglanamadi') return withKey ? 'used' : 'unreachable';
  return 'failed';
}

/** The helper gone while it was up: started again once, as the same device; the next fall is said. */
function crashed(gone: ChildProcessWithoutNullStreams): void {
  if (child !== gone) return;
  child = null;
  proxy = null;
  const paired = readRecord();
  console.error('[tailnet] the helper stopped');
  if (!paired || paired.direct) return setState('kapali');
  if (restarts >= 1) return setState('hata', 'crashed');
  restarts += 1;
  setState('baglaniyor');
  const program = ownHelper();
  if (!program) return setState('hata', 'crashed');
  void launch(program, paired.target, paired.hostname, '').then(
    (up) => {
      proxy = up;
      setState('bagli');
    },
    (failure) => {
      console.error(`[tailnet] the helper did not come back (${failure instanceof HelperFailure ? failure.code : 'failed'})`);
      setState('hata', troubleOf(failure, false) === 'unreachable' ? 'unreachable' : 'crashed');
    },
  );
}

/** The helper closed: its stdin ended, which ends it; killed if it is still there after a moment. */
function stopHelper(): Promise<void> {
  const running = child;
  child = null;
  proxy = null;
  if (!running || running.exitCode !== null || running.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      running.kill();
      done();
    }, 5000);
    running.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    running.stdin.end();
  });
}

/** `logout` run, the node leaving the tailnet; whatever it comes to, within a time. */
function logout(program: string, paired: Record_): Promise<void> {
  return new Promise((done) => {
    const { file, args, env } = commandOf(program, 'logout');
    let ran: ReturnType<typeof spawn>;
    try {
      ran = spawn(file, args, { env: helperEnv(paired.target, paired.hostname, env), stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return done();
    }
    const timer = setTimeout(() => {
      ran.kill();
      done();
    }, 40_000);
    ran.on('error', () => {
      clearTimeout(timer);
      done();
    });
    ran.on('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Whether this computer reaches an address itself: any HTTP answer from it, within three seconds. No key is sent. */
function reachable(url: string): Promise<boolean> {
  return new Promise((done) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return done(false);
    }
    const request = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', timeout: 3000, agent: false }, (response) => {
      response.resume();
      done(true);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => done(false));
    request.end();
  });
}

/* ------------------------------------------------------------------ */
/* What the window and the chat ask                                    */
/* ------------------------------------------------------------------ */

/** A pasted code: checked, the connection made, the server's settings kept; the code itself dropped. */
export async function pairTailnet(code: unknown): Promise<TailnetStatus> {
  if (pairing) throw new TailnetRefusal(say('Bağlantı zaten kuruluyor; bitmesini bekle.', 'A connection is being made already; wait for it to finish.'));
  const parsed = parsePairing(code, hooks.now());
  if (!parsed.ok) throw new TailnetRefusal(pairingRefusalText(parsed.refusal, readSettings().language === 'en'));
  const { pairing: paired } = parsed;
  // Checked before the auth key is spent: a key the code carries that could not be kept would leave the device joined for nothing.
  if (!safeStorage.isEncryptionAvailable()) throw new TailnetRefusal(sentence('noSafeStorage'));
  pairing = true;
  try {
    await stopHelper();
    // A code pasted over an earlier pairing (one that is failing, say): that device leaves the tailnet first, rather
    // than staying in the person's list of devices with its state deleted here.
    const earlier = readRecord();
    const earlierHelper = earlier && !earlier.direct ? ownHelper() : null;
    if (earlier && earlierHelper) await logout(earlierHelper, earlier);
    const hostname = deviceName();
    if (await hooks.probe(paired.url)) {
      // Tailscale is here already, in the same tailnet: no second device for this computer.
      saveHermes({ url: paired.url, profile: paired.profile, key: paired.hermesKey });
      clearState();
      writeRecord({ target: paired.url, hostname, direct: true });
      restarts = 0;
      setState('bagli', null, true);
      return tailnetStatus();
    }
    const helper = await ensureHelper();
    if ('trouble' in helper) throw new TailnetRefusal(sentence(helper.trouble));
    const { program } = helper;
    // A new key is a new device: what an earlier one left is not carried over.
    clearState();
    fs.mkdirSync(hooks.dir(), { recursive: true, mode: 0o700 });
    setState('baglaniyor');
    let up: Proxy;
    try {
      up = await launch(program, paired.url, hostname, paired.authkey);
    } catch (failure) {
      const why = troubleOf(failure, true);
      console.error(`[tailnet] pairing failed (${failure instanceof HelperFailure ? `${failure.kind}: ${failure.code}` : 'failed'})`);
      clearState();
      setState('hata', why);
      throw new TailnetRefusal(sentence(why));
    }
    proxy = up;
    try {
      saveHermes({ url: paired.url, profile: paired.profile, key: paired.hermesKey });
    } catch (err) {
      await stopHelper();
      clearState();
      setState('kapali');
      throw err;
    }
    writeRecord({ target: paired.url, hostname, direct: false });
    restarts = 0;
    setState('bagli');
    return tailnetStatus();
  } catch (err) {
    if (state === 'baglaniyor') setState('kapali');
    throw err;
  } finally {
    pairing = false;
  }
}

/** At the app's start: a pairing made here comes back, through the helper (no key now) or straight. */
export async function startTailnet(): Promise<TailnetStatus> {
  const paired = readRecord();
  if (!paired || paired.target !== readSettings().hermesUrl) return tailnetStatus();
  if (paired.direct) {
    setState('bagli', null, true);
    return tailnetStatus();
  }
  setState('baglaniyor');
  if (await hooks.probe(paired.target)) {
    setState('bagli', null, true);
    return tailnetStatus();
  }
  const helper = await ensureHelper();
  if ('trouble' in helper) {
    setState('hata', helper.trouble);
    return tailnetStatus();
  }
  try {
    proxy = await launch(helper.program, paired.target, paired.hostname, '');
    setState('bagli');
  } catch (failure) {
    console.error(`[tailnet] the helper did not start (${failure instanceof HelperFailure ? `${failure.kind}: ${failure.code}` : 'failed'})`);
    setState('hata', troubleOf(failure, false));
  }
  return tailnetStatus();
}

/** "Bağlantıyı kaldır": the helper closed and logged out, its state deleted, the server's settings forgotten. */
export async function forgetTailnet(): Promise<TailnetStatus> {
  const paired = readRecord();
  await stopHelper();
  if (paired && !paired.direct) {
    const program = ownHelper();
    if (program) await logout(program, paired);
  }
  clearState();
  forgetHermes();
  restarts = 0;
  setState('kapali');
  return tailnetStatus();
}

/** The app quitting: the helper's stdin closed, which ends it. */
export function stopTailnet(): void {
  void stopHelper();
}

/**
 * Where the chat sends a request for `url`: the helper's proxy when this address was paired through it and it is up;
 * a sentence when it was and is not; null when the address is reached as it is.
 */
export function tailnetRoute(url: string): { port: number; token: string } | { trouble: string } | null {
  const paired = readRecord();
  if (!paired || paired.direct || paired.target !== url || direct) return null;
  if (proxy && proxy.target === url) return { port: proxy.port, token: proxy.token };
  return { trouble: sentence(trouble ?? 'connecting') };
}

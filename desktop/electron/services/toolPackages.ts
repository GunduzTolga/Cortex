import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { CliId } from '../../shared/chat';
import { netFetch } from './netFetch';

/**
 * OpenCode, Codex, Gemini CLI and Qwen Code, installed by Cortex itself: no npm, no Node.js, no console window.
 *
 * 1 November: they were installed with `npm install -g`, and Node.js was set up first where there was none. Nobody
 * signing in to an OpenCode Go subscription expects to install Node.js ("opencode go aboneliğimi kullanmak için neden
 * node js kuruyorum"), and none of the four needs it from Cortex:
 * - OpenCode is one program (`opencode.exe`), in its maker's package for Windows (`opencode-windows-x64`).
 * - Codex is one too (`codex.exe` and its helpers), in `@openai/codex`'s Windows build (the `win32-x64` tag).
 * - Gemini CLI and Qwen Code are scripts with what they need bundled in (no dependencies); Electron has node in it
 *   (24 in Electron 43; they ask for 20 and 22), and Cortex runs them with it (clis.ts, ownProgram).
 *
 * Each is the package its maker publishes to the npm registry, the one `npm install` would have fetched: its address
 * and its SHA-512 read from the registry, the download checked against that SHA-512 before anything is kept, and
 * unpacked into a folder of its own under %LOCALAPPDATA%\Cortex\tools. Nothing in it is run until it is all there
 * and checked.
 */

export type Arch = 'x64' | 'arm64';

interface Spec {
  /** The package's manifest in the registry: name/tag. */
  meta: (arch: Arch) => string;
  /** The program in the package. */
  program: (arch: Arch) => string;
  /**
   * The same program built for older processors, for one whose program does not start. OpenCode's is built for
   * processors with AVX2; a Celeron or a laptop from before 2013 has none, and its maker publishes a "baseline" build
   * for them, as its npm installer picks.
   */
  older?: (arch: Arch) => string | null;
}

export const PACKAGES: Partial<Record<CliId, Spec>> = {
  opencode: {
    meta: (arch) => `opencode-windows-${arch}/latest`,
    program: () => 'bin/opencode.exe',
    older: (arch) => (arch === 'x64' ? 'opencode-windows-x64-baseline/latest' : null),
  },
  codex: { meta: (arch) => `@openai%2Fcodex/win32-${arch}`, program: (arch) => `vendor/${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc/bin/codex.exe` },
  gemini: { meta: () => '@google%2Fgemini-cli/latest', program: () => 'bundle/gemini.js' },
  qwen: { meta: () => '@qwen-code%2Fqwen-code/latest', program: () => 'cli-entry.js' },
};

export const REGISTRY = 'https://registry.npmjs.org/';
/** What each tool's folder says it holds: the program, and from which package. */
const RECORD = 'cortex-tool.json';
/** A download this slow is given up: 30 minutes is under 100 kB/s for Codex's 173 MB. */
const DOWNLOAD_LIMIT = 30 * 60_000;

/** Where the tools Cortex installs are kept: one folder each. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Cortex', 'tools');
}

export const archOf = (arch: string = process.arch): Arch => (arch === 'arm64' ? 'arm64' : 'x64');

export interface OwnProgram {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * A tool Cortex installed, as it is started: its program, or for a script, Electron's own node with it
 * (ELECTRON_RUN_AS_NODE); null where Cortex installed none.
 */
export function ownProgram(id: CliId, dir: string = toolsDir()): OwnProgram | null {
  if (!PACKAGES[id]) return null;
  const folder = path.join(dir, id);
  let program: unknown;
  try {
    program = (JSON.parse(fs.readFileSync(path.join(folder, RECORD), 'utf8')) as { program?: unknown }).program;
  } catch {
    return null;
  }
  if (typeof program !== 'string' || !safeRelative(program)) return null;
  const file = path.join(folder, ...program.split('/'));
  if (!fs.existsSync(file)) return null;
  if (/\.exe$/i.test(file)) return { command: file, args: [] };
  return { command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** A path inside the package: relative, without `..`, a drive or a stream name. */
function safeRelative(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes(':')) return false;
  return name.split(/[\\/]+/).every((part) => part !== '..');
}

export class PackageRefusal extends Error {}

interface Manifest {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
}

async function manifestOf(url: string): Promise<Manifest> {
  let answer: Response;
  try {
    answer = await netFetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new PackageRefusal('The download did not start: check the internet connection and try again.');
  }
  if (!answer.ok) throw new PackageRefusal(`The package was not found (${answer.status}). Try again later.`);
  const meta = (await answer.json()) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
  const { name, version } = meta;
  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof tarball !== 'string' || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new PackageRefusal('The package was not found. Try again later.');
  }
  return { name, version, tarball, integrity };
}

/**
 * A tool's package downloaded, checked and unpacked: into a folder beside where it goes, put in its place only once all
 * of it is there and its SHA-512 is the registry's. Returns the program. The registry and the folder are the tests'.
 */
export async function installPackage(id: CliId, options: { dir?: string; registry?: string; arch?: Arch; older?: boolean } = {}): Promise<string> {
  const spec = PACKAGES[id];
  if (!spec) throw new PackageRefusal('Cortex does not install this tool.');
  const arch = options.arch ?? archOf();
  const name = options.older ? spec.older?.(arch) : spec.meta(arch);
  if (!name) throw new PackageRefusal('Cortex does not install this tool.');
  const dir = options.dir ?? toolsDir();
  const manifest = await manifestOf(`${options.registry ?? REGISTRY}${name}`);
  const program = spec.program(arch);
  const target = path.join(dir, id);
  const part = path.join(dir, `${id}-indiriliyor`);
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true });
  try {
    let answer: Response;
    try {
      answer = await netFetch(manifest.tarball, { signal: AbortSignal.timeout(DOWNLOAD_LIMIT) });
    } catch {
      throw new PackageRefusal('The download did not start: check the internet connection and try again.');
    }
    if (!answer.ok || !answer.body) throw new PackageRefusal(`The package was not found (${answer.status}). Try again later.`);
    const hash = createHash('sha512');
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]), tap, createGunzip(), untar(part));
    } catch (err) {
      if (err instanceof PackageRefusal) throw err;
      throw new PackageRefusal('The download did not finish: check the internet connection and try again.');
    }
    if (`sha512-${hash.digest('base64')}` !== manifest.integrity) {
      throw new PackageRefusal('The download was not the package its maker published (its SHA-512 differs). Nothing was installed; try again.');
    }
    if (!fs.existsSync(path.join(part, ...program.split('/')))) throw new PackageRefusal('The package has no program in it. Nothing was installed.');
    fs.writeFileSync(path.join(part, RECORD), `${JSON.stringify({ name: manifest.name, version: manifest.version, program }, null, 2)}\n`);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(part, target);
    } catch {
      throw new PackageRefusal('The tool could not be put in place: close it where it is open, then try again.');
    }
  } catch (err) {
    fs.rmSync(part, { recursive: true, force: true });
    throw err;
  }
  return path.join(target, ...program.split('/'));
}

/** Whether a program starts and says its version: one built for a newer processor ends at once. */
export function starts(program: OwnProgram, timeout = 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(program.command, [...program.args, '--version'], { env: { ...process.env, ...program.env }, timeout, windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * What a gzip-ed npm package becomes: its files written under `dest`, without the package's own top folder (npm's
 * `package/`). Plain tar, as npm writes it: ustar headers, POSIX (pax) records for long names, and GNU's too; a link or
 * a device in it is passed over, and a name reaching out of `dest` refuses the whole package.
 */
export function untar(dest: string): Writable {
  let pending = Buffer.alloc(0);
  let state: 'header' | 'data' | 'meta' | 'pad' | 'end' = 'header';
  let left = 0;
  let pad = 0;
  let fd: number | null = null;
  let meta: Buffer[] = [];
  let metaKind: 'pax' | 'long' | 'skip' = 'skip';
  let nextName: string | null = null;
  const text = (block: Buffer, at: number, length: number) => {
    const raw = block.subarray(at, at + length);
    const stop = raw.indexOf(0);
    return raw.subarray(0, stop < 0 ? raw.length : stop).toString('utf8');
  };
  const close = () => {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
  };
  const header = (block: Buffer) => {
    if (block.every((byte) => byte === 0)) {
      state = 'end';
      return;
    }
    if (block[124] & 0x80) throw new PackageRefusal('The package is not one Cortex can open.');
    const size = parseInt(text(block, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new PackageRefusal('The package is not one Cortex can open.');
    const type = String.fromCharCode(block[156] || 48);
    left = size;
    pad = (512 - (size % 512)) % 512;
    if (type === 'x' || type === 'L' || type === 'g') {
      metaKind = type === 'x' ? 'pax' : type === 'L' ? 'long' : 'skip';
      meta = [];
      state = 'meta';
      return;
    }
    const ustar = text(block, 257, 6) === 'ustar';
    const prefix = ustar ? text(block, 345, 155) : '';
    const full = nextName ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    nextName = null;
    // npm takes off the package's top folder, whatever it is called (`package/` in all four).
    const name = full.replace(/^\.?\/+/, '').split('/').slice(1).join('/');
    if (name && !safeRelative(name)) throw new PackageRefusal('The package names a file outside its folder. Nothing was installed.');
    const file = name ? path.join(dest, ...name.split('/').filter(Boolean)) : dest;
    if (type === '5') {
      fs.mkdirSync(file, { recursive: true });
    } else if ((type === '0' || type === '7') && name) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, 'w');
    }
    state = left > 0 ? 'data' : pad > 0 ? 'pad' : 'header';
    if (state === 'header') close();
  };
  const metaDone = () => {
    const body = Buffer.concat(meta).toString('utf8');
    if (metaKind === 'long') nextName = body.replace(/\0+$/, '');
    if (metaKind === 'pax') {
      // Records of "length key=value\n"; a path in them is the next file's name.
      for (const record of body.split('\n')) {
        const at = record.indexOf(' path=');
        if (at > 0) nextName = record.slice(at + ' path='.length);
      }
    }
    meta = [];
  };
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let at = 0;
        while (at < pending.length && state !== 'end') {
          if (state === 'header') {
            if (pending.length - at < 512) break;
            header(pending.subarray(at, at + 512));
            at += 512;
          } else if (state === 'data' || state === 'meta') {
            const take = Math.min(left, pending.length - at);
            const piece = pending.subarray(at, at + take);
            if (state === 'meta') meta.push(Buffer.from(piece));
            else if (fd !== null) fs.writeSync(fd, piece);
            at += take;
            left -= take;
            if (left === 0) {
              if (state === 'meta') metaDone();
              else close();
              state = pad > 0 ? 'pad' : 'header';
            }
          } else {
            const take = Math.min(pad, pending.length - at);
            at += take;
            pad -= take;
            if (pad === 0) state = 'header';
          }
        }
        pending = state === 'end' ? Buffer.alloc(0) : pending.subarray(at);
        done();
      } catch (err) {
        close();
        done(err as Error);
      }
    },
    final(done) {
      close();
      done(state === 'end' || (state === 'header' && pending.length === 0) ? null : new PackageRefusal('The download did not finish: check the internet connection and try again.'));
    },
    destroy(err, done) {
      close();
      done(err);
    },
  });
}

/* ------------------------------------------------------------------ */
/* cortex-tailnet: one pinned program from Cortex's own pre-release    */
/* ------------------------------------------------------------------ */

/**
 * The small tailnet node "Kodla bağlan" needs (tools/cortex-tailnet, tailnet.ts), downloaded on the first pairing and
 * never put in the installer. Built and published by .github/workflows/tailnet-helper.yml as the pre-release
 * `cortex-tailnet-<version>`, never replaced once published; each platform's file is pinned here by its SHA-256, as
 * MinGit is (gitTool.ts), and bytes that are not those are deleted before they are ever run.
 *
 * NOT PUBLISHED YET (2026-11-06): the pre-release has not been made, so its SHA-256 values are not known. Each is the
 * placeholder UNPUBLISHED, which is no SHA-256 at all, and `downloadPinned` refuses to fetch anything while a pin holds
 * it. Taking up the release means writing the 64 hex digits from its `.sha256` files here (and its size, read from the
 * release), in the same change that may bump `version`.
 */
export const UNPUBLISHED = 'YAYIMLANMADI-sha256-bilinmiyor';

export interface Pin {
  file: string;
  sha256: string;
  /** The file's size in bytes, where known: a longer download is stopped before the disk fills with it. */
  size?: number;
}

const TAILNET_TAG = 'cortex-tailnet-0.1.0';
export const TAILNET_HELPER = {
  version: '0.1.0',
  releases: `https://github.com/GunduzTolga/Cortex/releases/download/${TAILNET_TAG}/`,
  /** By `<GOOS>-<GOARCH>`, as the workflow names them: cortex-tailnet-<os>-<arch>[.exe]. */
  pins: {
    'windows-amd64': { file: 'cortex-tailnet-windows-amd64.exe', sha256: UNPUBLISHED },
    'windows-arm64': { file: 'cortex-tailnet-windows-arm64.exe', sha256: UNPUBLISHED },
    'darwin-amd64': { file: 'cortex-tailnet-darwin-amd64', sha256: UNPUBLISHED },
    'darwin-arm64': { file: 'cortex-tailnet-darwin-arm64', sha256: UNPUBLISHED },
    'linux-amd64': { file: 'cortex-tailnet-linux-amd64', sha256: UNPUBLISHED },
  } as Record<string, Pin>,
};

/** The helper's pin for this computer (Node's platform and arch named as Go names them); null where none is built. */
export function tailnetPin(platform: string = process.platform, arch: string = process.arch): Pin | null {
  const os = platform === 'win32' ? 'windows' : platform;
  const goArch = arch === 'x64' ? 'amd64' : arch;
  return TAILNET_HELPER.pins[`${os}-${goArch}`] ?? null;
}

/** Whether a pin is a real SHA-256 (64 hex digits); UNPUBLISHED is not. */
export const pinned = (pin: Pin): boolean => /^[0-9a-f]{64}$/.test(pin.sha256);

/** The SHA-256 of a file on disk, in hex; null where it cannot be read. */
export function sha256Of(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Larger than any helper build (about 21 MB, tools/cortex-tailnet/README.md): not the file, and stopped. */
const PINNED_MAX = 64 * 1024 * 1024;

export type PinnedDownload = { ok: true; file: string } | { ok: false; reason: 'unpublished' | 'network' | 'mismatch' | 'place' };

/**
 * One pinned file downloaded to `target`: written beside it, kept only when all of it came and its SHA-256 is the pin's,
 * then renamed into place (executable on macOS and Linux). Anything else leaves nothing behind. Says why rather than
 * throwing, so the caller words it in the window's language. Nothing is fetched while the pin is UNPUBLISHED.
 */
export async function downloadPinned(url: string, pin: Pin, target: string, options: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; limit?: number } = {}): Promise<PinnedDownload> {
  if (!pinned(pin)) return { ok: false, reason: 'unpublished' };
  const part = `${target}.indiriliyor`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(part, { force: true });
  const fail = (reason: 'network' | 'mismatch' | 'place'): PinnedDownload => {
    fs.rmSync(part, { force: true });
    return { ok: false, reason };
  };
  let answer: Response;
  try {
    answer = await (options.fetch ?? netFetch)(url, { signal: AbortSignal.timeout(options.limit ?? 15 * 60_000) });
  } catch {
    return fail('network');
  }
  if (!answer.ok || !answer.body) return fail('network');
  const hash = createHash('sha256');
  let size = 0;
  const most = pin.size ?? PINNED_MAX;
  let tooLong = false;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > most) {
        tooLong = true;
        return done(new Error('longer than the pinned file'));
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]), tap, fs.createWriteStream(part, { mode: 0o700 }));
  } catch {
    return fail(tooLong ? 'mismatch' : 'network');
  }
  if ((pin.size !== undefined && size !== pin.size) || hash.digest('hex') !== pin.sha256) return fail('mismatch');
  try {
    fs.rmSync(target, { force: true });
    fs.renameSync(part, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
  } catch {
    return fail('place');
  }
  return { ok: true, file: target };
}

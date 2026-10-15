import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { SetupJob, SetupPush, SetupStatus, VoiceEngine, VoiceStatus } from '../../shared/setup';
import { childEnv } from './acp';
import { pythonOf } from './localChat';
import { readSettings } from './settings';

/**
 * Cortex set up from the app, so that nobody types an install command
 * (shared/setup.ts). Every job is the vault's own engine doing what its
 * command line does - the app only starts it, without a shell, and passes on
 * what it says:
 *
 * - the engine: the package that came with the app (`cortex/beyin-v3-X.Y.Z.zip`
 *   among its resources) installed into the vault by its own installer, or
 *   the vault's engine updated from it (`beyin.py update --package`);
 * - voice typing: yakala set up if it is not (`beyin.py yakala kur`), then
 *   `beyin.py ses kur`, whose steps come one JSON line each (`{"adim": …}`).
 *
 * One job at a time. A job is not stopped when the window closes: an engine
 * update or a 2 GB download cut short is worse than one let finish.
 */

const VERSION_FILE = '.beyin-version';
const PACKAGE = /^beyin-v3-(\d+)\.(\d+)\.(\d+)\.zip$/;
const STATUS_TIMEOUT = 60_000;
const JOB_TIMEOUT = 3 * 60 * 60_000;

let current: SetupJob | null = null;
let push: (message: SetupPush) => void = () => undefined;

export function onSetupPush(listener: (message: SetupPush) => void): void {
  push = listener;
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (X.Y.Z). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest engine package in the first of these folders that has one, by the version in its name. */
export function bundledPackage(dirs: string[]): { file: string; version: string } | null {
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const found: Array<{ file: string; version: string }> = [];
    for (const name of names) {
      const match = name.match(PACKAGE);
      if (match) found.push({ file: path.join(dir, name), version: `${match[1]}.${match[2]}.${match[3]}` });
    }
    found.sort((a, b) => compareVersions(b.version, a.version));
    if (found.length) return found[0];
  }
  return null;
}

/** Where the package may be: beside the packaged app, or, while developing, where the desktop build puts it. */
function packageDirs(): string[] {
  const dirs = [path.join(process.resourcesPath ?? '', 'cortex'), path.join(app.getAppPath(), 'cortex-paket')];
  return process.env.CORTEX_ENGINE_PACKAGES ? [process.env.CORTEX_ENGINE_PACKAGES, ...dirs] : dirs;
}

/** The version the vault's engine says it is, from the stamp its installer writes; null without an engine. */
export function installedVersion(vault: string): string | null {
  if (!fs.existsSync(path.join(vault, 'beyin.py'))) return null;
  try {
    const text = fs.readFileSync(path.join(vault, VERSION_FILE), 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** One line of what a job says: a step (`{"adim": …}`) or its result (any other JSON object); null for anything else. */
export function readLine(line: string): { step: string } | { result: Record<string, unknown> } | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.adim === 'string') return { step: record.adim };
    return { result: record };
  } catch {
    return null;
  }
}

/** `beyin.py ses durum` (or the status `ses ayar` returns) as the window holds it. */
export function voiceOf(result: Record<string, unknown>): VoiceStatus | null {
  if (typeof result.kurulu !== 'boolean') return null;
  const engine: VoiceEngine = result.motor === 'cuda' || result.motor === 'vulkan' ? result.motor : 'islemci';
  return {
    installed: result.kurulu,
    on: result.acik !== false,
    wake: result.uyandirma === true,
    engine,
    // The model's name only: where it runs is said by `engine`, not twice (`large-v3-turbo (ekran kartı, Vulkan)`).
    model: typeof result.model === 'string' ? result.model.replace(/\s*\([^)]*\)\s*$/, '') : null,
  };
}

/** A result written over several lines (`json.dumps(..., indent=2)`): the last block that starts a line with `{`. */
export function trailingObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const value = JSON.parse(lines.slice(i).join('\n')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The last line of what a process wrote to stderr: the sentence a failure ends with. */
function lastWords(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 400);
}

/**
 * Python with these arguments, in the vault, without a shell: each step it
 * says handed to `onStep`, its result (the last JSON object it wrote that is
 * not a step) returned. A failure rejects with the last thing it said.
 */
export function runPython(
  args: string[],
  options: { cwd: string; timeout: number; onStep?: (step: string) => void; python?: { command: string; args: string[] } | null },
): Promise<Record<string, unknown>> {
  const python = options.python === undefined ? pythonOf() : options.python;
  if (!python) return Promise.reject(new Error('Python bulunamadı.'));
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.args, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }),
    });
    let buffer = '';
    let written = '';
    let errors = '';
    let result: Record<string, unknown> | null = null;
    const timer = setTimeout(() => child.kill(), options.timeout);
    const take = (line: string) => {
      const read = readLine(line);
      if (!read) return;
      if ('step' in read) options.onStep?.(read.step);
      else result = read.result;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      written = (written + chunk).slice(-64000);
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        take(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) take(buffer);
      result ??= trailingObject(written);
      if (code === 0 && result) resolve(result);
      else reject(new Error(lastWords(errors) || (code === 0 ? 'Beklenen cevap gelmedi.' : `Çıkış kodu ${code}.`)));
    });
  });
}

function vaultOrNull(): string | null {
  const vault = readSettings().vault;
  return vault && fs.existsSync(vault) ? vault : null;
}

export async function setupStatus(): Promise<SetupStatus> {
  const vault = vaultOrNull();
  const python = pythonOf();
  const installed = vault ? installedVersion(vault) : null;
  const voiceSupported = process.platform === 'win32';
  let voice: VoiceStatus | null = null;
  if (vault && python && installed && voiceSupported && current !== 'voice') {
    try {
      voice = voiceOf(await runPython([path.join(vault, 'beyin.py'), 'ses', 'durum'], { cwd: vault, timeout: STATUS_TIMEOUT, python }));
    } catch {
      voice = null; // an engine from before voice typing: it does not know the command
    }
  }
  return {
    python: python !== null,
    vault: vault !== null,
    engine: { installed, bundled: bundledPackage(packageDirs())?.version ?? null },
    voice,
    voiceSupported,
    job: current,
  };
}

/** A job, the only one going on: its steps and its end pushed to the window, the status after it returned. */
async function job(kind: SetupJob, work: (vault: string, step: (text: string) => void) => Promise<void>): Promise<SetupStatus> {
  if (current) throw new Error('Başka bir kurulum sürüyor.');
  const vault = vaultOrNull();
  if (!vault) throw new Error('Önce bir kasa seç.');
  if (!pythonOf()) throw new Error('Python bulunamadı.');
  current = kind;
  try {
    await work(vault, (text) => push({ job: kind, step: text }));
    current = null;
    push({ job: kind, done: true, ok: true });
  } catch (err) {
    current = null;
    const error = err instanceof Error ? err.message : String(err);
    push({ job: kind, done: true, ok: false, error });
    throw err instanceof Error ? err : new Error(error);
  }
  return setupStatus();
}

/** The package taken apart into a folder, nothing written outside it; one JSON line says it is done. */
const UNPACK = [
  'import json, sys, zipfile, pathlib',
  'dest = pathlib.Path(sys.argv[2]).resolve()',
  'with zipfile.ZipFile(sys.argv[1]) as z:',
  '    for n in z.namelist():',
  '        if dest not in (dest / n).resolve().parents: raise SystemExit("bad path: " + n)',
  '    z.extractall(dest)',
  'print(json.dumps({"status": "acildi"}))',
].join('\n');

/** The engine that came with the app into the vault: its installer for a vault without one, its updater otherwise. */
export function installEngine(): Promise<SetupStatus> {
  return job('engine', async (vault, step) => {
    const bundled = bundledPackage(packageDirs());
    if (!bundled) throw new Error('Uygulamayla gelen Cortex paketi bulunamadı.');
    const installed = installedVersion(vault);
    if (installed) {
      if (compareVersions(installed, bundled.version) >= 0) return;
      step(`Cortex ${installed} → ${bundled.version} güncelleniyor…`);
      await runPython([path.join(vault, 'beyin.py'), 'update', '--package', bundled.file], { cwd: vault, timeout: JOB_TIMEOUT });
      return;
    }
    // No engine yet: the package's own installer, from a copy of it taken apart in a folder of its own.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-kurulum-'));
    try {
      step(`Cortex ${bundled.version} kasaya kuruluyor…`);
      await runPython(['-I', '-c', UNPACK, bundled.file, folder], { cwd: folder, timeout: STATUS_TIMEOUT });
      await runPython(['-I', path.join(folder, 'scripts', 'install_v3.py'), '--vault', vault], { cwd: vault, timeout: JOB_TIMEOUT });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    if (!installedVersion(vault)) throw new Error('Kurulum bitti ama kasada Cortex görünmüyor.');
  });
}

/** Yakala, if it is not set up yet, then voice typing; each step as the engine says it. */
export function installVoice(): Promise<SetupStatus> {
  return job('voice', async (vault, step) => {
    if (process.platform !== 'win32') throw new Error('Sesle yazma yalnız Windows\'ta.');
    const beyin = path.join(vault, 'beyin.py');
    const capture = await runPython([beyin, 'yakala', 'durum'], { cwd: vault, timeout: STATUS_TIMEOUT });
    if (capture.kurulu !== true) {
      step('Yakala kuruluyor (Ctrl+Alt+B)…');
      await runPython([beyin, 'yakala', 'kur'], { cwd: vault, timeout: STATUS_TIMEOUT * 5 });
    }
    await runPython([beyin, 'ses', 'kur'], { cwd: vault, timeout: JOB_TIMEOUT, onStep: step });
  });
}

/** Voice typing on or off, the wake phrase on or off. */
export async function setVoice(patch: unknown): Promise<SetupStatus> {
  const asked = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const args: string[] = [];
  if (typeof asked.on === 'boolean') args.push('--ses', asked.on ? 'ac' : 'kapat');
  if (typeof asked.wake === 'boolean') args.push('--uyandirma', asked.wake ? 'ac' : 'kapat');
  const vault = vaultOrNull();
  if (!args.length || !vault) return setupStatus();
  if (current) throw new Error('Başka bir kurulum sürüyor.');
  await runPython([path.join(vault, 'beyin.py'), 'ses', 'ayar', ...args], { cwd: vault, timeout: STATUS_TIMEOUT });
  return setupStatus();
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { COMMAND_WORDS, VOICE_COMMANDS } from '../../shared/setup';
import type { SetupJob, SetupPush, SetupStatus, VoiceCommands, VoiceEngine, VoiceStatus } from '../../shared/setup';
import pythonPin from '../../python.json';
import { childEnv } from './acp';
import { pythonOf } from './localChat';
import { readSettings } from './settings';

/**
 * Cortex set up from the app, so that nobody types an install command
 * (shared/setup.ts). Every job is the vault's own engine doing what its
 * command line does - the app only starts it, without a shell, and passes on
 * what it says:
 *
 * - Python, where the machine has none (Windows): python.org's signed
 *   installer that came with the app (desktop/python.json), checked by its
 *   SHA-256 and run quietly for this user only;
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

/** The voice status last read, and who is told of a new one (the notification-area icon, electron/services/tray.ts). */
let lastVoice: string | undefined;
const voiceListeners = new Set<(voice: VoiceStatus | null) => void>();

export function onVoiceStatus(listener: (voice: VoiceStatus | null) => void): () => void {
  voiceListeners.add(listener);
  return () => voiceListeners.delete(listener);
}

function heardVoice(voice: VoiceStatus | null): void {
  const said = JSON.stringify(voice);
  if (said === lastVoice) return;
  lastVoice = said;
  for (const listener of voiceListeners) listener(voice);
}

/** A sentence in the window's language: the setup speaks as the window does, never both at once. */
function say(tr: string, en: string): string {
  return readSettings().language === 'en' ? en : tr;
}

/**
 * What the vault's engine says while it installs voice typing is Turkish (beyin.py speaks
 * Turkish); in an English window its steps are said in English, the numbers kept.
 */
const ENGINE_STEPS: Array<[RegExp, string]> = [
  [/^Python: (.+)$/, 'Python: $1'],
  [/^Motor: NVIDIA ekran kartı \(CUDA\)$/, 'Engine: NVIDIA graphics card (CUDA)'],
  [/^Motor: AMD\/Intel ekran kartı \(Vulkan, whisper\.cpp\)$/, 'Engine: AMD / Intel graphics card (Vulkan, whisper.cpp)'],
  [/^Motor: işlemci$/, 'Engine: the processor'],
  [/^Vulkan derlemesi bu sürümde henüz yayımlanmadı\.$/, 'The Vulkan build is not published for this version yet.'],
  [/^whisper\.cpp \(Vulkan\) indiriliyor…$/, 'Downloading whisper.cpp (Vulkan)…'],
  [/^whisper\.cpp \(Vulkan\) indirilemedi: (.+)$/, 'whisper.cpp (Vulkan) could not be downloaded: $1'],
  [/^İşlemciye geçiliyor\.$/, 'Going on with the processor.'],
  [/^whisper\.cpp modeli indiriliyor \(yaklaşık 1,6 GB\)…$/, 'Downloading the whisper.cpp model (about 1.6 GB)…'],
  [/^Sanal ortam kuruluyor…$/, 'Setting up its own environment…'],
  [/^Paketler yükleniyor \(ilk kurulumda birkaç dakika sürer\): (.+)$/, 'Installing packages (a few minutes the first time): $1'],
  [/^Uyandırma modeli indiriliyor \(yaklaşık 40 MB\)…$/, 'Downloading the wake-word model (about 40 MB)…'],
  [/^Whisper modeli hazırlanıyor \(ilk seferde yaklaşık 1,6 GB iner\)…$/, 'Preparing the Whisper model (about 1.6 GB the first time)…'],
  [/^Whisper modeli hazırlanıyor…$/, 'Preparing the Whisper model…'],
  [/^%(\d+) \((\d+) \/ (\d+) MB\)$/, '$1% ($2 / $3 MB)'],
];

/** An engine step in the window's language. */
export function engineStep(line: string, language: 'tr' | 'en' | null = readSettings().language): string {
  const text = line.trim();
  if (language !== 'en') return text;
  for (const [pattern, english] of ENGINE_STEPS) if (pattern.test(text)) return text.replace(pattern, english);
  return text;
}
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

/** The Python installer that came with the app, beside it or where the desktop build puts it while developing. */
function pythonInstaller(): string | null {
  const dirs = [path.join(process.resourcesPath ?? '', 'python'), path.join(app.getAppPath(), 'python-paket')];
  if (process.env.CORTEX_PYTHON_INSTALLERS) dirs.unshift(process.env.CORTEX_PYTHON_INSTALLERS);
  // Carried as `.paket`: a signed build signs every .exe among its resources, and signing this one
  // again would change the bytes its SHA-256 is pinned to.
  const names = [PYTHON_PACKED, pythonPin.file];
  for (const dir of dirs) for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return null;
}

/** The name the Python installer travels under inside the app. */
export const PYTHON_PACKED = `${pythonPin.file}.paket`;

/**
 * How python.org's installer is run: quietly, for this user only (no administrator), with the
 * `py` launcher the engine is started by; the PATH, file types and Start menu left as they are.
 */
export const PYTHON_INSTALL_ARGS = [
  '/quiet',
  'InstallAllUsers=0',
  'InstallLauncherAllUsers=0',
  'Include_launcher=1',
  'PrependPath=0',
  'AssociateFiles=0',
  'Shortcuts=0',
  'Include_doc=0',
  'Include_test=0',
];

/** A file's SHA-256, read in pieces. */
export function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The installer run and waited for; its exit code (python.org's: 0 done, 3010 done after a restart, 1602 cancelled). */
function runInstaller(file: string, args: string[], timeout: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
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
    auto: result.otomatik_dinle !== false,
    engine,
    // The model's name only: where it runs is said by `engine`, not twice (`large-v3-turbo (ekran kartı, Vulkan)`).
    model: typeof result.model === 'string' ? result.model.replace(/\s*\([^)]*\)\s*$/, '') : null,
    commands: commandsOf(result),
  };
}

const wordsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);

/** The spoken commands as the engine reports them (`komutlar`, and `adla_kaydet` beside them); null from an older engine. */
function commandsOf(result: Record<string, unknown>): VoiceCommands | null {
  const given = result.komutlar;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return null;
  const said = given as Record<string, unknown>;
  return {
    kaydet: wordsOf(said.kaydet),
    adla_kaydet: wordsOf(result.adla_kaydet),
    kelime_sil: wordsOf(said.kelime_sil),
    cumle_sil: wordsOf(said.cumle_sil),
    sil: wordsOf(said.sil),
    iptal: wordsOf(said.iptal),
  };
}

/** The commands a window asked for, as `ses ayar --komutlar` takes them: known ones only, each word tidied; null when none. */
export function commandsPatch(asked: unknown): Partial<VoiceCommands> | null {
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return null;
  const patch: Partial<VoiceCommands> = {};
  for (const name of VOICE_COMMANDS) {
    const given = (asked as Record<string, unknown>)[name];
    if (!Array.isArray(given)) continue;
    patch[name] = wordsOf(given)
      .map((one) => one.trim().replace(/\s+/g, ' ').slice(0, COMMAND_WORDS.longest))
      .filter(Boolean)
      .slice(0, COMMAND_WORDS.most);
  }
  return Object.keys(patch).length ? patch : null;
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
  if (!python) return Promise.reject(new Error(say('Python bulunamadı.', 'Python was not found.')));
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

/**
 * Yakala's window opened from outside (the notification-area icon's "Not al"): `beyin.py yakala
 * pencere` asks the running listener for its window, the one with the voice helper warm, and
 * opens the window by itself when no listener runs. Not waited for: it lives as long as the window.
 */
export function openNoteWindow(): boolean {
  const vault = vaultOrNull();
  const python = pythonOf();
  if (!vault || !python || process.platform !== 'win32') return false;
  const child = spawn(python.command, [...python.args, path.join(vault, 'beyin.py'), 'yakala', 'pencere'], {
    cwd: vault,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }),
  });
  child.on('error', () => undefined);
  child.unref();
  return true;
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
  if (current !== 'voice') heardVoice(voice);
  return {
    python: python !== null,
    pythonBundled: process.platform === 'win32' && pythonInstaller() ? pythonPin.version : null,
    vault: vault !== null,
    engine: { installed, bundled: bundledPackage(packageDirs())?.version ?? null },
    voice,
    voiceSupported,
    job: current,
  };
}

/** A job, the only one going on: its steps and its end pushed to the window, the status after it returned. */
async function job(kind: SetupJob, work: (vault: string, step: (text: string) => void) => Promise<void>): Promise<SetupStatus> {
  if (current) throw new Error(say('Başka bir kurulum sürüyor.', 'Another setup is going on.'));
  // Python is installed before there is a vault, or a Python, to need.
  const vault = vaultOrNull();
  if (kind !== 'python' && !vault) throw new Error(say('Önce bir kasa seç.', 'Choose a vault first.'));
  if (kind !== 'python' && !pythonOf()) throw new Error(say('Python bulunamadı.', 'Python was not found.'));
  current = kind;
  try {
    await work(vault ?? '', (text) => push({ job: kind, step: text }));
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

/** The Python that came with the app, installed for this user where the machine has none. */
export function installPython(): Promise<SetupStatus> {
  return job('python', async (_vault, step) => {
    if (process.platform !== 'win32') throw new Error(say("Python yalnız Windows'ta uygulamayla gelir.", 'Python comes with the app on Windows only.'));
    if (pythonOf()) return;
    const file = pythonInstaller();
    if (!file) throw new Error(say('Uygulamayla gelen Python bulunamadı.', 'The Python that came with the app was not found.'));
    step(say(`Python ${pythonPin.version} doğrulanıyor…`, `Checking Python ${pythonPin.version}…`));
    if ((await sha256Of(file)) !== pythonPin.sha256) {
      throw new Error(say('Python kurucusu beklenen dosya değil (SHA-256 tutmadı); çalıştırılmadı.', 'The Python installer is not the expected file (its SHA-256 differs); it was not run.'));
    }
    step(say(`Python ${pythonPin.version} kuruluyor (yalnız senin kullanıcın için)…`, `Installing Python ${pythonPin.version} (for you only)…`));
    // Run under its own name from a folder of its own: the bytes just checked, as python.org signed them.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-python-'));
    let code: number;
    try {
      const runnable = path.join(folder, pythonPin.file);
      fs.copyFileSync(file, runnable);
      if ((await sha256Of(runnable)) !== pythonPin.sha256) throw new Error(say('Python kurucusu kopyalanırken değişti; çalıştırılmadı.', 'The Python installer changed while copied; it was not run.'));
      code = await runInstaller(runnable, PYTHON_INSTALL_ARGS, JOB_TIMEOUT);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    if (code === 1602) throw new Error(say('Python kurulumu iptal edildi.', 'The Python setup was cancelled.'));
    if (code !== 0 && code !== 3010) throw new Error(say(`Python kurulamadı (çıkış kodu ${code}).`, `Python could not be installed (exit code ${code}).`));
    if (!pythonOf()) throw new Error(say('Python kuruldu ama bulunamadı; uygulamayı yeniden aç.', 'Python was installed but not found; open the app again.'));
  });
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
    if (!bundled) throw new Error(say('Uygulamayla gelen Cortex paketi bulunamadı.', 'The Cortex package that came with the app was not found.'));
    const installed = installedVersion(vault);
    if (installed) {
      if (compareVersions(installed, bundled.version) >= 0) return;
      step(say(`Cortex ${installed} → ${bundled.version} güncelleniyor…`, `Updating Cortex ${installed} → ${bundled.version}…`));
      await runPython([path.join(vault, 'beyin.py'), 'update', '--package', bundled.file], { cwd: vault, timeout: JOB_TIMEOUT });
      return;
    }
    // No engine yet: the package's own installer, from a copy of it taken apart in a folder of its own.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-kurulum-'));
    try {
      step(say(`Cortex ${bundled.version} kasaya kuruluyor…`, `Setting Cortex ${bundled.version} up in the vault…`));
      await runPython(['-I', '-c', UNPACK, bundled.file, folder], { cwd: folder, timeout: STATUS_TIMEOUT });
      await runPython(['-I', path.join(folder, 'scripts', 'install_v3.py'), '--vault', vault], { cwd: vault, timeout: JOB_TIMEOUT });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    if (!installedVersion(vault)) throw new Error(say('Kurulum bitti ama kasada Cortex görünmüyor.', 'The setup ended but Cortex is not in the vault.'));
  });
}

/** Yakala, if it is not set up yet, then voice typing; each step as the engine says it. */
export function installVoice(): Promise<SetupStatus> {
  return job('voice', async (vault, step) => {
    if (process.platform !== 'win32') throw new Error(say("Sesle yazma yalnız Windows'ta.", 'Voice typing is for Windows only.'));
    const beyin = path.join(vault, 'beyin.py');
    const capture = await runPython([beyin, 'yakala', 'durum'], { cwd: vault, timeout: STATUS_TIMEOUT });
    if (capture.kurulu !== true) {
      step(say('Yakala kuruluyor (Ctrl+Alt+C)…', 'Setting up yakala (Ctrl+Alt+C)…'));
      await runPython([beyin, 'yakala', 'kur'], { cwd: vault, timeout: STATUS_TIMEOUT * 5 });
    }
    await runPython([beyin, 'ses', 'kur'], { cwd: vault, timeout: JOB_TIMEOUT, onStep: (line) => step(engineStep(line)) });
  });
}

/** Voice typing on or off, the wake phrase on or off, the spoken commands' words. */
export async function setVoice(patch: unknown): Promise<SetupStatus> {
  const asked = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const args: string[] = [];
  if (typeof asked.on === 'boolean') args.push('--ses', asked.on ? 'ac' : 'kapat');
  if (typeof asked.wake === 'boolean') args.push('--uyandirma', asked.wake ? 'ac' : 'kapat');
  if (typeof asked.auto === 'boolean') args.push('--otomatik', asked.auto ? 'ac' : 'kapat');
  if (asked.defaultCommands === true) args.push('--varsayilan-komutlar');
  const commands = commandsPatch(asked.commands);
  if (commands) args.push('--komutlar', JSON.stringify(commands));
  const vault = vaultOrNull();
  if (!args.length || !vault) return setupStatus();
  if (current) throw new Error(say('Başka bir kurulum sürüyor.', 'Another setup is going on.'));
  await runPython([path.join(vault, 'beyin.py'), 'ses', 'ayar', ...args], { cwd: vault, timeout: STATUS_TIMEOUT });
  return setupStatus();
}

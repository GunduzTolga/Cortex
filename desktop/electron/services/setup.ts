import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { type EngineCode, readEngineError, engineSentence } from '../../shared/engineError';
import { COMMAND_WORDS, CPU_MODELS, HOTKEYS, VOICE_COMMANDS, WAKE_PHRASES, hotkeyLabel } from '../../shared/setup';
import type { CpuModel, EngineStatus, Hotkey, SetupJob, SetupPush, SetupStatus, VoiceCommands, VoiceEngine, VoiceStatus, WakePhrase } from '../../shared/setup';
import pythonPin from '../../python.json';
import { childEnv } from './acp';
import { refreshPath } from './clis';
import { forgetPythonVerdicts, type PythonLaunch, pythonOf, pythonWanting, usablePython } from './localChat';
import { readOwner, restartingListener } from './microphone';
import { readSettings } from './settings';

/**
 * Cortex set up from the app, so that nobody types an install command
 * (shared/setup.ts). Every job is the vault's own engine doing what its
 * command line does - the app only starts it, without a shell, and passes on
 * what it says:
 *
 * - Python, where the machine has none fit for the engine - none that runs,
 *   or none 3.11 or newer (Windows): python.org's signed installer that came
 *   with the app (desktop/python.json), checked by its SHA-256 and run quietly
 *   for this user only;
 * - the engine: the package that came with the app (`cortex/beyin-v3-X.Y.Z.zip`
 *   among its resources) installed into the vault by its own installer, or
 *   the vault's engine updated from it (`beyin.py update --package`); the
 *   installer again for an engine of the same version with other files, and
 *   for the predecessor project's 2.x/3.x;
 * - voice typing: yakala set up if it is not (`beyin.py yakala kur`), then
 *   `beyin.py ses kur`, whose steps come one JSON line each (`{"adim": …}`).
 * - yakala moved to the vault open now, where it served another (`yakala kur`
 *   again, in the background), and set up again where its listener was found
 *   not running or another app holds its key.
 *
 * A vault with an engine is bound to where it is now when it is opened
 * (`beyin.py relocate`). A failure is said as the engine's sentence in the
 * window's language, never its JSON (shared/engineError.ts).
 *
 * One job at a time. A job is not stopped when the window closes: an engine
 * update or a 2 GB download cut short is worse than one let finish.
 */

const VERSION_FILE = '.beyin-version';
const PACKAGE = /^beyin-v3-(\d+)\.(\d+)\.(\d+)\.zip$/;
const STATUS_TIMEOUT = 60_000;
const JOB_TIMEOUT = 3 * 60 * 60_000;

let current: SetupJob | null = null;
/** Who waits for the job going on to end: the app, asked to quit when it is done (electron/main.ts). */
let idleWaiters: Array<() => void> = [];

/** The job going on, if one is: quitting now would cut it short (electron/main.ts asks first). */
export function setupBusy(): SetupJob | null {
  return current;
}

/** Resolves once no job is going on. */
export function whenSetupIdle(): Promise<void> {
  return current ? new Promise((done) => idleWaiters.push(done)) : Promise.resolve();
}

function jobEnded(): void {
  current = null;
  const waiting = idleWaiters;
  idleWaiters = [];
  for (const done of waiting) done();
}

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
  // A card that would not start, or was slower than the processor's quick model: the processor writes (voice-2).
  [/^Ekran kartı açılamadı; işlemciye geçiliyor\.$/, 'The graphics card would not start; going on with the processor.'],
  [/^Ekran kartı bu bilgisayarda işlemciden yavaş kaldı \((\d+),(\d+) sn\); işlemciye geçiliyor\.$/, 'On this computer the graphics card was slower than the processor ($1.$2 s); going on with the processor.'],
  [/^İşlemcinin modeli hazırlanamadı; ekran kartı kalıyor\.$/, 'The processor’s model could not be had; the graphics card stays.'],
  [/^whisper\.cpp modeli indiriliyor \(yaklaşık 1,6 GB\)…$/, 'Downloading the whisper.cpp model (about 1.6 GB)…'],
  [/^Sanal ortam kuruluyor…$/, 'Setting up its own environment…'],
  [/^Paketler yükleniyor \(ilk kurulumda birkaç dakika sürer\): (.+)$/, 'Installing packages (a few minutes the first time): $1'],
  [/^Uyandırma modeli indiriliyor \(yaklaşık 40 MB\)…$/, 'Downloading the wake-word model (about 40 MB)…'],
  [/^Whisper modeli hazırlanıyor \(ilk seferde yaklaşık (\d+),(\d) GB iner\)…$/, 'Preparing the Whisper model (about $1.$2 GB the first time)…'],
  [/^Whisper modeli hazırlanıyor…$/, 'Preparing the Whisper model…'],
  [/^%(\d+) \((\d+) \/ (\d+) MB\)$/, '$1% ($2 / $3 MB)'],
  // pip's downloads and installs, each as it goes, and a download that broke and goes on.
  [/^İniyor: (.+) \(([^()]+)\)$/, 'Downloading: $1 ($2)'],
  [/^Kuruluyor: (.+)$/, 'Installing: $1'],
  [/^Bağlantı koptu; kaldığı yerden yeniden deneniyor \((\d+)\/(\d+)\)…$/, 'The connection broke; going on from where it stopped ($1/$2)…'],
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

/**
 * Whether a stamp is the predecessor project's: Cortex began again at 1.0, after that project's 2.x and 3.x
 * (beyin.md, 3a). Such a vault looked newer than any Cortex and was left on the old engine, whose updater
 * refuses Cortex's package and which knows none of `ses`, `telegram` or `pyn` (install-update-4).
 */
export function isPredecessor(version: string, appVersion: string = app.getVersion()): boolean {
  const major = (one: string) => Number(one.split('.')[0]) || 0;
  return major(version) >= 2 && major(appVersion) < 2;
}

/**
 * The state folder the vault's engine is pinned to (`.beyin-runtime.json`), where it is on this machine; null where
 * the vault pins none, or one this machine does not have (a pin from another computer, through a synced vault).
 */
export function pinnedState(vault: string): string | null {
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(vault, '.beyin-runtime.json'), 'utf8')) as { state?: unknown };
    const state = typeof pin.state === 'string' && path.isAbsolute(pin.state) ? pin.state : null;
    return state && fs.existsSync(state) ? state : null;
  } catch {
    return null;
  }
}

/** Where the vault's package files go in it, as its installer writes them (scripts/install_v3.py, `add`); null for one compared otherwise. */
export function installedNameOf(packaged: string): string | null {
  if (packaged === 'scripts/beyin_entry.py') return 'beyin.py';
  if (packaged === 'scripts/beyin_v3.py') return '.claude/scripts/beyin_v3_cli.py';
  const script = /^template\/\.claude\/scripts\/(beyin_v3[^/]*\.py)$/.exec(packaged);
  return script ? `.claude/scripts/${script[1]}` : null;
}

/**
 * Whether the vault's engine is not the one in the package though their versions are one: a build given out under
 * an unchanged version (several 1.0.32s went to testers), whose fixes `update` took for nothing to do (install-update-1).
 * The package's digests of its code are held to what the vault's installer last wrote (`installed_hash` in
 * `<state>/v3-install.json`), not to the files as they are now: a file edited by hand is no reason to install again
 * and again. A file the installer did not write (an adapter left out) is not compared.
 */
export function staleAgainst(packageFiles: Record<string, unknown>, installedFiles: Record<string, unknown>): boolean {
  for (const [name, digest] of Object.entries(packageFiles)) {
    const there = installedNameOf(name);
    const written = there ? (installedFiles[there] as { installed_hash?: unknown } | undefined) : undefined;
    if (written && typeof digest === 'string' && written.installed_hash !== digest) return true;
  }
  return false;
}

/** The package's own list of its files and their digests, which `npm run cortex-paket` writes beside it (`beyin-v3-X.Y.Z.manifest.json`). */
export const manifestOf = (packageFile: string) => packageFile.replace(/\.zip$/, '.manifest.json');

/** A JSON file read once until it changes: the installer's record holds every file it wrote, a few MB, and the status is asked often. */
const readCache = new Map<string, { stamp: string; value: Record<string, unknown> | null }>();
function readJsonKept(file: string): Record<string, unknown> | null {
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const kept = readCache.get(file);
  if (kept?.stamp === stamp) return kept.value;
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    value = null;
  }
  readCache.set(file, { stamp, value });
  return value;
}

/** Whether the vault's engine is stale against the package that came with the app; false where either side cannot say. */
export function engineStale(vault: string, packageFile: string): boolean {
  const state = pinnedState(vault);
  const packaged = readJsonKept(manifestOf(packageFile))?.files;
  const installed = state ? readJsonKept(path.join(state, 'v3-install.json'))?.files : null;
  if (!packaged || typeof packaged !== 'object' || !installed || typeof installed !== 'object') return false;
  return staleAgainst(packaged as Record<string, unknown>, installed as Record<string, unknown>);
}

/** An update of the vault's engine left half done: its journal is still in the state folder (install-update-5). */
export function journalPending(vault: string): boolean {
  const state = pinnedState(vault);
  return state !== null && fs.existsSync(path.join(state, 'update-journal.json'));
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
    wakePhrase: WAKE_PHRASES.includes(result.uyandirma_sozu as WakePhrase) ? (result.uyandirma_sozu as WakePhrase) : 'pyn not al',
    // An engine from before Telegram does not say: taken as able, so nothing is offered that it cannot use.
    readsFiles: result.dosya_okur !== false,
    cpuModel: CPU_MODELS.includes(result.islemci_modeli as CpuModel) ? (result.islemci_modeli as CpuModel) : null,
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
    resim_ekle: wordsOf(said.resim_ekle),
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

/**
 * A command of the vault's engine that failed, said as a sentence in the window's language
 * (shared/engineError.ts): never the JSON line it ended with. What it was, where the engine named it
 * or its words tell (`code`), is kept for the setup to act on - wait and try again while the engine is
 * busy, finish an update left half done.
 */
export class EngineFailure extends Error {
  constructor(
    message: string,
    readonly code: EngineCode | null,
    /** How the program ended: its exit code; null when it was stopped (too long) or never started. */
    readonly exitCode: number | null,
    /** The last of what it wrote to stderr, as it came: for telling an engine that does not know a command. */
    readonly said: string,
  ) {
    super(message);
  }
}

/** What the engine's code was, for a failure that is one. */
export const codeOf = (err: unknown): EngineCode | null => (err instanceof EngineFailure ? err.code : null);

/** The failure a run ended with, read whole and only then cut short: an escaped pip error is longer than a toast. */
function failureOf(errors: string, exitCode: number | null, timedOut: boolean): EngineFailure {
  const language = readSettings().language === 'en' ? 'en' : 'tr';
  // Stopped for taking too long, it never reached its last word: what it wrote last (a pip warning, a step) is not why.
  const read = timedOut ? null : readEngineError(errors);
  const sentence = timedOut
    ? say('İşlem çok uzun sürdü ve durduruldu.', 'It took too long and was stopped.')
    : read
      ? engineSentence(read, language)
      : exitCode === 0
        ? say('Beklenen cevap gelmedi.', 'The answer that was expected did not come.')
        : exitCode === null
          ? say('İşlem bitmeden kesildi.', 'It was cut off before it finished.')
          : say(`İşlem tamamlanamadı (çıkış kodu ${exitCode}).`, `It did not finish (exit code ${exitCode}).`);
  return new EngineFailure(sentence, read?.code ?? null, exitCode, errors.slice(-2000));
}

/**
 * Python with these arguments, in the vault, without a shell: each step it
 * says handed to `onStep`, its result (the last JSON object it wrote that is
 * not a step) returned. A failure rejects with an EngineFailure: the sentence
 * the engine ended with, in the window's language.
 */
export function runPython(
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    onStep?: (step: string) => void;
    python?: PythonLaunch | null;
    /** More of the environment, for this run only (the Telegram bot's key: services/telegram.ts). */
    env?: Record<string, string>;
  },
): Promise<Record<string, unknown>> {
  const python = options.python === undefined ? pythonOf() : options.python;
  if (!python) return Promise.reject(new Error(say('Python bulunamadı.', 'Python was not found.')));
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.args, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...options.env }),
    });
    let buffer = '';
    let written = '';
    let errors = '';
    let timedOut = false;
    let result: Record<string, unknown> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeout);
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
      const why = (err as NodeJS.ErrnoException).code ?? err.message;
      reject(new EngineFailure(say(`Python başlatılamadı (${why}).`, `Python could not be started (${why}).`), null, null, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) take(buffer);
      result ??= trailingObject(written);
      if (code === 0 && result && !timedOut) resolve(result);
      else reject(failureOf(errors, code, timedOut));
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

/** The vault's engine as the setup sees it: its version, the one that came with the app, and whether it is a predecessor's or stale. */
function engineOf(vault: string | null): EngineStatus {
  const bundled = bundledPackage(packageDirs());
  const installed = vault ? installedVersion(vault) : null;
  const legacy = installed !== null && isPredecessor(installed);
  const stale = Boolean(vault && installed && !legacy && bundled && compareVersions(installed, bundled.version) === 0 && engineStale(vault, bundled.file));
  return { installed, bundled: bundled?.version ?? null, legacy, stale };
}

export async function setupStatus(): Promise<SetupStatus> {
  // A Python installed while the app was open (python.org, winget) is found without opening it again.
  await refreshPath();
  const vault = vaultOrNull();
  // Asked, not only found: a `py` left behind with no Python, or a Python 3.10, is no Python for the engine (desktop-shell-1).
  const python = await usablePython();
  const engine = engineOf(vault);
  const voiceSupported = process.platform === 'win32';
  let voice: VoiceStatus | null = null;
  if (vault && python && engine.installed && !engine.legacy && voiceSupported && current !== 'voice') {
    try {
      voice = voiceOf(await runPython([path.join(vault, 'beyin.py'), 'ses', 'durum'], { cwd: vault, timeout: STATUS_TIMEOUT, python }));
    } catch {
      voice = null; // an engine from before voice typing: it does not know the command
    }
  }
  if (current !== 'voice') heardVoice(voice);
  return {
    python: python !== null,
    pythonWanting: python ? null : pythonWanting(),
    pythonBundled: process.platform === 'win32' && pythonInstaller() ? pythonPin.version : null,
    vault: vault !== null,
    engine,
    voice,
    voiceSupported,
    job: current,
  };
}

/**
 * A job, the only one going on: its steps and its end pushed to the window, the status after it returned. A job that
 * ended but not as wished - voice typing set up, its listener not running - returns what to say, and ends with it.
 */
async function job(kind: SetupJob, work: (vault: string, step: (text: string) => void) => Promise<string | void>): Promise<SetupStatus> {
  if (current) throw new Error(say('Başka bir kurulum sürüyor.', 'Another setup is going on.'));
  // Python is installed before there is a vault, or a Python, to need.
  const vault = vaultOrNull();
  if (kind !== 'python' && !vault) throw new Error(say('Önce bir kasa seç.', 'Choose a vault first.'));
  current = kind;
  if (kind !== 'python' && !(await usablePython())) {
    jobEnded();
    throw new Error(say('Python bulunamadı.', 'Python was not found.'));
  }
  try {
    const warning = await work(vault ?? '', (text) => push({ job: kind, step: text }));
    jobEnded();
    push({ job: kind, done: true, ok: true, ...(warning ? { warning } : {}) });
  } catch (err) {
    jobEnded();
    const error = err instanceof Error ? err.message : String(err);
    push({ job: kind, done: true, ok: false, error });
    throw err instanceof Error ? err : new Error(error);
  }
  return setupStatus();
}

/** The Python that came with the app, installed for this user where the machine has none fit for the engine. */
export function installPython(): Promise<SetupStatus> {
  return job('python', async (_vault, step) => {
    if (process.platform !== 'win32') throw new Error(say("Python yalnız Windows'ta uygulamayla gelir.", 'Python comes with the app on Windows only.'));
    // Not "a Python is there": one that runs and is new enough. A launcher left behind, or a 3.10, is not (desktop-shell-1).
    if (await usablePython()) return;
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
    // Each Python is asked again: a `py` that had nothing behind it finds this one now.
    forgetPythonVerdicts();
    await refreshPath(true);
    if (!(await usablePython())) throw new Error(say('Python kuruldu ama bulunamadı; uygulamayı yeniden aç.', 'Python was installed but not found; open the app again.'));
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

/** How long the setup waits, each time in turn, for an engine busy with other work (a chat's hook syncing) before it tries again. */
let busyWaits = [3_000, 6_000, 12_000];

/** For the tests: the waits made short. */
export function setBusyWaits(waits: number[]): void {
  busyWaits = waits;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The package's own installer run on the vault, from a copy of the package taken apart in a folder of its own: for a
 * vault without an engine, a predecessor's, or one stale against the package (install-update-1, install-update-4).
 * The state the vault is pinned to is given to it: without `--state` it pins this machine's default one, and a vault
 * set up with another would be parted from its index, its receipts and its voice setup.
 */
async function runPackageInstaller(vault: string, bundled: { file: string; version: string }): Promise<Record<string, unknown>> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-kurulum-'));
  try {
    await runPython(['-I', '-c', UNPACK, bundled.file, folder], { cwd: folder, timeout: STATUS_TIMEOUT });
    const state = pinnedState(vault);
    const args = ['-I', path.join(folder, 'scripts', 'install_v3.py'), '--vault', vault, ...(state ? ['--state', state] : [])];
    let result = await runPython(args, { cwd: vault, timeout: JOB_TIMEOUT });
    // An update left half done is finished first, and that is all such a run does: the install is the next one.
    if (result.install_resumed === true) result = await runPython(args, { cwd: vault, timeout: JOB_TIMEOUT });
    return result;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The vault's engine updated from the package (`beyin.py update --package`). Busy with other work, it is asked again a
 * little later, as it asks. Left half done before - the computer turned off, a file held by a scanner - every later
 * `beyin.py` may fail on the half-written engine, recover and rollback with it, so the package's own installer, which
 * finishes what its journal began, is run instead (install-update-5).
 */
async function updateEngine(vault: string, bundled: { file: string; version: string }, step: (text: string) => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runPython([path.join(vault, 'beyin.py'), 'update', '--package', bundled.file], { cwd: vault, timeout: JOB_TIMEOUT });
      return;
    } catch (err) {
      const code = codeOf(err);
      if (code === 'updater_busy' && attempt < busyWaits.length) {
        step(say('Cortex başka bir işi bitiriyor; birazdan yeniden deneniyor…', 'Cortex is finishing other work; trying again in a moment…'));
        await pause(busyWaits[attempt]);
        continue;
      }
      // Still busy after the waits: another update holds the engine, its journal is its own, not one left half done.
      if (code !== 'updater_busy' && (code === 'pending_journal' || journalPending(vault))) {
        step(say('Yarım kalan güncelleme tamamlanıyor…', 'Finishing the update left half done…'));
        await runPackageInstaller(vault, bundled);
        return;
      }
      throw err;
    }
  }
}

/** The engine that came with the app into the vault: installed, updated, refreshed, or a predecessor's moved to Cortex. */
export function installEngine(): Promise<SetupStatus> {
  return job('engine', async (vault, step) => {
    const bundled = bundledPackage(packageDirs());
    if (!bundled) throw new Error(say('Uygulamayla gelen Cortex paketi bulunamadı.', 'The Cortex package that came with the app was not found.'));
    const installed = installedVersion(vault);
    if (installed && !isPredecessor(installed)) {
      const order = compareVersions(installed, bundled.version);
      if (order < 0) {
        step(say(`Cortex ${installed} → ${bundled.version} güncelleniyor…`, `Updating Cortex ${installed} → ${bundled.version}…`));
        await updateEngine(vault, bundled, step);
      } else if (order === 0 && engineStale(vault, bundled.file)) {
        // The same version, other files: `update` takes it for nothing to do, the installer writes what differs.
        step(say(`Cortex ${installed}, uygulamayla gelen dosyalarla yenileniyor…`, `Refreshing Cortex ${installed} with the files that came with the app…`));
        await runPackageInstaller(vault, bundled);
      } else {
        return;
      }
    } else {
      step(
        installed
          ? say(`Kasadaki önceki kurulum (${installed}) Cortex ${bundled.version} sürümüne geçiriliyor…`, `Moving the vault’s earlier engine (${installed}) to Cortex ${bundled.version}…`)
          : say(`Cortex ${bundled.version} kasaya kuruluyor…`, `Setting Cortex ${bundled.version} up in the vault…`),
      );
      await runPackageInstaller(vault, bundled);
      const now = installedVersion(vault);
      if (!now || isPredecessor(now)) throw new Error(say('Kurulum bitti ama kasada Cortex görünmüyor.', 'The setup ended but Cortex is not in the vault.'));
    }
    // A vault moved with an engine from before `relocate` is bound now, with the engine that knows how.
    const failure = await relocateVault(vault);
    if (failure) throw new Error(failure);
    settling = { vault, done: Promise.resolve(null) };
  });
}

/**
 * The vault's engine bound to where the vault is now (`beyin.py relocate`). Its hooks and its state name the folder
 * it was set up in; moved - OneDrive taking Documents over, a rename, a copy on a second computer - every hook failed
 * and the memory said "runtime belongs to another vault" with no way out (hooks-clients-2, hooks-clients-M1). The
 * engine binds itself again where the old folder is gone, gives a copy a state of its own where it is not, and says
 * so at once when nothing moved. Resolves to the failure's sentence, or null; an engine from before `relocate` does not
 * know it (argparse's "invalid choice", exit 2) and is left as it is.
 */
async function relocateVault(vault: string): Promise<string | null> {
  const installed = installedVersion(vault);
  if (!installed || isPredecessor(installed)) return null;
  const python = await usablePython();
  if (!python) return null; // the setup offers Python first; there is nothing to bind before
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runPython([path.join(vault, 'beyin.py'), 'relocate'], { cwd: vault, timeout: STATUS_TIMEOUT, python });
      return null;
    } catch (err) {
      // Ended well without a word to read: nothing failed.
      if (err instanceof EngineFailure && err.exitCode === 0) return null;
      if (err instanceof EngineFailure && err.exitCode === 2 && !readEngineError(err.said)?.type) return null;
      if (codeOf(err) === 'updater_busy' && attempt < busyWaits.length) {
        await pause(busyWaits[attempt]);
        continue;
      }
      return err instanceof Error ? err.message : String(err);
    }
  }
}

/** The vault opened last, and its binding (`relocateVault`) going on or done. */
let settling: { vault: string; done: Promise<string | null> } | null = null;

/**
 * The vault just opened bound to where it is now: at the app's start with the vault kept, and after one is chosen,
 * in the background, before the Telegram listener starts in it and before a chat's CLI does (`vaultSettled`). Once
 * per vault: asked again, the same answer, unless it failed - then the next opening tries again. Resolves to the
 * failure's sentence (the window says it once, and goes on), or null.
 */
export function settleVault(): Promise<string | null> {
  const vault = vaultOrNull();
  if (!vault) return Promise.resolve(null);
  if (settling?.vault === vault) return settling.done;
  const entry = { vault, done: relocateVault(vault).catch((err: unknown) => (err instanceof Error ? err.message : String(err))) };
  settling = entry;
  void entry.done.then((failure) => {
    if (failure && settling === entry) settling = null;
  });
  return entry.done;
}

/** Resolves once the vault opened last is bound, or could not be: its hooks then point where the vault is. */
export function vaultSettled(): Promise<void> {
  return settling ? settling.done.then(() => undefined) : Promise.resolve();
}

/**
 * Yakala, if it is not set up yet, then voice typing; each step as the engine says it. Its end says whether yakala's
 * listener runs after it (`dinleyici` in `ses kur`'s result): the voice, the key and "Pyn, not al" live in it, and a
 * listener that did not start - the key held by another app at its first start, a first start slower than its wait -
 * ended the setup with "Sesle yazma hazır" over nothing that listened (windows-e2e-5).
 */
export function installVoice(): Promise<SetupStatus> {
  return job('voice', async (vault, step) => {
    if (process.platform !== 'win32') throw new Error(say("Sesle yazma yalnız Windows'ta.", 'Voice typing is for Windows only.'));
    const beyin = path.join(vault, 'beyin.py');
    return restartingListener(async () => {
      const capture = await runPython([beyin, 'yakala', 'durum'], { cwd: vault, timeout: STATUS_TIMEOUT });
      if (capture.kurulu !== true) {
        step(say('Yakala kuruluyor (Ctrl+Alt+C)…', 'Setting up yakala (Ctrl+Alt+C)…'));
        await runPython([beyin, 'yakala', 'kur'], { cwd: vault, timeout: STATUS_TIMEOUT * 5 });
      }
      const result = await runPython([beyin, 'ses', 'kur'], { cwd: vault, timeout: JOB_TIMEOUT, onStep: (line) => step(engineStep(line)) });
      if (result.dinleyici !== false) return undefined;
      const warning = say(
        'Sesle yazma kuruldu, ama arka plandaki dinleyici başlamadı: kısayol, uyandırma sözü ve sesle yazma şimdilik çalışmıyor. Ayarlar → Sesle yazma\'dan dinleyiciyi yeniden başlat.',
        'Voice typing is set up, but the listener in the background did not start: the key, the wake phrase and voice typing do not work for now. Start the listener again from Settings → Voice typing.',
      );
      step(warning);
      return warning;
    });
  });
}

/** The platform yakala's key and listener are set up on: Windows. The tests stand in for it (`setYakalaPlatform`). */
let yakalaPlatform: NodeJS.Platform = process.platform;

export function setYakalaPlatform(platform: NodeJS.Platform): void {
  yakalaPlatform = platform;
}

/** One folder, as the platform compares paths: Windows' in any letter case, either slash; a folder still there by where it really is. */
export function sameFolder(one: string, other: string, platform: NodeJS.Platform = yakalaPlatform): boolean {
  const real = (folder: string) => {
    try {
      return fs.realpathSync.native(folder);
    } catch {
      return path.resolve(folder);
    }
  };
  const plain = (folder: string) => {
    const text = path.normalize(real(folder)).replace(/[\\/]+$/, '');
    return platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
  };
  return plain(one) === plain(other);
}

/** `beyin.py yakala kur` in the vault open now, with these arguments; its result, or the engine's sentence. */
async function yakalaKur(vault: string, args: string[], python: PythonLaunch): Promise<Record<string, unknown>> {
  return restartingListener(() => runPython([path.join(vault, 'beyin.py'), 'yakala', 'kur', ...args], { cwd: vault, timeout: STATUS_TIMEOUT * 5, python }));
}

/** Yakala's work, one at a time: two vaults chosen quickly move it twice, in turn. */
let yakalaQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = yakalaQueue.then(work, work);
  yakalaQueue = next.catch(() => undefined);
  return next;
}

/**
 * Yakala - its key, "Pyn, not al" and the voice with it, the icon's "Not al", Send To - moved to the vault open now,
 * where it serves another (`yakala-sahip.json`, which `yakala kur` writes): after another vault is chosen, and once an
 * engine is installed in one. Before, all of it kept writing into the vault left - one that might be gone, and was made
 * again - while the settings switched the voice of the new one, and nothing said so (yakala-3). The same key goes with
 * it. Not where the vault has no engine yet (its install moves it after), nor where nothing set yakala up; not while a
 * setup job runs, which may be setting the listener up itself: after it. Windows only, as yakala's key is. Resolves to
 * the key it serves now, as a person reads it, or null when nothing was moved; rejects with the engine's sentence.
 */
export function repointYakala(): Promise<string | null> {
  return oneAtATime(async () => {
    if (yakalaPlatform !== 'win32') return null;
    await whenSetupIdle();
    const vault = vaultOrNull();
    const owner = readOwner();
    if (!vault || !owner || sameFolder(owner.vault, vault)) return null;
    const installed = installedVersion(vault);
    if (!installed || isPredecessor(installed)) return null;
    const python = await usablePython();
    if (!python) return null;
    await yakalaKur(vault, owner.tus ? ['--tus', owner.tus] : [], python);
    return hotkeyLabel(owner.tus ?? HOTKEYS[0]);
  });
}

/** The vault open now, its engine, and a Python to run it with; the reason it cannot be, said, where one is missing. */
async function yakalaPlace(): Promise<{ vault: string; python: PythonLaunch }> {
  if (current) throw new Error(say('Başka bir kurulum sürüyor.', 'Another setup is going on.'));
  const vault = vaultOrNull();
  if (!vault) throw new Error(say('Önce bir kasa seç.', 'Choose a vault first.'));
  const installed = installedVersion(vault);
  if (!installed || isPredecessor(installed)) throw new Error(say("Önce Cortex'i kasaya kur (Ayarlar → Cortex).", 'Set Cortex up in the vault first (Settings → Cortex).'));
  const python = await usablePython();
  if (!python) throw new Error(say('Python bulunamadı.', 'Python was not found.'));
  return { vault, python };
}

/**
 * Yakala set up again in the vault open now, its key kept: the listener found not running (the settings' and the icon's
 * "Dinleyici çalışmıyor") is started again with Windows and now. Rejects with the engine's sentence, or when it still
 * does not run.
 */
export function restartListener(): Promise<void> {
  return oneAtATime(async () => {
    const { vault, python } = await yakalaPlace();
    const result = await yakalaKur(vault, [], python);
    if (result.dinleyici === false) {
      throw new Error(say('Dinleyici yine başlamadı. Bilgisayarı yeniden başlatıp dene; sürerse sesle yazmayı yeniden kur.', 'The listener did not start this time either. Restart the computer and try again; if it goes on, set voice typing up again.'));
    }
  });
}

/** Yakala's key changed to one of HOTKEYS, where another app holds the one it has (`kisayol: 'mesgul'`). */
export function changeHotkey(asked: unknown): Promise<void> {
  return oneAtATime(async () => {
    if (!HOTKEYS.includes(asked as Hotkey)) throw new Error(say('Bu kısayol seçilemez.', 'That key cannot be chosen.'));
    const { vault, python } = await yakalaPlace();
    await yakalaKur(vault, ['--tus', asked as Hotkey], python);
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
  if (WAKE_PHRASES.includes(asked.wakePhrase as WakePhrase)) args.push('--uyandirma-sozu', asked.wakePhrase as WakePhrase);
  // The model the processor writes with: the listener starts again with it (the engine's own setting).
  if (CPU_MODELS.includes(asked.cpuModel as CpuModel)) args.push('--islemci-modeli', asked.cpuModel as CpuModel);
  const commands = commandsPatch(asked.commands);
  if (commands) args.push('--komutlar', JSON.stringify(commands));
  const vault = vaultOrNull();
  if (!args.length || !vault) return setupStatus();
  if (current) throw new Error(say('Başka bir kurulum sürüyor.', 'Another setup is going on.'));
  // The microphone listens all the time only once the person allowed it (src/ui/MicConsent.tsx, services/microphone.ts).
  if (asked.wake === true && !readSettings().wakeConsent) {
    throw new Error(say('Mikrofonun sürekli dinlemesine önce izin ver.', 'Allow the microphone to listen all the time first.'));
  }
  // A switch, a model or the engine changed starts the listener again: not "not running" meanwhile.
  await restartingListener(() => runPython([path.join(vault, 'beyin.py'), 'ses', 'ayar', ...args], { cwd: vault, timeout: STATUS_TIMEOUT }));
  return setupStatus();
}

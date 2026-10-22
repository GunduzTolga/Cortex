import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { engineFailureText, readEngineError } from '../../shared/engineError';
import { BOT_KEY, type TelegramErrorCode, type TelegramStatus, telegramErrorOf, telegramErrorText } from '../../shared/telegram';
import { childEnv } from './acp';
import { writeWhole } from './fileWrite';
import { pythonOf } from './localChat';
import { readSettings } from './settings';
import { EngineFailure, installedVersion, runPython, trailingObject } from './setup';

/**
 * Notes from the phone through the person's own Telegram bot (shared/telegram.ts).
 *
 * The vault's engine does the work: `beyin.py telegram kur` checks the key and
 * hands out a pairing link, `telegram dinle` asks Telegram for new messages
 * and writes each into the inbox, `telegram kaldir` forgets the bot. This
 * keeps the key and the listener:
 *
 * - the key is encrypted with the operating system's own store (safeStorage,
 *   as services/keys.ts keeps the AI tools' keys) into the app's data folder,
 *   never the vault, and given to the engine only as its environment
 *   (BEYIN_TELEGRAM_TOKEN). The window can give a key and have it forgotten;
 *   it never reads one back.
 * - the listener runs while Cortex runs, in the notification area too. When it
 *   stops by itself it is started again, a little later each time; a key
 *   Telegram no longer takes stops it until a new one is given, and so does
 *   a Telegram not set up yet. One listener per machine: another (from a
 *   terminal) is left to do the work.
 * - what the engine knows of the bot - the pairing, the last message read -
 *   is kept in the app's data folder too (BEYIN_TELEGRAM_DIR), beside the key,
 *   not in the vault's state: it belongs to the bot, not to a vault. Kept per
 *   vault, choosing another vault silently stopped the notes from the phone,
 *   asked for the key again, and started a listener every few seconds that
 *   could not run (pyn-telegram-jev-3). The engine moves a vault's own over
 *   the first time.
 */

const KEY_ENV = 'BEYIN_TELEGRAM_TOKEN';
const STATE_ENV = 'BEYIN_TELEGRAM_DIR';
const STATUS_TIMEOUT = 60_000;
/** The first wait before starting a stopped listener again, and the longest. */
const RESTART_FIRST = 5_000;
const RESTART_LONGEST = 5 * 60_000;
/** A listener that ran this long worked: the wait starts from the beginning again. */
const RAN_WELL = 60_000;
/** Another listener holds the machine's lock: looked at again after this long. */
const OTHER_LISTENER_WAIT = 60_000;
/** A key kept, but no vault, Python or engine yet: looked at again this often. */
const MISSING_WAIT = 60_000;

const file = () => path.join(app.getPath('userData'), 'telegram.json');
/** The engine's Telegram folder (durum.json, the listener's lock), one per person, whichever vault is open. */
export const telegramFolder = () => path.join(app.getPath('userData'), 'telegram');

/** What every Telegram command of the engine is given: its folder, and the key where there is one. */
function telegramEnv(key: string | null): Record<string, string> {
  return { [STATE_ENV]: telegramFolder(), ...(key ? { [KEY_ENV]: key } : {}) };
}

const language = (): 'tr' | 'en' => (readSettings().language === 'en' ? 'en' : 'tr');

/** A sentence in the window's language, as the setup speaks (services/setup.ts). */
function say(tr: string, en: string): string {
  return readSettings().language === 'en' ? en : tr;
}

function keptKey(): string | null {
  try {
    const kept = JSON.parse(fs.readFileSync(file(), 'utf8')) as { key?: unknown };
    if (typeof kept.key !== 'string' || !kept.key) return null;
    return safeStorage.decryptString(Buffer.from(kept.key, 'base64'));
  } catch {
    return null;
  }
}

function keepKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error(say('Bu bilgisayar anahtarı saklayacak güvenli bir yer sunmuyor.', 'This computer offers no safe place to keep a key.'));
  // Renamed into place, tried again for a moment while Windows says the file is busy (a scanner opens a file just
  // written): the bot was already paired, and a key not kept left the listener off (desktop-shell-10).
  writeWhole(file(), JSON.stringify({ key: safeStorage.encryptString(key).toString('base64') }), 0o600);
}

function dropKey(): void {
  fs.rmSync(file(), { force: true });
}

function vaultOrNull(): string | null {
  const vault = readSettings().vault;
  return vault && fs.existsSync(vault) ? vault : null;
}

/** The engine's status (`telegram durum`) as the window holds it, its failure said in the window's language. */
export function telegramOf(result: Record<string, unknown> | null, key: boolean, said: 'tr' | 'en' = 'tr'): TelegramStatus {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const error = text(result?.son_hata);
  const errorCode = error ? telegramErrorOf(error, result?.son_hata_kod) : null;
  return {
    key,
    supported: result !== null,
    bot: text(result?.bot),
    paired: result?.eslesti === true,
    person: text(result?.kisi),
    link: text(result?.baglanti),
    code: text(result?.kod),
    listening: result?.calisiyor === true,
    error: telegramErrorText(error, errorCode, said),
    errorCode,
    captured: typeof result?.yakalanan === 'number' ? result.yakalanan : 0,
    voiceNotes: result?.sesli_not === true,
  };
}

/**
 * What the engine said when it refused, as the window says it (shared/engineError.ts): its sentence, never its JSON,
 * and a Telegram refusal the window knows (a key Telegram does not know, a bot tied elsewhere) in an English window's
 * words too (pyn-telegram-jev-8).
 */
export function engineSentence(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  const sentence = engineFailureText(said, language()) ?? said;
  const code = telegramCodeOf(error);
  return code ? (telegramErrorText(sentence, code, language()) ?? sentence) : sentence;
}

/** What a failed command was, as Telegram's codes name it (shared/telegram.ts), from what it wrote last; null for anything else. */
export function telegramCodeOf(error: unknown): TelegramErrorCode | null {
  if (error instanceof TelegramRefusal) return error.code;
  const said = error instanceof Error ? error.message : String(error);
  const read = readEngineError(error instanceof EngineFailure && error.said ? error.said : said);
  return telegramErrorOf(read?.message ?? said, read?.given);
}

/** A Telegram command the engine refused: its sentence for the window, and what it was, for the app to act on. */
class TelegramRefusal extends Error {
  constructor(
    message: string,
    readonly code: TelegramErrorCode | null,
  ) {
    super(message);
  }
}

/** How long to wait before starting the listener again, after it ran this long and stopped this many times in a row. */
export function restartDelay(failures: number): number {
  return Math.min(RESTART_FIRST * 2 ** Math.max(0, failures), RESTART_LONGEST);
}

let child: ChildProcess | null = null;
let closed: Promise<void> | null = null;
let retry: NodeJS.Timeout | null = null;
/** Listeners stopped on purpose: their end starts nothing again, even one that comes after a new listener started. */
const stopped = new WeakSet<ChildProcess>();
let failures = 0;

/** The listener started, if there is a key, a vault with an engine, and a Python; nothing when one runs already. */
export function startTelegram(): boolean {
  if (child || retry) return Boolean(child);
  const vault = vaultOrNull();
  const python = pythonOf();
  const key = keptKey();
  if (!vault || !python || !key || !installedVersion(vault)) {
    // A key kept and the rest not there yet - Python or the engine being set up, a vault on a drive
    // not mounted when Windows signed in: tried again in a while, not left off until a restart.
    if (key) {
      retry = setTimeout(() => {
        retry = null;
        startTelegram();
      }, MISSING_WAIT);
      retry.unref();
    }
    return false;
  }
  const started = Date.now();
  let output = '';
  let errors = '';
  const proc = spawn(python.command, [...python.args, path.join(vault, 'beyin.py'), 'telegram', 'dinle', '--json'], {
    cwd: vault,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...telegramEnv(key) }),
  });
  child = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    output = (output + chunk).slice(-8000);
  });
  // Read, so a full pipe never stops it; its last words say why it ended.
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    errors = (errors + chunk).slice(-4000);
  });
  closed = new Promise((resolve) => {
    proc.on('error', () => resolve());
    proc.on('close', (code) => {
      if (child === proc) child = null;
      resolve();
      if (stopped.has(proc)) return;
      const result = trailingObject(output);
      // A key Telegram does not take: nothing to do until a new one is given (the settings say so).
      if (code === 2 || result?.status === 'anahtar_gecersiz') return;
      // Not set up (an engine that keeps Telegram per vault, in a vault where it never was): started again it ends
      // again, every few seconds for as long as Cortex runs. Given the key in the settings, it is set up and started.
      const read = readEngineError(errors);
      if (result?.status === 'kurulmamis' || (code !== 0 && telegramErrorOf(read?.message, read?.given) === 'kurulmamis')) return;
      failures = Date.now() - started >= RAN_WELL ? 0 : failures + 1;
      const wait = result?.status === 'zaten-calisiyor' ? OTHER_LISTENER_WAIT : restartDelay(failures - 1);
      retry = setTimeout(() => {
        retry = null;
        startTelegram();
      }, wait);
    });
  });
  return true;
}

/** The listener stopped, and not started again; resolves when it has gone. */
export async function stopTelegram(): Promise<void> {
  if (retry) clearTimeout(retry);
  retry = null;
  const going = child;
  child = null;
  if (!going) return;
  stopped.add(going);
  // On Windows the listener is Python under the `py` launcher: ended alone, the launcher can leave
  // the listener running (as services/acp.ts ends a program, its whole tree is ended).
  if (process.platform === 'win32' && going.pid) execFile('taskkill', ['/pid', String(going.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  else going.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** How the listener is, for the tests: running, waiting to start again, or off until something starts it. */
export function telegramListener(): 'running' | 'waiting' | 'off' {
  return child ? 'running' : retry ? 'waiting' : 'off';
}

/** Started again: another vault was chosen, or a new key given. */
export async function restartTelegram(): Promise<void> {
  await stopTelegram();
  failures = 0;
  startTelegram();
}

async function engine(args: string[], key: string | null): Promise<Record<string, unknown>> {
  const vault = vaultOrNull();
  if (!vault) throw new Error(say('Önce bir kasa seç.', 'Choose a vault first.'));
  if (!installedVersion(vault)) throw new Error(say('Önce Cortex\'i kasaya kur (Ayarlar → Cortex).', 'Set Cortex up in the vault first (Settings → Cortex).'));
  if (!pythonOf()) throw new Error(say('Python bulunamadı.', 'Python was not found.'));
  try {
    return await runPython([path.join(vault, 'beyin.py'), 'telegram', ...args, '--json'], {
      cwd: vault,
      timeout: STATUS_TIMEOUT,
      env: telegramEnv(key),
    });
  } catch (err) {
    throw new TelegramRefusal(engineSentence(err), telegramCodeOf(err));
  }
}

/**
 * A command run just after the listener was stopped: the listener's Python may take a moment to let its lock go
 * (the `py` launcher's child outlives the launcher's end by a little), and an engine that will not change the pairing
 * under a running listener says so; asked again a few times before that is the answer.
 */
async function engineOnceStopped(args: string[], key: string | null): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await engine(args, key);
    } catch (err) {
      if (attempt >= 2 || telegramCodeOf(err) !== 'calisiyor') throw err;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
}

export async function telegramStatus(): Promise<TelegramStatus> {
  const key = keptKey();
  try {
    return telegramOf(await engine(['durum'], key), key !== null, language());
  } catch {
    return telegramOf(null, key !== null, language()); // no vault, no engine, or one from before Telegram
  }
}

/**
 * The key from @BotFather checked by the engine with Telegram, then kept and the listener started. A new key of the
 * same bot - one Telegram stopped taking the old key of, after /revoke - keeps the pairing (pyn-telegram-jev-7). A key
 * refused leaves the listener as it was: started again with the key kept.
 */
export async function connectTelegram(given: unknown): Promise<TelegramStatus> {
  const key = typeof given === 'string' ? given.trim() : '';
  if (!BOT_KEY.test(key)) {
    throw new Error(say('Bu bir bot anahtarına benzemiyor: @BotFather\'ın verdiği anahtar "123456789:AA…" gibi görünür.', 'That does not look like a bot key: the one @BotFather gives looks like "123456789:AA…".'));
  }
  await stopTelegram();
  try {
    const result = await engineOnceStopped(['kur'], key);
    keepKey(key);
    const status = telegramOf(result, true, language());
    // Telegram took this key just now: an old key's refusal, which the engine keeps until its next round, is over.
    return { ...status, ...(status.errorCode === 'anahtar_gecersiz' ? { error: null, errorCode: null } : {}), listening: true };
  } finally {
    failures = 0;
    startTelegram();
  }
}

/**
 * A new pairing link, the listener stopped around it and started again on it. Left running, it wrote back the state
 * it read at the start of its round - the old phone's chat, no code - within the 50 seconds it waits for messages, and
 * the new phone's /start was taken for a stranger's (pyn-telegram-jev-2).
 */
export async function pairTelegramAgain(): Promise<TelegramStatus> {
  const key = keptKey();
  if (!key) throw new Error(say('Önce botun anahtarını gir.', 'Give the bot\'s key first.'));
  await stopTelegram();
  try {
    const result = await engineOnceStopped(['kur', '--yeniden-esle'], key);
    return { ...telegramOf(result, true, language()), listening: true };
  } finally {
    failures = 0;
    startTelegram();
  }
}

/** The listener stopped, the engine's pairing and the key forgotten; the notes that came in stay in the vault. */
export async function disconnectTelegram(): Promise<TelegramStatus> {
  await stopTelegram();
  const key = keptKey();
  // The listener's Python may take a moment to let its lock go after it was stopped.
  for (let attempt = 0; vaultOrNull() && attempt < 3; attempt += 1) {
    if (await engine(['kaldir'], key).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  dropKey();
  return telegramStatus();
}

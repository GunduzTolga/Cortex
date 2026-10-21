import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { BOT_KEY, type TelegramStatus } from '../../shared/telegram';
import { childEnv } from './acp';
import { pythonOf } from './localChat';
import { readSettings } from './settings';
import { installedVersion, runPython, trailingObject } from './setup';

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
 *   Telegram no longer takes stops it until a new one is given. One listener
 *   per machine: another (from a terminal) is left to do the work.
 */

const KEY_ENV = 'BEYIN_TELEGRAM_TOKEN';
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
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const temp = `${file()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ key: safeStorage.encryptString(key).toString('base64') }), { mode: 0o600 });
  fs.renameSync(temp, file());
}

function dropKey(): void {
  fs.rmSync(file(), { force: true });
}

function vaultOrNull(): string | null {
  const vault = readSettings().vault;
  return vault && fs.existsSync(vault) ? vault : null;
}

/** The engine's status (`telegram durum`) as the window holds it. */
export function telegramOf(result: Record<string, unknown> | null, key: boolean): TelegramStatus {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    key,
    supported: result !== null,
    bot: text(result?.bot),
    paired: result?.eslesti === true,
    person: text(result?.kisi),
    link: text(result?.baglanti),
    code: text(result?.kod),
    listening: result?.calisiyor === true,
    error: text(result?.son_hata),
    captured: typeof result?.yakalanan === 'number' ? result.yakalanan : 0,
    voiceNotes: result?.sesli_not === true,
  };
}

/** What the engine said when it refused: its JSON error's message, or the line as it came. */
export function engineSentence(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(said) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // not JSON: the line itself
  }
  return said;
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
  const proc = spawn(python.command, [...python.args, path.join(vault, 'beyin.py'), 'telegram', 'dinle', '--json'], {
    cwd: vault,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', [KEY_ENV]: key }),
  });
  child = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    output = (output + chunk).slice(-8000);
  });
  proc.stderr.on('data', () => undefined); // read, so a full pipe never stops it
  closed = new Promise((resolve) => {
    proc.on('error', () => resolve());
    proc.on('close', (code) => {
      if (child === proc) child = null;
      resolve();
      if (stopped.has(proc)) return;
      const result = trailingObject(output);
      // A key Telegram does not take: nothing to do until a new one is given (the settings say so).
      if (code === 2 || result?.status === 'anahtar_gecersiz') return;
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
      env: key ? { [KEY_ENV]: key } : {},
    });
  } catch (err) {
    throw new Error(engineSentence(err));
  }
}

export async function telegramStatus(): Promise<TelegramStatus> {
  const key = keptKey();
  try {
    return telegramOf(await engine(['durum'], key), key !== null);
  } catch {
    return telegramOf(null, key !== null); // no vault, no engine, or one from before Telegram
  }
}

/** The key from @BotFather checked by the engine with Telegram, then kept and the listener started. */
export async function connectTelegram(given: unknown): Promise<TelegramStatus> {
  const key = typeof given === 'string' ? given.trim() : '';
  if (!BOT_KEY.test(key)) {
    throw new Error(say('Bu bir bot anahtarına benzemiyor: @BotFather\'ın verdiği anahtar "123456789:AA…" gibi görünür.', 'That does not look like a bot key: the one @BotFather gives looks like "123456789:AA…".'));
  }
  await stopTelegram();
  const result = await engine(['kur'], key);
  keepKey(key);
  failures = 0;
  startTelegram();
  return { ...telegramOf(result, true), listening: true };
}

/** A new pairing link; the listener reads it on its next round. */
export async function pairTelegramAgain(): Promise<TelegramStatus> {
  const key = keptKey();
  if (!key) throw new Error(say('Önce botun anahtarını gir.', 'Give the bot\'s key first.'));
  const result = await engine(['kur', '--yeniden-esle'], key);
  if (!child) startTelegram();
  return { ...telegramOf(result, true), listening: true };
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

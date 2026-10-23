/**
 * What the vault's engine says when a command fails, said to the person.
 *
 * `beyin.py` and the package's `install_v3.py` end a failure with one line of
 * JSON on stderr - `{"error": "ValueError", "message": "…", "code": "…"}` -
 * written with every letter past ASCII escaped (`ü`). The app showed that
 * line as it came: a toast under "Kurulum bitmedi" read
 * `{"error": "RuntimeError", "message": "Paketler yüklenemedi: …"}`, on
 * the first run, when a person most needs a sentence (desktop-shell-2).
 *
 * This is the one place that reads it. The JSON is found on the last lines of
 * what was written, whole, before anything is cut short, so the escapes come
 * back as letters. A failure that names itself (`code`) is said in the
 * window's language from the table below, with what the app does about it
 * where it does something; a Turkish window keeps the engine's own sentence,
 * which carries the detail (the file, the folder). An engine from before the
 * codes says a few of these in English: those are known by their words and
 * said the same way. Anything else is the engine's sentence, or the line as
 * it came when it was not the engine's JSON - never the JSON itself, nor a
 * piece of it: a line cut short is read for the sentence still in it.
 */

export const ENGINE_CODES = [
  'updater_busy',
  'update_conflict',
  'rollback_conflict',
  'pending_journal',
  'migration_changed',
  'python_too_old',
  'legacy_review',
  'network',
  'disk_full',
  'vault_moved',
  'voice_network',
  'voice_disk_full',
  'voice_failed',
] as const;

export type EngineCode = (typeof ENGINE_CODES)[number];

export interface EngineError {
  /** The exception's name ("ValueError"); null for a line that was not the engine's JSON. */
  type: string | null;
  /** What the failure is, as the engine named it or as its English words tell; null for anything else. */
  code: EngineCode | null;
  /** The engine's sentence, its letters whole; the line itself when it was not JSON. */
  message: string;
  /** What to do, where the engine added it (`hint`). */
  hint: string | null;
  /** The engine named the code itself: its sentence is Turkish and says the detail. */
  named: boolean;
  /** The code as the engine wrote it, one the table below does not know too (a Telegram command's: shared/telegram.ts); null where it wrote none. */
  given: string | null;
}

/** The longest a sentence is shown: the engine's are short, a program's last words need not be. */
const LONGEST = 400;

/** How each failure is said, in each language; `{file}` is the file the engine named, left out when it named none. */
const SAID: Record<EngineCode, { tr: string; en: string }> = {
  updater_busy: {
    tr: 'Cortex şu an başka bir işi bitiriyor (bir sohbetin hafızası yazılıyor olabilir); birkaç saniye sonra yeniden dene.',
    en: 'Cortex is finishing other work right now (a chat’s memory may be being written); try again in a few seconds.',
  },
  update_conflict: {
    tr: 'Güncelleme durdu: Cortex’in yönettiği bir dosya{file} elle değiştirilmiş; üzerine yazılmadı. O değişikliği geri alıp yeniden dene.',
    en: 'The update stopped: a file Cortex manages{file} was changed by hand, and was not written over. Undo that change, then try again.',
  },
  rollback_conflict: {
    tr: 'Geri alma durdu: Cortex’in dosyalarından biri{file} sonradan değiştirilmiş; üzerine yazılmadı.',
    en: 'Undoing the update stopped: one of Cortex’s files{file} was changed since, and was not written over.',
  },
  pending_journal: {
    tr: 'Yarım kalmış bir kurulum tamamlanamadı. Uygulamayı kapatıp açtıktan sonra Ayarlar → Cortex’ten yeniden dene.',
    en: 'A setup left half done could not be finished. Close and open the app, then try again from Settings → Cortex.',
  },
  migration_changed: {
    tr: 'Güncelleme durdu: kasanın verisi güncelleme hazırlanırken değişti. Biraz sonra yeniden dene.',
    en: 'The update stopped: the vault’s data changed while the update was being prepared. Try again in a moment.',
  },
  python_too_old: {
    tr: 'Bu Python Cortex için çok eski: 3.11 ya da sonrası gerekir. Uygulamayla gelen Python’u Ayarlar → Cortex’ten kur, sonra yeniden dene.',
    en: 'This Python is too old for Cortex, which needs 3.11 or later. Install the Python that came with the app (Settings → Cortex), then try again.',
  },
  legacy_review: {
    tr: 'Kasadaki eski Cortex (V2) dosyalarından biri{file} elle değiştirilmiş; kurulum onun üzerine yazmamak için durdu.',
    en: 'One of the vault’s old Cortex (V2) files{file} was changed by hand, and the setup stopped rather than write over it.',
  },
  network: {
    tr: 'İnternete bağlanılamadı ya da bağlantı koptu; bağlantını denetleyip yeniden dene.',
    en: 'The internet could not be reached, or the connection broke; check the connection and try again.',
  },
  disk_full: {
    tr: 'Diskte yer kalmadı; biraz yer açıp yeniden dene.',
    en: 'The disk is full; free some space and try again.',
  },
  vault_moved: {
    tr: 'Kasa taşınmış ya da kopyalanmış; Cortex’in hafızası eski yerine bağlı kaldı ve uygulama bunu kendi düzeltemedi.',
    en: 'The vault was moved or copied, and Cortex’s memory is still tied to its old place; the app could not mend this by itself.',
  },
  voice_network: {
    tr: 'Sesle yazma kurulamadı: indirirken internete bağlanılamadı ya da bağlantı koptu. Bağlantını denetleyip yeniden dene; inenler korunur.',
    en: 'Voice typing could not be set up: the internet could not be reached while downloading, or the connection broke. Check the connection and try again; what came down is kept.',
  },
  voice_disk_full: {
    tr: 'Sesle yazma kurulamadı: diskte yer kalmadı (yaklaşık 3 GB gerekir). Yer açıp yeniden dene.',
    en: 'Voice typing could not be set up: the disk is full (it needs about 3 GB). Free some space and try again.',
  },
  voice_failed: {
    tr: 'Sesle yazma kurulamadı; ayrıntılar ses klasöründeki kurulum.log dosyasında.',
    en: 'Voice typing could not be set up; the details are in kurulum.log in the voice folder.',
  },
};

/**
 * How an engine from before the codes says them, in its own English (and its voice setup's few
 * Turkish words): known by these, said as a named one is. A program's own words about the network
 * or the disk (pip, urllib) are known too, wherever they come from.
 */
const KNOWN: Array<[RegExp, EngineCode]> = [
  [/runtime\/updater busy/i, 'updater_busy'],
  [/runtime belongs to another vault|journal belongs to another vault|Unmanaged file conflict \.beyin-runtime\.json/i, 'vault_moved'],
  [/^(?:update|reinstall) conflict\b|^Unmanaged file conflict\b/i, 'update_conflict'],
  [/^rollback conflict\b|rollback conflict$/i, 'rollback_conflict'],
  [/^Pending installation\b/i, 'pending_journal'],
  [/unsupported Python runtime/i, 'python_too_old'],
  [/Customized legacy runner requires review/i, 'legacy_review'],
  [/no space left on device|errno 28\b|winerror 112\b|not enough space on the disk/i, 'disk_full'],
  [
    /urlopen error|getaddrinfo failed|temporary failure in name resolution|name or service not known|failed to establish a new connection|max retries exceeded|no matching distribution found|could not fetch url|connection (?:timed out|reset|aborted)|network is unreachable|proxyerror|certificate verify failed/i,
    'network',
  ],
];

const isCode = (value: unknown): value is EngineCode => typeof value === 'string' && (ENGINE_CODES as readonly string[]).includes(value);

/** The engine's JSON error among the last lines written, read whole; null when none of them is one. */
function jsonError(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The error is the engine's last word; a warning Python prints as it shuts down may come after it.
  for (const line of lines.slice(-5).reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record.message === 'string' || typeof record.error === 'string') return record;
      }
    } catch {
      // not JSON: an earlier line may be
    }
  }
  return null;
}

/**
 * The engine's JSON line cut short - its start lost to a buffer that keeps only the last of what was written, its end
 * to a program stopped mid-line - read for the fields it still has, their escapes read back as letters; null when it
 * has none of them.
 */
function cutError(line: string): Record<string, unknown> | null {
  const record: Record<string, unknown> = {};
  for (const name of ['error', 'message', 'code', 'hint']) {
    const found = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(line);
    if (!found) continue;
    try {
      // A string cut inside an escape (`\u00f`) loses that letter, not what came before it.
      record[name] = JSON.parse(`"${found[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '')}"`) as string;
    } catch {
      // an escape that cannot be read: the field is left out
    }
  }
  return Object.keys(record).length ? record : null;
}

/**
 * A line that is JSON, or a piece of it: whole JSON, one that starts as an object of it does, names the engine's
 * fields, or carries its escapes with a quote of it. Not every line that begins with a bracket: `[Errno 28] No space
 * left on device` and pip's `[notice] …` are words. Nor one with a Windows path that only looks escaped: Python says
 * `'C:\Users\u1234\…'` in single quotes, and a piece of the engine's line always keeps a double quote (its start or its
 * end is still there).
 */
function jsonish(line: string): boolean {
  if (/^\{"|"(?:error|message|code|hint)"\s*:/.test(line)) return true;
  if (/\\u[0-9a-fA-F]{4}/.test(line) && line.includes('"')) return true;
  if (!/^[[{]/.test(line)) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function errorOf(found: Record<string, unknown>): EngineError {
  const message = typeof found.message === 'string' ? found.message.trim() : '';
  const type = typeof found.error === 'string' ? found.error : null;
  const named = isCode(found.code);
  return {
    type,
    code: named ? (found.code as EngineCode) : codeOf(message),
    message,
    hint: typeof found.hint === 'string' && found.hint.trim() ? found.hint.trim() : null,
    named,
    given: typeof found.code === 'string' && found.code ? found.code : null,
  };
}

/** What a failed command wrote (its stderr, or the sentence a call rejected with), read; null when it wrote nothing a person can be told. */
export function readEngineError(text: string): EngineError | null {
  const found = jsonError(text);
  if (found) return errorOf(found);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // JSON is never the sentence: the engine's own line cut short says what it still can, and any other - a result or a
  // warning written as JSON, a piece with nothing of the engine's in it - is passed over for the words before it.
  // What the failure was is read from the end of what was written, as far back as before setup.ts kept more of it for
  // the engine's long line: a pip warning far above, about a connection tried again, is not why it failed.
  for (const line of lines.reverse()) {
    if (!jsonish(line)) return { type: null, code: codeOf(text.slice(-8000)), message: line, hint: null, named: false, given: null };
    const cut = cutError(line);
    const read = cut ? errorOf(cut) : null;
    if (read && (read.message || read.type || read.code)) return read;
  }
  return null;
}

function codeOf(message: string): EngineCode | null {
  for (const [words, code] of KNOWN) if (words.test(message)) return code;
  return null;
}

/** The file a failure names, vault-relative as the engine writes it (`.claude/scripts/flush.py`); null when it names none. */
function fileOf(message: string): string | null {
  const found = /(?:^|[\s'"(])((?:\.claude|\.codex|\.gemini|\.qwen|\.agents|\.opencode|\.kiro)\/[^\s'",;)]+|beyin\.py|\.beyin-runtime\.json|AGENTS\.md|CLAUDE\.md)/.exec(message);
  return found ? found[1] : null;
}

/** The sentence a person reads for a failure, in the window's language. */
export function engineSentence(error: EngineError, language: 'tr' | 'en'): string {
  const cut = (text: string) => (text.length > LONGEST ? `${text.slice(0, LONGEST - 1)}…` : text);
  if (error.code) {
    // A Turkish window keeps the engine's own sentence when it is Turkish, as one that names its code is: it says the detail.
    if (language === 'tr' && error.named && error.message) return cut(error.message);
    const file = fileOf(error.message);
    return cut(SAID[error.code][language].replace('{file}', file ? ` (${file})` : ''));
  }
  const said = error.message || (error.type ? (language === 'en' ? `Cortex’s engine failed (${error.type}).` : `Cortex’in motoru bir hata verdi (${error.type}).`) : '');
  return cut(error.hint ? `${said} ${error.hint}` : said);
}

/** What a failed command wrote, as the sentence to show; null when it wrote nothing. */
export function engineFailureText(text: string, language: 'tr' | 'en'): string | null {
  const error = readEngineError(text);
  return error ? engineSentence(error, language) : null;
}

/** Every failure's sentence in both languages, for the tests: none may be missing. */
export const ENGINE_SENTENCES: Readonly<Record<EngineCode, { tr: string; en: string }>> = SAID;

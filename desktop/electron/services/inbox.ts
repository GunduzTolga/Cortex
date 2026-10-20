import fs from 'node:fs';
import path from 'node:path';
import { pythonOf } from './localChat';
import { readSettings } from './settings';
import { installedVersion, runPython } from './setup';

/**
 * Something kept for later in the vault's inbox (`📥 000-Inbox/Yakala`), as
 * a yakala card: the vault's own `beyin.py yakala ekle` writes it, the same
 * place Ctrl+Alt+C and Telegram write to. Used by a chat message's "Gelen
 * kutusuna at" and by the local models' one tool (services/localChat.ts).
 * It only adds: nothing in the vault is changed or removed from here.
 */

const TEXT_MAX = 20_000;
const URL_MAX = 2_000;
const WHY_MAX = 2_000;
const TIMEOUT = 60_000;
const LINK = /https?:\/\/[^\s<>"]+/;

/** A sentence in the window's language. */
function say(tr: string, en: string): string {
  return readSettings().language === 'en' ? en : tr;
}

export interface InboxInput {
  text?: unknown;
  url?: unknown;
  why?: unknown;
}

export interface InboxResult {
  /** Where the card is, relative to the vault, with `/`. */
  path: string;
  /** A new card, or a link captured before that gained the new words. */
  added: 'new' | 'existing';
}

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

/**
 * What a card is made of, from what was given: a link alone is its source, a
 * link among words is the source and the words why it was kept, words alone
 * are the note. A link that is not http(s) stays words; yakala never fetches it.
 */
export function inboxParts(input: InboxInput): { url: string | null; text: string; why: string } {
  let url = clean(input.url, URL_MAX);
  let text = clean(input.text, TEXT_MAX);
  let why = clean(input.why, WHY_MAX);
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    text = [url, text].filter(Boolean).join('\n\n');
    url = '';
  }
  if (!url) {
    const found = text.match(LINK)?.[0]?.replace(/[.,;:!?)\]}'"]+$/, '') ?? '';
    if (found) {
      url = found;
      const rest = text.replace(found, '').trim();
      text = '';
      why = [rest, why].filter(Boolean).join('\n\n');
    }
  }
  return { url: url || null, text, why };
}

/** A card in the inbox, by the vault's own engine; refused with a sentence when there is nothing to keep or no engine. */
export async function captureToInbox(input: InboxInput, tool = 'pyn'): Promise<InboxResult> {
  const { url, text, why } = inboxParts(input);
  if (!url && !text) throw new Error(say('Kaydedilecek bir şey yok.', 'There is nothing to keep.'));
  const vault = readSettings().vault;
  if (!vault || !fs.existsSync(vault)) throw new Error(say('Önce bir kasa seç.', 'Choose a vault first.'));
  if (!installedVersion(vault)) throw new Error(say('Önce Cortex\'i kasaya kur (Ayarlar → Cortex).', 'Set Cortex up in the vault first (Settings → Cortex).'));
  if (!pythonOf()) throw new Error(say('Python bulunamadı.', 'Python was not found.'));
  // The link is the one item: anything else would be taken for a file's path. The words go as words.
  const args = [path.join(vault, 'beyin.py'), 'yakala', 'ekle', ...(url ? [url] : []), '--arac', tool, '--json'];
  // `--metin=…`: words that begin with a dash are still the words, not an option.
  if (text) args.push(`--metin=${text}`);
  if (why) args.push(`--neden=${why}`);
  let result: Record<string, unknown>;
  try {
    result = await runPython(args, { cwd: vault, timeout: TIMEOUT });
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    let message = said;
    try {
      const parsed = JSON.parse(said) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
    } catch {
      // not JSON: the line as it came
    }
    throw new Error(message);
  }
  if (typeof result.path !== 'string') throw new Error(say('Kart yazılamadı.', 'The card was not written.'));
  return { path: result.path.replace(/\\/g, '/'), added: result.status === 'mevcut_karta_eklendi' ? 'existing' : 'new' };
}

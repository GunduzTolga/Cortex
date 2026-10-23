/**
 * Notes from the person's phone through a Telegram bot of their own: what
 * they send it lands in the vault's inbox (`📥 000-Inbox/Yakala`), as a yakala
 * card. The vault's engine does the work (`beyin.py telegram`); the app keeps
 * the bot's key encrypted, hands it to the engine, and keeps its listener
 * running while Cortex runs (electron/services/telegram.ts).
 */

export interface TelegramStatus {
  /** A bot key is kept here (encrypted); the window never reads it back. */
  key: boolean;
  /** The vault's engine knows `telegram`; false for an engine from before 1.0.26. */
  supported: boolean;
  /** The bot's name, `@` left off; null before a key was checked. */
  bot: string | null;
  /** A chat on the person's phone opened the pairing link: the only chat the bot listens to. */
  paired: boolean;
  /** Who paired, by their first name in Telegram. */
  person: string | null;
  /** The link that pairs the phone (`https://t.me/<bot>?start=<code>`) while nobody has; null after. */
  link: string | null;
  /** The pairing code, to type into the chat where the link does not open the app. */
  code: string | null;
  /** The listener is running (this app's, or one started from a terminal). */
  listening: boolean;
  /** The last thing that went wrong, in the window's language (`telegramErrorText`); null after a round that worked. */
  error: string | null;
  /** What that was (`telegramErrorOf`): a key Telegram no longer takes is given anew where the pairing is shown; null when unknown. */
  errorCode: TelegramErrorCode | null;
  /** How many notes came in so far. */
  captured: number;
  /** Voice notes can be written out: voice typing is set up and can open a recorded file. */
  voiceNotes: boolean;
}

export interface TelegramApi {
  status(): Promise<TelegramStatus>;
  /** The key from @BotFather: checked with Telegram, kept encrypted, the listener started. */
  connect(key: string): Promise<TelegramStatus>;
  /** A new pairing link, the old pairing forgotten (another phone, another account). */
  pairAgain(): Promise<TelegramStatus>;
  /** The listener stopped, the key and the pairing forgotten; the notes that came in stay. */
  disconnect(): Promise<TelegramStatus>;
}

/** What a bot key looks like: the bot's number, a colon, then its secret. Telegram checks it again. */
export const BOT_KEY = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

/**
 * What went wrong with the bot, by name. The listener writes it beside its sentence (`son_hata_kod`: a key Telegram
 * no longer takes, the bot listened to elsewhere too, no connection, Telegram's own refusal), and `telegram kur`'s
 * refusals carry one in the engine's error JSON (`code`). An engine from before the codes is known by its Turkish
 * words, as shared/engineError.ts knows an older engine's English ones.
 */
export const TELEGRAM_ERRORS = ['anahtar_gecersiz', 'cakisma', 'baglanti', 'telegram', 'bot_degil', 'webhook', 'calisiyor', 'kurulmamis'] as const;
export type TelegramErrorCode = (typeof TELEGRAM_ERRORS)[number];

const TELEGRAM_WORDS: Array<[RegExp, TelegramErrorCode]> = [
  [/anahtarı geçersiz|bu anahtarı tanımadı/i, 'anahtar_gecersiz'],
  [/başka bir yerde de dinleniyor/i, 'cakisma'],
  [/^Bağlantı yok\b/i, 'baglanti'],
  [/bir bota ait değil/i, 'bot_degil'],
  [/\(webhook\)/i, 'webhook'],
  [/dinleyicisi çalışıyor/i, 'calisiyor'],
  [/Telegram kurulmamış/i, 'kurulmamis'],
  [/^Telegram: /, 'telegram'],
];

/** What a Telegram failure is: the code the engine gave, where it is one of these, else what its sentence tells; null when neither says. */
export function telegramErrorOf(sentence: string | null | undefined, code?: unknown): TelegramErrorCode | null {
  if (typeof code === 'string' && (TELEGRAM_ERRORS as readonly string[]).includes(code)) return code as TelegramErrorCode;
  const text = (sentence ?? '').trim();
  if (!text) return null;
  for (const [words, named] of TELEGRAM_WORDS) if (words.test(text)) return named;
  return null;
}

/** Each failure in each language: a Turkish window keeps the engine's own sentence, which can say more (why the connection broke). */
const TELEGRAM_SAID: Record<TelegramErrorCode, { tr: string; en: string }> = {
  anahtar_gecersiz: {
    tr: 'Telegram bu anahtarı kabul etmiyor. @BotFather\'dan botun anahtarını yeniden al ve buraya yapıştır.',
    en: 'Telegram does not accept this key. Get the bot\'s key again from @BotFather and paste it here.',
  },
  cakisma: {
    tr: 'Bu bot başka bir yerde de dinleniyor; Cortex için ayrı bir bot kullan.',
    en: 'This bot is listened to somewhere else too; use a bot of its own for Cortex.',
  },
  baglanti: {
    tr: 'Telegram\'a bağlanılamadı; bağlantı gelince kendiliğinden yeniden dener.',
    en: 'Telegram could not be reached; it tries again by itself once there is a connection.',
  },
  telegram: {
    tr: 'Telegram bir isteği geri çevirdi; biraz sonra yeniden dener.',
    en: 'Telegram turned a request down; it tries again in a while.',
  },
  bot_degil: {
    tr: 'Bu anahtar bir bota ait değil: @BotFather\'ın verdiği anahtarı yapıştır.',
    en: 'This key is not a bot\'s: paste the key @BotFather gave.',
  },
  webhook: {
    tr: 'Bu bot başka bir yere bağlı (webhook). Cortex için @BotFather\'dan ayrı bir bot aç.',
    en: 'This bot is tied to somewhere else (a webhook). Make a bot of its own for Cortex with @BotFather.',
  },
  calisiyor: {
    tr: 'Telegram dinleyicisi hâlâ çalışıyor; birkaç saniye sonra yeniden dene.',
    en: 'The Telegram listener is still running; try again in a few seconds.',
  },
  kurulmamis: {
    tr: 'Telegram kurulmamış: botun anahtarını yeniden ver.',
    en: 'Telegram is not set up: give the bot\'s key again.',
  },
};

/** A failure as the window says it: the engine's sentence in a Turkish window, the table's for a code in an English one; the engine's sentence where nothing is known. */
export function telegramErrorText(sentence: string | null, code: TelegramErrorCode | null, language: 'tr' | 'en'): string | null {
  if (!code) return sentence;
  if (language === 'tr' && sentence) return sentence;
  return TELEGRAM_SAID[code][language];
}

/** Every failure's sentence in both languages, for the tests: none may be missing. */
export const TELEGRAM_SENTENCES: Readonly<Record<TelegramErrorCode, { tr: string; en: string }>> = TELEGRAM_SAID;

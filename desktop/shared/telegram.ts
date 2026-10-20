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
  /** The last thing that went wrong, as the engine said it; null after a round that worked. */
  error: string | null;
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

import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, CliId, ConfigOption, PermissionKind } from '../../shared/chat';

/**
 * What the chat's two ways of talking to a CLI share (electron/services/chat.ts):
 * the Agent Client Protocol (acpChat.ts: OpenCode, Gemini CLI, Qwen Code) and
 * Claude Code's own stream of JSON (claudeChat.ts). Each is a Backend that runs
 * one turn of one chat at a time; the chat itself - kept on disk, told to the
 * window, its cards asked of the person - is the manager's.
 */

export class ChatRefusal extends Error {}

/** A turn's end that is not an answer: what was said, and what kind of trouble it is, for the window to say plainly. */
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly kind: string | null,
  ) {
    super(message);
  }
}

/** A card asking leave for a step: what it would do, and the answers the CLI offers. */
export interface Card {
  title: string;
  kind: string;
  paths: string[];
  options: Array<{ id: string; name: string; kind: PermissionKind }>;
}

/** One turn of one chat, as a backend sees it: where to run, what to continue, and how to tell what happens. */
export interface Turn {
  chatId: string;
  cli: CliId;
  vault: string;
  /**
   * Aborted when the person presses Stop. A turn still starting its CLI - a cold start, a session
   * resumed, the memory hook asked - ends there as `cancelled`, its message never sent: Stop used to
   * wait for the start, and the message it was pressed against was then sent and answered anyway.
   */
  signal: AbortSignal;
  /** The session the chat continues, or null for a new one. */
  sessionId: string | null;
  /** The turn's number in the chat since the app started, for a message the CLI gave no id. */
  number: number;
  /** What the person last chose for this CLI - its model, its mode - for a new session. */
  prefs: Readonly<Record<string, string>>;
  emit(event: ChatEvent): void;
  setOptions(options: ConfigOption[]): void;
  setSession(sessionId: string): void;
  setTitle(title: string): void;
  /** Asked of the person on a card; the option chosen, or null when refused or the turn ended first. */
  ask(card: Card): Promise<string | null>;
}

export interface Backend {
  /** One turn: the message sent, what happens told through the turn; the reason it stopped (`end_turn`, `cancelled`…), or a TurnFailure. */
  run(turn: Turn, message: string): Promise<string>;
  /** Stop the chat's turn: asked of the CLI, and the CLI ended if it does not stop in a few seconds. */
  cancel(chatId: string): void;
  /** A setting chosen: given to the CLI now where it takes it, else at its next session; the chat's settings as they are now. */
  setOption(chatId: string, options: ConfigOption[], option: string, value: string): Promise<ConfigOption[]>;
  /** The chat forgotten: anything kept running for it ended. */
  forget(chatId: string): void;
  /** Every CLI this backend started, ended. */
  shutdown(): void;
}

/** After Stop, how long a CLI has to end its turn before it is ended itself: in an object, so a test can wait less. */
export const STOP_GRACE = { ms: 8000 };
export const OUTPUT_MAX = 4000;
export const TITLE_MAX = 300;

/** A turn's setup given up because the person pressed Stop: the backend ends the turn as `cancelled`. */
export class Stopped extends Error {}

/**
 * A step of a turn's setup, or the turn's Stop, whichever comes first. Racing matters: a setup that
 * never ends - a CLI stuck in its `initialize`, a request with no answer - held the chat "running"
 * until the app was closed. The step itself goes on and is used by the next turn, or not at all.
 */
export function unlessStopped<T>(signal: AbortSignal, step: Promise<T>): Promise<T> {
  if (signal.aborted) {
    step.catch(() => undefined);
    return Promise.reject(new Stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Stopped());
    signal.addEventListener('abort', stop, { once: true });
    step.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(err);
      },
    );
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spellings = (place: string) => [...new Set([place, place.replace(/\\/g, '/'), place.replace(/\//g, '\\')])].map(escape).join('|');
/** A place's name ends where no letter or digit follows, nor a `.`, `-` or `_` before one: `Kasa` is not `Kasa2` or `Kasa.bak` beside it, and is still `Kasa` at the end of a sentence. */
const ENDS = '(?![.\\-]?[\\w\\u00C0-\\uFFFF])';
/** A place that ends with its separator - a drive's root, `D:\\` - has no name to end: anything follows it, as a path inside it does. */
const endOf = (place: string) => (/[\\/]$/.test(place) ? '' : ENDS);

/** Every spelling of the vault's place and the person's home in a text, the vault's taken off and home said as `~`. */
export function scrubberFor(vault: string, home = os.homedir()): (text: string) => string {
  const inVault = new RegExp(`(?:${spellings(vault)})${endOf(vault)}[\\\\/]?`, 'gi');
  const inHome = home ? new RegExp(`(?:${spellings(home)})${endOf(home)}`, 'gi') : null;
  return (text) => {
    const relative = text.replace(inVault, '');
    return inHome ? relative.replace(inHome, '~') : relative;
  };
}

/** How a card names the vault's place, in the window's language. */
export const vaultWord = (turkish: boolean) => (turkish ? '‹Kasa›' : '‹Vault›');

/**
 * What a card asking leave says, made safe to show but hiding nothing: the vault's place said as a
 * word (`‹Kasa›/Notes/a.md`), home as `~`, the rest as it is. The transcript's scrubber takes the
 * vault's place off, which on a card read `rm -rf "C:\Users\ayse\Kasa"` as `rm -rf ""`: the one
 * step that deletes the vault shown as a step that does nothing.
 */
export function cardTextFor(vault: string, word: string, home = os.homedir()): (text: string) => string {
  const inVault = new RegExp(`(?:${spellings(vault)})${endOf(vault)}`, 'gi');
  const inHome = home ? new RegExp(`(?:${spellings(home)})${endOf(home)}`, 'gi') : null;
  return (text) => {
    // A vault at a drive's root keeps the separator it was spelled with: `‹Kasa›\\Notes`, not `‹Kasa›Notes`.
    const named = text.replace(inVault, (found) => (/[\\/]$/.test(found) ? `${word}${found.slice(-1)}` : word));
    return inHome ? named.replace(inHome, '~') : named;
  };
}

/** A path on a card: relative to the vault with `/`, the vault itself by its word, and outside it whole (home as `~`), never cut to its file's name. */
export function cardPath(vault: string, place: string, say: (text: string) => string): string {
  const shown = shownPath(vault, place);
  return shown.startsWith('…/') || shown === '.' ? say(path.resolve(vault, place)) : shown;
}

/** Text cut for a card, the cut said: a command's harmless head never stands for the whole of it. */
export function cutSaid(text: string, max = OUTPUT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text;
}

/** A path a CLI names, as the window may see it: relative to the vault with `/`, or only its file's name outside it. */
export function shownPath(vault: string, place: string): string {
  const relative = path.relative(vault, path.resolve(vault, place));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  if (!relative) return '.';
  return `…/${path.basename(place)}`;
}

/** A string, cut to a length; anything else, empty. */
export const textOf = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** A turn's failure as the window is told it: the CLI's sentence made safe, and its kind. */
export function failureEvent(err: unknown, scrub: (text: string) => string): ChatEvent {
  const kind = err instanceof TurnFailure ? err.kind : null;
  return { type: 'error', message: scrub(err instanceof Error ? err.message : String(err)).slice(0, 1000), kind };
}

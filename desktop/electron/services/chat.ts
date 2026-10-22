import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChatEvent, ChatOpened, ChatPush, ChatSummary, CliId, CliInfo, ConfigOption } from '../../shared/chat';
import { acpBackend } from './acpChat';
import { type Backend, type Card, ChatRefusal, type Turn, failureEvent, scrubberFor } from './chatKit';
import { claudeBackend } from './claudeChat';
import { codexBackend } from './codexChat';
import { writeWhole } from './fileWrite';
import { localBackend } from './localChat';
import { LOCAL_IDS, isLocal, launchFor, listClis, protocolOf, refreshPath } from './clis';
import { findLocal } from './localModels';
import { readSettings } from './settings';
import { vaultSettled } from './setup';

export { ChatRefusal } from './chatKit';
export { scrubberFor, shownPath } from './chatKit';

/**
 * The chat on Cortex's first screen: the person writes, and one of their own
 * AI command lines (electron/services/clis.ts) answers, started in the vault
 * so that Cortex's hooks there give it the vault's memory as they do in a
 * terminal. Claude Code is spoken to in its own stream of JSON
 * (claudeChat.ts), Codex through its app server (codexChat.ts), OpenCode,
 * Gemini CLI and Qwen Code over the Agent Client Protocol (acpChat.ts). Here
 * is what they share.
 *
 * What the window is told is what the program said, made safe to show
 * (chatKit.ts): every path relative to the vault, or cut to its file's name
 * outside it; text cut to a length; nothing run, nothing opened. A step the
 * program asks leave for waits for the person's answer on a card.
 *
 * Kept in the app's own data folder (`chats/`), never in the vault: the list
 * of chats with the session each continues, and what each chat showed, so a
 * chat reopened reads as it did. The conversation itself stays the CLI's: a
 * chat continued resumes its session where the CLI can, and starts a new one
 * where it cannot.
 */

interface Stored extends ChatSummary {
  /** The vault it was held in; a chat is listed and continued only there. */
  vault: string;
  sessionId: string | null;
}

interface Index {
  version: 1;
  chats: Stored[];
  /** What the person last chose for each CLI - its model, its mode - given to every new session of it. */
  prefs: Partial<Record<CliId, Record<string, string>>>;
}

interface Live {
  stored: Stored;
  events: ChatEvent[];
  running: boolean;
  options: ConfigOption[];
  /** Answers awaited for steps the program asked leave for, by the card's id. */
  permissions: Map<string, (option: string | null) => void>;
  /** The running turn's Stop (Turn.signal). */
  stop: AbortController | null;
  turn: number;
  /** Its events counted since the app started (ChatPush.seq). */
  seq: number;
}

const CLI_IDS: readonly CliId[] = ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama', 'test', 'test-claude', 'test-codex'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_MAX = 60;
const MESSAGE_MAX = 100_000;
const EVENTS_KEPT = 2000;

const BACKENDS = { claude: claudeBackend, codex: codexBackend, acp: acpBackend, local: localBackend } as const;
const backendOf = (cli: CliId): Backend => BACKENDS[protocolOf(cli)];

let push: (message: ChatPush) => void = () => undefined;

/** Where the window hears of the chat: electron/ipc.ts sends each push on. */
export function onChatPush(listener: (message: ChatPush) => void): void {
  push = listener;
}

/* ------------------------------------------------------------------ */
/* Kept on disk                                                        */
/* ------------------------------------------------------------------ */

const folder = () => path.join(app.getPath('userData'), 'chats');
const indexFile = () => path.join(folder(), 'index.json');
const logFile = (id: string) => path.join(folder(), `${id}.json`);

let index: Index | null = null;

function readIndex(): Index {
  if (index) return index;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as Partial<Index>;
    const chats = (Array.isArray(parsed.chats) ? parsed.chats : []).filter(
      (one): one is Stored =>
        typeof one === 'object' && one !== null && ID.test(String(one.id)) && CLI_IDS.includes(one.cli) && typeof one.vault === 'string' && typeof one.title === 'string',
    );
    index = { version: 1, chats, prefs: typeof parsed.prefs === 'object' && parsed.prefs !== null ? parsed.prefs : {} };
  } catch (err) {
    // A list that will not be read is kept beside, as the settings file is, and the chat starts with none.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        fs.copyFileSync(indexFile(), path.join(folder(), `index.broken-${Date.now()}.json`));
      } catch {
        /* nothing to keep */
      }
    }
    index = { version: 1, chats: [], prefs: {} };
  }
  return index;
}

/** Written beside and renamed into place, tried again while Windows holds the file (fileWrite.ts): a list half written is never left. */
const saveIndex = () => writeWhole(indexFile(), JSON.stringify(readIndex()));

/**
 * The list saved for something a CLI said while it answered - its session, its name for the chat -
 * where a failure to write is not thrown: thrown inside the handler reading the CLI's output, it
 * stopped that handler and showed the main process's error dialog. The list is written again at
 * the next save, with it.
 */
function saveIndexQuietly(): void {
  try {
    saveIndex();
  } catch {
    /* kept in memory; written with the next save */
  }
}

/** A chat's events made short to keep: the pieces of one message joined, every word on one step joined into it. */
export function compact(events: readonly ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  // The steps of one turn: a step's id is its turn's (a local model's restart at `turn-1` with every start of the app).
  const tools = new Map<string, Extract<ChatEvent, { type: 'tool' }>>();
  for (const event of events) {
    if (event.type === 'user') tools.clear();
    const last = out[out.length - 1];
    if ((event.type === 'text' || event.type === 'thought') && last?.type === event.type && last.id === event.id) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else if (event.type === 'tool') {
      const had = tools.get(event.id);
      if (had) Object.assign(had, Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)));
      else {
        const copy = { ...event };
        tools.set(event.id, copy);
        out.push(copy);
      }
    } else {
      out.push(event);
    }
  }
  return out.slice(-EVENTS_KEPT);
}

function readLog(id: string): ChatEvent[] {
  try {
    const events = JSON.parse(fs.readFileSync(logFile(id), 'utf8')) as unknown;
    return Array.isArray(events) ? events.filter((one): one is ChatEvent => typeof one === 'object' && one !== null && typeof (one as { type?: unknown }).type === 'string') : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* The chats                                                           */
/* ------------------------------------------------------------------ */

const live = new Map<string, Live>();

function currentVault(): string {
  const vault = readSettings().vault;
  if (!vault) throw new ChatRefusal('Choose the vault first.');
  return vault;
}

const summaryOf = (stored: Stored): ChatSummary => ({ id: stored.id, title: stored.title, cli: stored.cli, createdAt: stored.createdAt, updatedAt: stored.updatedAt });

function storedOf(id: unknown): Stored {
  if (typeof id !== 'string' || !ID.test(id)) throw new ChatRefusal('Not a chat.');
  const stored = readIndex().chats.find((one) => one.id === id);
  if (!stored) throw new ChatRefusal('That chat is gone.');
  return stored;
}

const fresh = (stored: Stored, events: ChatEvent[]): Live => ({ stored, events, running: false, options: [], permissions: new Map(), stop: null, turn: 0, seq: 0 });

function liveOf(id: unknown): Live {
  const stored = storedOf(id);
  let chat = live.get(stored.id);
  if (!chat) {
    chat = fresh(stored, readLog(stored.id));
    live.set(stored.id, chat);
  }
  return chat;
}

function emit(chat: Live, event: ChatEvent): void {
  chat.events.push(event);
  chat.seq += 1;
  push({ chatId: chat.stored.id, event, seq: chat.seq });
}

function setState(chat: Live, change: Partial<Pick<Live, 'running' | 'options'>>): void {
  Object.assign(chat, change);
  push({ chatId: chat.stored.id, state: { running: chat.running, options: chat.options } });
}

function saveLog(chat: Live): void {
  chat.events = compact(chat.events);
  try {
    writeWhole(logFile(chat.stored.id), JSON.stringify(chat.events));
  } catch {
    /* What was shown stays on screen; it is kept again at the next turn's end. */
  }
}

/** A card shown, and the person's answer awaited: the option chosen, or null when refused or the turn ended first. */
async function askPerson(chat: Live, card: Card): Promise<string | null> {
  const id = randomUUID();
  emit(chat, { type: 'permission', id, ...card });
  const option = await new Promise<string | null>((resolve) => chat.permissions.set(id, resolve));
  chat.permissions.delete(id);
  const chosen = option !== null && card.options.some((one) => one.id === option) ? option : null;
  emit(chat, { type: 'answered', id, option: chosen });
  return chosen;
}

/** Whether the chat is still one of the chats: a chat deleted while it answered is not written back. */
const kept = (chat: Live) => live.get(chat.stored.id) === chat;

/** The turn a backend runs, told through this chat. */
function turnOf(chat: Live, signal: AbortSignal): Turn {
  const stored = chat.stored;
  return {
    chatId: stored.id,
    cli: stored.cli,
    vault: stored.vault,
    sessionId: stored.sessionId,
    number: chat.turn,
    prefs: readIndex().prefs[stored.cli] ?? {},
    signal,
    emit: (event) => chat.running && emit(chat, event),
    setOptions: (options) => setState(chat, { options }),
    setSession: (sessionId) => {
      if (stored.sessionId === sessionId || !kept(chat)) return;
      stored.sessionId = sessionId;
      saveIndexQuietly();
    },
    setTitle: (title) => {
      // A name given late, for a chat deleted since, would put it back in the list.
      if (!kept(chat)) return;
      stored.title = title.slice(0, TITLE_MAX);
      saveIndexQuietly();
      push({ chatId: stored.id, summary: summaryOf(stored) });
    },
    // After Stop nothing more is asked: a step that a CLI which does not stop asks leave for is refused, unshown.
    ask: (card) => (chat.running && !signal.aborted ? askPerson(chat, card) : Promise.resolve(null)),
  };
}

/** A restart of the CLIs asked for while a turn went on, made when the last turn ends (restartIdleChats). */
let restartWanted = false;

async function run(chat: Live, message: string): Promise<void> {
  const stop = new AbortController();
  chat.stop = stop;
  try {
    // The vault just opened is bound to where it is first, so its hooks point there (services/setup.ts); Stop ends the wait.
    await Promise.race([vaultSettled(), new Promise((done) => stop.signal.addEventListener('abort', done, { once: true }))]);
    // Stopped while it waited: the CLI is not started for a turn already ended.
    const reason = stop.signal.aborted ? 'cancelled' : await backendOf(chat.stored.cli).run(turnOf(chat, stop.signal), message);
    emit(chat, { type: 'done', reason });
  } catch (err) {
    emit(chat, failureEvent(err, scrubberFor(chat.stored.vault)));
  } finally {
    if (chat.stop === stop) chat.stop = null;
    for (const answer of chat.permissions.values()) answer(null);
    chat.permissions.clear();
    setState(chat, { running: false });
    // A chat deleted while it answered leaves nothing behind: its log is not written again.
    if (kept(chat)) saveLog(chat);
    if (restartWanted && ![...live.values()].some((one) => one.running)) shutdownChats();
  }
}

/** Every CLI, the model servers on this machine asked first: one is offered while it is up with a model. */
export async function listChatClis(): Promise<CliInfo[]> {
  // A tool installed since the app started is found without opening it again.
  await Promise.all([refreshPath(), ...LOCAL_IDS.map((one) => findLocal(one))]);
  return listClis();
}

export function listChats(): ChatSummary[] {
  const vault = readSettings().vault;
  return readIndex()
    .chats.filter((one) => one.vault === vault)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summaryOf);
}

export function openChat(id: unknown): ChatOpened {
  const chat = liveOf(id);
  return { chat: summaryOf(chat.stored), events: compact(chat.events), running: chat.running, options: chat.options, seq: chat.seq };
}

/** A message to a chat, or to a new chat with that CLI. Answered at once with the chat's id; the answer itself comes as pushes. */
export function sendChat(id: unknown, cli: unknown, message: unknown): { id: string } {
  if (typeof message !== 'string' || !message.trim()) throw new ChatRefusal('An empty message is not sent.');
  if (message.length > MESSAGE_MAX) throw new ChatRefusal('That message is too long to send.');
  const vault = currentVault();
  let chat: Live;
  if (id === null) {
    if (!CLI_IDS.includes(cli as CliId)) throw new ChatRefusal('Not a CLI the chat knows.');
    // A model server is asked when the chat runs; one that is off says so in the chat.
    if (!isLocal(cli as CliId) && !launchFor(cli as CliId)) throw new ChatRefusal(`${cli} is not installed on this machine.`);
    const now = Date.now();
    const stored: Stored = { id: randomUUID(), title: '', cli: cli as CliId, createdAt: now, updatedAt: now, vault, sessionId: null };
    readIndex().chats.push(stored);
    chat = fresh(stored, []);
    live.set(stored.id, chat);
  } else {
    chat = liveOf(id);
    if (chat.stored.vault !== vault) throw new ChatRefusal('That chat was held in another vault.');
  }
  if (chat.running) throw new ChatRefusal('Wait for the answer, or stop it, before writing again.');
  chat.turn += 1;
  emit(chat, { type: 'user', text: message, at: Date.now() });
  if (!chat.stored.title) chat.stored.title = message.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  chat.stored.updatedAt = Date.now();
  saveIndex();
  push({ chatId: chat.stored.id, summary: summaryOf(chat.stored) });
  setState(chat, { running: true });
  void run(chat, message);
  return { id: chat.stored.id };
}

/** Stop the answer: a card waiting is answered "no", and the CLI is asked to end its turn. */
export function cancelChat(id: unknown): void {
  const chat = liveOf(id);
  if (!chat.running) return;
  for (const answer of chat.permissions.values()) answer(null);
  // A turn still starting its CLI ends here; one under way is asked of its CLI to end.
  chat.stop?.abort();
  backendOf(chat.stored.cli).cancel(chat.stored.id);
}

export function answerChat(id: unknown, permission: unknown, option: unknown): void {
  const chat = liveOf(id);
  if (typeof permission !== 'string') return;
  chat.permissions.get(permission)?.(typeof option === 'string' ? option : null);
}

/** A setting of the chat's session - the model, the mode - chosen, and kept as the person's choice for this CLI's next sessions. */
export async function setChatOption(id: unknown, option: unknown, value: unknown): Promise<ConfigOption[]> {
  const chat = liveOf(id);
  if (typeof option !== 'string' || typeof value !== 'string') throw new ChatRefusal('Not a setting.');
  const known = chat.options.find((one) => one.id === option);
  if (!known || !known.choices.some((choice) => choice.value === value)) throw new ChatRefusal('Not a choice this chat offers.');
  if (chat.running) throw new ChatRefusal('Wait for the answer to end before changing this.');
  setState(chat, { options: await backendOf(chat.stored.cli).setOption(chat.stored.id, chat.options, option, value) });
  const prefs = readIndex().prefs;
  prefs[chat.stored.cli] = { ...(prefs[chat.stored.cli] ?? {}), [option]: value };
  saveIndex();
  return chat.options;
}

export function renameChat(id: unknown, title: unknown): ChatSummary {
  const stored = storedOf(id);
  if (typeof title !== 'string' || !title.trim()) throw new ChatRefusal('A chat needs a name.');
  stored.title = title.trim().slice(0, 120);
  saveIndex();
  return summaryOf(stored);
}

/** A chat forgotten: its entry and what it showed. The CLI's own record of the session is the CLI's, and is left. */
export function removeChat(id: unknown): void {
  const stored = storedOf(id);
  const chat = live.get(stored.id);
  if (chat?.running) cancelChat(stored.id);
  backendOf(stored.cli).forget(stored.id);
  live.delete(stored.id);
  const list = readIndex();
  list.chats = list.chats.filter((one) => one.id !== stored.id);
  saveIndex();
  fs.rmSync(logFile(stored.id), { force: true });
}

/** Every program ended: the app is closing, or another vault was chosen. */
export function shutdownChats(): void {
  restartWanted = false;
  for (const backend of Object.values(BACKENDS)) backend.shutdown();
}

/**
 * A sign-in, a key or an install changed while CLIs were kept running: they are ended between
 * turns, and each chat's next message starts its CLI again with it, its session resumed. A CLI
 * started before kept the key or sign-in it started with, and the chat kept failing until the app
 * was opened again. Not while a turn is going on - a card waiting on the person included - that
 * one is not cut off: the restart is made when the last turn ends. Whether it was made now.
 */
export function restartIdleChats(): boolean {
  if ([...live.values()].some((one) => one.running)) {
    restartWanted = true;
    return false;
  }
  shutdownChats();
  return true;
}

/** For tests: forget what is held in memory, as a restart would. */
export function forgetChats(): void {
  shutdownChats();
  live.clear();
  index = null;
}

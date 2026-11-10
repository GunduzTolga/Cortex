import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChatEvent, ChatOpened, ChatPush, ChatSpend, ChatSummary, CliId, CliInfo, ConfigOption } from '../../shared/chat';
import { ATTACHING_CLIS } from '../../shared/chat';
import { heldAttachments, type HeldAttachment } from './attachments';
import { acpBackend } from './acpChat';
import { type Backend, type Between, type Card, ChatRefusal, type Turn, failureEvent, scrubberFor } from './chatKit';
import { claudeBackend } from './claudeChat';
import { codexBackend } from './codexChat';
import { writeWhole } from './fileWrite';
import { hermesBackend } from './hermesChat';
import { localBackend } from './localChat';
import { LOCAL_IDS, isServer, launchFor, listClis, protocolOf, refreshPath } from './clis';
import { findLocal } from './localModels';
import { CHAT_TOOLS, readSettings } from './settings';
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
  /**
   * The settings its engine last offered (model, mode, effort), shown again once the app is opened anew: they came
   * only with a turn, and a chat reopened had its tool's chip alone until the next message (29 October).
   */
  options?: ConfigOption[];
  /** The last running total a tool told for this chat's session (the spend event's `total`), to take the next rise from. */
  spendMark?: { session: string; usd: number };
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
  /** The options are the ones kept from before the app started (Stored.options), not yet offered by the engine now. */
  stale: boolean;
  /** Answers awaited for steps the program asked leave for, by the card's id. */
  permissions: Map<string, (option: string | null) => void>;
  /** The running turn's Stop (Turn.signal). */
  stop: AbortController | null;
  turn: number;
  /** Its events counted since the app started (ChatPush.seq). */
  seq: number;
  /** Its history on disk was not read (held by another program): what is said now is not saved over it (saveLog). */
  unread: boolean;
}

const CLI_IDS: readonly CliId[] = ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama', 'hermes', 'test', 'test-claude', 'test-codex'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_MAX = 60;
const MESSAGE_MAX = 100_000;
const EVENTS_KEPT = 2000;

const BACKENDS = { claude: claudeBackend, codex: codexBackend, acp: acpBackend, local: localBackend, hermes: hermesBackend } as const;
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
  let text: string | null = null;
  try {
    text = fs.readFileSync(indexFile(), 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Partial<Index>;
    const chats = (Array.isArray(parsed.chats) ? parsed.chats : []).filter(
      (one): one is Stored =>
        typeof one === 'object' && one !== null && ID.test(String(one.id)) && CLI_IDS.includes(one.cli) && typeof one.vault === 'string' && typeof one.title === 'string',
    );
    index = { version: 1, chats, prefs: typeof parsed.prefs === 'object' && parsed.prefs !== null ? parsed.prefs : {} };
  } catch (err) {
    // A list that will not be read is kept beside, as the settings file is, and the chat starts with none. One the disk
    // would not hand over (another program holding it) is not damaged: nothing is written over it in this run, as the
    // settings file is not (30 October: a list held at the start was taken as damaged, no copy was made of it, and
    // the next chat's save left a list of one).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      indexBroken = text === null ? 'left' : 'damaged';
      if (text !== null) {
        try {
          fs.copyFileSync(indexFile(), path.join(folder(), `index.broken-${Date.now()}.json`));
          indexBroken = 'copied';
        } catch {
          /* no copy made: the damaged list is left as it is */
        }
      }
      // Said once to the window (ipc.ts, chat:list): every chat went from the list and nothing told why (29 October).
      indexLeft = indexBroken !== 'copied';
    }
    index = { version: 1, chats: [], prefs: {} };
  }
  return index;
}

/** The list on disk was not read and is left as it is: nothing is saved over it until the app starts again. */
let indexLeft = false;

/** Written beside and renamed into place, tried again while Windows holds the file (fileWrite.ts): a list half written is never left. */
const saveIndex = () => {
  const now = readIndex();
  if (!indexLeft) writeWhole(indexFile(), JSON.stringify(now));
};

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

/** The chat's events as kept; null when the disk would not hand them over (another program holding the file). */
function readLog(id: string): ChatEvent[] | null {
  let text: string;
  try {
    text = fs.readFileSync(logFile(id), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  try {
    const events = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
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

const summaryOf = (stored: Stored): ChatSummary => ({
  id: stored.id,
  title: stored.title,
  cli: stored.cli,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  ...(validSpend(stored.spend) ? { spend: stored.spend } : {}),
});

/** A total read back from the list as it can be: numbers that are numbers, or none (a hand-edited or older list). */
function validSpend(spend: unknown): spend is ChatSpend {
  const one = spend as ChatSpend | undefined;
  return typeof one === 'object' && one !== null && (one.usd === null || (typeof one.usd === 'number' && Number.isFinite(one.usd) && one.usd >= 0)) && typeof one.tokens === 'number' && Number.isFinite(one.tokens) && one.tokens >= 0 && typeof one.subscription === 'boolean';
}

/** A turn's cost added to its chat's: dollars stay none until one turn says them; the list hears it at once. */
export function addSpend(stored: Stored, turn: Extract<ChatEvent, { type: 'spend' }>): void {
  const had = validSpend(stored.spend) ? stored.spend : { usd: null, tokens: 0, subscription: turn.subscription };
  let usd = turn.usd === null || !Number.isFinite(turn.usd) || turn.usd < 0 ? had.usd : (had.usd ?? 0) + turn.usd;
  const total = turn.total;
  if (total && typeof total.session === 'string' && Number.isFinite(total.usd) && total.usd >= 0) {
    // The rise since the session's last total; a session not seen before (a new one, or one from before totals were
    // kept) counts whole, which is what it has cost this chat.
    const mark = stored.spendMark;
    const rise = mark && mark.session === total.session && total.usd >= mark.usd ? total.usd - mark.usd : total.usd;
    usd = (usd ?? 0) + rise;
    stored.spendMark = { session: total.session, usd: total.usd };
  }
  const tokens = had.tokens + (Number.isFinite(turn.tokens) && turn.tokens > 0 ? Math.round(turn.tokens) : 0);
  stored.spend = { usd, tokens, subscription: had.subscription || turn.subscription };
}

function storedOf(id: unknown): Stored {
  if (typeof id !== 'string' || !ID.test(id)) throw new ChatRefusal('Not a chat.');
  const stored = readIndex().chats.find((one) => one.id === id);
  if (!stored) throw new ChatRefusal('That chat is gone.');
  return stored;
}

// The options kept are shown again only for an engine that takes a choice before its session runs; an ACP agent
// refuses one until it is connected, so its chips would refuse every pick.
const keptOptions = (stored: Stored): ConfigOption[] | null => (Array.isArray(stored.options) && protocolOf(stored.cli) !== 'acp' ? stored.options : null);
const fresh = (stored: Stored, events: ChatEvent[] | null): Live => ({
  stored,
  events: events ?? [],
  running: false,
  options: keptOptions(stored) ?? [],
  stale: keptOptions(stored) !== null,
  permissions: new Map(),
  stop: null,
  turn: 0,
  seq: 0,
  unread: events === null,
});

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
  if (change.options) chat.stale = false;
  if (change.options?.length && kept(chat)) {
    chat.stored.options = change.options;
    saveIndexQuietly();
  }
  push({ chatId: chat.stored.id, state: { running: chat.running, options: chat.options } });
}

function saveLog(chat: Live): void {
  chat.events = compact(chat.events);
  // A history not read is not written over with what was said since: read as none, the chat's past was lost at its next turn.
  if (chat.unread) return;
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
function turnOf(chat: Live, signal: AbortSignal, attachments: readonly HeldAttachment[] = []): Turn {
  const stored = chat.stored;
  return {
    chatId: stored.id,
    cli: stored.cli,
    vault: stored.vault,
    sessionId: stored.sessionId,
    attachments,
    number: chat.turn,
    // A chat reopened after a restart runs as its chips say: its engine had not seen the options kept for it, and
    // started with the CLI's last choices while the chip showed the chat's own ("Önce sor" shown, edits accepted: 30 October).
    prefs: { ...(readIndex().prefs[stored.cli] ?? {}), ...(chat.stale ? Object.fromEntries(chat.options.map((one) => [one.id, one.current])) : {}) },
    signal,
    emit: (event) => {
      if (!chat.running) return;
      // A turn's cost goes to the chat's total in the list, not into what the chat shows.
      if (event.type === 'spend') {
        if (!kept(chat)) return;
        addSpend(stored, event);
        saveIndexQuietly();
        push({ chatId: stored.id, summary: summaryOf(stored) });
        return;
      }
      emit(chat, event);
    },
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

async function run(chat: Live, message: string, files: readonly HeldAttachment[] = []): Promise<void> {
  const stop = new AbortController();
  chat.stop = stop;
  try {
    // The vault just opened is bound to where it is first, so its hooks point there (services/setup.ts); Stop ends the wait.
    await Promise.race([vaultSettled(), new Promise((done) => stop.signal.addEventListener('abort', done, { once: true }))]);
    // Stopped while it waited: the CLI is not started for a turn already ended.
    const reason = stop.signal.aborted ? 'cancelled' : await backendOf(chat.stored.cli).run(turnOf(chat, stop.signal, files), message);
    // Once Stop was asked for, the turn was stopped, whatever the CLI reports: an agent asked to end while a card
    // waited said end_turn, and what it wrote after Stop read as a finished answer (29 October).
    emit(chat, { type: 'done', reason: stop.signal.aborted ? 'cancelled' : reason });
  } catch (err) {
    // A program ended under a stopped turn (Stop, or the app closing: shutdownChats) did not fail: it was stopped.
    emit(chat, stop.signal.aborted ? { type: 'done', reason: 'cancelled' } : failureEvent(err, scrubberFor(chat.stored.vault), !isServer(chat.stored.cli)));
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
  return offered(listClis(), readSettings().chatTools);
}

/**
 * The tools the person chose (settings.ts, chooseChatTool) offered, the others listed as not: a chat begun with one goes
 * on, and it is a sign-in away in the AI tools window. A model server, Hermes and the stand-ins are offered as before.
 */
export function offered(clis: CliInfo[], chosen: readonly CliId[] | null): CliInfo[] {
  if (!chosen) return clis;
  return clis.map((one) => (CHAT_TOOLS.includes(one.id) && !chosen.includes(one.id) ? { ...one, available: false } : one));
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
  offerTo(chat);
  return { chat: summaryOf(chat.stored), events: compact(chat.events), running: chat.running, options: chat.options, seq: chat.seq };
}

/** A chat opened before any turn of it ran since the app started: the settings its engine has without one (Hermes's sessions), pushed once asked. */
function offerTo(chat: Live): void {
  const backend = backendOf(chat.stored.cli);
  // Kept options are asked again: an engine that offers its own (Hermes's sessions) lists them as they are now.
  if (!backend.offer || chat.running || (chat.options.length && !chat.stale)) return;
  backend.offer(chat.stored.sessionId).then(
    (options) => {
      if (kept(chat) && !chat.running && (!chat.options.length || chat.stale) && options.length) setState(chat, { options });
    },
    () => undefined,
  );
}

/** The settings shown in a new chat with each CLI before its first message, as chosen there: its first turn starts with them. */
const shownNew = new Map<CliId, ConfigOption[]>();

/** The settings with the person's last choices for the CLI as their current ones, where each is still one of its choices. */
const withPrefs = (options: ConfigOption[], prefs: Readonly<Record<string, string>>): ConfigOption[] =>
  options.map((one) => (prefs[one.id] !== undefined && one.choices.some((choice) => choice.value === prefs[one.id]) ? { ...one, current: prefs[one.id] } : one));

/**
 * The settings a new chat with that CLI has before its first message. Hermes: its sessions, to continue one. Claude
 * Code, Codex and the ACP tools: the model and the mode it will start with (2 November: "ilk mesaj kısmında sadece
 * opencode seçebiliyorum.. mesaj attıktan sonra model seçme vs geliyor"): those its last chat was offered, else asked of
 * the CLI itself (Backend.probe), the person's last choices current. None for the rest, or where they cannot be asked.
 */
export async function offerChat(cli: unknown): Promise<ConfigOption[]> {
  if (!CLI_IDS.includes(cli as CliId)) throw new ChatRefusal('Not a CLI the chat knows.');
  const id = cli as CliId;
  const backend = backendOf(id);
  if (backend.offer) return backend.offer(null).catch(() => []);
  if (!backend.probe) return [];
  const prefs = readIndex().prefs[id] ?? {};
  const last = readIndex()
    .chats.filter((one) => one.cli === id && Array.isArray(one.options) && one.options.length)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.options;
  let options = last ?? [];
  if (!options.length) {
    try {
      options = await backend.probe(id, currentVault(), prefs);
    } catch {
      options = [];
    }
  }
  const shown = withPrefs(options, prefs);
  shownNew.set(id, shown);
  return shown;
}

/**
 * A setting chosen in a new chat before its first message. Hermes: the chat begun on it (a session continued). The
 * others: kept as the person's choice for the CLI, the chat begun by its first message with it; no chat yet (id null),
 * the settings as they are now.
 */
async function preferChat(id: CliId, option: string, value: string): Promise<{ id: null; options: ConfigOption[] }> {
  const backend = backendOf(id);
  const options = shownNew.get(id) ?? (await offerChat(id));
  if (!options.find((one) => one.id === option)?.choices.some((one) => one.value === value)) throw new ChatRefusal('Not a choice this chat offers.');
  const prefs = readIndex().prefs;
  prefs[id] = { ...(prefs[id] ?? {}), [option]: value };
  saveIndex();
  const chosen = options.map((one) => (one.id === option ? { ...one, current: value } : one));
  const next = backend.prefer ? await backend.prefer(id, chosen, option, value).catch(() => chosen) : chosen;
  shownNew.set(id, next);
  return { id: null, options: next };
}

/**
 * A new chat begun on a setting chosen before its first message - Hermes: a session begun
 * elsewhere, continued here, its last messages shown - and named after the choice; its id.
 */
export async function beginChat(cli: unknown, option: unknown, value: unknown): Promise<{ id: string | null; options?: ConfigOption[] }> {
  const vault = currentVault();
  if (!CLI_IDS.includes(cli as CliId)) throw new ChatRefusal('Not a CLI the chat knows.');
  if (typeof option !== 'string' || typeof value !== 'string') throw new ChatRefusal('Not a setting.');
  const backend = backendOf(cli as CliId);
  if (!backend.offer) return preferChat(cli as CliId, option, value);
  const options = backend.offer ? await backend.offer(null) : [];
  const choice = options.find((one) => one.id === option)?.choices.find((one) => one.value === value);
  if (!choice) throw new ChatRefusal('Not a choice this chat offers.');
  const now = Date.now();
  const stored: Stored = { id: randomUUID(), title: choice.name.slice(0, TITLE_MAX), cli: cli as CliId, createdAt: now, updatedAt: now, vault, sessionId: null };
  const chat = fresh(stored, []);
  chat.options = options;
  readIndex().chats.push(stored);
  live.set(stored.id, chat);
  try {
    await setChatOption(stored.id, option, value);
  } catch (err) {
    // Not begun after all: nothing of it left in the list.
    live.delete(stored.id);
    readIndex().chats = readIndex().chats.filter((one) => one.id !== stored.id);
    saveIndexQuietly();
    throw err;
  }
  push({ chatId: stored.id, summary: summaryOf(stored) });
  return { id: stored.id };
}

/** A message to a chat, or to a new chat with that CLI. Answered at once with the chat's id; the answer itself comes as pushes. */
export function sendChat(id: unknown, cli: unknown, message: unknown, attachments?: unknown): { id: string } {
  const files = heldAttachments(attachments);
  if (typeof message !== 'string' || (!message.trim() && !files.length)) throw new ChatRefusal('An empty message is not sent.');
  if (message.length > MESSAGE_MAX) throw new ChatRefusal('That message is too long to send.');
  const vault = currentVault();
  let chat: Live;
  if (id === null) {
    if (!CLI_IDS.includes(cli as CliId)) throw new ChatRefusal('Not a CLI the chat knows.');
    // A model server, or Hermes on another machine, is asked when the chat runs; one that is off says so in the chat.
    if (!isServer(cli as CliId) && !launchFor(cli as CliId)) throw new ChatRefusal(`${cli} is not installed on this machine.`);
    const now = Date.now();
    const stored: Stored = { id: randomUUID(), title: '', cli: cli as CliId, createdAt: now, updatedAt: now, vault, sessionId: null };
    readIndex().chats.push(stored);
    chat = fresh(stored, []);
    // What the new chat showed before its first message is what its first turn starts with: run as its chips say, as a
    // chat reopened after a restart is (turnOf).
    const shown = shownNew.get(cli as CliId);
    if (shown?.length) {
      chat.options = shown;
      chat.stale = true;
    }
    live.set(stored.id, chat);
  } else {
    chat = liveOf(id);
    if (chat.stored.vault !== vault) throw new ChatRefusal('That chat was held in another vault.');
  }
  if (chat.running) throw new ChatRefusal('Wait for the answer, or stop it, before writing again.');
  if (files.length && !ATTACHING_CLIS.includes(chat.stored.cli)) throw new ChatRefusal('This tool does not take attachments.');
  chat.turn += 1;
  emit(chat, { type: 'user', text: message, at: Date.now(), ...(files.length ? { attachments: files.map((one) => ({ name: one.name, kind: one.kind })) } : {}) });
  if (!chat.stored.title) chat.stored.title = (message.trim() || files[0]?.name || '').replace(/\s+/g, ' ').slice(0, TITLE_MAX);
  chat.stored.updatedAt = Date.now();
  saveIndex();
  push({ chatId: chat.stored.id, summary: summaryOf(chat.stored) });
  setState(chat, { running: true });
  void run(chat, message, files);
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
  // A session chosen to continue (Hermes) binds the chat to it, and shows where its conversation left off.
  const between: Between = {
    emit: (event) => emit(chat, event),
    setSession: (sessionId) => {
      if (!kept(chat)) return;
      chat.stored.sessionId = sessionId;
      saveIndexQuietly();
    },
  };
  setState(chat, { options: await backendOf(chat.stored.cli).setOption(chat.stored.id, chat.options, option, value, between) });
  if (kept(chat)) saveLog(chat);
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

/** Whether the chat list would not be read and was begun again, since this was last asked: said once, then forgotten. */
let indexBroken: 'copied' | 'left' | 'damaged' | false = false;
/**
 * Whether the list began empty because it was not read: damaged and a copy kept beside it, held by another program and
 * left as it was, or damaged and left as it was (no copy could be made). Said once.
 */
export function takeIndexBroken(): 'copied' | 'left' | 'damaged' | false {
  const was = indexBroken;
  indexBroken = false;
  return was;
}

/** Every program ended: the app is closing, or another vault was chosen. */
export function shutdownChats(closing = false): void {
  restartWanted = false;
  // A chat answering as Cortex closes is stopped first: ended by its program going, it was kept as the tool having
  // failed ("Program durdu.") and reopened that way (29 October). Another vault chosen mid-answer is still said as
  // the tool having stopped: the person did not stop it, the vault under it went.
  if (closing) for (const chat of live.values()) if (chat.running) chat.stop?.abort();
  for (const backend of Object.values(BACKENDS)) backend.shutdown();
}

/** Whether a chat is answering now, a card waiting on the person included. */
export const chatsRunning = (): boolean => [...live.values()].some((one) => one.running);

/**
 * A sign-in, a key or an install changed while CLIs were kept running: they are ended between
 * turns, and each chat's next message starts its CLI again with it, its session resumed. A CLI
 * started before kept the key or sign-in it started with, and the chat kept failing until the app
 * was opened again. Not while a turn is going on - a card waiting on the person included - that
 * one is not cut off: the restart is made when the last turn ends. Whether it was made now.
 */
export function restartIdleChats(): boolean {
  if (chatsRunning()) {
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
  shownNew.clear();
  index = null;
  indexLeft = false;
  indexBroken = false;
}

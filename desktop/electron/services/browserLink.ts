import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import {
  BROWSER_LINK_PROTOCOL,
  type BrowserLinkStatus,
  type BrowserMessage,
  type CortexMessage,
  type ErrorCode,
  LIMITS,
  type LinkEvent,
  type LinkPermission,
  type LinkTool,
  RENDEZVOUS_FILE,
  type Rendezvous,
  STATUS_PHASES,
  type StatusPhase,
  cutTo,
  encodeLine,
  longerThan,
  parseBrowserLine,
} from '../../shared/browserLink';
import type { ChatEvent, CliId, CliInfo } from '../../shared/chat';
import { PAGE_TEXT_MAX } from './browserPage';
import { type ChatHeard, ChatRefusal, MESSAGE_MAX, answerChat, browserChat, cancelChat, chatAnswering, chatCli, listChatClis, listChats, sendChat, tapChat, toolPermission } from './chat';
import { writeWhole } from './fileWrite';
import { captureToInbox } from './inbox';
import { readSettings, updateSettings } from './settings';

/**
 * Cortex's end of the link to Cortex Browser (shared/browserLink.ts, shared/browser-link-contract.json): the browser's
 * assistant asks, and the AI tool the person uses in Cortex answers, in a chat of this vault's that can be read and
 * gone on with here (services/chat.ts).
 *
 * Nothing listens until the link is opened: by the person in the settings, or by the browser starting Cortex for it
 * (`--tarayici`), which keeps it open from then on. Closed by the person in the settings, it stays closed: the
 * browser's word does not open it again, only the person does, and the meeting file says so (`off`) for the browser
 * not to try. Open, it is a named pipe on Windows and a socket elsewhere, under
 * a name drawn anew each time; no port is opened, so a web page cannot reach it and no firewall asks. The socket lies
 * in a folder only the person may enter, made so before anything listens in it. Who may open the pipe on Windows is
 * Node's default for a pipe, which Cortex does not narrow and which has not been looked at on a Windows machine
 * (docs/v3/BROWSER-LINK.md says how to): nothing here leans on it.
 *
 * Where the link is, is written in the data folder at every start (`browser-link.json`: the pipe, or none while the
 * listener is closed; the program to start; the process) and left there when Cortex closes: the file says Cortex is
 * installed and where, never that it runs.
 *
 * Whoever can open the pipe can connect. What tells the browser from another program is leave given once, in Cortex:
 * a connection that shows no token Cortex knows is told to wait, with a short code, while the person is asked and
 * shown the same code; it is given a token when they allow it. Cortex keeps the token's SHA-256 (services/settings.ts),
 * never the token, and writes it nowhere else: no line here logs what a message carried. One token holds at a time: a
 * new leave, or the leave taken back, closes every link the earlier one let in, whichever step it was at. This sets
 * apart the program the person meant to let in; it is no wall against one of their own programs that reads the
 * browser's files, which could read their notes as well.
 *
 * A stranger is given little to spend: a line before it is let in is short (LIMITS.line_bytes_before_hello_ok), a
 * link that says no hello is closed after a while, a full house drops its oldest stranger for a newcomer, and the
 * person is not asked about a refused browser again at will (REASK).
 *
 * A question becomes a turn of a chat, with the tool a new chat in Cortex would be written to, or the conversation's
 * own once it has one; its first status says which. A page added to a question is not sent to a tool Cortex cannot
 * hold to asking unless the person, warned in the browser, said so. What the chat shows is passed on as the
 * contract's events: the answer's words, a card asking leave, its answer wherever it was given, the end. The tool's
 * thinking and its steps stay in Cortex. A question written in Cortex to the same chat is answered in Cortex alone. A
 * browser that goes in the middle of an answer leaves the answer going: it is the chat's, and a card it waits on can
 * be answered here.
 */

/** More connections at once than these are not taken: a browser opens one. */
export const MAX_CONNECTIONS = 8;
/** What is waiting to be written to a browser that does not read: past this, its link is closed. */
const WRITE_MAX = 64 * 1024 * 1024;
/** The format of the meeting file. */
const RENDEZVOUS_VERSION = 1;
/** How long a connection may stay without a hello (LIMITS.hello_wait_ms); in an object, so a test need not wait. */
export const HELLO_WAIT: { ms: number } = { ms: LIMITS.hello_wait_ms };
/**
 * After a refusal the person is not asked again at once, however often the browser says hello: after `ms`, twice as
 * long after each refusal that follows, `max` at most. "Ask again", pressed by the person in the browser, passes over
 * that wait - once in `again` at most. Refused `lock` times running, no hello asks any more until the person says so
 * in the settings (allowBrowserFromSettings) or Cortex is opened again. With its clock, so a test need not wait.
 */
export const REASK = { ms: 30_000, max: 10 * 60_000, again: 60_000, lock: 3, now: (): number => Date.now() };
/** How long after its last question a browser that has gone still counts as there (browserLinkBusy). */
const BUSY_AFTER_ASK = 10 * 60_000;

/** `new`: no leave; `waiting`: the person is being asked; `welcoming`: let in, its welcome on the way; `paired`. */
type Stage = 'new' | 'waiting' | 'welcoming' | 'paired' | 'closed';

interface Conn {
  socket: net.Socket;
  stage: Stage;
  /** It has said a hello of this protocol: counted as a browser there (onBrowserLink). */
  greeted: boolean;
  /** Closes it if it has said no hello by then. */
  helloTimer: ReturnType<typeof setTimeout> | null;
  /** The code it was told with "waiting", shown to the person when it is the one asked about. */
  code: string | null;
  /** The digest of the token it was let in by: a link is paired only while that is still the one kept. */
  digest: string | null;
  /** The bytes of a line not ended yet, and how many of them are in. */
  held: Buffer | null;
  used: number;
  /** Its messages are taken one after another: a question sent right behind a hello waits for the hello's answer. */
  work: Promise<void>;
  asks: Map<string, Ask>;
}

interface Ask {
  id: string;
  conn: Conn;
  conversation: string;
  /** The chat its turn runs in, once begun. */
  chatId: string | null;
  /** How far its status has come (STATUS_PHASES). */
  phase: number;
  /** Stop asked before its turn began. */
  stopped: boolean;
  over: boolean;
}

let server: net.Server | null = null;
let listeningOn: string | null = null;
let untap: (() => void) | null = null;
const conns = new Set<Conn>();
/** The asks whose turn runs, by their chat. */
const byChat = new Map<string, Ask>();
/** The conversations with a question going on, from its arrival: one at a time each. */
const answering = new Set<string>();
/** The browser the person is being asked about, and those that said hello while they were. */
let pending: { owner: Conn; others: Conn[] } | null = null;
/** Refusals in a row, when the last was, and when "ask again" last passed over the wait. */
let refusals = 0;
let refusedAt = 0;
let askedAgainAt = Number.NEGATIVE_INFINITY;
let lastAskAt = Number.NEGATIVE_INFINITY;
let tools: () => Promise<CliInfo[]> = listChatClis;
let statusHeard: (status: BrowserLinkStatus, clients: number) => void = () => undefined;
let clientsHeard: (clients: number) => void = () => undefined;
let askedHeard: () => void = () => undefined;
let lastTold = '';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Where the link is, for a name drawn for this run: a pipe on Windows; elsewhere a socket in a folder of the app's
 * data (`link/`), under the name's first twelve letters, a socket's path being short.
 */
export function pipeFor(name: string, platform: NodeJS.Platform = process.platform, dataDir: string = app.getPath('userData')): string {
  return platform === 'win32' ? `\\\\.\\pipe\\cortex-browser-link-${name}` : path.join(dataDir, 'link', `${name.slice(0, 12)}.sock`);
}

const rendezvousPath = () => path.join(app.getPath('userData'), RENDEZVOUS_FILE);

/**
 * The meeting file, written whole: the pipe, or none while nothing listens; and `off` where the person closed the
 * link, which tells the browser not to start Cortex for it. Said, not thrown, where it cannot be written.
 */
function writeMeeting(pipe: string | null): void {
  try {
    const meeting: Rendezvous = { version: RENDEZVOUS_VERSION, pipe, ...(readSettings().browserLink === 'off' ? { off: true as const } : {}), exe: app.getPath('exe'), pid: process.pid };
    writeWhole(rendezvousPath(), JSON.stringify(meeting));
  } catch (err) {
    console.warn('[browser link] the meeting file could not be written:', (err as NodeJS.ErrnoException | null)?.code ?? 'unknown');
  }
}

/** Where the window hears of the link (electron/ipc.ts): its state, and how many browsers have said hello on it. */
export function onBrowserLink(listener: (status: BrowserLinkStatus, clients: number) => void): void {
  statusHeard = listener;
}

/** Where the app hears how many browsers are there now (electron/main.ts: one started hidden for a browser leaves with the last). */
export function onBrowsersThere(listener: (clients: number) => void): void {
  clientsHeard = listener;
}

/** Where the app hears that the person is being asked about a browser: said from the notification area when the window is not shown. */
export function onPairingAsked(listener: () => void): void {
  askedHeard = listener;
}

export function browserLinkStatus(): BrowserLinkStatus {
  return {
    on: readSettings().browserLink === 'on',
    turnedOff: readSettings().browserLink === 'off',
    listening: server !== null,
    allowed: readSettings().browserLinkToken !== null,
    connected: [...conns].some((one) => one.stage === 'paired'),
    asking: pending !== null,
    code: pending?.owner.code ?? null,
    locked: refusals >= REASK.lock,
  };
}

/**
 * Whether a browser is there, or was a moment ago: connected now, or a question of its came within the last ten
 * minutes. Asked before Cortex closes itself to install an update unasked (electron/ipc.ts).
 */
export function browserLinkBusy(): boolean {
  return [...conns].some((one) => one.greeted) || REASK.now() - lastAskAt < BUSY_AFTER_ASK;
}

/** Said when it changed, not at every message. */
function changed(): void {
  const status = browserLinkStatus();
  const clients = [...conns].filter((one) => one.greeted).length;
  const told = JSON.stringify([status, clients]);
  if (told === lastTold) return;
  lastTold = told;
  for (const tell of [() => statusHeard(status, clients), () => clientsHeard(clients)]) {
    try {
      tell();
    } catch {
      /* the listener's own trouble */
    }
  }
}

/** The tool a new chat would be written to, among these: the one last written to in this vault while it is still offered, else the first offered. */
function defaultAmong(all: CliInfo[]): CliInfo | null {
  const offered = all.filter((one) => one.available);
  const last = listChats()[0]?.cli;
  return offered.find((one) => one.id === last) ?? offered[0] ?? null;
}

/**
 * The tool a new chat in Cortex would be written to (src/chat/chatStore.ts keeps the same order for the window).
 * Offered is installed and chosen for the chat; whether it is signed in is learnt when it is asked, as in the window.
 */
export async function defaultTool(): Promise<CliInfo | null> {
  return defaultAmong(await tools());
}

/** A tool as the browser is told of it: its name, how it asks leave, and whether a page added to a conversation holds it to asking (services/chat.ts, toolPermission). */
export function linkToolOf(tool: Pick<CliInfo, 'id' | 'name'>): LinkTool {
  return { id: tool.id, name: cutTo(tool.name, LIMITS.name_chars), ...toolPermission(tool.id) };
}

/** A turn's failure in the contract's codes, by the kind the chat gave it (ChatEvent's `error`). */
export function errorCodeOf(kind: string | null): ErrorCode {
  if (kind === 'auth' || kind === 'provider-auth' || kind === 'provider-key') return 'not_signed_in';
  if (kind === 'limit' || kind === 'provider.quota') return 'limit';
  if (kind === 'network') return 'network';
  return 'tool_failed';
}

/** What cannot be part of a path's name in a sentence: where one ends. */
const PATH_END = `[^\\s'"<>|*?]`;
const PATHS = new RegExp(
  [
    // Windows: a drive's, a share's.
    `\\b[A-Za-z]:[\\\\/]${PATH_END}*`,
    `\\\\\\\\${PATH_END}+`,
    // Home said short.
    `~[\\\\/]${PATH_END}*`,
    // From the root: not the path of a web address, nor "5/7".
    `(?<![\\w:/.~-])/[A-Za-z._]${PATH_END}*`,
  ].join('|'),
  'g',
);

/**
 * A failure's `detail` as the contract allows it: for a log, never shown to the person, and never saying where
 * anything is on this computer. Every path in it is taken out, home's first, and it is cut to the contract's length.
 */
export function safeDetail(text: string): string {
  const home = os.homedir();
  const homeless = home && home.length > 1 ? text.split(home).join('~') : text;
  return cutTo(homeless.replace(PATHS, '…'), LIMITS.detail_chars);
}

/**
 * A card as the browser is told it, within the contract's limits: its title and names cut, its paths and answers
 * counted. After a page no leave is given for good (services/chat.ts leaves it off the card already), and an answer
 * whose id the browser could not send back is not offered.
 */
export function linkPermissionOf(event: Extract<ChatEvent, { type: 'permission' }>): LinkPermission {
  return {
    id: event.id,
    title: cutTo(event.title, LIMITS.permission_title_chars),
    kind: cutTo(event.kind, LIMITS.name_chars),
    paths: event.paths.slice(0, LIMITS.permission_paths).map((one) => cutTo(one, LIMITS.permission_title_chars)),
    options: event.options
      .filter((one) => (!event.afterPage || one.kind !== 'allow_always') && one.id.length > 0 && !longerThan(one.id, LIMITS.id_chars))
      .slice(0, LIMITS.permission_options)
      .map((one) => ({ id: one.id, name: cutTo(one.name, LIMITS.name_chars), kind: one.kind })),
    after_page: event.afterPage === true,
  };
}

function send(conn: Conn, message: CortexMessage): void {
  if (conn.stage === 'closed' || conn.socket.destroyed) return;
  if (conn.socket.writableLength > WRITE_MAX) {
    conn.socket.destroy();
    return;
  }
  conn.socket.write(encodeLine(message));
}

/** An ask let go of: its conversation takes the next question. Its turn, if one runs, goes on in its chat. */
function release(ask: Ask): void {
  ask.over = true;
  ask.conn.asks.delete(ask.id);
  answering.delete(ask.conversation);
  if (ask.chatId && byChat.get(ask.chatId) === ask) byChat.delete(ask.chatId);
}

/** A connection that is no more, however it went: its asks let go, and the question about it handed on or taken down. */
function gone(conn: Conn): void {
  if (!conns.delete(conn)) return;
  conn.stage = 'closed';
  conn.held = null;
  conn.used = 0;
  if (conn.helloTimer) clearTimeout(conn.helloTimer);
  conn.helloTimer = null;
  for (const ask of [...conn.asks.values()]) release(ask);
  if (pending?.owner === conn) {
    // Another that said hello meanwhile (the browser started again while the card was up) is the one asked about now.
    const next = pending.others.shift();
    pending = next ? { owner: next, others: pending.others } : null;
  } else if (pending) pending.others = pending.others.filter((one) => one !== conn);
  changed();
}

/** Told why, and closed. */
function bye(conn: Conn, reason: Extract<CortexMessage, { type: 'bye' }>['reason']): void {
  if (conn.stage === 'closed') return;
  const socket = conn.socket;
  if (!socket.destroyed) socket.end(encodeLine({ type: 'bye', reason }));
  // A peer that never closes its end is not waited on.
  setTimeout(() => socket.destroy(), 2000).unref();
  gone(conn);
}

function tokenKnown(token: string): boolean {
  const kept = readSettings().browserLinkToken;
  if (!kept || !token || token.length > 512) return false;
  return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(kept, 'hex'));
}

/**
 * Let in: told what answers here, and given its token when it was just allowed. The tools are asked first, and the
 * leave may be gone by the time they answer (taken back, or given anew to another): looked at again before a word
 * is written.
 */
async function welcome(conn: Conn, token: string | null): Promise<void> {
  const tool = await defaultTool().catch(() => null);
  if (conn.stage !== 'welcoming' && conn.stage !== 'paired') return;
  if (!conn.digest || conn.digest !== readSettings().browserLinkToken) return bye(conn, 'unpaired');
  conn.stage = 'paired';
  const vault = readSettings().vault;
  send(conn, { type: 'hello_ok', protocol: BROWSER_LINK_PROTOCOL, app_version: app.getVersion(), tool: tool ? linkToolOf(tool) : null, vault_name: vault ? cutTo(path.basename(vault), LIMITS.name_chars) : null, token });
  changed();
}

/** Whether a hello that shows no leave is answered "refused" without the person being asked. */
function refusedUnasked(askAgain: boolean): boolean {
  if (!refusals) return false;
  // Refused that often in a row: the person lets it ask again in the settings, or not at all.
  if (refusals >= REASK.lock) return true;
  const now = REASK.now();
  if (now - refusedAt >= Math.min(REASK.ms * 2 ** (refusals - 1), REASK.max)) return false;
  // Within the wait: only the person's own "ask again" passes, and not more than once in a while.
  if (!askAgain || now - askedAgainAt < REASK.again) return true;
  askedAgainAt = now;
  return false;
}

async function hello(conn: Conn, message: Extract<BrowserMessage, { type: 'hello' }>): Promise<void> {
  if (message.protocol !== BROWSER_LINK_PROTOCOL) return bye(conn, 'protocol');
  if (!conn.greeted) {
    conn.greeted = true;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    changed();
  }
  // Said again on a link already let in, it is answered with how things are now: the tool, the vault.
  if (conn.stage === 'paired') return welcome(conn, null);
  if (conn.stage === 'welcoming') return;
  if (message.token !== null && tokenKnown(message.token)) {
    conn.stage = 'welcoming';
    conn.digest = readSettings().browserLinkToken;
    return welcome(conn, null);
  }
  if (conn.stage === 'waiting' && conn.code) return send(conn, { type: 'pairing', state: 'waiting', code: conn.code });
  if (refusedUnasked(message.ask_again === true)) return send(conn, { type: 'pairing', state: 'refused' });
  conn.stage = 'waiting';
  // Shown to the person beside the question, and by the browser in its own window: compared, never typed.
  conn.code = String(randomInt(10_000)).padStart(4, '0');
  send(conn, { type: 'pairing', state: 'waiting', code: conn.code });
  if (pending) {
    pending.others.push(conn);
    return;
  }
  pending = { owner: conn, others: [] };
  changed();
  try {
    askedHeard();
  } catch {
    /* the listener's own trouble */
  }
}

/**
 * The person's answer to the browser waiting. Allowed: a token drawn for it, its digest kept, the token sent to that
 * connection alone; a link let in by the token before it is told and closed; any other that waited is not let in on
 * this leave, and may say hello again. Refused: all told so.
 */
export function decidePairing(allow: unknown): BrowserLinkStatus {
  const asked = pending;
  if (!asked) return browserLinkStatus();
  pending = null;
  const refuse = (conn: Conn) => {
    if (conn.stage !== 'waiting') return;
    conn.stage = 'new';
    conn.code = null;
    send(conn, { type: 'pairing', state: 'refused' });
  };
  if (allow === true) {
    const token = randomBytes(32).toString('base64url');
    const kept = digest(token);
    updateSettings((settings) => {
      settings.browserLinkToken = kept;
    });
    refusals = 0;
    for (const conn of [...conns]) if ((conn.stage === 'paired' || conn.stage === 'welcoming') && conn.digest !== kept) bye(conn, 'unpaired');
    if (asked.owner.stage === 'waiting') {
      asked.owner.stage = 'welcoming';
      asked.owner.code = null;
      asked.owner.digest = kept;
      void welcome(asked.owner, token);
    }
  } else {
    refusals += 1;
    refusedAt = REASK.now();
    refuse(asked.owner);
  }
  for (const other of asked.others) refuse(other);
  changed();
  return browserLinkStatus();
}

/**
 * "Allow" in the settings. With a browser waiting: that one let in, as from the question. With none, and the browser
 * refused so often that it is not asked about any more: it may ask again, and its next hello is asked about. It lets
 * nobody in by itself.
 */
export function allowBrowserFromSettings(): BrowserLinkStatus {
  if (pending) return decidePairing(true);
  refusals = 0;
  refusedAt = 0;
  askedAgainAt = Number.NEGATIVE_INFINITY;
  changed();
  return browserLinkStatus();
}

/**
 * The leave taken back (Settings): the digest forgotten, and every link that has it, waits for it or is on its way
 * to it told so and closed - one whose hello is still being answered among them.
 */
export function unpairBrowser(): BrowserLinkStatus {
  updateSettings((settings) => {
    settings.browserLinkToken = null;
  });
  for (const conn of [...conns]) if (conn.stage !== 'new') bye(conn, 'unpaired');
  pending = null;
  changed();
  return browserLinkStatus();
}

function phase(ask: Ask, next: StatusPhase, tool?: LinkTool): void {
  const order = STATUS_PHASES.indexOf(next);
  if (order <= ask.phase) return;
  ask.phase = order;
  send(ask.conn, { type: 'event', id: ask.id, kind: 'status', phase: next, ...(tool ? { tool } : {}) });
}

/** The last word of an ask. */
function end(ask: Ask, event: Extract<LinkEvent, { kind: 'done' | 'error' }>): void {
  if (ask.over) return;
  release(ask);
  send(ask.conn, event);
}

async function ask(conn: Conn, message: Extract<BrowserMessage, { type: 'ask' }>): Promise<void> {
  const failed = (code: ErrorCode, detail = '', tool?: LinkTool): Extract<LinkEvent, { kind: 'error' }> => ({ type: 'event', id: message.id, kind: 'error', code, detail, ...(tool ? { tool } : {}) });
  // The id of a question still being answered names that question: used again, nobody could tell their events apart.
  if (conn.asks.has(message.id)) return bye(conn, 'bad_message');
  if (answering.has(message.conversation)) return send(conn, failed('busy'));
  const asked: Ask = { id: message.id, conn, conversation: message.conversation, chatId: null, phase: -1, stopped: false, over: false };
  conn.asks.set(asked.id, asked);
  answering.add(asked.conversation);
  lastAskAt = REASK.now();
  try {
    if (longerThan(message.text, MESSAGE_MAX) || (message.page && longerThan(message.page.text, PAGE_TEXT_MAX))) return end(asked, failed('too_long'));
    const all = await tools();
    // Its link closed meanwhile, or Stop came before anything began.
    if (asked.over) return;
    if (asked.stopped) return end(asked, { type: 'event', id: asked.id, kind: 'done', cancelled: true });
    const vault = readSettings().vault;
    if (!vault || !fs.existsSync(vault)) return end(asked, failed('no_vault'));
    const chatId = browserChat(asked.conversation);
    // Its chat answering a message written in Cortex is busy as well.
    if (chatId && chatAnswering(chatId)) return end(asked, failed('busy'));
    // A chat begun keeps its tool; a new one takes the tool a new chat in Cortex would.
    const kept: CliId | null = chatId ? chatCli(chatId) : null;
    const tool = kept ? (all.find((one) => one.id === kept) ?? { id: kept, name: kept }) : defaultAmong(all);
    if (!tool) return end(asked, failed('no_tool'));
    const told = linkToolOf(tool);
    // A page is anybody's words. A tool Cortex cannot hold to asking may act on them unasked: not sent to it unless
    // the person, warned in the browser, said to.
    if (message.page && !told.can_ask && !message.page_ack) return end(asked, failed('page_unprotected', '', told));
    phase(asked, 'starting', told);
    const begun = sendChat(chatId, tool.id, message.text, undefined, { conversation: asked.conversation, page: message.page });
    asked.chatId = begun.id;
    byChat.set(begun.id, asked);
  } catch (err) {
    // Cortex's own sentence where it refused; of anything else its code alone, which names no place.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    end(asked, failed('internal', safeDetail(err instanceof ChatRefusal ? err.message : typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : '')));
  }
}

/** What a chat shows, passed on to the browser whose question it answers. */
function heardChat(message: ChatHeard): void {
  const asked = byChat.get(message.chatId);
  if (!asked || asked.over) return;
  if (message.sent) return phase(asked, 'thinking');
  const event = message.event;
  if (!event) return;
  const id = asked.id;
  switch (event.type) {
    case 'text':
      if (!event.text) return;
      phase(asked, 'answering');
      send(asked.conn, { type: 'event', id, kind: 'text', text: event.text });
      break;
    case 'permission':
      send(asked.conn, { type: 'event', id, kind: 'permission', permission: linkPermissionOf(event) });
      break;
    case 'answered':
      send(asked.conn, { type: 'event', id, kind: 'permission_closed', permission: event.id, option: event.option });
      break;
    case 'done':
      // A turn that was stopped ends as `cancelled`, whatever its tool said of it (services/chat.ts, run). Its end
      // closes a card still open: the contract says so to the browser, and the chat closes it in Cortex.
      end(asked, { type: 'event', id, kind: 'done', cancelled: event.reason === 'cancelled' });
      break;
    case 'error':
      end(asked, { type: 'event', id, kind: 'error', code: errorCodeOf(event.kind), detail: safeDetail(event.message) });
      break;
    default:
      break;
  }
}

async function capture(conn: Conn, message: Extract<BrowserMessage, { type: 'capture' }>): Promise<void> {
  const vault = readSettings().vault;
  if (!vault || !fs.existsSync(vault)) return send(conn, { type: 'captured', id: message.id, ok: false, code: 'no_vault', detail: '' });
  try {
    const saved = await captureToInbox({ url: message.url, title: message.title, why: message.note }, 'cortex-browser');
    send(conn, { type: 'captured', id: message.id, ok: true, path: saved.path });
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    send(conn, { type: 'captured', id: message.id, ok: false, code: 'capture_failed', detail: safeDetail(said.split(vault).join('')) });
  }
}

async function handle(conn: Conn, message: BrowserMessage): Promise<void> {
  if (conn.stage === 'closed') return;
  if (message.type === 'hello') return hello(conn, message);
  if (message.type === 'bye') {
    conn.socket.end();
    return gone(conn);
  }
  // Nothing is asked, answered or kept before leave is given.
  if (conn.stage !== 'paired') return bye(conn, 'unpaired');
  switch (message.type) {
    case 'ask':
      // Not waited for: Stop, and the answer to a card, are read while the question is being answered.
      void ask(conn, message);
      break;
    case 'answer': {
      const asked = conn.asks.get(message.id);
      if (asked?.chatId) answerChat(asked.chatId, message.permission, message.option);
      break;
    }
    case 'cancel': {
      const asked = conn.asks.get(message.id);
      // Its turn stopped, where one runs (it then ends as `done {cancelled: true}`); else never begun.
      if (asked?.chatId) cancelChat(asked.chatId);
      else if (asked) asked.stopped = true;
      break;
    }
    case 'capture':
      void capture(conn, message);
      break;
    default:
      break;
  }
}

/** The longest line this connection may send now: short until it is let in. */
const lineLimit = (conn: Conn) => (conn.stage === 'paired' ? LIMITS.line_bytes : LIMITS.line_bytes_before_hello_ok);

/** One line off the pipe. Its words are never logged: a hello carries the token. */
function take(conn: Conn, line: Buffer): void {
  let text: string;
  try {
    text = utf8.decode(line);
  } catch {
    return bye(conn, 'bad_message');
  }
  // A line with nothing on it is nothing.
  if (!text.trim()) return;
  const read = parseBrowserLine(text, lineLimit(conn));
  if ('bad' in read) return bye(conn, 'bad_message');
  const message = read.message;
  if (!message) return;
  conn.work = conn.work.then(() => handle(conn, message)).catch((err: unknown) => console.warn('[browser link] a message could not be handled:', err instanceof Error ? err.name : typeof err));
}

/**
 * Bytes off the pipe. A line not ended yet is kept in one buffer of its own, grown as it grows: kept as the pieces
 * they came in, a line sent a byte at a time held a whole read's memory for each byte. Longer than a line may be
 * for this connection, it is given up as soon as that is known, not once all of it is in.
 */
function received(conn: Conn, chunk: Buffer): void {
  let from = 0;
  while (conn.stage !== 'closed') {
    const at = chunk.indexOf(0x0a, from);
    if (at < 0) break;
    if (conn.used + (at - from) > lineLimit(conn)) return bye(conn, 'bad_message');
    let line = chunk.subarray(from, at);
    if (conn.used && conn.held) {
      line = Buffer.concat([conn.held.subarray(0, conn.used), line]);
      conn.used = 0;
      // A long line's room is not kept for the short ones after it.
      if (conn.held.length > 64 * 1024) conn.held = null;
    }
    from = at + 1;
    take(conn, line);
  }
  if (conn.stage === 'closed' || from >= chunk.length) return;
  const more = chunk.length - from;
  const need = conn.used + more;
  if (need > lineLimit(conn)) return bye(conn, 'bad_message');
  if (!conn.held || conn.held.length < need) {
    const grown = Buffer.allocUnsafe(Math.max(need, Math.min(LIMITS.line_bytes, Math.max(1024, (conn.held?.length ?? 0) * 2))));
    if (conn.held && conn.used) conn.held.copy(grown, 0, 0, conn.used);
    conn.held = grown;
  }
  chunk.copy(conn.held, conn.used, from);
  conn.used = need;
}

/** Room made for a newcomer in a full house: the oldest link that has no leave and is not the one being asked about. */
function makeRoom(): boolean {
  const strangers = [...conns].filter((one) => one.stage === 'new');
  const waiters = [...conns].filter((one) => one.stage === 'waiting' && one !== pending?.owner);
  const out = strangers[0] ?? waiters[0];
  if (!out) return false;
  out.socket.destroy();
  gone(out);
  return true;
}

function accept(socket: net.Socket): void {
  if (conns.size >= MAX_CONNECTIONS && !makeRoom()) {
    socket.destroy();
    return;
  }
  const conn: Conn = { socket, stage: 'new', greeted: false, helloTimer: null, code: null, digest: null, held: null, used: 0, work: Promise.resolve(), asks: new Map() };
  conns.add(conn);
  // No hello in time: closed, so a link that only holds a place does not hold it long.
  conn.helloTimer = setTimeout(() => {
    conn.helloTimer = null;
    if (conn.greeted || conn.stage === 'closed') return;
    socket.destroy();
    gone(conn);
  }, HELLO_WAIT.ms);
  conn.helloTimer.unref();
  socket.on('data', (chunk: Buffer) => received(conn, chunk));
  socket.on('error', () => undefined);
  socket.on('close', () => gone(conn));
}

/** The listener opened under a name drawn now, and the meeting file told; whether it is open. */
async function openListener(): Promise<boolean> {
  if (server) return true;
  const pipe = pipeFor(randomBytes(8).toString('hex'));
  const made = net.createServer(accept);
  try {
    if (process.platform !== 'win32') {
      // Its folder is the person's alone before anything listens in it: nobody else reaches the socket, whatever
      // the socket's own mode is between its making and its narrowing. Sockets left by a run that died are cleared.
      const dir = path.dirname(pipe);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) if (name.endsWith('.sock')) fs.rmSync(path.join(dir, name), { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      made.once('error', reject);
      made.listen(pipe, () => {
        made.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600);
  } catch (err) {
    console.warn('[browser link] the link could not be opened:', (err as NodeJS.ErrnoException | null)?.code ?? 'unknown');
    made.close();
    // Said in the file - no pipe - and in the settings, where the switch is on and nothing listens.
    writeMeeting(null);
    changed();
    return false;
  }
  made.on('error', (err) => console.warn('[browser link]', (err as NodeJS.ErrnoException).code ?? 'error'));
  server = made;
  listeningOn = pipe;
  untap = tapChat(heardChat);
  writeMeeting(pipe);
  changed();
  return true;
}

/** The listener closed: every browser told, nothing left listening. The leave given stays. */
function closeListener(): void {
  untap?.();
  untap = null;
  for (const conn of [...conns]) bye(conn, 'shutdown');
  pending = null;
  if (server) {
    server.close();
    server = null;
    if (process.platform !== 'win32' && listeningOn) fs.rmSync(listeningOn, { force: true });
  }
  listeningOn = null;
}

/**
 * The browser's own word that the link be open (`--tarayici`), taken where nobody has opened or closed it yet: kept
 * as `on` from then. Where the person closed it, it stays closed - the switch in the settings would mean nothing if
 * the browser could put it back at every question.
 */
function openedForBrowser(): void {
  if (readSettings().browserLink !== null) return;
  updateSettings((settings) => {
    settings.browserLink = 'on';
  });
}

/**
 * At the app's start, by the one instance that runs (electron/main.ts): the meeting file written - over whatever a
 * run before left - and the listener opened where the link is kept on. `asked`: Cortex was started for the browser,
 * which opens a link nobody has touched and never one the person closed. Whether the listener is open. `tools`
 * stands in for the chat's list of tools in a test.
 */
export async function startBrowserLink(given: { tools?: () => Promise<CliInfo[]>; asked?: boolean } = {}): Promise<boolean> {
  tools = given.tools ?? listChatClis;
  if (given.asked) openedForBrowser();
  if (server) return true;
  writeMeeting(null);
  if (readSettings().browserLink !== 'on') {
    changed();
    return false;
  }
  return openListener();
}

/** The same word reaching a Cortex that already runs, by a second launch (electron/main.ts): opened as at a start, or left closed. */
export async function openBrowserLinkForBrowser(): Promise<BrowserLinkStatus> {
  openedForBrowser();
  if (readSettings().browserLink === 'on') await openListener();
  changed();
  return browserLinkStatus();
}

/**
 * The person's switch in the settings, and theirs alone. On: the listener opened, and kept on. Off: the listener
 * closed, the meeting file naming no pipe and saying `off`, and the link not to be opened by the browser from then.
 */
export async function setBrowserLinkOn(on: unknown): Promise<BrowserLinkStatus> {
  if (typeof on !== 'boolean') return browserLinkStatus();
  const kept = on ? 'on' : 'off';
  if (readSettings().browserLink !== kept) {
    updateSettings((settings) => {
      settings.browserLink = kept;
    });
  }
  if (on) await openListener();
  else {
    closeListener();
    writeMeeting(null);
  }
  changed();
  return browserLinkStatus();
}

/**
 * The app closing: every browser told and the listener closed. The meeting file stays - by it the browser finds the
 * program to start - and names no pipe from here on: nothing listens, and a name left written would be one for
 * another program to open in Cortex's place. Where the app ends without this (a crash, Windows signing out) the name
 * stays, and a pipe nothing listens on tells the browser as much.
 */
export function stopBrowserLink(): void {
  const listened = listeningOn !== null;
  closeListener();
  if (listened) writeMeeting(null);
  refusals = 0;
  refusedAt = 0;
  askedAgainAt = Number.NEGATIVE_INFINITY;
  lastAskAt = Number.NEGATIVE_INFINITY;
  changed();
}

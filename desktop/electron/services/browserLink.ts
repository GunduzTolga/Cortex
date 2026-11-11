import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';
import {
  BROWSER_LINK_PROTOCOL,
  type BrowserLinkStatus,
  type BrowserMessage,
  type CortexMessage,
  type ErrorCode,
  LINE_MAX,
  type LinkEvent,
  RENDEZVOUS_FILE,
  type Rendezvous,
  STATUS_PHASES,
  type StatusPhase,
  encodeLine,
  parseBrowserLine,
  readRendezvous,
} from '../../shared/browserLink';
import type { CliInfo } from '../../shared/chat';
import { PAGE_TEXT_MAX } from './browserPage';
import { type ChatHeard, MESSAGE_MAX, answerChat, browserChat, cancelChat, chatAnswering, listChatClis, listChats, sendChat, tapChat } from './chat';
import { writeWhole } from './fileWrite';
import { captureToInbox } from './inbox';
import { readSettings, updateSettings } from './settings';

/**
 * Cortex's end of the link to Cortex Browser (shared/browserLink.ts, shared/browser-link-contract.json): the browser's
 * assistant asks, and the AI tool the person uses in Cortex answers, in a chat of this vault's that can be read and
 * gone on with here (services/chat.ts).
 *
 * Reached only from this computer: a named pipe on Windows (`\\.\pipe\cortex-browser-link-<id>`, the id drawn once
 * for this install), a socket in the app's data folder elsewhere, the person's alone. No port is opened: a web page
 * cannot reach a pipe, and no firewall asks. Where it is, is written in the data folder (`browser-link.json`: the
 * pipe, the program to start when nothing listens there, the process), whole, and taken away when the app closes.
 *
 * Any program of the same person can connect. What tells the browser from another is leave given once, in Cortex: a
 * connection that shows no token Cortex knows is told to wait while the person is asked, and is given a token when
 * they allow it. Cortex keeps the token's SHA-256 (services/settings.ts), never the token, and writes it nowhere
 * else: no line here logs what a message carried. This sets apart the program the person meant to let in; it is no
 * wall against one of their own programs that reads the browser's files, which could read their notes as well.
 *
 * A question becomes a turn of a chat, with the tool a new chat in Cortex would be written to (defaultTool). What the
 * chat shows is passed on as the contract's events: the answer's words, a card asking leave, its answer wherever it
 * was given, the end. The tool's thinking and its steps stay in Cortex. A question written in Cortex to the same chat
 * is answered in Cortex alone. A browser that goes in the middle of an answer leaves the answer going: it is the
 * chat's, and a card it waits on can be answered here.
 */

/** More connections at once than these are not taken: a browser opens one. */
export const MAX_CONNECTIONS = 8;
/** What is waiting to be written to a browser that does not read: past this, its link is closed. */
const WRITE_MAX = 64 * 1024 * 1024;
/** The format of the meeting file. */
const RENDEZVOUS_VERSION = 1;
/**
 * After a refusal the person is not asked again at once, however often the browser says hello: after `ms`, twice as
 * long after each refusal that follows, `max` at most. In an object, with its clock, so a test need not wait.
 */
export const REASK = { ms: 30_000, max: 10 * 60_000, now: (): number => Date.now() };

type Stage = 'new' | 'waiting' | 'paired' | 'closed';

interface Conn {
  socket: net.Socket;
  stage: Stage;
  /** It has said a hello of this protocol: counted as a browser there (onBrowserLink). */
  greeted: boolean;
  /** The pieces of a line not ended yet, and their bytes. */
  pieces: Buffer[];
  size: number;
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
let untap: (() => void) | null = null;
const conns = new Set<Conn>();
/** The asks whose turn runs, by their chat. */
const byChat = new Map<string, Ask>();
/** The conversations with a question going on, from its arrival: one at a time each. */
const answering = new Set<string>();
/** The browser the person is being asked about, and those that said hello while they were. */
let pending: { owner: Conn; others: Conn[] } | null = null;
let refusals = 0;
let refusedAt = 0;
let tools: () => Promise<CliInfo[]> = listChatClis;
let statusHeard: (status: BrowserLinkStatus, clients: number) => void = () => undefined;
let clientsHeard: (clients: number) => void = () => undefined;
let askedHeard: () => void = () => undefined;
let lastTold = '';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Where the link is: a pipe named by the install on Windows, a socket in the app's data folder elsewhere. */
export function pipeFor(id: string, platform: NodeJS.Platform = process.platform, dataDir: string = app.getPath('userData')): string {
  return platform === 'win32' ? `\\\\.\\pipe\\cortex-browser-link-${id}` : path.join(dataDir, 'browser-link.sock');
}

const rendezvousPath = () => path.join(app.getPath('userData'), RENDEZVOUS_FILE);

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
  return { allowed: readSettings().browserLinkToken !== null, connected: [...conns].some((one) => one.stage === 'paired'), asking: pending !== null };
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

/**
 * The tool a new chat in Cortex would be written to: the one last written to in this vault while it is still offered,
 * else the first offered (src/chat/chatStore.ts keeps the same order for the window). Offered is installed and chosen
 * for the chat; whether it is signed in is learnt when it is asked, as in the window.
 */
export async function defaultTool(): Promise<CliInfo | null> {
  const offered = (await tools()).filter((one) => one.available);
  const last = listChats()[0]?.cli;
  return offered.find((one) => one.id === last) ?? offered[0] ?? null;
}

/** A turn's failure in the contract's codes, by the kind the chat gave it (ChatEvent's `error`). */
export function errorCodeOf(kind: string | null): ErrorCode {
  if (kind === 'auth' || kind === 'provider-auth' || kind === 'provider-key') return 'not_signed_in';
  if (kind === 'limit' || kind === 'provider.quota') return 'limit';
  if (kind === 'network') return 'network';
  return 'tool_failed';
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
  conn.pieces = [];
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

/** Let in: told what answers here, and given its token when it was just allowed. */
async function welcome(conn: Conn, token: string | null): Promise<void> {
  const tool = await defaultTool().catch(() => null);
  if (conn.stage === 'closed') return;
  conn.stage = 'paired';
  const vault = readSettings().vault;
  send(conn, { type: 'hello_ok', protocol: BROWSER_LINK_PROTOCOL, app_version: app.getVersion(), tool: tool ? { id: tool.id, name: tool.name } : null, vault_name: vault ? path.basename(vault) : null, token });
  changed();
}

async function hello(conn: Conn, message: Extract<BrowserMessage, { type: 'hello' }>): Promise<void> {
  if (message.protocol !== BROWSER_LINK_PROTOCOL) return bye(conn, 'protocol');
  if (!conn.greeted) {
    conn.greeted = true;
    changed();
  }
  // Said again on a link already let in, it is answered with how things are now: the tool, the vault.
  if (conn.stage === 'paired' || (message.token !== null && tokenKnown(message.token))) return welcome(conn, null);
  if (conn.stage === 'waiting') return send(conn, { type: 'pairing', state: 'waiting' });
  if (refusals && REASK.now() - refusedAt < Math.min(REASK.ms * 2 ** (refusals - 1), REASK.max)) return send(conn, { type: 'pairing', state: 'refused' });
  conn.stage = 'waiting';
  send(conn, { type: 'pairing', state: 'waiting' });
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
 * connection alone; any other that waited is not let in on its leave, and may say hello again. Refused: all told so.
 */
export function decidePairing(allow: unknown): BrowserLinkStatus {
  const asked = pending;
  if (!asked) return browserLinkStatus();
  pending = null;
  const refuse = (conn: Conn) => {
    if (conn.stage !== 'waiting') return;
    conn.stage = 'new';
    send(conn, { type: 'pairing', state: 'refused' });
  };
  if (allow === true) {
    const token = randomBytes(32).toString('base64url');
    updateSettings((settings) => {
      settings.browserLinkToken = digest(token);
    });
    refusals = 0;
    void welcome(asked.owner, token);
  } else {
    refusals += 1;
    refusedAt = REASK.now();
    refuse(asked.owner);
  }
  for (const other of asked.others) refuse(other);
  changed();
  return browserLinkStatus();
}

/** The leave taken back (Settings): the digest forgotten, and a browser connected told so and closed. */
export function unpairBrowser(): BrowserLinkStatus {
  updateSettings((settings) => {
    settings.browserLinkToken = null;
  });
  for (const conn of [...conns]) if (conn.stage === 'paired') bye(conn, 'unpaired');
  changed();
  return browserLinkStatus();
}

function phase(ask: Ask, next: StatusPhase): void {
  const order = STATUS_PHASES.indexOf(next);
  if (order <= ask.phase) return;
  ask.phase = order;
  send(ask.conn, { type: 'event', id: ask.id, kind: 'status', phase: next });
}

/** The last word of an ask. */
function end(ask: Ask, event: Extract<LinkEvent, { kind: 'done' | 'error' }>): void {
  if (ask.over) return;
  release(ask);
  send(ask.conn, event);
}

async function ask(conn: Conn, message: Extract<BrowserMessage, { type: 'ask' }>): Promise<void> {
  const failed = (code: ErrorCode, detail = ''): LinkEvent => ({ type: 'event', id: message.id, kind: 'error', code, detail });
  if (conn.asks.has(message.id) || answering.has(message.conversation)) return send(conn, failed('busy'));
  const asked: Ask = { id: message.id, conn, conversation: message.conversation, chatId: null, phase: -1, stopped: false, over: false };
  conn.asks.set(asked.id, asked);
  answering.add(asked.conversation);
  phase(asked, 'starting');
  try {
    if (message.text.length > MESSAGE_MAX || (message.page && message.page.text.length > PAGE_TEXT_MAX)) return end(asked, failed('too_long') as Extract<LinkEvent, { kind: 'error' }>);
    const tool = await defaultTool();
    // Its link closed meanwhile, or Stop came before anything began.
    if (asked.over) return;
    if (asked.stopped) return end(asked, { type: 'event', id: asked.id, kind: 'done', cancelled: true });
    if (!readSettings().vault) return end(asked, failed('internal', 'no vault') as Extract<LinkEvent, { kind: 'error' }>);
    const chatId = browserChat(asked.conversation);
    // Its chat answering a message written in Cortex is busy as well.
    if (chatId && chatAnswering(chatId)) return end(asked, failed('busy') as Extract<LinkEvent, { kind: 'error' }>);
    if (!chatId && !tool) return end(asked, failed('no_tool') as Extract<LinkEvent, { kind: 'error' }>);
    // A chat begun keeps its tool; a new one takes the tool a new chat in Cortex would.
    const begun = sendChat(chatId, tool?.id ?? null, message.text, undefined, { conversation: asked.conversation, page: message.page });
    asked.chatId = begun.id;
    byChat.set(begun.id, asked);
  } catch (err) {
    end(asked, failed('internal', (err instanceof Error ? err.message : String(err)).slice(0, 300)) as Extract<LinkEvent, { kind: 'error' }>);
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
      send(asked.conn, {
        type: 'event',
        id,
        kind: 'permission',
        permission: {
          id: event.id,
          title: event.title,
          kind: event.kind,
          paths: event.paths,
          // After a page no leave is given for good (services/chat.ts leaves it off the card already).
          options: event.options.filter((one) => !event.afterPage || one.kind !== 'allow_always').map((one) => ({ id: one.id, name: one.name, kind: one.kind })),
          after_page: event.afterPage === true,
        },
      });
      break;
    case 'answered':
      send(asked.conn, { type: 'event', id, kind: 'permission_closed', permission: event.id, option: event.option });
      break;
    case 'done':
      end(asked, { type: 'event', id, kind: 'done', cancelled: event.reason === 'cancelled' });
      break;
    case 'error':
      end(asked, { type: 'event', id, kind: 'error', code: errorCodeOf(event.kind), detail: event.message.slice(0, 300) });
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
    send(conn, { type: 'captured', id: message.id, ok: false, code: 'capture_failed', detail: said.split(vault).join('').slice(0, 300) });
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
  const read = parseBrowserLine(text);
  if ('bad' in read) return bye(conn, 'bad_message');
  const message = read.message;
  if (!message) return;
  conn.work = conn.work.then(() => handle(conn, message)).catch((err: unknown) => console.warn('[browser link] a message could not be handled:', err instanceof Error ? err.name : typeof err));
}

function received(conn: Conn, chunk: Buffer): void {
  let from = 0;
  while (conn.stage !== 'closed') {
    const at = chunk.indexOf(0x0a, from);
    if (at < 0) break;
    const piece = chunk.subarray(from, at);
    const line = conn.pieces.length ? Buffer.concat([...conn.pieces, piece]) : piece;
    conn.pieces = [];
    conn.size = 0;
    from = at + 1;
    if (line.length > LINE_MAX) return bye(conn, 'bad_message');
    take(conn, line);
  }
  if (conn.stage === 'closed' || from >= chunk.length) return;
  const rest = chunk.subarray(from);
  conn.pieces.push(rest);
  conn.size += rest.length;
  // Longer than a line may be, before its end is in sight: not kept, not waited for.
  if (conn.size > LINE_MAX) bye(conn, 'bad_message');
}

function accept(socket: net.Socket): void {
  if (conns.size >= MAX_CONNECTIONS) {
    socket.destroy();
    return;
  }
  const conn: Conn = { socket, stage: 'new', greeted: false, pieces: [], size: 0, work: Promise.resolve(), asks: new Map() };
  conns.add(conn);
  socket.on('data', (chunk: Buffer) => received(conn, chunk));
  socket.on('error', () => undefined);
  socket.on('close', () => gone(conn));
}

/** The install's id, drawn at the first start and kept: the pipe's name does not change between starts. */
function linkId(): string {
  return readSettings().browserLinkId ?? (updateSettings((settings) => {
    settings.browserLinkId = randomBytes(8).toString('hex');
  }).browserLinkId as string);
}

/**
 * The link opened, and the meeting file written; whether it is open. Called once the app is ready, by the one
 * instance that runs (electron/main.ts). `tools` stands in for the chat's list of tools in a test.
 */
export async function startBrowserLink(given: { tools?: () => Promise<CliInfo[]> } = {}): Promise<boolean> {
  if (server) return true;
  tools = given.tools ?? listChatClis;
  const pipe = pipeFor(linkId());
  const made = net.createServer(accept);
  try {
    // A socket left by a run that died: this is the one instance, so nothing listens on it.
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
    await new Promise<void>((resolve, reject) => {
      made.once('error', reject);
      made.listen(pipe, () => {
        made.off('error', reject);
        resolve();
      });
    });
    // The person's alone, whatever the process's mask says (the data folder it lies in is theirs alone as well).
    if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600);
  } catch (err) {
    console.warn('[browser link] the link could not be opened:', (err as NodeJS.ErrnoException | null)?.code ?? 'unknown');
    made.close();
    return false;
  }
  made.on('error', (err) => console.warn('[browser link]', (err as NodeJS.ErrnoException).code ?? 'error'));
  server = made;
  untap = tapChat(heardChat);
  try {
    const meeting: Rendezvous = { version: RENDEZVOUS_VERSION, pipe, exe: app.getPath('exe'), pid: process.pid };
    writeWhole(rendezvousPath(), JSON.stringify(meeting));
  } catch (err) {
    console.warn('[browser link] the meeting file could not be written:', (err as NodeJS.ErrnoException | null)?.code ?? 'unknown');
  }
  return true;
}

/** The app closing: every browser told, the link closed, the meeting file taken away where it is this process's. */
export function stopBrowserLink(): void {
  untap?.();
  untap = null;
  for (const conn of [...conns]) bye(conn, 'shutdown');
  pending = null;
  refusals = 0;
  refusedAt = 0;
  if (server) {
    const pipe = pipeFor(readSettings().browserLinkId ?? '');
    server.close();
    server = null;
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
  }
  try {
    const said = readRendezvous(JSON.parse(fs.readFileSync(rendezvousPath(), 'utf8')));
    if (!said || said.pid === process.pid) fs.rmSync(rendezvousPath(), { force: true });
  } catch {
    /* none there, or not to be read: nothing of this process's to take away */
  }
  changed();
}

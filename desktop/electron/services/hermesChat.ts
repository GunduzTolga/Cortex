import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { ChatEvent, ConfigOption, PermissionKind } from '../../shared/chat';
import { HERMES_PROFILE, type HermesStatus, hermesAddress } from '../../shared/hermes';
import { type Backend, OUTPUT_MAX, STOP_GRACE, Stopped, type Turn, TurnFailure, cutSaid, scrubberFor, textOf, unlessStopped } from './chatKit';
import { forgetKey, keptHere, keptReadable, keyEnv, saveKey } from './keys';
import { readSettings, updateSettings } from './settings';
import { tailnetRoute } from './tailnet';

/**
 * The chat with a Hermes Agent running on another machine, through its
 * gateway's API server: HTTP for its sessions, a stream of server-sent events
 * for a turn (`POST /api/sessions/{id}/chat/stream`). Nothing is started here;
 * the agent, its tools, its memory and its sessions are Hermes's, where it runs.
 *
 * What is set (shared/hermes.ts): the server's address, the profile it serves
 * under `/p/<profile>/` where it serves several, and its key, sent as a Bearer
 * token to that address and to nothing else. The key is kept encrypted with
 * the other tools' (keys.ts) and never leaves the main process otherwise; no
 * sentence of this file carries it.
 *
 * A new chat begins a Hermes session with its first message (`POST
 * /api/sessions`), and every later message goes on in it. The chat's
 * "Session" chip lists Hermes's recent sessions - one begun on a phone, in
 * its terminal, anywhere - and choosing one binds the chat to it at once: its
 * last messages are shown, so the person sees where it left off, and the next
 * message continues it (Backend.setOption, chatKit.ts `Between`). The chip is
 * there before the first message too (Backend.offer): a session chosen in a
 * new chat begins the chat on it (chat.ts, beginChat), so continuing one begun
 * on a phone does not first begin another here.
 *
 * What Hermes streams is told as the chat's events: the words as they come
 * (`assistant.delta`), its thinking folded (`tool.progress`), a step per tool
 * (`tool.started`, `tool.completed`, `tool.failed`, paired by the tool's name
 * as they come), its words beside the steps (`assistant.commentary`) and the
 * whole answer where nothing came in pieces (`assistant.completed`). A
 * command Hermes asks leave for (`approval.request`) is a card with the
 * choices Hermes offers, answered at `POST /v1/runs/{run}/approval`; Stop is
 * asked of Hermes (`POST /v1/runs/{run}/stop`) and the stream let go.
 */

/**
 * Its name in the tool list: Pyn, said to be the one on the server. "Pyn" alone sat among Claude Code and Codex
 * and read as nothing in particular (30 October).
 */
export const hermesName = (): string => (english() ? 'Pyn on the server' : 'Sunucudaki Pyn');
/** What a session begun here is marked as made by, in Hermes's own list. */
const SOURCE = 'cortex-desktop';
export const SESSION_OPTION = 'session';
export const NEW_SESSION = 'new';
const SESSIONS_LISTED = 20;
/** The messages of a session continued that are shown: its last ones, enough to see where it left off. */
const HISTORY_SHOWN = 100;
const CALL_TIMEOUT = 15_000;
/** Hermes writes a keepalive every ten seconds while a turn goes on, a card waited on too: a stream silent this long is gone. */
const STREAM_SILENCE = 90_000;
/** The most of an answer read whole; a session's messages fit in it many times over. */
const BODY_MAX = 16 * 1024 * 1024;
const TEXT_MAX = 1_000_000;

/** A refusal of the window's asking: a setting that is not one, a session gone. */
export class HermesRefusal extends Error {}

interface Server {
  /** The address with the profile's path: what every route is put after. */
  base: string;
  key: string;
  /**
   * Paired by code (tailnet.ts): the requests go to the helper's proxy on this computer, with its token, and the proxy
   * puts them on the address; `path` is what follows the address in `base` (the profile's).
   */
  via?: { port: number; token: string; path: string };
}

interface Running {
  stop: AbortController;
  runId: string | null;
  server: Server | null;
  stopping: boolean;
}

const running = new Map<string, Running>();
const english = () => readSettings().language === 'en';

/* ------------------------------------------------------------------ */
/* What is set                                                         */
/* ------------------------------------------------------------------ */

/** Whether the chat offers Hermes: its address is given. */
export const hermesConfigured = (): boolean => Boolean(readSettings().hermesUrl);

export function hermesStatus(): HermesStatus {
  const { hermesUrl, hermesProfile } = readSettings();
  return { url: hermesUrl, profile: hermesProfile, key: keptReadable('hermes') };
}

/** The origin an address is sent to (scheme, host, port), or null for one that is not an address. */
function originOf(address: string | null): string | null {
  if (!address) return null;
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/** The address, the profile and, where one is given, a new key, as the window sets them. */
export function saveHermes(setup: unknown): HermesStatus {
  const asked = setup && typeof setup === 'object' ? (setup as Record<string, unknown>) : {};
  const url = typeof asked.url === 'string' ? hermesAddress(asked.url) : null;
  if (!url) throw new HermesRefusal('That is not the address of a Pyn server. Give it as https://host:port.');
  // Written as Hermes's path (`/p/name/`) or as the name alone.
  const profile = typeof asked.profile === 'string' ? asked.profile.trim().replace(/^\/?p\//, '').replace(/\/+$/, '') : '';
  if (profile && !HERMES_PROFILE.test(profile)) throw new HermesRefusal('That is not the name of a profile: letters, digits, - and _ only.');
  // The key first: one refused leaves the address as it was.
  if (typeof asked.key === 'string' && asked.key.trim()) saveKey('hermes', asked.key, undefined);
  else if (!keptReadable('hermes')) throw new HermesRefusal('Pyn on the server needs its API key (API_SERVER_KEY).');
  // A key kept goes only to the server it was given for: another host or port is asked for it again. Kept, the next
  // request sent it to whatever address the window had saved (29 October).
  else if (originOf(readSettings().hermesUrl) !== originOf(url)) throw new HermesRefusal('A new address needs its key again: a kept key is sent only to the server it was given for.');
  updateSettings((settings) => {
    settings.hermesUrl = url;
    settings.hermesProfile = profile || null;
  });
  return hermesStatus();
}

export function forgetHermes(): HermesStatus {
  forgetKey('hermes');
  updateSettings((settings) => {
    settings.hermesUrl = null;
    settings.hermesProfile = null;
  });
  return hermesStatus();
}

/** The server asked as a chat asks it, with the key kept: how many recent sessions it lists. */
export async function testHermes(): Promise<{ sessions: number }> {
  return { sessions: (await listSessions(serverOf(), undefined, true)).length };
}

function serverOf(): Server {
  const { hermesUrl, hermesProfile } = readSettings();
  const key = keyEnv('hermes').HERMES_API_KEY;
  // An address with a key kept that this computer cannot read back (kept on another, or under another account).
  if (hermesUrl && !key && keptHere('hermes')) throw new TurnFailure('The key kept for Pyn on the server cannot be read on this computer. Give its API key again in the AI tools window.', 'auth');
  if (!hermesUrl || !key) throw new TurnFailure('Pyn on the server is not set up: give its address and its API key in the AI tools window.', 'auth');
  const path = hermesProfile ? `/p/${encodeURIComponent(hermesProfile)}` : '';
  // An address paired by code is reached through the helper; while the helper is not up, its own sentence says why.
  const route = tailnetRoute(hermesUrl);
  if (route && 'trouble' in route) throw new TurnFailure(route.trouble, null);
  return { base: hermesUrl + path, key, ...(route ? { via: { port: route.port, token: route.token, path } } : {}) };
}

/* ------------------------------------------------------------------ */
/* Asking the server                                                   */
/* ------------------------------------------------------------------ */

interface Reply {
  status: number;
  body: string;
}

/** A request sent, its key in its header; the answer to `onResponse`. */
function open(server: Server, method: 'GET' | 'POST', route: string, body: unknown, signal: AbortSignal | undefined, timeout: number, onResponse: (response: http.IncomingMessage) => void): http.ClientRequest {
  const url = new URL(server.via ? `http://127.0.0.1:${server.via.port}${server.via.path}${route}` : server.base + route);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string | number> = { authorization: `Bearer ${server.key}`, accept: 'application/json, text/event-stream' };
  if (server.via) headers['x-cortex-tailnet'] = server.via.token;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, signal, timeout, agent: false }, onResponse);
  // Said by its code alone (unreachable): `Pyn on the server could not be reached (ETIMEDOUT)`.
  request.on('timeout', () => request.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
  request.end(payload);
  return request;
}

/** One request, its answer read whole. */
function call(server: Server, method: 'GET' | 'POST', route: string, body?: unknown, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = open(server, method, route, body, signal, CALL_TIMEOUT, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > BODY_MAX) request.destroy(new TurnFailure('Pyn on the server answered with more than Cortex reads.', null));
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      response.on('error', (err) => reject(err instanceof TurnFailure ? err : lost()));
      // Cut off with no end and no error said: the promise is not left waiting for ever.
      response.on('close', () => {
        if (!response.complete) reject(signal?.aborted ? new Stopped() : lost());
      });
    });
    request.on('error', (err: NodeJS.ErrnoException) => reject(signal?.aborted ? new Stopped() : err instanceof TurnFailure ? err : unreachable(err)));
  });
}

/** The server not reached: its kind of trouble named (`ECONNREFUSED`, a certificate's), never more of the error. */
function unreachable(err: NodeJS.ErrnoException): TurnFailure {
  const why = typeof err.code === 'string' && /^[A-Z0-9_]{2,60}$/.test(err.code) ? ` (${err.code})` : '';
  return new TurnFailure(`Pyn on the server could not be reached${why}. Check that the server is running and that the address is right.`, null);
}

const lost = () => new TurnFailure('Pyn on the server stopped answering mid-way: the connection was lost.', null);

/** What Hermes said of a refusal: its OpenAI-style `{"error": {"message"}}`, cut. */
function saidOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const said = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    return typeof said === 'string' ? said.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  } catch {
    return '';
  }
}

/** A refusal of the server's, as the chat says it. */
function refusal(reply: Reply): TurnFailure {
  const said = saidOf(reply.body);
  const status = reply.status;
  if (status === 401 || status === 403) return new TurnFailure('Pyn on the server did not take the key. Give its API_SERVER_KEY again in the AI tools window.', 'auth');
  if (status === 409) return new TurnFailure(said ? `Pyn on the server is busy with this session: ${said}` : 'Pyn on the server is busy with this session. Wait for its turn to end, or choose another session.', null);
  if (status === 429) return new TurnFailure('Pyn on the server is running as many turns as it takes. Try again in a moment.', null);
  return new TurnFailure(said ? `Pyn on the server refused (HTTP ${status}): ${said}` : `Pyn on the server refused (HTTP ${status}).`, null);
}

function parsed(reply: Reply): Record<string, unknown> {
  try {
    const value = JSON.parse(reply.body) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    /* said below */
  }
  throw new TurnFailure('Pyn on the server answered with something Cortex does not read. Is this the address of its API server?', null);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface Listed {
  id: string;
  title: string | null;
  preview: string | null;
  /** When it was last written to, in seconds, as Hermes keeps it. */
  at: number | null;
}

/**
 * Hermes's recent sessions, the last written to first (`GET /api/sessions`). A key refused, or an
 * address with no Hermes behind it, is the turn's failure; any other trouble leaves the list empty
 * and the turn goes on - unless `strict`, for the window's test of the connection.
 */
async function listSessions(server: Server, signal: AbortSignal | undefined, strict = false): Promise<Listed[]> {
  const reply = await call(server, 'GET', `/api/sessions?limit=${SESSIONS_LISTED}`, undefined, signal);
  if (reply.status === 404) throw new TurnFailure('There is no Pyn API server at this address: check the address and the profile.', null);
  if (reply.status !== 200) {
    if (strict || reply.status === 401 || reply.status === 403) throw refusal(reply);
    return [];
  }
  const data = parsed(reply).data;
  return (Array.isArray(data) ? data : [])
    .filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === 'object' && typeof (one as { id?: unknown }).id === 'string' && (one as { is_internal_child?: unknown }).is_internal_child !== true)
    .map((one) => ({
      id: String(one.id),
      title: textOf(one.title, 200) || null,
      preview: textOf(one.preview, 200) || null,
      at: typeof one.last_active === 'number' ? one.last_active : typeof one.started_at === 'number' ? one.started_at : null,
    }));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A session begun for the chat's first message, its id; named after the message, as Hermes's list shows it. */
async function createSession(server: Server, message: string, signal: AbortSignal): Promise<string> {
  const now = new Date();
  // Hermes keeps every title once: the moment makes it the chat's own.
  const title = `${message.trim().replace(/\s+/g, ' ').slice(0, 50)} · ${pad(now.getDate())}.${pad(now.getMonth() + 1)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  for (const body of [{ title, source: SOURCE }, { source: SOURCE }]) {
    const reply = await call(server, 'POST', '/api/sessions', body, signal);
    // A title it will not take: begun without one.
    if (reply.status === 400 && 'title' in body) continue;
    if (reply.status !== 200 && reply.status !== 201) throw refusal(reply);
    const session = parsed(reply).session as { id?: unknown } | undefined;
    if (typeof session?.id === 'string' && session.id) return session.id;
    break;
  }
  throw new TurnFailure('Pyn on the server did not start a session.', null);
}

/** A session's name on the chip: its title (or its first words), and when it was last written to. */
function sessionName(one: Listed, inEnglish: boolean): string {
  const name = (one.title || one.preview || one.id).replace(/\s+/g, ' ').trim();
  const shown = name.length > 48 ? `${name.slice(0, 47)}…` : name;
  if (one.at === null) return shown;
  const when = new Date(one.at > 1e12 ? one.at : one.at * 1000).toLocaleString(inEnglish ? 'en' : 'tr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `${shown} · ${when}`;
}

/** The chat's "Session" chip: a new session, then Hermes's recent ones; the chat's own among them. */
export function sessionOptions(sessions: Listed[], current: string | null): ConfigOption {
  const inEnglish = english();
  const choices = [{ value: NEW_SESSION, name: inEnglish ? 'New session' : 'Yeni oturum' }, ...sessions.map((one) => ({ value: one.id, name: sessionName(one, inEnglish) }))];
  if (current && !choices.some((one) => one.value === current)) choices.splice(1, 0, { value: current, name: inEnglish ? 'This chat’s session' : 'Bu sohbetin oturumu' });
  return { id: SESSION_OPTION, name: inEnglish ? 'Session' : 'Oturum', category: SESSION_OPTION, current: current ?? NEW_SESSION, choices };
}

/** A message's words: a string, or the text of its parts (`[{"type": "text", "text": …}]`). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * A session's messages (`GET /api/sessions/{id}/messages`, oldest first) as the chat shows them:
 * the person's as their messages, Hermes's words as its answers. Its tools' exchange, and what
 * Hermes keeps hidden (its compaction's scaffolding), are left out.
 */
export function historyEvents(messages: unknown[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  // Its own ids for each reading: one session chosen twice in a chat shows its messages twice, not merged.
  const reading = randomUUID();
  messages.forEach((one, at) => {
    if (!one || typeof one !== 'object') return;
    const message = one as Record<string, unknown>;
    if (message.display_kind === 'hidden') return;
    const text = contentText(message.content).trim().slice(0, TEXT_MAX);
    if (!text) return;
    if (message.role === 'user') {
      const time = typeof message.timestamp === 'number' ? message.timestamp : null;
      events.push({ type: 'user', text, at: time === null ? Date.now() : Math.round(time > 1e12 ? time : time * 1000) });
    } else if (message.role === 'assistant') {
      events.push({ type: 'text', id: `hermes-history:${reading}:${at}`, text });
    }
  });
  return events;
}

async function readHistory(server: Server, sessionId: string): Promise<ChatEvent[]> {
  const reply = await call(server, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${HISTORY_SHOWN}&order=latest`);
  if (reply.status === 404) throw new HermesRefusal('That session is gone.');
  if (reply.status !== 200) throw refusal(reply);
  const data = parsed(reply).data;
  return historyEvents(Array.isArray(data) ? data : []);
}

/* ------------------------------------------------------------------ */
/* A turn                                                              */
/* ------------------------------------------------------------------ */

/** Server-sent events read as they come: each event's name and its data, parsed. */
export function sseReader(onEvent: (name: string, data: Record<string, unknown>) => void) {
  let buffer = '';
  let name = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      try {
        const value = JSON.parse(data.join('\n')) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          onEvent(name || (typeof record.event === 'string' ? record.event : 'message'), record);
        }
      } catch {
        /* data that is not JSON */
      }
    }
    name = '';
    data = [];
  };
  const line = (raw: string) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!text) return dispatch();
    // `: keepalive`
    if (text.startsWith(':')) return;
    const at = text.indexOf(':');
    const field = at < 0 ? text : text.slice(0, at);
    const value = at < 0 ? '' : text.slice(at + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  };
  return {
    feed(chunk: string) {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}

/** A step's kind, by its tool's name, for its icon. */
function kindOf(tool: string): string {
  const name = tool.toLowerCase();
  if (/terminal|shell|bash|exec|process|command/.test(name)) return 'execute';
  if (/search|grep|find|glob/.test(name)) return 'search';
  if (/write|edit|patch|replace|create|delete/.test(name)) return 'edit';
  if (/read|view|open|list/.test(name)) return 'read';
  if (/web|fetch|browse|http|url/.test(name)) return 'fetch';
  return 'other';
}

/** Hermes's choices for a command it asks leave for, as the card offers them. */
const APPROVALS: Record<string, { kind: PermissionKind; en: string; tr: string }> = {
  once: { kind: 'allow_once', en: 'Allow once', tr: 'Bir kez izin ver' },
  session: { kind: 'allow_always', en: 'Allow for this session', tr: 'Bu oturumda izin ver' },
  always: { kind: 'allow_always', en: 'Always allow', tr: 'Hep izin ver' },
  deny: { kind: 'reject_once', en: 'Deny', tr: 'Reddet' },
};

/** A command Hermes asks leave for, asked of the person on a card; the answer sent back, "deny" when there is none. */
async function approve(turn: Turn, server: Server, data: Record<string, unknown>): Promise<void> {
  const runId = textOf(data.run_id, 200);
  if (!runId) return;
  const inEnglish = english();
  const offered = (Array.isArray(data.choices) ? data.choices : ['once', 'deny']).filter((one): one is string => typeof one === 'string' && one in APPROVALS);
  if (!offered.includes('deny')) offered.push('deny');
  const said = [textOf(data.description, 1000).trim(), textOf(data.command, OUTPUT_MAX * 2).trim()].filter(Boolean).join('\n');
  const chosen = await turn.ask({
    title: cutSaid(said || (inEnglish ? 'Pyn on the server asks before a step' : 'Pyn on the server bir adımdan önce izin istiyor')),
    kind: 'execute',
    paths: [],
    options: offered.map((id) => ({ id, name: inEnglish ? APPROVALS[id].en : APPROVALS[id].tr, kind: APPROVALS[id].kind })),
  });
  const requestId = textOf(data.request_id, 256);
  // Not taken (the run ended meanwhile): Hermes refuses the step itself when nobody answers.
  await call(server, 'POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { choice: chosen ?? 'deny', ...(requestId ? { request_id: requestId } : {}) }).catch(() => undefined);
}

/** Stop: asked of Hermes, so the run ends there and not only its stream; the stream let go once it answered, or after a few seconds. */
function halt(live: Running): void {
  if (live.stopping) return;
  live.stopping = true;
  const { runId, server } = live;
  if (!runId || !server) {
    live.stop.abort();
    return;
  }
  const timer = setTimeout(() => live.stop.abort(), STOP_GRACE.ms);
  void call(server, 'POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {})
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      live.stop.abort();
    });
}

/** The session the chat continues is no longer in Hermes: begun anew by the turn. */
const GONE = 'session-gone';

/** One turn streamed: what Hermes says told as the chat's events; how it ended, or GONE. */
function streamTurn(turn: Turn, server: Server, sessionId: string, message: string, live: Running): Promise<string> {
  const scrub = scrubberFor(turn.vault);
  const answerId = `hermes-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    let answering = false;
    let streamed = false;
    let ending: string | null = null;
    let failure: TurnFailure | null = null;
    let steps = 0;
    let remarks = 0;
    // The words before a step and the words after it are two messages: shown in their order, around it.
    let part = 0;
    let wrote = false;
    const textId = () => `${answerId}:${part}`;
    // The steps begun and not yet ended, in their order: an end is paired with the first of its tool's name.
    const begun: Array<{ name: string; id: string }> = [];

    const onEvent = (name: string, data: Record<string, unknown>) => {
      if (typeof data.run_id === 'string' && data.run_id) live.runId = data.run_id;
      // Where Hermes carried the conversation on in a session of its own (its context compacted): the chat follows it.
      if ((name === 'assistant.completed' || name.startsWith('run.')) && typeof data.session_id === 'string' && data.session_id && data.session_id !== sessionId && data.session_id.length <= 256) {
        turn.setSession(data.session_id);
      }
      switch (name) {
        case 'assistant.delta': {
          const piece = textOf(data.delta, TEXT_MAX);
          if (!piece) break;
          streamed = true;
          wrote = true;
          turn.emit({ type: 'text', id: textId(), text: scrub(piece) });
          break;
        }
        case 'tool.progress': {
          const piece = textOf(data.delta, TEXT_MAX);
          if (piece) turn.emit({ type: 'thought', id: `${answerId}:thought`, text: scrub(piece) });
          break;
        }
        case 'tool.started': {
          const tool = textOf(data.tool_name, 200) || 'tool';
          const id = `${answerId}:tool:${steps++}`;
          begun.push({ name: tool, id });
          if (wrote) {
            part += 1;
            wrote = false;
          }
          const preview = textOf(data.preview, 300).replace(/\s+/g, ' ').trim();
          turn.emit({ type: 'tool', id, title: scrub(preview ? `${tool}: ${preview}` : tool), kind: kindOf(tool), status: 'in_progress' });
          break;
        }
        case 'tool.completed':
        case 'tool.failed': {
          const at = begun.findIndex((one) => one.name === data.tool_name);
          const step = begun.splice(at >= 0 ? at : 0, 1)[0];
          if (!step) break;
          const output = textOf(data.preview, OUTPUT_MAX * 2);
          turn.emit({ type: 'tool', id: step.id, status: name === 'tool.failed' ? 'failed' : 'completed', ...(output ? { output: cutSaid(scrub(output)) } : {}) });
          break;
        }
        case 'assistant.commentary': {
          const text = textOf(data.text, TEXT_MAX).trim();
          if (text && data.already_streamed !== true) turn.emit({ type: 'text', id: `${answerId}:said:${remarks++}`, text: scrub(text) });
          break;
        }
        case 'assistant.completed': {
          const content = textOf(data.content, TEXT_MAX);
          if (!streamed && content.trim()) turn.emit({ type: 'text', id: textId(), text: scrub(content) });
          if (data.interrupted === true) ending = 'cancelled';
          break;
        }
        case 'approval.request':
          void approve(turn, server, data);
          break;
        case 'run.completed':
          ending = 'end_turn';
          break;
        case 'run.cancelled':
          ending = 'cancelled';
          break;
        case 'run.failed': {
          const why = textOf(data.turn_exit_reason ?? data.error, 300).trim();
          failure = new TurnFailure(why ? `Pyn on the server could not finish the answer: ${why}` : 'Pyn on the server could not finish the answer.', null);
          break;
        }
        case 'error': {
          const said = textOf(data.message, 500).trim();
          failure = new TurnFailure(said ? `Pyn on the server stopped: ${said}` : 'Pyn on the server stopped.', null);
          break;
        }
        default:
          break;
      }
    };

    const route = `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
    const request = open(server, 'POST', route, { input: message }, live.stop.signal, STREAM_SILENCE, (response) => {
      response.setEncoding('utf8');
      if (response.statusCode !== 200) {
        let text = '';
        response.on('data', (chunk: string) => (text = (text + chunk).slice(0, 8000)));
        response.on('end', () => finish(response.statusCode === 404 ? GONE : refusal({ status: response.statusCode ?? 0, body: text })));
        response.on('error', () => finish(lost()));
        return;
      }
      answering = true;
      const events = sseReader(onEvent);
      const end = () => {
        events.end();
        // Stopped: what came so far is the answer.
        finish(live.stopping ? 'cancelled' : (failure ?? ending ?? 'end_turn'));
      };
      response.on('data', (chunk: string) => events.feed(chunk));
      response.on('end', end);
      response.on('error', () => (live.stop.signal.aborted ? end() : finish(lost())));
      response.on('close', () => (live.stop.signal.aborted || ending || failure ? end() : finish(lost())));
    });
    request.on('error', (err: NodeJS.ErrnoException) => {
      if (live.stop.signal.aborted) finish('cancelled');
      else finish(answering ? lost() : unreachable(err));
    });
  });
}

export const hermesBackend: Backend = {
  async run(turn, message) {
    const stop = new AbortController();
    const live: Running = { stop, runId: null, server: null, stopping: false };
    running.get(turn.chatId)?.stop.abort();
    running.set(turn.chatId, live);
    const stopped = () => halt(live);
    turn.signal.addEventListener('abort', stopped, { once: true });
    if (turn.signal.aborted) halt(live);
    try {
      const server = serverOf();
      live.server = server;
      // Asked at every turn: the chip lists what Hermes has now, and a key refused says so before the message is sent.
      const sessions = await unlessStopped(stop.signal, listSessions(server, stop.signal));
      let sessionId = turn.sessionId;
      for (let attempt = 0; ; attempt += 1) {
        if (!sessionId) {
          sessionId = await unlessStopped(stop.signal, createSession(server, message, stop.signal));
          turn.setSession(sessionId);
        }
        turn.setOptions([sessionOptions(sessions, sessionId)]);
        if (!attempt) turn.sent?.();
        const reason = await streamTurn(turn, server, sessionId, message, live);
        if (reason !== GONE) return reason;
        if (attempt) throw new TurnFailure('Pyn on the server did not start a session.', null);
        // Deleted in Hermes since: the message goes to a new session, and the chat says the earlier one is not remembered.
        turn.emit({ type: 'notice', notice: 'new-session' });
        sessionId = null;
      }
    } catch (err) {
      if (err instanceof Stopped) return 'cancelled';
      // What the server said is passed on; its key, were the server ever to repeat it, is not.
      const key = live.server?.key;
      if (err instanceof TurnFailure && key && err.message.includes(key)) throw new TurnFailure(err.message.split(key).join('…'), err.kind);
      throw err;
    } finally {
      turn.signal.removeEventListener('abort', stopped);
      if (running.get(turn.chatId) === live) running.delete(turn.chatId);
    }
  },

  cancel(chatId) {
    const live = running.get(chatId);
    if (live) halt(live);
  },

  async offer(sessionId) {
    return [sessionOptions(await listSessions(serverOf(), undefined), sessionId)];
  },

  async setOption(_chatId, options, option, value, chat) {
    if (option !== SESSION_OPTION) return options;
    const next = options.map((one) => (one.id === option ? { ...one, current: value } : one));
    if (value === NEW_SESSION) {
      chat?.setSession(null);
      return next;
    }
    // Read before the chat is bound: a session that cannot be read is not continued blind.
    const history = await readHistory(serverOf(), value);
    chat?.setSession(value);
    for (const event of history) chat?.emit(event);
    return next;
  },

  forget(chatId) {
    // The session itself is Hermes's, and is left there.
    const live = running.get(chatId);
    if (live) halt(live);
  },

  shutdown() {
    for (const live of running.values()) live.stop.abort();
    running.clear();
  },
};

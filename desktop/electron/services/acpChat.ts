import { app } from 'electron';
import type { CliId, ConfigOption, PermissionKind, ToolStatus } from '../../shared/chat';
import { AcpConnection, AcpError } from './acp';
import { type Backend, ChatRefusal, OUTPUT_MAX, STOP_GRACE, Stopped, TITLE_MAX, type Turn, TurnFailure, cardPath, cardTextFor, cutSaid, scrubberFor, shownPath, textOf, unlessStopped, vaultWord } from './chatKit';
import { launchFor } from './clis';
import { keptHere } from './keys';
import { readSettings } from './settings';

/**
 * The chat with the CLIs that speak the Agent Client Protocol: OpenCode
 * (`opencode acp`), Gemini CLI and Qwen Code (`--acp`). One program per CLI,
 * started in the vault, its sessions one per chat (electron/services/acp.ts).
 * Its words are recorded from OpenCode's own (14 October): thought and
 * message chunks, tool calls and their updates with locations, usage, config
 * options for the model, the mode and the effort.
 */

interface Conn {
  cli: CliId;
  vault: string;
  acp: AcpConnection;
  ready: Promise<void>;
  canResume: boolean;
}

const conns = new Map<CliId, Conn>();
/** Each chat's session, in the program it lives in. */
const sessions = new Map<string, { conn: Conn; sessionId: string }>();

interface Running {
  turn: Turn;
  conn: Conn;
  /** Ends the turn as stopped without waiting for the program: a turn let go after Stop while other chats run on its program. */
  letGo: () => void;
}

/** The turn each session is running now: what its notifications and requests are told to. */
const running = new Map<string, Running>();
const stopping = new Map<string, ReturnType<typeof setTimeout>>();

/** The way in each ACP tool names for a key in its environment, as their `initialize` answered on 14 October. */
const KEY_METHODS: Partial<Record<CliId, string>> = { gemini: 'gemini-api-key', qwen: 'openai' };

const PERMISSION_KINDS: readonly PermissionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const TOOL_STATUSES: readonly ToolStatus[] = ['pending', 'in_progress', 'completed', 'failed'];

/** A session's settings as the program offers them; a list in groups is read whole. */
export function optionsOf(configOptions: unknown): ConfigOption[] | null {
  if (!Array.isArray(configOptions)) return null;
  const out: ConfigOption[] = [];
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const one = raw as { id?: unknown; name?: unknown; category?: unknown; type?: unknown; currentValue?: unknown; options?: unknown };
    if (typeof one.id !== 'string' || one.type !== 'select' || typeof one.currentValue !== 'string' || !Array.isArray(one.options)) continue;
    type Choice = { value?: unknown; name?: unknown; options?: unknown };
    const flat = (one.options as Choice[]).flatMap((choice) => (Array.isArray(choice.options) ? (choice.options as Choice[]) : [choice]));
    const choices = flat
      .filter((choice) => typeof choice.value === 'string')
      .map((choice) => ({ value: String(choice.value), name: textOf(choice.name, 120) || String(choice.value) }))
      .slice(0, 500);
    out.push({ id: one.id, name: textOf(one.name, 60) || one.id, category: typeof one.category === 'string' ? one.category : null, current: one.currentValue, choices });
  }
  return out;
}

/** The paths a step names, each as `show` says it: shownPath for the transcript, a card's whole path for a card. */
function pathsOf(vault: string, locations: unknown, show: (vault: string, place: string) => string = shownPath): string[] {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((one) => (typeof one === 'object' && one !== null && typeof (one as { path?: unknown }).path === 'string' ? show(vault, (one as { path: string }).path) : null))
    .filter((one): one is string => one !== null)
    .slice(0, 20);
}

/** What a step said back, as text: its words, a diff as the lines it adds and takes, nothing of a terminal. */
function outputOf(vault: string, content: unknown, scrub: (text: string) => string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const one = item as { type?: unknown; content?: { type?: unknown; text?: unknown }; path?: unknown; oldText?: unknown; newText?: unknown };
    if (one.type === 'content' && one.content?.type === 'text' && typeof one.content.text === 'string') parts.push(one.content.text);
    if (one.type === 'diff' && typeof one.path === 'string') {
      const lines = (value: unknown) => (typeof value === 'string' && value ? value.split('\n').length : 0);
      parts.push(`${shownPath(vault, one.path)}: +${lines(one.newText)} −${lines(one.oldText)}`);
    }
  }
  return parts.length ? scrub(parts.join('\n')).slice(0, OUTPUT_MAX) : undefined;
}

function connectionFor(cli: CliId, vault: string): Promise<Conn> {
  const had = conns.get(cli);
  if (had && had.acp.alive && had.vault === vault) return had.ready.then(() => had);
  had?.acp.close();
  const launch = launchFor(cli);
  if (!launch) throw new ChatRefusal(`${cli} is not installed on this machine.`);
  const conn = { cli, vault, canResume: false } as Conn;
  conn.acp = new AcpConnection(launch, vault, {
    notify: (method, params) => heard(conn, method, params),
    request: (method, params) => asked(method, params),
    exited: () => {
      if (conns.get(cli) === conn) conns.delete(cli);
      for (const [chatId, held] of sessions) if (held.conn === conn) sessions.delete(chatId);
    },
  });
  conn.ready = conn.acp
    .request('initialize', {
      protocolVersion: 1,
      // The program reads and writes the vault with its own tools, under its own permissions: Cortex serves it no files and no terminal.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'Cortex', version: app.getVersion() },
    })
    .then(async (result) => {
      const answer = result as { agentCapabilities?: { sessionCapabilities?: { resume?: unknown } }; authMethods?: Array<{ id?: unknown }> } | null;
      conn.canResume = Boolean(answer?.agentCapabilities?.sessionCapabilities?.resume);
      // A key kept by Cortex is in the program's environment; it is told to use it, by the way in it names for a key (14 October).
      const method = KEY_METHODS[cli];
      if (method && keptHere(cli) && answer?.authMethods?.some((one) => one.id === method)) await conn.acp.request('authenticate', { methodId: method });
    });
  // A start that failed is not kept: the next message starts the program again, rather than meet the same failure until the app is closed.
  conn.ready.catch(() => {
    if (conns.get(cli) !== conn) return;
    conns.delete(cli);
    conn.acp.close();
  });
  conns.set(cli, conn);
  return conn.ready.then(() => conn);
}

/** The chat's session in this program: the one it had where the program can resume it, else a new one, given the person's last choices for this CLI. */
async function sessionFor(turn: Turn, conn: Conn): Promise<string> {
  const held = sessions.get(turn.chatId);
  if (held && held.conn === conn) return held.sessionId;
  const known = turn.sessionId;
  if (known && conn.canResume) {
    try {
      const resumed = (await conn.acp.request('session/resume', { sessionId: known, cwd: conn.vault, mcpServers: [] })) as { configOptions?: unknown } | null;
      if (turn.signal.aborted) throw new Stopped();
      sessions.set(turn.chatId, { conn, sessionId: known });
      const options = optionsOf(resumed?.configOptions);
      if (options) turn.setOptions(options);
      return known;
    } catch (err) {
      if (err instanceof Stopped) throw err;
      /* A session the program no longer has: a new one. */
    }
  }
  const made = (await conn.acp.request('session/new', { cwd: conn.vault, mcpServers: [] })) as { sessionId?: unknown; configOptions?: unknown } | null;
  // Stopped meanwhile: the session is left unrecorded rather than written over a later turn's.
  if (turn.signal.aborted) throw new Stopped();
  if (typeof made?.sessionId !== 'string') throw new TurnFailure('The program did not start a session.', null);
  const sessionId = made.sessionId;
  sessions.set(turn.chatId, { conn, sessionId });
  turn.setSession(sessionId);
  // The chat had a conversation this program could not continue: the person is told it begins anew, rather than find it forgotten.
  if (known) turn.emit({ type: 'notice', notice: 'new-session' });
  let options = optionsOf(made.configOptions) ?? [];
  turn.setOptions(options);
  for (const [configId, value] of Object.entries(turn.prefs)) {
    const option = options.find((one) => one.id === configId);
    if (!option || option.current === value || !option.choices.some((choice) => choice.value === value)) continue;
    try {
      const set = (await conn.acp.request('session/set_config_option', { sessionId, configId, value })) as { configOptions?: unknown } | null;
      options = optionsOf(set?.configOptions) ?? options.map((one) => (one.id === configId ? { ...one, current: value } : one));
      turn.setOptions(options);
    } catch {
      /* The program's own default stands. */
    }
  }
  return sessionId;
}

/** A notification from a program: what one of its sessions did, told to the turn it runs. */
function heard(conn: Conn, method: string, params: unknown): void {
  if (method !== 'session/update' || typeof params !== 'object' || params === null) return;
  const { sessionId, update } = params as { sessionId?: unknown; update?: Record<string, unknown> };
  const turn = typeof sessionId === 'string' ? running.get(sessionId)?.turn : undefined;
  if (!turn || !update) return;
  const scrub = scrubberFor(conn.vault);
  const content = update.content as { type?: unknown; text?: unknown } | undefined;
  const messageId = typeof update.messageId === 'string' ? update.messageId : `turn-${turn.number}`;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (content?.type === 'text' && typeof content.text === 'string') turn.emit({ type: 'text', id: messageId, text: scrub(content.text) });
      break;
    case 'agent_thought_chunk':
      if (content?.type === 'text' && typeof content.text === 'string') turn.emit({ type: 'thought', id: `${messageId}:thought`, text: scrub(content.text) });
      break;
    case 'tool_call':
    case 'tool_call_update': {
      if (typeof update.toolCallId !== 'string') break;
      const title = textOf(update.title, TITLE_MAX) || textOf(update.name, TITLE_MAX);
      turn.emit({
        type: 'tool',
        id: update.toolCallId.slice(0, 200),
        title: title ? scrub(title) : undefined,
        kind: typeof update.kind === 'string' ? update.kind.slice(0, 40) : undefined,
        status: TOOL_STATUSES.includes(update.status as ToolStatus) ? (update.status as ToolStatus) : undefined,
        paths: Array.isArray(update.locations) ? pathsOf(conn.vault, update.locations) : undefined,
        output: outputOf(conn.vault, update.content, scrub),
      });
      break;
    }
    case 'plan':
      if (Array.isArray(update.entries))
        turn.emit({ type: 'plan', entries: (update.entries as Array<{ content?: unknown; status?: unknown }>).slice(0, 50).map((one) => ({ content: scrub(textOf(one.content, 500)), status: textOf(one.status, 20) || 'pending' })) });
      break;
    case 'usage_update': {
      const cost = update.cost as { amount?: unknown; currency?: unknown } | undefined;
      if (typeof update.used === 'number' && typeof update.size === 'number')
        turn.emit({ type: 'usage', used: update.used, size: update.size, cost: typeof cost?.amount === 'number' ? cost.amount : null, currency: typeof cost?.currency === 'string' ? cost.currency : null });
      break;
    }
    case 'config_option_update': {
      const options = optionsOf(update.configOptions);
      if (options) turn.setOptions(options);
      break;
    }
    case 'session_info_update':
      // The program's own name for the chat, where it gives one, over the first words of the first message.
      if (typeof update.title === 'string' && update.title.trim()) turn.setTitle(scrub(update.title.trim()));
      break;
    default:
      break;
  }
}

/** A request from a program: leave for a step, asked of the person on a card; nothing else is answered. */
async function asked(method: string, params: unknown): Promise<unknown> {
  if (method !== 'session/request_permission') throw new AcpError(`Cortex does not answer ${method}.`, -32601);
  const { sessionId, toolCall, options } = (params ?? {}) as { sessionId?: unknown; toolCall?: Record<string, unknown>; options?: unknown };
  const turn = typeof sessionId === 'string' ? running.get(sessionId)?.turn : undefined;
  if (!turn) return { outcome: { outcome: 'cancelled' } };
  // A card hides nothing: the vault said as a word, a path outside it whole, the title to its end (chatKit.ts).
  const say = cardTextFor(turn.vault, vaultWord(readSettings().language !== 'en'));
  const choices = (Array.isArray(options) ? options : [])
    .filter((one): one is { optionId: string; name?: unknown; kind?: unknown } => typeof one === 'object' && one !== null && typeof one.optionId === 'string')
    .slice(0, 8)
    .map((one) => ({ id: one.optionId, name: say(textOf(one.name, 80)) || one.optionId, kind: PERMISSION_KINDS.includes(one.kind as PermissionKind) ? (one.kind as PermissionKind) : 'allow_once' }));
  const chosen = await turn.ask({
    title: cutSaid(say(textOf(toolCall?.title, 100_000) || textOf(toolCall?.kind, 40))),
    kind: textOf(toolCall?.kind, 40) || 'other',
    paths: pathsOf(turn.vault, toolCall?.locations, (vault, place) => cardPath(vault, place, say)),
    options: choices,
  });
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } };
}

/** What a refusal from the program says it is: out of quota, not logged in, not supported, gone. */
function failureOf(err: unknown): TurnFailure {
  if (err instanceof TurnFailure) return err;
  if (err instanceof AcpError) {
    const data = err.data as { errorName?: unknown; authMethods?: unknown } | null;
    if (data && typeof data.errorName === 'string') return new TurnFailure(err.message, data.errorName.slice(0, 60));
    // Not logged in: the CLI names the ways it can be (Qwen Code, 14 October), or says so by the protocol's own code for it, `auth_required`.
    if ((data && Array.isArray(data.authMethods)) || err.code === -32000) return new TurnFailure(err.message, 'auth');
    if (err.code === -32601) return new TurnFailure(err.message, 'unsupported');
    return new TurnFailure(err.message, err.code === null ? 'stopped' : null);
  }
  return new TurnFailure(err instanceof Error ? err.message : String(err), null);
}

export const acpBackend: Backend = {
  async run(turn, message) {
    let sessionId: string | null = null;
    let entry: Running | null = null;
    try {
      const conn = await unlessStopped(turn.signal, connectionFor(turn.cli, turn.vault));
      sessionId = await unlessStopped(turn.signal, sessionFor(turn, conn));
      const letGo = new Promise<{ stopReason: string }>((resolve) => {
        entry = { turn, conn, letGo: () => resolve({ stopReason: 'cancelled' }) };
        running.set(sessionId as string, entry);
      });
      const prompt = conn.acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: message }] });
      const result = (await Promise.race([prompt, letGo])) as { stopReason?: unknown } | null;
      return typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
    } catch (err) {
      // After Stop, however the program ended the turn - its answer, an error, the program ended - the turn was stopped.
      if (err instanceof Stopped || turn.signal.aborted) return 'cancelled';
      throw failureOf(err);
    } finally {
      if (sessionId && entry && running.get(sessionId) === entry) running.delete(sessionId);
      const timer = stopping.get(turn.chatId);
      if (timer) clearTimeout(timer);
      stopping.delete(turn.chatId);
    }
  },

  cancel(chatId) {
    const held = sessions.get(chatId);
    const now = held ? running.get(held.sessionId) : undefined;
    if (!held || !now) return;
    held.conn.acp.notify('session/cancel', { sessionId: held.sessionId });
    if (stopping.has(chatId)) return;
    stopping.set(
      chatId,
      setTimeout(() => {
        if (running.get(held.sessionId) !== now) return;
        // One program carries every chat of its CLI: ended only when this turn is the only one on it. Else this
        // turn alone is let go, its session with it, and the chat's next message resumes it or starts a new one.
        if ([...running.values()].some((other) => other !== now && other.conn === now.conn)) {
          running.delete(held.sessionId);
          if (sessions.get(chatId) === held) sessions.delete(chatId);
          now.letGo();
        } else held.conn.acp.close();
      }, STOP_GRACE.ms),
    );
  },

  async setOption(chatId, options, option, value) {
    const held = sessions.get(chatId);
    if (!held || !held.conn.acp.alive) throw new ChatRefusal('The chat is not connected; write to it first.');
    const set = (await held.conn.acp.request('session/set_config_option', { sessionId: held.sessionId, configId: option, value })) as { configOptions?: unknown } | null;
    return optionsOf(set?.configOptions) ?? options.map((one) => (one.id === option ? { ...one, current: value } : one));
  },

  forget(chatId) {
    sessions.delete(chatId);
  },

  shutdown() {
    for (const conn of conns.values()) conn.acp.close();
    conns.clear();
    sessions.clear();
  },
};

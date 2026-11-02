import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { CliId, ConfigOption, PermissionKind, ToolStatus } from '../../shared/chat';
import { AcpConnection, AcpError } from './acp';
import { type Backend, ChatRefusal, OUTPUT_MAX, STOP_GRACE, Stopped, TITLE_MAX, type Turn, TurnFailure, cardPath, cardTextFor, cutSaid, scrubberFor, shownPath, textOf, unlessStopped, vaultWord } from './chatKit';
import { launchFor } from './clis';
import { keptReadable } from './keys';
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
/**
 * A session begun to show a new chat's model and mode before its first message (probe), taken by the next new chat of
 * its CLI rather than left unused: one at most for each CLI, so opening new chats leaves no trail of empty sessions.
 */
const spares = new Map<CliId, { conn: Conn; sessionId: string; options: ConfigOption[] }>();
/** A probe going on, for each CLI. */
const probing = new Map<CliId, Promise<ConfigOption[]>>();
/** Each chat's settings as its program last gave them: the model a refusal was for. */
const shown = new Map<string, ConfigOption[]>();

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

/**
 * OpenCode names a model by its provider first ("opencode-go/…"), and its own default can be one of a provider nobody
 * signed in to here: signed in to OpenCode Go, a chat began on "opencode/DeepSeek V4.1 Flash" (OpenCode Zen) and every
 * message was refused, "provider authentication required", signing in again changing nothing (2 November). A
 * provider by its name ("OpenCode Go") is its id with the spaces and marks taken out ("opencode-go"); OpenCode Zen's
 * id is "opencode".
 */
const providerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const PROVIDER_NAMES: Record<string, string[]> = { opencode: ['opencode', 'opencodezen'] };
const providerOf = (value: string) => value.split('/')[0] ?? '';

/**
 * A model of a provider signed in to, for a model option whose current one is of a provider that is not; null where it
 * is signed in, nothing is known to be, or none of the choices is one. The providers in the order they are listed.
 */
export function signedInChoice(option: ConfigOption, signedIn: string[]): string | null {
  const keys = signedIn.map(providerKey).filter(Boolean);
  const named = (provider: string) => PROVIDER_NAMES[provider] ?? [providerKey(provider)];
  if (!keys.length || named(providerOf(option.current)).some((one) => keys.includes(one))) return null;
  for (const key of keys) {
    const hit = option.choices.find((choice) => named(providerOf(choice.value)).includes(key));
    if (hit) return hit.value;
  }
  return null;
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
      if (spares.get(cli)?.conn === conn) spares.delete(cli);
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
      if (method && keptReadable(cli) && answer?.authMethods?.some((one) => one.id === method)) await conn.acp.request('authenticate', { methodId: method });
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
  let sessionId: string;
  let options: ConfigOption[];
  // The session begun to show the new chat's settings, taken; else a new one.
  const spare = spares.get(conn.cli);
  if (spare && spare.conn === conn) {
    spares.delete(conn.cli);
    sessionId = spare.sessionId;
    options = spare.options;
  } else {
    const made = (await conn.acp.request('session/new', { cwd: conn.vault, mcpServers: [] })) as { sessionId?: unknown; configOptions?: unknown } | null;
    // Stopped meanwhile: the session is left unrecorded rather than written over a later turn's.
    if (turn.signal.aborted) throw new Stopped();
    if (typeof made?.sessionId !== 'string') throw new TurnFailure('The program did not start a session.', null);
    sessionId = made.sessionId;
    options = optionsOf(made.configOptions) ?? [];
  }
  sessions.set(turn.chatId, { conn, sessionId });
  turn.setSession(sessionId);
  // The chat had a conversation this program could not continue: the person is told it begins anew, rather than find it forgotten.
  if (known) turn.emit({ type: 'notice', notice: 'new-session' });
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
  const signed = await signedInModel(conn, sessionId, options, turn.prefs);
  if (signed !== options) turn.setOptions(signed);
  return sessionId;
}

/**
 * No model chosen for OpenCode yet, and its default one of a provider not signed in to: one of OpenCode Go, where its key
 * is given in Cortex, the one way in (auth.ts) (signedInChoice).
 * The settings as they are after; the same ones where nothing was changed.
 */
async function signedInModel(conn: Conn, sessionId: string, options: ConfigOption[], prefs: Readonly<Record<string, string>>): Promise<ConfigOption[]> {
  const model = conn.cli === 'opencode' ? options.find((one) => one.category === 'model' || one.id === 'model') : undefined;
  if (!model || prefs[model.id] !== undefined) return options;
  const value = signedInChoice(model, keptReadable('opencode') ? ['OpenCode Go'] : []);
  if (!value) return options;
  try {
    const set = (await conn.acp.request('session/set_config_option', { sessionId, configId: model.id, value })) as { configOptions?: unknown } | null;
    return optionsOf(set?.configOptions) ?? options.map((one) => (one.id === model.id ? { ...one, current: value } : one));
  } catch {
    /* The program's own default stands. */
    return options;
  }
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
    const data = err.data as { errorName?: unknown; authMethods?: unknown; providerId?: unknown } | null;
    if (data && typeof data.errorName === 'string') return new TurnFailure(err.message, data.errorName.slice(0, 60));
    // The tool is signed in, the chosen model's provider is not (OpenCode names it): another model, or that provider's sign-in.
    if (data && typeof data.providerId === 'string' && data.providerId) {
      return new TurnFailure(`The chosen model's provider (${data.providerId.slice(0, 60)}) is not signed in.`, 'provider-auth');
    }
    // Not logged in: the CLI names the ways it can be (Qwen Code, 14 October), or says so by the protocol's own code for it, `auth_required`.
    if ((data && Array.isArray(data.authMethods)) || err.code === -32000) return new TurnFailure(err.message, 'auth');
    if (err.code === -32601) return new TurnFailure(err.message, 'unsupported');
    return new TurnFailure(err.message, err.code === null ? 'stopped' : null);
  }
  return new TurnFailure(err instanceof Error ? err.message : String(err), null);
}

/**
 * OpenCode refused the turn for want of a key for the chosen model's provider, without naming it (its LoadAPIKeyError,
 * 2 November: "provider authentication required" with OpenCode Go signed in): named from the chat's model, so the
 * window says whose sign-in is missing rather than that OpenCode's own is.
 */
function providerRefusal(failure: TurnFailure, options: ConfigOption[] | undefined): TurnFailure {
  if (failure.kind !== 'auth' || !/provider authentication required/i.test(failure.message)) return failure;
  const model = options?.find((one) => one.category === 'model' || one.id === 'model')?.current;
  const provider = model ? providerOf(model).slice(0, 60) : '';
  return provider ? new TurnFailure(`The chosen model's provider (${provider}) is not signed in.`, 'provider-auth') : failure;
}

/** Where OpenCode writes its log (XDG data, as it keeps its sign-ins): ~/.local/share/opencode/log, on Windows too. */
export const opencodeLogDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'log');

/** The end of a log read: enough for the minutes a turn takes, little of a log grown over months. */
const LOG_TAIL = 512 * 1024;

/**
 * What OpenCode wrote in its own log of the refusal of a turn begun at `since`: the provider's own sentence, as "This API
 * key has expired. Create a new API key in OpenCode Console…". Its ACP says only "provider authentication required";
 * 2 November, the sentence was in its log since the morning, through thirty sign-ins that could not help. Null where
 * it wrote none: no log, none since the turn began, or none of a provider's refusal.
 */
export function opencodeSaid(since: number, dir: string = opencodeLogDir()): string | null {
  let files: Array<{ file: string; at: number }>;
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((one) => one.at >= since - 5_000)
      .sort((a, b) => b.at - a.at)
      .slice(0, 3);
  } catch {
    return null;
  }
  for (const { file } of files) {
    let text: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, LOG_TAIL);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!/\bERROR\b/.test(line)) continue;
      // 2.x: `timestamp=2026-11-02T18:18:13.984Z level=ERROR`; 1.x: `ERROR 2026-08-01T22:21:22 +993ms` (local time).
      const stamp = /timestamp=(\S+Z)\b/.exec(line)?.[1] ?? /^ERROR\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(line)?.[1];
      const at = stamp ? Date.parse(stamp) : NaN;
      if (Number.isNaN(at)) continue;
      if (at < since - 2_000) break;
      const said = /(?:AI\.Error|AI_APICallError|AI_LoadAPIKeyError|LoadAPIKeyError|ProviderAuthError|AuthenticationError):\s*(.+?)(?:\\n|\\"|"|$)/.exec(line)?.[1]?.trim();
      if (said) return said.slice(0, 300);
    }
  }
  return null;
}

/**
 * The provider refusing the key itself, as OpenCode passes it on in its protocol (an `APIError`): said as the key's
 * refusal, in its own words. 2 November: a key given in Cortex that opencode.ai did not know came as "Internal error:
 * Upstream request failed: Invalid credential", under "something went wrong", with no word of the key.
 */
export function opencodeKeyRefusal(failure: TurnFailure): TurnFailure | null {
  if (failure.kind !== 'APIError' || !/invalid credential|invalid api key|api key has expired|unauthori[sz]ed/i.test(failure.message)) return null;
  return new TurnFailure(`OpenCode: ${failure.message.replace(/^Internal error:\s*/i, '')}`, 'provider-key');
}

/** OpenCode's own sentence for a refusal of its sign-in, where its log has one: said instead of the protocol's. */
async function withOpencodeCause(cli: CliId, failure: TurnFailure, since: number): Promise<TurnFailure> {
  if (cli !== 'opencode') return failure;
  const refused = opencodeKeyRefusal(failure);
  if (refused) return refused;
  if (failure.kind !== 'auth' && failure.kind !== 'provider-auth') return failure;
  // Written as it refused, by its server process: looked for again for a couple of seconds, until it reaches the file.
  for (let tries = 0; tries < 6; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const said = opencodeSaid(since);
    if (said) return new TurnFailure(`OpenCode: ${said}`, 'provider-key');
  }
  return failure;
}

export const acpBackend: Backend = {
  async run(original, message) {
    const began = Date.now();
    let sessionId: string | null = null;
    let entry: Running | null = null;
    const turn: Turn = {
      ...original,
      setOptions: (options) => {
        shown.set(original.chatId, options);
        original.setOptions(options);
      },
    };
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
      throw await withOpencodeCause(turn.cli, providerRefusal(failureOf(err), shown.get(turn.chatId)), began);
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

  probe(cli, vault, prefs) {
    // Asked twice at once (the tool chosen, then the list of tools read again): one session begun, not two.
    const going = probing.get(cli);
    if (going) return going;
    const asked = (async () => {
      const conn = await connectionFor(cli, vault);
      const had = spares.get(cli);
      if (had && had.conn === conn) return had.options;
      const made = (await conn.acp.request('session/new', { cwd: conn.vault, mcpServers: [] })) as { sessionId?: unknown; configOptions?: unknown } | null;
      if (typeof made?.sessionId !== 'string') return [];
      const spare = { conn, sessionId: made.sessionId, options: optionsOf(made.configOptions) ?? [] };
      spares.set(cli, spare);
      // Shown as it will run: OpenCode's model of a provider signed in to, where none was chosen.
      spare.options = await signedInModel(conn, spare.sessionId, spare.options, prefs);
      return spare.options;
    })().finally(() => probing.delete(cli));
    probing.set(cli, asked);
    return asked;
  },

  async prefer(cli, options, option, value) {
    // Given to the session begun for the new chat, where there is one: another model offers its own efforts.
    const spare = spares.get(cli);
    if (!spare || !spare.conn.acp.alive) return options;
    const set = (await spare.conn.acp.request('session/set_config_option', { sessionId: spare.sessionId, configId: option, value })) as { configOptions?: unknown } | null;
    spare.options = optionsOf(set?.configOptions) ?? options;
    return spare.options;
  },

  async setOption(chatId, options, option, value) {
    const held = sessions.get(chatId);
    if (!held || !held.conn.acp.alive) throw new ChatRefusal('The chat is not connected; write to it first.');
    const set = (await held.conn.acp.request('session/set_config_option', { sessionId: held.sessionId, configId: option, value })) as { configOptions?: unknown } | null;
    const next = optionsOf(set?.configOptions) ?? options.map((one) => (one.id === option ? { ...one, current: value } : one));
    shown.set(chatId, next);
    return next;
  },

  forget(chatId) {
    sessions.delete(chatId);
    shown.delete(chatId);
  },

  shutdown() {
    for (const conn of conns.values()) conn.acp.close();
    conns.clear();
    sessions.clear();
    spares.clear();
  },
};

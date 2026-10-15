import { app } from 'electron';
import type { CliId, ConfigOption, ToolStatus } from '../../shared/chat';
import { AcpConnection, AcpError } from './acp';
import { type Backend, type Card, ChatRefusal, OUTPUT_MAX, STOP_GRACE, TITLE_MAX, type Turn, TurnFailure, scrubberFor, shownPath, textOf } from './chatKit';
import { launchFor } from './clis';
import { readSettings } from './settings';

/**
 * The chat with Codex, through its app server (`codex app-server`): JSON-RPC
 * over standard input and output, the framing ACP uses too, so the same
 * connection carries it (electron/services/acp.ts). One server per vault, a
 * thread per chat, a turn per message. Its words were taken from the types
 * the server writes itself (`codex app-server generate-ts`) and from a
 * recorded session with Codex 0.162.1 (14 October): agent message deltas
 * (`commentary` while it works, `final_answer` at the end, which comes whole),
 * command and file-change items, the plan, token usage with the context
 * window, and `turn/completed` with its status and error.
 *
 * The model, the effort, the approval policy and the sandbox are given with
 * every turn, so a setting changed applies to the next message as it is. The
 * model a chat starts with is the person's last choice, else the one the
 * server marks as default: the model in `config.toml` can be one the account
 * may no longer use (14 October: `gpt-5.5`, refused for a ChatGPT account).
 * Full access to the disk is never offered.
 */

interface Model {
  id: string;
  name: string;
  isDefault: boolean;
  efforts: string[];
}

interface Conn {
  cli: CliId;
  vault: string;
  rpc: AcpConnection;
  ready: Promise<void>;
  models: Model[];
}

interface Running {
  turn: Turn;
  turnId: string | null;
  finish: (reason: string) => void;
  fail: (error: TurnFailure) => void;
  /** Items whose words came in pieces: their whole text at completion is not shown again. */
  streamed: Set<string>;
  /** The paths of each file change, for the card that asks to apply it. */
  changes: Map<string, string[]>;
}

const conns = new Map<CliId, Conn>();
const threads = new Map<string, { conn: Conn; threadId: string }>();
const running = new Map<string, Running>();
const settings = new Map<string, ConfigOption[]>();
const stopping = new Map<string, ReturnType<typeof setTimeout>>();

const MODES = ['ask', 'readonly', 'auto'] as const;
type Mode = (typeof MODES)[number];
const turkish = () => readSettings().language !== 'en';

/** What a mode lets Codex do: ask before what the sandbox stops, read only, or work in the vault without asking. */
function policyOf(mode: string): { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> } {
  const write = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  if (mode === 'readonly') return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  if (mode === 'auto') return { approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: write };
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: write };
}

/** The chat's settings: the server's models, what Codex may do, and the effort the chosen model offers. */
export function codexOptions(models: Model[], prefs: Readonly<Record<string, string>>): ConfigOption[] {
  const tr = turkish();
  const model = models.find((one) => one.id === prefs.model) ?? models.find((one) => one.isDefault) ?? models[0];
  const modeNames: Record<Mode, string> = tr ? { ask: 'Önce sor', readonly: 'Salt okunur', auto: 'Kasada sormadan çalış' } : { ask: 'Ask first', readonly: 'Read only', auto: 'Work in the vault without asking' };
  const efforts = ['default', ...(model?.efforts ?? [])];
  const effortName = (value: string) => (value === 'default' ? (tr ? 'Varsayılan efor' : 'Default effort') : tr ? `Efor: ${value}` : `Effort: ${value}`);
  const options: ConfigOption[] = [];
  if (model) options.push({ id: 'model', name: 'Model', category: 'model', current: model.id, choices: models.map((one) => ({ value: one.id, name: one.name })) });
  options.push({ id: 'mode', name: tr ? 'İzin modu' : 'Permission mode', category: 'mode', current: MODES.includes(prefs.mode as Mode) ? prefs.mode : 'ask', choices: MODES.map((value) => ({ value, name: modeNames[value] })) });
  options.push({ id: 'effort', name: tr ? 'Efor' : 'Effort', category: 'thought_level', current: efforts.includes(prefs.effort) ? prefs.effort : 'default', choices: efforts.map((value) => ({ value, name: effortName(value) })) });
  return options;
}

/** The sentence inside a failure: the server sends the provider's JSON as the message. */
export function sentenceOf(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === 'string' && inner.trim()) return inner;
  } catch {
    /* plain words */
  }
  return message;
}

/** What a failed turn is, for the window to say plainly. */
function kindOf(info: unknown, sentence: string): string | null {
  if (info === 'unauthorized') return 'auth';
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') return 'provider.quota';
  if (/model is not supported|model .*not (available|found)|unsupported model/i.test(sentence)) return 'model';
  return null;
}

function command(item: Record<string, unknown>): string {
  const actions = Array.isArray(item.commandActions) ? (item.commandActions as Array<{ command?: unknown }>) : [];
  return textOf(actions[0]?.command, 300) || textOf(item.command, 300);
}

function kindOfCommand(item: Record<string, unknown>): string {
  const first = Array.isArray(item.commandActions) ? (item.commandActions as Array<{ type?: unknown }>)[0]?.type : undefined;
  return first === 'read' ? 'read' : first === 'search' || first === 'listFiles' ? 'search' : 'execute';
}

const statusOf = (value: unknown): ToolStatus => (value === 'completed' ? 'completed' : value === 'failed' || value === 'declined' ? 'failed' : 'in_progress');

/** A diff as the lines it adds and takes. */
function diffCount(diff: unknown): string {
  if (typeof diff !== 'string') return '';
  const lines = diff.split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return `+${added} −${removed}`;
}

function connectionFor(cli: CliId, vault: string): Promise<Conn> {
  const had = conns.get(cli);
  if (had && had.rpc.alive && had.vault === vault) return had.ready.then(() => had);
  had?.rpc.close();
  const launch = launchFor(cli);
  if (!launch) throw new ChatRefusal('Codex is not installed on this machine.');
  const conn = { cli, vault, models: [] } as unknown as Conn;
  conn.rpc = new AcpConnection(launch, vault, {
    notify: (method, params) => heard(conn, method, params),
    request: (method, params) => asked(method, params),
    exited: () => {
      if (conns.get(cli) === conn) conns.delete(cli);
      for (const [chatId, held] of threads) if (held.conn === conn) threads.delete(chatId);
    },
  });
  conn.ready = (async () => {
    await conn.rpc.request('initialize', { clientInfo: { name: 'cortex', title: 'Cortex', version: app.getVersion() }, capabilities: null });
    conn.rpc.notify('initialized', undefined);
    const listed = (await conn.rpc.request('model/list', {}).catch(() => null)) as { data?: unknown } | null;
    conn.models = (Array.isArray(listed?.data) ? (listed.data as Array<Record<string, unknown>>) : [])
      .filter((one) => typeof one.id === 'string' && !one.hidden)
      .map((one) => ({
        id: String(one.id),
        name: textOf(one.displayName, 80) || String(one.id),
        isDefault: one.isDefault === true,
        efforts: (Array.isArray(one.supportedReasoningEfforts) ? (one.supportedReasoningEfforts as Array<{ reasoningEffort?: unknown }>) : []).map((effort) => textOf(effort.reasoningEffort, 20)).filter(Boolean),
      }))
      .slice(0, 40);
  })();
  conns.set(cli, conn);
  return conn.ready.then(() => conn);
}

/** The chat's thread: the one it had, resumed; else a new one in the vault. */
async function threadFor(turn: Turn, conn: Conn, mode: string): Promise<string> {
  const held = threads.get(turn.chatId);
  if (held && held.conn === conn) return held.threadId;
  const policy = policyOf(mode);
  if (turn.sessionId) {
    try {
      const resumed = (await conn.rpc.request('thread/resume', { threadId: turn.sessionId, cwd: conn.vault, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox })) as { thread?: { id?: unknown } } | null;
      if (typeof resumed?.thread?.id === 'string') {
        threads.set(turn.chatId, { conn, threadId: resumed.thread.id });
        return resumed.thread.id;
      }
    } catch {
      /* A thread the server no longer has: a new one. */
    }
  }
  const made = (await conn.rpc.request('thread/start', { cwd: conn.vault, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox })) as { thread?: { id?: unknown } } | null;
  if (typeof made?.thread?.id !== 'string') throw new TurnFailure('Codex did not start a thread.', null);
  threads.set(turn.chatId, { conn, threadId: made.thread.id });
  turn.setSession(made.thread.id);
  return made.thread.id;
}

/** A notification from the server: what one of its threads did, told to the turn it runs. */
function heard(conn: Conn, method: string, params: unknown): void {
  if (typeof params !== 'object' || params === null) return;
  const body = params as Record<string, unknown>;
  const now = typeof body.threadId === 'string' ? running.get(body.threadId) : undefined;
  if (!now) return;
  const { turn } = now;
  const scrub = scrubberFor(conn.vault);
  const item = (typeof body.item === 'object' && body.item !== null ? body.item : {}) as Record<string, unknown>;
  const itemId = typeof body.itemId === 'string' ? body.itemId : typeof item.id === 'string' ? item.id : '';
  switch (method) {
    case 'item/agentMessage/delta':
      if (itemId && typeof body.delta === 'string') {
        now.streamed.add(itemId);
        turn.emit({ type: 'text', id: itemId, text: scrub(body.delta) });
      }
      break;
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      if (itemId && typeof body.delta === 'string') {
        now.streamed.add(itemId);
        turn.emit({ type: 'thought', id: `${itemId}:thought`, text: scrub(body.delta) });
      }
      break;
    case 'item/started':
    case 'item/completed': {
      const done = method === 'item/completed';
      if (item.type === 'agentMessage' && done && !now.streamed.has(itemId) && typeof item.text === 'string' && item.text) {
        // The final answer comes whole, in its completion.
        turn.emit({ type: 'text', id: itemId, text: scrub(item.text) });
      } else if (item.type === 'reasoning' && done && !now.streamed.has(itemId)) {
        const words = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter((one) => typeof one === 'string').join('\n');
        if (words) turn.emit({ type: 'thought', id: `${itemId}:thought`, text: scrub(words) });
      } else if (item.type === 'commandExecution') {
        const actions = Array.isArray(item.commandActions) ? (item.commandActions as Array<{ path?: unknown }>) : [];
        const paths = actions.map((one) => (typeof one.path === 'string' ? shownPath(conn.vault, one.path) : null)).filter((one): one is string => one !== null);
        turn.emit({
          type: 'tool',
          id: itemId,
          ...(done ? {} : { title: scrub(command(item)).slice(0, TITLE_MAX), kind: kindOfCommand(item), paths }),
          status: done ? statusOf(item.status) : 'in_progress',
          output: done && typeof item.aggregatedOutput === 'string' && item.aggregatedOutput ? scrub(item.aggregatedOutput).slice(0, OUTPUT_MAX) : undefined,
        });
      } else if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown; diff?: unknown }>) : [];
        const paths = changes.map((one) => (typeof one.path === 'string' ? shownPath(conn.vault, one.path) : null)).filter((one): one is string => one !== null);
        now.changes.set(itemId, paths);
        turn.emit({
          type: 'tool',
          id: itemId,
          ...(done ? {} : { title: `${turkish() ? 'Düzenle' : 'Edit'} ${paths.join(', ')}`.slice(0, TITLE_MAX), kind: 'edit', paths }),
          status: done ? statusOf(item.status) : 'in_progress',
          output: done ? changes.map((one, at) => `${paths[at] ?? ''}: ${diffCount(one.diff)}`).join('\n') : undefined,
        });
      } else if (item.type === 'mcpToolCall') {
        const args = (typeof item.arguments === 'object' && item.arguments !== null ? item.arguments : {}) as Record<string, unknown>;
        const result = item.result as { content?: Array<{ type?: unknown; text?: unknown }> } | null;
        const output = done ? (result?.content ?? []).map((part) => (part.type === 'text' ? textOf(part.text, OUTPUT_MAX) : '')).join('\n') : '';
        turn.emit({
          type: 'tool',
          id: itemId,
          ...(done ? {} : { title: scrub(textOf(args.title, 200) || `${textOf(item.server, 60)} ${textOf(item.tool, 60)}`).slice(0, TITLE_MAX), kind: 'other' }),
          status: done ? statusOf(item.status) : 'in_progress',
          output: output ? scrub(output).slice(0, OUTPUT_MAX) : undefined,
        });
      } else if (item.type === 'webSearch' && !done) {
        turn.emit({ type: 'tool', id: itemId, title: `Search ${scrub(textOf(item.query, 200))}`.trim(), kind: 'fetch', status: 'in_progress' });
      } else if (item.type === 'webSearch' && done) {
        turn.emit({ type: 'tool', id: itemId, status: 'completed' });
      }
      break;
    }
    case 'turn/plan/updated':
      if (Array.isArray(body.plan))
        turn.emit({
          type: 'plan',
          entries: (body.plan as Array<{ step?: unknown; status?: unknown }>).slice(0, 50).map((one) => ({ content: scrub(textOf(one.step, 500)), status: one.status === 'inProgress' ? 'in_progress' : textOf(one.status, 20) || 'pending' })),
        });
      break;
    case 'thread/tokenUsage/updated': {
      const usage = body.tokenUsage as { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } | undefined;
      if (typeof usage?.last?.totalTokens === 'number' && typeof usage.modelContextWindow === 'number') turn.emit({ type: 'usage', used: usage.last.totalTokens, size: usage.modelContextWindow, cost: null, currency: null });
      break;
    }
    case 'thread/name/updated':
      if (typeof body.threadName === 'string' && body.threadName.trim()) turn.setTitle(scrub(body.threadName.trim()));
      break;
    case 'turn/completed': {
      const ended = body.turn as { status?: unknown; error?: { message?: unknown; codexErrorInfo?: unknown } | null } | undefined;
      running.delete(body.threadId as string);
      if (ended?.status === 'interrupted') now.finish('cancelled');
      else if (ended?.status === 'failed') {
        const sentence = sentenceOf(textOf(ended.error?.message, 2000) || 'Codex could not answer.');
        now.fail(new TurnFailure(sentence, kindOf(ended.error?.codexErrorInfo, sentence)));
      } else now.finish('end_turn');
      break;
    }
    default:
      break;
  }
}

/** A request from the server: leave for a command, a file change or more permissions, asked of the person on a card; nothing else is answered. */
async function asked(method: string, params: unknown): Promise<unknown> {
  const body = (params ?? {}) as Record<string, unknown>;
  const threadId = typeof body.threadId === 'string' ? body.threadId : typeof body.conversationId === 'string' ? body.conversationId : '';
  const now = running.get(threadId);
  const tr = turkish();
  const once = { id: 'once', name: tr ? 'Bir kez izin ver' : 'Allow once', kind: 'allow_once' as const };
  const session = { id: 'session', name: tr ? 'Bu sohbette hep izin ver' : 'Allow for this chat', kind: 'allow_always' as const };
  const refuse = { id: 'decline', name: tr ? 'Reddet' : 'Reject', kind: 'reject_once' as const };
  const ask = (card: Card) => (now ? now.turn.ask(card) : Promise.resolve(null));
  const scrub = now ? scrubberFor(now.turn.vault) : (text: string) => text;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const chosen = await ask({ title: scrub(`$ ${command(body)}`).slice(0, TITLE_MAX), kind: 'execute', paths: [], options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'accept' : chosen === 'session' ? 'acceptForSession' : 'decline' };
    }
    case 'item/fileChange/requestApproval': {
      const paths = now?.changes.get(textOf(body.itemId, 200)) ?? [];
      const chosen = await ask({ title: `${tr ? 'Düzenle' : 'Edit'} ${paths.join(', ')}`.trim(), kind: 'edit', paths, options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'accept' : chosen === 'session' ? 'acceptForSession' : 'decline' };
    }
    case 'item/permissions/requestApproval': {
      const wanted = (typeof body.permissions === 'object' && body.permissions !== null ? body.permissions : {}) as Record<string, unknown>;
      const chosen = await ask({ title: scrub(textOf(body.reason, TITLE_MAX)) || (tr ? 'Ek izin' : 'More permissions'), kind: 'other', paths: [], options: [once, session, refuse] });
      // What it asked for, and nothing more; refused, nothing.
      const granted = Object.fromEntries(Object.entries(wanted).filter(([, value]) => value !== null && value !== undefined));
      return { permissions: chosen ? granted : {}, scope: chosen === 'session' ? 'session' : 'turn' };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const title = method === 'execCommandApproval' ? `$ ${(Array.isArray(body.command) ? body.command : []).join(' ')}` : tr ? 'Dosya değişikliği' : 'File change';
      const chosen = await ask({ title: scrub(title).slice(0, TITLE_MAX), kind: method === 'execCommandApproval' ? 'execute' : 'edit', paths: [], options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'approved' : chosen === 'session' ? 'approved_for_session' : { denied: { rejection: 'The person did not allow this step.' } } };
    }
    default:
      throw new AcpError(`Cortex does not answer ${method}.`, -32601);
  }
}

export const codexBackend: Backend = {
  async run(turn, message) {
    let threadId: string | null = null;
    try {
      const conn = await connectionFor(turn.cli, turn.vault);
      let options = settings.get(turn.chatId);
      if (!options) {
        options = codexOptions(conn.models, turn.prefs);
        settings.set(turn.chatId, options);
      }
      turn.setOptions(options);
      const current = (id: string) => options?.find((one) => one.id === id)?.current;
      const mode = current('mode') ?? 'ask';
      threadId = await threadFor(turn, conn, mode);
      const policy = policyOf(mode);
      const effort = current('effort');
      const done = new Promise<string>((finish, fail) => {
        running.set(threadId as string, { turn, turnId: null, finish, fail, streamed: new Set(), changes: new Map() });
      });
      const started = (await conn.rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: message, text_elements: [] }],
        ...(current('model') ? { model: current('model') } : {}),
        ...(effort && effort !== 'default' ? { effort } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      })) as { turn?: { id?: unknown } } | null;
      const now = running.get(threadId);
      if (now && typeof started?.turn?.id === 'string') now.turnId = started.turn.id;
      return await done;
    } catch (err) {
      if (err instanceof TurnFailure) throw err;
      if (err instanceof AcpError) throw new TurnFailure(sentenceOf(err.message), err.code === null ? 'stopped' : null);
      throw new TurnFailure(err instanceof Error ? err.message : String(err), null);
    } finally {
      if (threadId) running.delete(threadId);
      const timer = stopping.get(turn.chatId);
      if (timer) clearTimeout(timer);
      stopping.delete(turn.chatId);
    }
  },

  cancel(chatId) {
    const held = threads.get(chatId);
    const now = held ? running.get(held.threadId) : undefined;
    if (!held || !now) return;
    if (now.turnId) void held.conn.rpc.request('turn/interrupt', { threadId: held.threadId, turnId: now.turnId }).catch(() => undefined);
    if (!stopping.has(chatId)) stopping.set(chatId, setTimeout(() => running.has(held.threadId) && held.conn.rpc.close(), STOP_GRACE));
  },

  async setOption(chatId, options, option, value) {
    let next = options.map((one) => (one.id === option ? { ...one, current: value } : one));
    // Another model offers its own efforts: the list follows it, and an effort it does not have goes back to the default.
    if (option === 'model') {
      const conn = threads.get(chatId)?.conn ?? [...conns.values()][0];
      if (conn?.models.length) next = codexOptions(conn.models, Object.fromEntries(next.map((one) => [one.id, one.current])));
    }
    settings.set(chatId, next);
    return next;
  },

  forget(chatId) {
    threads.delete(chatId);
    settings.delete(chatId);
  },

  shutdown() {
    for (const conn of conns.values()) conn.rpc.close();
    conns.clear();
    threads.clear();
  },
};

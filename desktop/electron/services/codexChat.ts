import { app } from 'electron';
import type { CliId, ConfigOption, ToolStatus } from '../../shared/chat';
import { AcpConnection, AcpError } from './acp';
import { type Backend, type Card, ChatRefusal, OUTPUT_MAX, STOP_GRACE, Stopped, TITLE_MAX, type Turn, TurnFailure, cardPath, cardTextFor, cutSaid, scrubberFor, shownPath, textOf, unlessStopped, vaultWord } from './chatKit';
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
  /** Turns let go after Stop that the server may still be running: never heard as a later turn of their thread. */
  abandoned: Set<string>;
}

interface Running {
  turn: Turn;
  /** The server the turn runs on: a turn is settled when its server ends, whatever became of the chat's thread. */
  conn: Conn;
  turnId: string | null;
  /** Stop was pressed: the turn ends as stopped, not failed, however the server ends it. */
  stopRequested: boolean;
  finish: (reason: string) => void;
  fail: (error: TurnFailure) => void;
  /** Items whose words came in pieces: their whole text at completion is not shown again. */
  streamed: Set<string>;
  /** The paths of each file change, as the server named them, for the card that asks to apply it. */
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
  const conn = { cli, vault, models: [], abandoned: new Set<string>() } as unknown as Conn;
  conn.rpc = new AcpConnection(launch, vault, {
    notify: (method, params) => heard(conn, method, params),
    request: (method, params) => asked(conn, method, params),
    exited: (_code, stderr) => {
      if (conns.get(cli) === conn) conns.delete(cli);
      for (const [chatId, held] of threads) if (held.conn === conn) threads.delete(chatId);
      // Its turns end with it: only `turn/completed` settles a turn, and a server gone - crashed, ended
      // after Stop, closed for another vault - sends none, which left the chat "running" for good.
      const why = stderr ? `Codex stopped: ${stderr.split('\n').slice(-3).join(' ').slice(0, 500)}` : 'Codex stopped.';
      for (const [threadId, now] of [...running]) {
        if (now.conn !== conn) continue;
        running.delete(threadId);
        if (now.stopRequested) now.finish('cancelled');
        else now.fail(new TurnFailure(why, 'stopped'));
      }
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
  // A start that failed is not kept: the next message starts the server again, rather than meet the same failure until the app is closed.
  conn.ready.catch(() => {
    if (conns.get(cli) !== conn) return;
    conns.delete(cli);
    conn.rpc.close();
  });
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
      if (turn.signal.aborted) throw new Stopped();
      if (typeof resumed?.thread?.id === 'string') {
        threads.set(turn.chatId, { conn, threadId: resumed.thread.id });
        return resumed.thread.id;
      }
    } catch (err) {
      if (err instanceof Stopped) throw err;
      /* A thread the server no longer has: a new one. */
    }
  }
  const made = (await conn.rpc.request('thread/start', { cwd: conn.vault, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox })) as { thread?: { id?: unknown } } | null;
  // Stopped meanwhile: the thread is left unrecorded rather than written over a later turn's.
  if (turn.signal.aborted) throw new Stopped();
  if (typeof made?.thread?.id !== 'string') throw new TurnFailure('Codex did not start a thread.', null);
  threads.set(turn.chatId, { conn, threadId: made.thread.id });
  turn.setSession(made.thread.id);
  // The chat had a thread the server could not continue: the person is told it begins anew, rather than find it forgotten.
  if (turn.sessionId) turn.emit({ type: 'notice', notice: 'new-session' });
  return made.thread.id;
}

/**
 * Whether what the server sends names another turn than the one its thread runs now. A turn let go
 * after Stop may still be heard from on the thread its chat's next turn runs on: only this turn's
 * words are shown as its words, and only its own steps are asked of the person. The one let go is
 * never this one, also before the server has named this one.
 */
function another(conn: Conn, now: Running, body: Record<string, unknown>): boolean {
  const itsTurn = typeof body.turnId === 'string' ? body.turnId : textOf((body.turn as { id?: unknown } | undefined)?.id, 200);
  return Boolean(itsTurn) && (conn.abandoned.has(itsTurn) || (now.turnId !== null && itsTurn !== now.turnId));
}

/** A notification from the server: what one of its threads did, told to the turn it runs. */
function heard(conn: Conn, method: string, params: unknown): void {
  if (typeof params !== 'object' || params === null) return;
  const body = params as Record<string, unknown>;
  const now = typeof body.threadId === 'string' ? running.get(body.threadId) : undefined;
  if (!now || another(conn, now, body)) return;
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
        const named = changes.map((one) => (typeof one.path === 'string' ? one.path : null)).filter((one): one is string => one !== null);
        const paths = named.map((one) => shownPath(conn.vault, one));
        now.changes.set(itemId, named);
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

/** What a request for more permissions asks, said on its card: the network, and every folder to read or write, whole. */
function permissionsSaid(wanted: Record<string, unknown>, vault: string, say: (text: string) => string, tr: boolean): string[] {
  const out: string[] = [];
  const network = wanted.network as { enabled?: unknown } | null | undefined;
  if (typeof network === 'object' && network !== null && network.enabled === true) out.push(tr ? 'Ağ erişimi' : 'Network access');
  const files = wanted.fileSystem as Record<string, unknown> | null | undefined;
  if (typeof files === 'object' && files !== null) {
    for (const [key, label] of [['read', tr ? 'Okuma' : 'Read'], ['write', tr ? 'Yazma' : 'Write']] as const) {
      const places = Array.isArray(files[key]) ? (files[key] as unknown[]) : [];
      for (const place of places.slice(0, 20)) if (typeof place === 'string') out.push(`${label}: ${cardPath(vault, place, say)}`);
    }
  }
  // Anything else it asks for, by its name: nothing that would be granted goes unsaid.
  for (const [key, value] of Object.entries(wanted)) if (key !== 'network' && key !== 'fileSystem' && value !== null && value !== undefined) out.push(key.slice(0, 60));
  return out;
}

/** A request from the server: leave for a command, a file change or more permissions, asked of the person on a card; nothing else is answered. */
async function asked(conn: Conn, method: string, params: unknown): Promise<unknown> {
  const body = (params ?? {}) as Record<string, unknown>;
  const threadId = typeof body.threadId === 'string' ? body.threadId : typeof body.conversationId === 'string' ? body.conversationId : '';
  // A turn let go after Stop asking leave on its thread is not asked of the person on the card of the turn that runs there now: it is refused.
  const held = running.get(threadId);
  const now = held && !another(conn, held, body) ? held : undefined;
  const tr = turkish();
  const once = { id: 'once', name: tr ? 'Bir kez izin ver' : 'Allow once', kind: 'allow_once' as const };
  const session = { id: 'session', name: tr ? 'Bu sohbette hep izin ver' : 'Allow for this chat', kind: 'allow_always' as const };
  const refuse = { id: 'decline', name: tr ? 'Reddet' : 'Reject', kind: 'reject_once' as const };
  const ask = (card: Card) => (now ? now.turn.ask(card) : Promise.resolve(null));
  // A card hides nothing: the vault said as a word, a path outside it whole, a command whole (chatKit.ts).
  const vault = now?.turn.vault ?? '';
  const say = now ? cardTextFor(vault, vaultWord(tr)) : (text: string) => text;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // The command as the server will run it, whole: its first parsed part alone hid what came after `&&`.
      const whole = textOf(body.command, 100_000) || command(body);
      const chosen = await ask({ title: cutSaid(say(`$ ${whole}`)), kind: 'execute', paths: [], options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'accept' : chosen === 'session' ? 'acceptForSession' : 'decline' };
    }
    case 'item/fileChange/requestApproval': {
      const paths = (now?.changes.get(textOf(body.itemId, 200)) ?? []).map((one) => cardPath(vault, one, say));
      // Leave to write anywhere under a folder for the rest of the chat, when it asks for it: said with the folder.
      const root = textOf(body.grantRoot, 4000);
      const granting = root ? [`${tr ? 'Yazma izni' : 'Write access'}: ${cardPath(vault, root, say)}`] : [];
      const chosen = await ask({ title: `${tr ? 'Düzenle' : 'Edit'} ${paths.join(', ')}`.trim(), kind: 'edit', paths: [...paths, ...granting], options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'accept' : chosen === 'session' ? 'acceptForSession' : 'decline' };
    }
    case 'item/permissions/requestApproval': {
      const wanted = (typeof body.permissions === 'object' && body.permissions !== null ? body.permissions : {}) as Record<string, unknown>;
      // The reason is the model's own words: what it would be given is said beside it.
      const chosen = await ask({ title: cutSaid(say(textOf(body.reason, 100_000))) || (tr ? 'Ek izin' : 'More permissions'), kind: 'other', paths: permissionsSaid(wanted, vault, say, tr), options: [once, session, refuse] });
      // What it asked for, and nothing more, only when allowed: Reject answers "decline", a word, and a word granted it all.
      const granted = Object.fromEntries(Object.entries(wanted).filter(([, value]) => value !== null && value !== undefined));
      const allowed = chosen === 'once' || chosen === 'session';
      return { permissions: allowed ? granted : {}, scope: chosen === 'session' ? 'session' : 'turn' };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const title = method === 'execCommandApproval' ? `$ ${(Array.isArray(body.command) ? body.command : []).join(' ')}` : tr ? 'Dosya değişikliği' : 'File change';
      const chosen = await ask({ title: cutSaid(say(title)), kind: method === 'execCommandApproval' ? 'execute' : 'edit', paths: [], options: [once, session, refuse] });
      return { decision: chosen === 'once' ? 'approved' : chosen === 'session' ? 'approved_for_session' : { denied: { rejection: 'The person did not allow this step.' } } };
    }
    default:
      throw new AcpError(`Cortex does not answer ${method}.`, -32601);
  }
}

/** The turn a chat runs now, whatever became of its thread. */
const runningOf = (chatId: string) => [...running.entries()].find(([, now]) => now.turn.chatId === chatId);

export const codexBackend: Backend = {
  async run(turn, message) {
    let threadId: string | null = null;
    let entry: Running | null = null;
    try {
      const conn = await unlessStopped(turn.signal, connectionFor(turn.cli, turn.vault));
      let options = settings.get(turn.chatId);
      if (!options) {
        options = codexOptions(conn.models, turn.prefs);
        settings.set(turn.chatId, options);
      }
      turn.setOptions(options);
      const current = (id: string) => options?.find((one) => one.id === id)?.current;
      const mode = current('mode') ?? 'ask';
      threadId = await unlessStopped(turn.signal, threadFor(turn, conn, mode));
      const policy = policyOf(mode);
      const effort = current('effort');
      const done = new Promise<string>((finish, fail) => {
        entry = { turn, conn, turnId: null, stopRequested: false, finish, fail, streamed: new Set(), changes: new Map() };
        running.set(threadId as string, entry);
      });
      // Its server can end it while `turn/start` is still awaited (closed for another vault): the failure
      // is the turn's, said by the start refused below, and not left unheard for the main process.
      done.catch(() => undefined);
      const started = (await conn.rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: message, text_elements: [] }],
        ...(current('model') ? { model: current('model') } : {}),
        ...(effort && effort !== 'default' ? { effort } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      })) as { turn?: { id?: unknown } } | null;
      // This turn's own entry, whatever runs on its thread now: one let go while its start was awaited
      // (Stop, then its grace, other chats on the server) left the thread to its chat's next turn.
      const mine = entry as Running | null;
      if (mine && typeof started?.turn?.id === 'string') {
        mine.turnId = started.turn.id;
        if (running.get(threadId) !== mine) mine.conn.abandoned.add(mine.turnId);
        // Stop pressed before the server named the turn: it is interrupted now that it can be, let go or not.
        if (mine.stopRequested) void conn.rpc.request('turn/interrupt', { threadId, turnId: mine.turnId }).catch(() => undefined);
      }
      return await done;
    } catch (err) {
      // After Stop, however the turn ended - the server ended under it, its start refused - it was stopped.
      if (err instanceof Stopped || turn.signal.aborted) return 'cancelled';
      if (err instanceof TurnFailure) throw err;
      if (err instanceof AcpError) throw new TurnFailure(sentenceOf(err.message), err.code === null ? 'stopped' : null);
      throw new TurnFailure(err instanceof Error ? err.message : String(err), null);
    } finally {
      if (threadId && entry && running.get(threadId) === entry) running.delete(threadId);
      const timer = stopping.get(turn.chatId);
      if (timer) clearTimeout(timer);
      stopping.delete(turn.chatId);
    }
  },

  cancel(chatId) {
    const found = runningOf(chatId);
    if (!found) return;
    const [threadId, now] = found;
    now.stopRequested = true;
    if (now.turnId) void now.conn.rpc.request('turn/interrupt', { threadId, turnId: now.turnId }).catch(() => undefined);
    if (stopping.has(chatId)) return;
    stopping.set(
      chatId,
      setTimeout(() => {
        if (running.get(threadId) !== now) return;
        // One server carries every Codex chat: ended only when this turn is the only one on it. Else this
        // turn alone is let go, its thread with it, and the chat's next message resumes or starts one.
        if ([...running.values()].some((other) => other !== now && other.conn === now.conn)) {
          running.delete(threadId);
          if (threads.get(chatId)?.threadId === threadId) threads.delete(chatId);
          if (now.turnId) now.conn.abandoned.add(now.turnId);
          now.finish('cancelled');
        } else now.conn.rpc.close();
      }, STOP_GRACE.ms),
    );
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

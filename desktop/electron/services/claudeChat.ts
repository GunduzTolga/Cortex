import fs from 'node:fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatEvent, ConfigOption, ToolStatus } from '../../shared/chat';
import { fileLines, IMAGE_INLINE_MAX, type HeldAttachment } from './attachments';
import { childEnv, systemProxyKnown } from './acp';
import { type Backend, ChatRefusal, OUTPUT_MAX, STOP_GRACE, Stopped, TITLE_MAX, type Turn, TurnFailure, cardPath, cardTextFor, cutSaid, networkTrouble, scrubberFor, shownPath, textOf, unlessStopped, vaultWord } from './chatKit';
import { launchFor } from './clis';
import { readSettings } from './settings';

/**
 * The chat with Claude Code, in its own structured mode rather than ACP:
 * `claude -p` reading and writing one JSON object a line
 * (`--input-format stream-json --output-format stream-json`), as the Claude
 * Agent SDK drives it. One program per chat, started in the vault - so the
 * vault's `.claude/settings.json` gives it Cortex's hooks, and with them the
 * vault's memory - and kept for the chat's next message.
 *
 * What it says was recorded from Claude Code 2.1.296 (14 October): a control
 * response to `initialize` with the models it offers, `system/init` with the
 * session, partial message events, assistant and user messages carrying tool
 * uses and their results, and a `result` that ends each turn (`is_error` when
 * it failed, even with `subtype: success`). A step it would ask about is a
 * `can_use_tool` control request: answered from the person's card. Stop is an
 * `interrupt` control request.
 *
 * A setting changed - the model, the permission mode, the effort - is given
 * at the next start: the program is ended between turns and started again on
 * the same session (`--resume`), with the setting as a flag. A session Claude
 * Code no longer has - it deletes transcripts after a month
 * (`cleanupPeriodDays`) - is not resumed for ever: the message goes to a new
 * one, and the chat says so.
 *
 * A program no message was written to for a while (IDLE) is ended, as one whose setting changed is: a chat left open
 * kept its `claude` running until the chat was deleted or the app closed, one for every chat written to (S9). The
 * next message starts it again on the same session.
 */

interface Proc {
  chatId: string;
  child: ChildProcessWithoutNullStreams;
  alive: boolean;
  buffer: string;
  stderr: string;
  /** Answers awaited to Cortex's own control requests, by request id. */
  controls: Map<string, (response: unknown) => void>;
  turn: Turn | null;
  finish: ((reason: string) => void) | null;
  fail: ((error: TurnFailure) => void) | null;
  cancelled: boolean;
  /** After Stop, the program ended if the stopped turn has not: for that turn only, never the one after it. */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** The message being streamed, and whether its words already came in pieces. */
  messageId: string | null;
  streamed: Set<string>;
  /** The last real message's usage, which says how full the context is. */
  lastUsage: { used: number } | null;
  /** Why it could not be started at all (startFailure), kept for the start that was waiting on it. */
  notStarted: TurnFailure | null;
  /** The retry the chat was last told of, so a run of them is said once; null once the answer goes on. */
  retrySaid: string | null;
  /** Ends the program left without a message for IDLE. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const procs = new Map<string, Proc>();
const STDERR_KEPT = 8 * 1024;
const LINE_MAX = 16 * 1024 * 1024;
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
/** What Claude Code says when the session it was told to resume is gone. */
const SESSION_GONE = /no conversation found/i;
/** After its exit, how long the program's last words on standard error are waited for. */
const DRAIN_MS = 1000;
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** How long a chat's program is kept with no message written to it, before it is ended: in an object, so a test can wait less. */
export const IDLE = { ms: 12 * 60_000 };

/** The models offered before Claude Code says which it has, as its own `initialize` named them on 14 October. */
const FALLBACK_MODELS = [
  { value: 'default', name: 'Default (recommended)' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'opus', name: 'Opus' },
  { value: 'haiku', name: 'Haiku' },
];

const turkish = () => readSettings().language !== 'en';

/** The chat's settings: the model (Claude Code's own list once it has said it), the permission mode, the effort. */

/**
 * A turn's cost from Claude Code's `result`: its tokens (cache included, as they are priced), and the session's running
 * total in dollars (`total_cost_usd`, counted across a resume: measured 4 November), from which the chat takes the rise.
 */
export function spendOf(message: Record<string, unknown>, sessionId: string | null): Extract<ChatEvent, { type: 'spend' }> | null {
  const usage = (typeof message.usage === 'object' && message.usage !== null ? message.usage : {}) as Record<string, unknown>;
  const count = (key: string) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : 0);
  const tokens = count('input_tokens') + count('output_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  const usd = typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : null;
  const session = typeof message.session_id === 'string' && message.session_id ? message.session_id : sessionId;
  if (!tokens && usd === null) return null;
  return { type: 'spend', usd: null, tokens, subscription: true, ...(usd !== null && session ? { total: { session, usd } } : {}) };
}

export function claudeOptions(prefs: Readonly<Record<string, string>>, models: Array<{ value: string; name: string }> = FALLBACK_MODELS): ConfigOption[] {
  const tr = turkish();
  // Each choice names what it is, so a chip reads alone: "Default effort", not "Default" beside "Default (recommended)".
  const modeNames: Record<(typeof PERMISSION_MODES)[number], string> = tr
    ? { default: 'Önce sor', acceptEdits: 'Düzenlemeleri kabul et', plan: 'Plan modu', auto: 'Otomatik' }
    : { default: 'Ask first', acceptEdits: 'Accept edits', plan: 'Plan mode', auto: 'Auto' };
  const effortNames: Record<(typeof EFFORTS)[number], string> = tr
    ? { default: 'Varsayılan efor', low: 'Düşük efor', medium: 'Orta efor', high: 'Yüksek efor', xhigh: 'Çok yüksek efor', max: 'En yüksek efor' }
    : { default: 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra-high effort', max: 'Max effort' };
  const pick = (value: string | undefined, allowed: readonly string[], fallback: string) => (value && allowed.includes(value) ? value : fallback);
  // A model Claude Code itself offered (its own list, kept with the chat or as the last choice) is kept before Claude
  // Code is asked again: the list it starts with does not name it, and the chip said it while the chat ran on the
  // default (30 October). Claude Code's own list, once it names it, decides.
  if (models === FALLBACK_MODELS && prefs.model && !models.some((one) => one.value === prefs.model) && /^[\w.:@/\[\]-]{1,80}$/.test(prefs.model)) {
    models = [...models, { value: prefs.model, name: prefs.model }];
  }
  return [
    { id: 'model', name: 'Model', category: 'model', current: pick(prefs.model, models.map((one) => one.value), 'default'), choices: models },
    { id: 'mode', name: tr ? 'İzin modu' : 'Permission mode', category: 'mode', current: pick(prefs.mode, PERMISSION_MODES, 'default'), choices: PERMISSION_MODES.map((value) => ({ value, name: modeNames[value] })) },
    {
      id: 'effort',
      name: tr ? 'Efor' : 'Effort',
      category: 'thought_level',
      current: pick(prefs.effort, EFFORTS, 'default'),
      choices: EFFORTS.map((value) => ({ value, name: effortNames[value] })),
    },
  ];
}

/** The flags a start is given for the chat's settings, and the session it continues. */
export function claudeArgs(base: string[], options: ConfigOption[], sessionId: string | null): string[] {
  const current = (id: string) => options.find((one) => one.id === id)?.current;
  const args = [...base];
  const model = current('model');
  if (model && model !== 'default') args.push('--model', model);
  const mode = current('mode');
  if (mode && mode !== 'default') args.push('--permission-mode', mode);
  const effort = current('effort');
  if (effort && effort !== 'default') args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const KINDS: Record<string, string> = {
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  PowerShell: 'execute',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
};

const fileOf = (input: Record<string, unknown>, max: number) => textOf(input.file_path, max) || textOf(input.notebook_path, max) || textOf(input.path, max);
const whatOf = (input: Record<string, unknown>, max: number, path: string | undefined) =>
  textOf(input.command, max) || textOf(input.pattern, max) || textOf(input.url, max) || textOf(input.query, max) || textOf(input.description, max) || (path ?? '');

/** A tool's step as the chat shows it: its kind, a title with what it works on, and the paths it touches. */
export function stepOf(name: string, input: Record<string, unknown>, vault: string, scrub: (text: string) => string): { title: string; kind: string; paths: string[] } {
  const file = fileOf(input, 1000);
  const paths = file ? [shownPath(vault, file)] : [];
  const what = whatOf(input, 200, paths[0]);
  return { title: scrub(what ? `${name} ${what}` : name).slice(0, TITLE_MAX), kind: KINDS[name] ?? 'other', paths };
}

/**
 * A step as its card asks leave for it: said whole, where the step in the transcript is cut and
 * made short. The vault is said as a word, a path outside it in full, a command to its end (a cut
 * said as one): the card is the one check before a command or a write outside the vault, and it
 * showed `Bash rm -rf ""` for the vault deleted, and only the harmless head of a long command.
 */
export function cardOf(name: string, input: Record<string, unknown>, vault: string, say: (text: string) => string): { title: string; kind: string; paths: string[] } {
  const file = fileOf(input, 4000);
  const paths = file ? [cardPath(vault, file, say)] : [];
  const what = whatOf(input, 100_000, paths[0]);
  return { title: cutSaid(say(what ? `${name} ${what}` : name)), kind: KINDS[name] ?? 'other', paths };
}

/** A tool result's words: a string, or the text parts of a list. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' ? textOf((part as { text?: unknown }).text, OUTPUT_MAX) : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * What a failed turn's sentence says it is. A server not reached, by the system's own code, is that whatever else the
 * sentence names (a sign-in that could not be renewed for want of a connection is not a sign-in to make again). A
 * subscription's allowance used up (`limit`: "5-hour limit reached · resets 3pm", "You've hit your … limit", read from
 * Claude Code 2.1.322) comes back by itself, where a balance or a quota (`provider.quota`) does not (S10).
 */
export function kindOfFailure(text: string): string | null {
  const network = networkTrouble(text);
  if (network === 'code') return 'network';
  // A company's proxy asking for its own password, and a sign-in that could not be renewed because nothing was
  // reached, are the network's trouble: signing in to Claude again changes nothing (the second review, R2S-2).
  if (/\b407\b|proxy authentication/i.test(text)) return 'network';
  if (network && /refresh|renew/i.test(text)) return 'network';
  if (/\b401\b|authenticat|log ?in|oauth/i.test(text)) return 'auth';
  if (/\b429\b|rate.?limit/i.test(text)) return 'provider.quota';
  // The subscription's own limits, by their names: "limit reached" alone is also a conversation that is full
  // ("Context limit reached"), which waiting does not help (R2S-1).
  if (/usage limit|(?:session|weekly|daily|monthly|\d+[- ]?hour) limit reached|hit your (?:[\w-]+ )*limit|out of (?:extra )?usage/i.test(text)) return 'limit';
  if (/quota|credit balance/i.test(text)) return 'provider.quota';
  return network ? 'network' : null;
}

/**
 * Why Claude Code could not be started at all - Windows or an antivirus refusing its program (EPERM, EACCES), the
 * program or the vault's folder gone (ENOENT): the system's code, not its sentence, which names the program's path.
 * Its sentence goes to the log.
 */
export function startFailure(err: unknown): TurnFailure {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  console.warn('[chat] Claude Code could not start:', err instanceof Error ? err.message : err);
  // Not there (the program, or the vault's folder it is started in) is not "blocked": another thing to do (R2S-7).
  return new TurnFailure(typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `Claude Code could not start (${code}).` : 'Claude Code could not start.', code === 'ENOENT' ? 'not-found' : 'not-started');
}

function write(proc: Proc, message: unknown): void {
  if (proc.alive) proc.child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** A control request of Cortex's own (initialize, interrupt), its answer awaited for a while. */
function control(proc: Proc, request: Record<string, unknown>, ms = 30_000): Promise<unknown> {
  const id = `cortex-${randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.controls.delete(id);
      resolve(null);
    }, ms);
    proc.controls.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    write(proc, { type: 'control_request', request_id: id, request });
  });
}

/** The program's time without a message begins (again): ended after IDLE unless a turn began meanwhile. */
function idleFrom(proc: Proc): void {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => {
    proc.idleTimer = null;
    if (!proc.turn) close(proc);
  }, IDLE.ms);
  // Never what keeps the app from closing.
  proc.idleTimer.unref();
}

function end(proc: Proc, why: TurnFailure): void {
  if (!proc.alive) return;
  proc.alive = false;
  if (proc.stopTimer) clearTimeout(proc.stopTimer);
  proc.stopTimer = null;
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = null;
  if (procs.get(proc.chatId) === proc) procs.delete(proc.chatId);
  for (const answer of proc.controls.values()) answer(null);
  proc.controls.clear();
  // Ended after Stop, the turn is a stopped one, not a failure.
  if (proc.cancelled) proc.finish?.('cancelled');
  else proc.fail?.(why);
  proc.finish = null;
  proc.fail = null;
}

function close(proc: Proc): void {
  if (!proc.alive) return;
  const pid = proc.child.pid;
  if (process.platform === 'win32' && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  else proc.child.kill();
  end(proc, new TurnFailure('Claude Code was stopped.', 'stopped'));
}

/** One line from the program: a piece of the answer, a step, a request for leave, or the turn's end. */
function receive(proc: Proc, line: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null) return;
  const turn = proc.turn;

  if (message.type === 'control_response') {
    const response = message.response as { request_id?: unknown; response?: unknown } | undefined;
    if (typeof response?.request_id === 'string') proc.controls.get(response.request_id)?.(response.response ?? null);
    if (typeof response?.request_id === 'string') proc.controls.delete(response.request_id);
    return;
  }
  if (message.type === 'control_request') {
    void answerControl(proc, message);
    return;
  }
  // An error said before any turn - a session it cannot resume, said in its own JSON rather than on standard error - is kept as why it stopped.
  if (!turn && message.type === 'result' && message.is_error) {
    const said = textOf(message.result, 1000) || (Array.isArray(message.errors) ? message.errors.filter((one): one is string => typeof one === 'string').join(' ').slice(0, 1000) : '');
    if (said) proc.stderr = `${proc.stderr}\n${said}`.slice(-STDERR_KEPT);
  }
  if (!turn) return;
  const scrub = scrubberFor(turn.vault);
  // A sub-agent's own messages (a Task tool's) are its business: the step stands for them.
  if (message.parent_tool_use_id) return;

  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && typeof message.session_id === 'string') turn.setSession(message.session_id);
      // A request to the API that failed and is tried again (read from Claude Code 2.1.322: `api_retry` with `attempt`,
      // `retry_delay_ms`, and `error_status`, null where no answer came at all). Nothing was told of it: with no
      // internet the chat read "working" for minutes (S3). Said once for a run of them, as what it is.
      if (message.subtype === 'api_retry') {
        const notice = typeof message.error_status === 'number' ? 'retry-busy' : 'retry-network';
        if (proc.retrySaid !== notice) turn.emit({ type: 'notice', notice });
        proc.retrySaid = notice;
      }
      break;
    case 'stream_event': {
      proc.retrySaid = null;
      const event = message.event as { type?: unknown; message?: { id?: unknown }; delta?: { type?: unknown; text?: unknown; thinking?: unknown } } | undefined;
      if (event?.type === 'message_start' && typeof event.message?.id === 'string') proc.messageId = event.message.id;
      if (event?.type === 'content_block_delta' && proc.messageId) {
        const id = proc.messageId;
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          proc.streamed.add(id);
          turn.emit({ type: 'text', id, text: scrub(event.delta.text) });
        } else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          proc.streamed.add(id);
          turn.emit({ type: 'thought', id: `${id}:thought`, text: scrub(event.delta.thinking) });
        }
      }
      break;
    }
    case 'assistant': {
      const body = message.message as { id?: unknown; model?: unknown; content?: unknown; usage?: Record<string, unknown> } | undefined;
      // A message the program made up to carry an error says it again in the result: shown once, there.
      if (!body || body.model === '<synthetic>' || !Array.isArray(body.content)) break;
      const id = typeof body.id === 'string' ? body.id : `turn-${turn.number}`;
      const usage = body.usage;
      if (usage) {
        const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
        proc.lastUsage = { used: count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens') + count('output_tokens') };
      }
      for (const block of body.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>;
          if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
            const entries = (input.todos as Array<{ content?: unknown; status?: unknown }>).slice(0, 50).map((one) => ({ content: scrub(textOf(one.content, 500)), status: textOf(one.status, 20) || 'pending' }));
            turn.emit({ type: 'plan', entries });
          }
          turn.emit({ type: 'tool', id: block.id.slice(0, 200), ...stepOf(block.name, input, turn.vault, scrub), status: 'in_progress' });
        } else if (!proc.streamed.has(id) && block.type === 'text' && typeof block.text === 'string') {
          turn.emit({ type: 'text', id, text: scrub(block.text) });
        } else if (!proc.streamed.has(id) && block.type === 'thinking' && typeof block.thinking === 'string') {
          turn.emit({ type: 'thought', id: `${id}:thought`, text: scrub(block.thinking) });
        }
      }
      break;
    }
    case 'user': {
      const body = message.message as { content?: unknown } | undefined;
      if (!Array.isArray(body?.content)) break;
      for (const block of body.content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const status: ToolStatus = block.is_error ? 'failed' : 'completed';
        const output = resultText(block.content);
        turn.emit({ type: 'tool', id: block.tool_use_id.slice(0, 200), status, output: output ? scrub(output).slice(0, OUTPUT_MAX) : undefined });
      }
      break;
    }
    case 'result': {
      const modelUsage = message.modelUsage as Record<string, { contextWindow?: unknown }> | undefined;
      const size = Math.max(0, ...Object.values(modelUsage ?? {}).map((one) => (typeof one?.contextWindow === 'number' ? one.contextWindow : 0)));
      // The context ring shows no dollars: on a subscription they are not what the person pays. The chat's list shows
      // them as the API's price of the work, marked so (2 November notes; ChatSpend).
      if (proc.lastUsage && size) turn.emit({ type: 'usage', used: proc.lastUsage.used, size, cost: null, currency: null });
      const spent = spendOf(message, turn.sessionId);
      if (spent) turn.emit(spent);
      const finish = proc.finish;
      const fail = proc.fail;
      proc.turn = null;
      proc.finish = null;
      proc.fail = null;
      proc.streamed.clear();
      proc.retrySaid = null;
      if (proc.stopTimer) clearTimeout(proc.stopTimer);
      proc.stopTimer = null;
      idleFrom(proc);
      if (proc.cancelled) finish?.('cancelled');
      else if (message.is_error) {
        const text = textOf(message.result, 1000) || textOf(message.terminal_reason, 100) || 'Claude Code could not answer.';
        fail?.(new TurnFailure(text, kindOfFailure(text)));
      } else {
        const subtype = textOf(message.subtype, 40);
        finish?.(subtype === 'success' ? 'end_turn' : subtype === 'error_max_turns' ? 'max_turn_requests' : subtype || 'end_turn');
      }
      proc.cancelled = false;
      break;
    }
    default:
      break;
  }
}

/** A control request from the program: leave for a step, asked of the person; anything else is refused. */
async function answerControl(proc: Proc, message: Record<string, unknown>): Promise<void> {
  const id = message.request_id;
  const request = message.request as { subtype?: unknown; tool_name?: unknown; input?: unknown; permission_suggestions?: unknown } | undefined;
  const reply = (response: unknown) => write(proc, { type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  if (request?.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string') {
    write(proc, { type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Cortex does not answer this request.' } });
    return;
  }
  const input = (typeof request.input === 'object' && request.input !== null ? request.input : {}) as Record<string, unknown>;
  const turn = proc.turn;
  if (!turn) {
    reply({ behavior: 'deny', message: 'The chat is not waiting for this.' });
    return;
  }
  const suggestions = Array.isArray(request.permission_suggestions) && request.permission_suggestions.length ? request.permission_suggestions : null;
  const tr = turkish();
  const step = cardOf(request.tool_name, input, turn.vault, cardTextFor(turn.vault, vaultWord(tr)));
  const chosen = await turn.ask({
    title: step.title,
    kind: step.kind,
    paths: step.paths,
    options: [
      { id: 'allow', name: tr ? 'Bir kez izin ver' : 'Allow once', kind: 'allow_once' },
      // "Always" is the rule Claude Code suggests itself, kept by Claude Code in its own settings.
      ...(suggestions ? [{ id: 'always', name: tr ? 'Her zaman izin ver' : 'Always allow', kind: 'allow_always' as const }] : []),
      { id: 'deny', name: tr ? 'Reddet' : 'Reject', kind: 'reject_once' },
    ],
  });
  if (chosen === 'allow') reply({ behavior: 'allow', updatedInput: input });
  else if (chosen === 'always' && suggestions) reply({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions });
  else reply({ behavior: 'deny', message: 'The person did not allow this step.' });
}

/** The chat's program, started in the vault with its settings, continuing its session; asked what models it has. */
async function start(turn: Turn, options: ConfigOption[]): Promise<Proc> {
  await systemProxyKnown();
  const launch = launchFor(turn.cli);
  if (!launch) throw new ChatRefusal('Claude Code is not installed on this machine.');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launch.command, claudeArgs(launch.args, options, turn.sessionId), { cwd: turn.vault, env: childEnv(launch.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  } catch (err) {
    // Refused at once: Node throws what the system says of a start it would not make (EPERM under an antivirus), where a program not found comes as an `error` event.
    throw startFailure(err);
  }
  const proc: Proc = {
    chatId: turn.chatId,
    child,
    alive: true,
    buffer: '',
    stderr: '',
    controls: new Map(),
    turn: null,
    finish: null,
    fail: null,
    cancelled: false,
    stopTimer: null,
    messageId: null,
    streamed: new Set(),
    lastUsage: null,
    notStarted: null,
    retrySaid: null,
    idleTimer: null,
  };
  procs.set(turn.chatId, proc);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk: string) => {
    proc.buffer += chunk;
    if (proc.buffer.length > LINE_MAX && !proc.buffer.includes('\n')) {
      close(proc);
      return;
    }
    let at: number;
    while ((at = proc.buffer.indexOf('\n')) >= 0) {
      const line = proc.buffer.slice(0, at).trim();
      proc.buffer = proc.buffer.slice(at + 1);
      if (line) receive(proc, line);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    proc.stderr = (proc.stderr + chunk).slice(-STDERR_KEPT);
  });
  const stopped = () => new TurnFailure(proc.stderr.trim() ? `Claude Code stopped: ${proc.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}` : 'Claude Code stopped.', 'stopped');
  // Never started (no process id): no turn is waiting to be failed yet, so the reason is kept for the start below. It
  // was dropped, and the chat said only "Claude Code stopped." (S1). An error of a program that did start is its stop.
  child.on('error', (err) => {
    if (!proc.alive) return;
    if (child.pid === undefined) proc.notStarted = startFailure(err);
    end(proc, proc.notStarted ?? stopped());
  });
  // Why it stopped is read once its output is closed: at its exit, Node may not have handed over all
  // it wrote to standard error, and the reason was cut to "Claude Code stopped.". A program it left
  // holding the pipes open is not waited for long.
  child.on('exit', () => setTimeout(() => end(proc, stopped()), DRAIN_MS).unref());
  child.on('close', () => end(proc, stopped()));
  let ready: { models?: unknown } | null;
  try {
    ready = (await unlessStopped(turn.signal, control(proc, { subtype: 'initialize', hooks: null }))) as { models?: unknown } | null;
  } catch (err) {
    // Stopped while it started: ended, and the message never sent.
    if (err instanceof Stopped) close(proc);
    throw err;
  }
  if (!proc.alive) throw proc.notStarted ?? stopped();
  // Left with no message - a start whose turn was given up - it is ended as any other.
  idleFrom(proc);
  if (Array.isArray(ready?.models)) {
    const models = (ready.models as Array<{ value?: unknown; displayName?: unknown }>)
      .filter((one) => typeof one.value === 'string')
      .map((one) => ({ value: String(one.value), name: textOf(one.displayName, 80) || String(one.value) }))
      .slice(0, 40);
    if (models.length) turn.setOptions(claudeOptions(Object.fromEntries(options.map((one) => [one.id, one.current])), models));
  }
  return proc;
}

/** Each chat's settings, as last set, for its next start. */
const settings = new Map<string, ConfigOption[]>();

/**
 * The message's content as Claude Code takes it: the words, the files' paths to read with its own tools, and the
 * pictures shown as images (base64 blocks, the Messages API's own; one larger than the API takes goes as a file).
 */
export function contentOf(message: string, attachments: readonly HeldAttachment[]): Array<Record<string, unknown>> {
  const shown = attachments.filter((one) => one.kind === 'image' && one.mime && one.size <= IMAGE_INLINE_MAX);
  const read = attachments.filter((one) => !shown.includes(one));
  const images = shown.flatMap((one) => {
    try {
      return [{ type: 'image', source: { type: 'base64', media_type: one.mime, data: fs.readFileSync(one.path).toString('base64') } }];
    } catch {
      return [];
    }
  });
  const text = `${message}${fileLines(read)}`.trim();
  return [...(text ? [{ type: 'text', text }] : []), ...images];
}

/** A message sent to the chat's program, as its next turn; how the turn ended. */
function send(proc: Proc, turn: Turn, message: string): Promise<string> {
  if (turn.signal.aborted) return Promise.resolve('cancelled');
  return new Promise<string>((resolve, reject) => {
    proc.turn = turn;
    proc.cancelled = false;
    proc.lastUsage = null;
    proc.retrySaid = null;
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
    proc.finish = resolve;
    proc.fail = reject;
    write(proc, { type: 'user', message: { role: 'user', content: contentOf(message, turn.attachments) }, parent_tool_use_id: null });
    turn.sent?.();
  });
}

/** The chat's program started, and the message sent as its first turn; `said` learns whether anything of it was shown. */
async function startAndSend(turn: Turn, options: ConfigOption[], message: string, said: { any: boolean }): Promise<string> {
  // The models Claude Code names replace the fallback list: kept as this chat's settings.
  const relay: Turn = {
    ...turn,
    emit: (event) => {
      said.any = true;
      turn.emit(event);
    },
    setOptions: (next) => (settings.set(turn.chatId, next), turn.setOptions(next)),
  };
  return send(await start(relay, options), relay, message);
}

export const claudeBackend: Backend = {
  async run(turn, message) {
    let options = settings.get(turn.chatId);
    if (!options) {
      options = claudeOptions(turn.prefs);
      settings.set(turn.chatId, options);
      turn.setOptions(options);
    }
    const proc = procs.get(turn.chatId);
    if (proc && proc.alive) return send(proc, turn, message);
    const said = { any: false };
    try {
      return await startAndSend(turn, options, message, said);
    } catch (err) {
      if (err instanceof Stopped) return 'cancelled';
      // The session the chat continues is gone - Claude Code deletes its transcripts after a month - and
      // every message failed on it for good. The message goes to a new session, once, before anything
      // of it was shown; system/init keeps that one as the chat's.
      if (!(err instanceof TurnFailure) || !turn.sessionId || said.any || !SESSION_GONE.test(err.message) || turn.signal.aborted) throw err;
      const left = procs.get(turn.chatId);
      if (left) close(left);
      turn.emit({ type: 'notice', notice: 'new-session' });
      try {
        return await startAndSend({ ...turn, sessionId: null }, options, message, said);
      } catch (again) {
        if (again instanceof Stopped) return 'cancelled';
        throw again;
      }
    }
  },

  cancel(chatId) {
    const proc = procs.get(chatId);
    if (!proc?.turn) return;
    proc.cancelled = true;
    void control(proc, { subtype: 'interrupt' }, STOP_GRACE.ms);
    // Ended if this turn has not ended by then: a turn begun after it - Stop, then the question asked again - is not this one's to end.
    // Stop pressed again does not put that off: the first press's grace holds (the timer goes with its turn's result).
    const stopped = proc.turn;
    if (proc.stopTimer) return;
    proc.stopTimer = setTimeout(() => {
      proc.stopTimer = null;
      if (proc.turn === stopped) close(proc);
    }, STOP_GRACE.ms);
  },

  // Before a new chat's first message: the list Claude Code starts with, the person's last choices current; its own
  // list replaces it once it has started.
  async probe(_cli, _vault, prefs) {
    return claudeOptions(prefs);
  },

  async setOption(chatId, options, option, value) {
    const next = options.map((one) => (one.id === option ? { ...one, current: value } : one));
    settings.set(chatId, next);
    // Given at the next start: ended now, between turns, and started again on the same session with its flags.
    const proc = procs.get(chatId);
    if (proc && !proc.turn) close(proc);
    return next;
  },

  forget(chatId) {
    const proc = procs.get(chatId);
    if (proc) close(proc);
    settings.delete(chatId);
  },

  shutdown() {
    for (const proc of [...procs.values()]) close(proc);
    procs.clear();
  },
};

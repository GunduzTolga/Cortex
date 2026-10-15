import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ConfigOption, ToolStatus } from '../../shared/chat';
import { childEnv } from './acp';
import { type Backend, ChatRefusal, OUTPUT_MAX, STOP_GRACE, TITLE_MAX, type Turn, TurnFailure, scrubberFor, shownPath, textOf } from './chatKit';
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
 * the same session (`--resume`), with the setting as a flag.
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
  /** The message being streamed, and whether its words already came in pieces. */
  messageId: string | null;
  streamed: Set<string>;
  /** The last real message's usage, which says how full the context is. */
  lastUsage: { used: number } | null;
}

const procs = new Map<string, Proc>();
const STDERR_KEPT = 8 * 1024;
const LINE_MAX = 16 * 1024 * 1024;
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The models offered before Claude Code says which it has, as its own `initialize` named them on 14 October. */
const FALLBACK_MODELS = [
  { value: 'default', name: 'Default (recommended)' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'opus', name: 'Opus' },
  { value: 'haiku', name: 'Haiku' },
];

const turkish = () => readSettings().language !== 'en';

/** The chat's settings: the model (Claude Code's own list once it has said it), the permission mode, the effort. */
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

/** A tool's step as the chat shows it: its kind, a title with what it works on, and the paths it touches. */
export function stepOf(name: string, input: Record<string, unknown>, vault: string, scrub: (text: string) => string): { title: string; kind: string; paths: string[] } {
  const file = textOf(input.file_path, 1000) || textOf(input.notebook_path, 1000) || textOf(input.path, 1000);
  const paths = file ? [shownPath(vault, file)] : [];
  const kinds: Record<string, string> = {
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
  const what = textOf(input.command, 200) || textOf(input.pattern, 200) || textOf(input.url, 200) || textOf(input.query, 200) || textOf(input.description, 200) || (paths[0] ?? '');
  return { title: scrub(what ? `${name} ${what}` : name).slice(0, TITLE_MAX), kind: kinds[name] ?? 'other', paths };
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

/** What a failed turn's sentence says it is. */
function kindOfFailure(text: string): string | null {
  if (/\b401\b|authenticat|log ?in|oauth/i.test(text)) return 'auth';
  if (/\b429\b|rate.?limit|usage limit|quota|credit balance/i.test(text)) return 'provider.quota';
  return null;
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

function end(proc: Proc, why: TurnFailure): void {
  if (!proc.alive) return;
  proc.alive = false;
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
  if (!turn) return;
  const scrub = scrubberFor(turn.vault);
  // A sub-agent's own messages (a Task tool's) are its business: the step stands for them.
  if (message.parent_tool_use_id) return;

  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && typeof message.session_id === 'string') turn.setSession(message.session_id);
      break;
    case 'stream_event': {
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
      // Its cost in dollars is left out: on a subscription it is not what the person pays.
      if (proc.lastUsage && size) turn.emit({ type: 'usage', used: proc.lastUsage.used, size, cost: null, currency: null });
      const finish = proc.finish;
      const fail = proc.fail;
      proc.turn = null;
      proc.finish = null;
      proc.fail = null;
      proc.streamed.clear();
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
  const step = stepOf(request.tool_name, input, turn.vault, scrubberFor(turn.vault));
  const tr = turkish();
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
  const launch = launchFor(turn.cli);
  if (!launch) throw new ChatRefusal('Claude Code is not installed on this machine.');
  const child = spawn(launch.command, claudeArgs(launch.args, options, turn.sessionId), { cwd: turn.vault, env: childEnv(launch.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const proc: Proc = { chatId: turn.chatId, child, alive: true, buffer: '', stderr: '', controls: new Map(), turn: null, finish: null, fail: null, cancelled: false, messageId: null, streamed: new Set(), lastUsage: null };
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
  child.on('error', (err) => end(proc, new TurnFailure(`Claude Code could not start: ${err.message}`, 'stopped')));
  child.on('exit', () => end(proc, stopped()));
  const ready = (await control(proc, { subtype: 'initialize', hooks: null })) as { models?: unknown } | null;
  if (!proc.alive) throw stopped();
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

export const claudeBackend: Backend = {
  async run(turn, message) {
    let options = settings.get(turn.chatId);
    if (!options) {
      options = claudeOptions(turn.prefs);
      settings.set(turn.chatId, options);
      turn.setOptions(options);
    }
    let proc = procs.get(turn.chatId);
    if (!proc || !proc.alive) {
      const held = options;
      // The models Claude Code names replace the fallback list: kept as this chat's settings.
      const relay: Turn = { ...turn, setOptions: (next) => (settings.set(turn.chatId, next), turn.setOptions(next)) };
      proc = await start(relay, held);
    }
    const running = proc;
    return new Promise<string>((resolve, reject) => {
      running.turn = turn;
      running.cancelled = false;
      running.lastUsage = null;
      running.finish = resolve;
      running.fail = reject;
      write(running, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] }, parent_tool_use_id: null });
    });
  },

  cancel(chatId) {
    const proc = procs.get(chatId);
    if (!proc?.turn) return;
    proc.cancelled = true;
    void control(proc, { subtype: 'interrupt' }, STOP_GRACE);
    setTimeout(() => proc.turn && close(proc), STOP_GRACE);
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

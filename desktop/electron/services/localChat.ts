import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import type { ConfigOption } from '../../shared/chat';
import { childEnv } from './acp';
import { type Backend, Stopped, type Turn, TurnFailure, scrubberFor, unlessStopped } from './chatKit';
import { onPathFile, onPathFiles } from './clis';
import { writeWhole } from './fileWrite';
import { captureToInbox } from './inbox';
import { LOCAL, type LocalId, type LocalModels, baseOf, findLocal, localModel } from './localModels';
import { readSettings } from './settings';

/**
 * The chat with a model on this machine's own server, LM Studio or Ollama,
 * talked to directly: the model the person loaded in its app answers, through
 * the server's OpenAI-compatible endpoint (`/v1/chat/completions`, streamed).
 * No other program stands between.
 *
 * Pyn's memory comes as it comes to any client of the vault: from the vault's
 * own hook (`.claude/scripts/beyin_v3_hook.py`), asked as the vault's OpenCode
 * plugin asks it - `SessionStart` with the chat's first message, its context
 * kept as the session's; `UserPromptSubmit` with every later one, its context
 * riding in that message. The hook is asked under OpenCode's name, the
 * harness through which local models had their memory before, so they get
 * the same. Where the vault has no hook, or Python will not answer, the chat
 * goes on without memory: never a broken turn.
 *
 * The model has one tool: `save_to_inbox`, which adds a card to the vault's
 * inbox (services/inbox.ts, `beyin.py yakala ekle`), so "save this for later"
 * is saved, not promised. It reads nothing and changes nothing else. A model
 * its server says cannot take tools is asked again without it, and the person
 * still has "Gelen kutusuna at" beside Send (Ctrl+Enter), which keeps a message without the model. The
 * conversation is kept in the app's data folder under the chat's own id, so it
 * goes on after the app is closed, and goes with the chat when it is deleted;
 * the tool's own exchange is not kept, only the answer it led to.
 */

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A tool call as the server streams it, put together from its pieces. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** What goes to the server within one turn: the conversation, and the tool's exchange while it lasts. */
type Wire = Message | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] } | { role: 'tool'; tool_call_id: string; content: string };

export const SAVE_TOOL = 'save_to_inbox';

/** The one tool, as the OpenAI-compatible endpoint takes it. */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: SAVE_TOOL,
      description:
        "Save something to the user's Cortex inbox (📥 000-Inbox/Yakala) so it is kept for later: a link, a note, an idea, a task. " +
        'Call it whenever the user asks to save, keep, note down or remember something for later, or says they will look at something later. ' +
        'It only adds a card; it never edits or deletes anything.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to keep, in the user’s own words (a link may be in it).' },
          url: { type: 'string', description: 'The link to keep, if there is one.' },
          why: { type: 'string', description: 'Why it is kept or what to do with it later, if the user said.' },
        },
      },
    },
  },
];

/** Rounds of tool calls in one turn; after them the model answers without the tool. */
const TOOL_ROUNDS = 3;
/** A server's word that the model takes no tools (Ollama: "… does not support tools"). */
const NO_TOOLS = /does not support tools|tools? (?:are |is )?not supported|unsupported.*tool/i;
/** Models their server said take no tools, by server and model: asked without the tool from then on. */
const toolless = new Set<string>();

interface Session {
  id: string;
  /** The model the person chose for this chat on its chip; null: the one loaded in the server's app. */
  chosen: string | null;
  /** Whether the vault's hook has been asked for the session's context. */
  started: boolean;
  messages: Message[];
}

const sessions = new Map<string, Session>();
/** Choices made on a chat's chip before it was run in this start. */
const pendingChoice = new Map<string, string>();
const running = new Map<string, AbortController>();

const SESSION_ID = /^[0-9a-f-]{36}$/;
const MESSAGES_MAX = 400;
const HOOK_TIMEOUT = 20_000;

const sessionDir = () => path.join(app.getPath('userData'), 'chats', 'local');
const sessionFile = (id: string) => path.join(sessionDir(), `${id}.json`);

function loadSession(id: string): Session | null {
  if (!SESSION_ID.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')) as Partial<Session>;
    const messages = Array.isArray(raw.messages)
      ? raw.messages.filter((one): one is Message => typeof one === 'object' && one !== null && ['system', 'user', 'assistant'].includes(one.role) && typeof one.content === 'string')
      : [];
    return { id, chosen: typeof raw.chosen === 'string' ? raw.chosen : null, started: raw.started === true, messages };
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  try {
    writeWhole(sessionFile(session.id), JSON.stringify({ chosen: session.chosen, started: session.started, messages: session.messages.slice(-MESSAGES_MAX) }));
  } catch {
    /* Kept in memory for this start. */
  }
}

/** How a Python is started: its program, and what comes before the script (`py -3`). */
export interface PythonLaunch {
  command: string;
  args: string[];
}

/** The oldest Python the vault's engine runs on: its package's `min_python` (scripts/build_v3_release.py). */
export const PYTHON_MIN = [3, 11] as const;
/** How long a Python is given to say its version: a first start under a virus scan takes seconds, and a slow answer is not a wrong one. */
const PROBE_TIMEOUT = 15_000;
/** A Python found wanting is asked again after this long: one installed meanwhile (python.org, winget, the app's own) is then seen. */
const RECHECK_AFTER = 30_000;

/** What a Python said when asked its version: fit for the engine, or not - too old, or not running at all - and when. */
type Verdict = { fit: true; version: string } | { fit: false; version: string | null; at: number };
const verdicts = new Map<string, Verdict>();
const asking = new Map<string, Promise<string | null | undefined>>();
const keyOf = (one: PythonLaunch) => [one.command, ...one.args].join('\0');

/**
 * Every Python the vault's engine could be run by on this machine, the one preferred first: Windows' `py -3` (the newest
 * Python it knows), a `python.exe` on the PATH, then where python.org's installer puts one for this user - the one the
 * first-run screen installs is found at once, without the PATH this process started with knowing it; elsewhere `python3`.
 * Never the Store's stand-in, which opens the Store. Found by name only: whether one runs, and is new enough, is
 * `usablePython`'s to ask.
 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): PythonLaunch[] {
  const found: PythonLaunch[] = [];
  const add = (command: string, args: string[] = []) => {
    if (!found.some((one) => keyOf(one) === keyOf({ command, args }))) found.push({ command, args });
  };
  if (process.platform === 'win32') {
    const launcher = onPathFile(['py.exe'], env);
    if (launcher) add(launcher, ['-3']);
    for (const python of onPathFiles(['python.exe'], env, (file) => !/\\WindowsApps\\/i.test(file))) add(python);
    const own = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Python') : null;
    if (own) {
      if (fs.existsSync(path.join(own, 'Launcher', 'py.exe'))) add(path.join(own, 'Launcher', 'py.exe'), ['-3']);
      for (const name of ['Python313', 'Python312', 'Python311']) {
        const file = path.join(own, name, 'python.exe');
        if (fs.existsSync(file)) add(file);
      }
    }
    return found;
  }
  // A Mac's own python3 is 3.9: a newer one later on the PATH, or under its versioned name, is the one.
  for (const python of onPathFiles(['python3', 'python', 'python3.13', 'python3.12', 'python3.11'], env)) add(python);
  return found;
}

/**
 * Python as the vault's engine is run: BEYIN_PYTHON where it is set, else the first of this machine's Pythons not found
 * wanting. Found by name, the way it was before it is asked (`usablePython`): the status at the app's start asks, and from
 * then on a `py` launcher left behind with no Python, or a Python 3.10, is passed over here too - Telegram, the inbox and
 * the chat's memory run on the one the setup found fit.
 */
export function pythonOf(env: NodeJS.ProcessEnv = process.env): PythonLaunch | null {
  if (env.BEYIN_PYTHON) return { command: env.BEYIN_PYTHON, args: [] };
  return pythonCandidates(env).find((one) => verdicts.get(keyOf(one))?.fit !== false) ?? null;
}

/**
 * What a Python says it is ("3.12"): null when it does not start, fails (a `py` launcher with no Python behind it says
 * "No suitable Python runtime found" and exits) or says something else; undefined when it did not answer in time. Its
 * input is closed, so a launcher that would ask to install a Python is told no rather than waited on.
 */
export function pythonVersion(one: PythonLaunch, timeout = PROBE_TIMEOUT): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let said = '';
    let late = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(one.command, [...one.args, '-c', "import sys; print('%d.%d' % sys.version_info[:2])"], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }),
      });
    } catch {
      resolve(null);
      return;
    }
    // Answered at the timeout, not when the output closes: a launcher's Python, left running, may hold it open.
    const timer = setTimeout(() => {
      late = true;
      child.kill();
      resolve(undefined);
    }, timeout);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      said = (said + chunk).slice(-200);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (late) return;
      const version = /^(\d+)\.(\d+)\s*$/.exec(said.trim().split(/\r?\n/).pop() ?? '');
      resolve(code === 0 && version ? `${version[1]}.${version[2]}` : null);
    });
  });
}

/** A version the engine runs on: 3.11 or newer. */
export function fitVersion(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1]);
}

/**
 * The Python the vault's engine is run by, each of this machine's asked its version until one is 3.11 or newer; null
 * when none is (the first-run screen and the settings then offer the Python the app came with). Its answer is kept: a
 * fit one is not asked again, one found wanting is after a while. One that does not answer in time is not taken for
 * wanting - a slow first start is not a wrong Python - and is used, and asked again the next time.
 */
export async function usablePython(env: NodeJS.ProcessEnv = process.env, timeout = PROBE_TIMEOUT): Promise<PythonLaunch | null> {
  if (env.BEYIN_PYTHON) return { command: env.BEYIN_PYTHON, args: [] };
  for (const one of pythonCandidates(env)) {
    const key = keyOf(one);
    const known = verdicts.get(key);
    if (known?.fit) return one;
    if (known && Date.now() - known.at < RECHECK_AFTER) continue;
    // Two asking at once (the status at start, the notification-area icon) start it once.
    let answer = asking.get(key);
    if (!answer) {
      answer = pythonVersion(one, timeout);
      asking.set(key, answer);
      void answer.finally(() => asking.delete(key));
    }
    const version = await answer;
    if (version === undefined) return one;
    if (version !== null && fitVersion(version)) {
      verdicts.set(key, { fit: true, version });
      return one;
    }
    verdicts.set(key, { fit: false, version, at: Date.now() });
  }
  return null;
}

/**
 * Why no Python of this machine is used, as the setup says it: the newest one found too old ("3.10"), 'broken' when
 * those found do not run (a `py` launcher left behind when Python was uninstalled), null when none was found at all.
 */
export function pythonWanting(env: NodeJS.ProcessEnv = process.env): string | null {
  let broken = false;
  let newest: string | null = null;
  const rank = (version: string) => version.split('.').reduce((sum, part) => sum * 1000 + Number(part), 0);
  for (const one of pythonCandidates(env)) {
    const known = verdicts.get(keyOf(one));
    if (!known || known.fit) continue;
    if (known.version === null) broken = true;
    else if (!newest || rank(known.version) > rank(newest)) newest = known.version;
  }
  return newest ?? (broken ? 'broken' : null);
}

/** What each Python said, forgotten: one was just installed, and the launcher that had nothing behind it may have now. */
export function forgetPythonVerdicts(): void {
  verdicts.clear();
}

/** The context the vault's hook gives for this moment of the chat; empty where there is none to give, or when the turn is stopped (the hook ended with it). */
export function hookContext(vault: string, event: 'SessionStart' | 'UserPromptSubmit', sessionId: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const hook = path.join(vault, '.claude', 'scripts', 'beyin_v3_hook.py');
  let state: string | null = null;
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(vault, '.beyin-runtime.json'), 'utf8')) as { state?: unknown };
    state = typeof runtime.state === 'string' && path.isAbsolute(runtime.state) ? runtime.state : null;
  } catch {
    state = null;
  }
  const python = pythonOf();
  if (!state || !python || !fs.existsSync(hook)) return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      const child = execFile(
        python.command,
        [...python.args, hook, '--vault', vault, '--state', state, '--harness', 'opencode'],
        { cwd: vault, timeout: HOOK_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal, env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }) },
        (error, stdout) => {
          try {
            const text = error ? '' : (JSON.parse(String(stdout || '{}')) as { hookSpecificOutput?: { additionalContext?: unknown } })?.hookSpecificOutput?.additionalContext;
            resolve(typeof text === 'string' ? text : '');
          } catch {
            resolve('');
          }
        },
      );
      child.on('error', () => resolve(''));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, prompt, cwd: vault }));
    } catch {
      resolve('');
    }
  });
}

/** What the model is told it is, in the window's language: Pyn, on a model of this machine, with one tool that only saves. */
export function preamble(): string {
  const { language, userName } = readSettings();
  if (language === 'en') {
    return (
      "You are Pyn, the user's thinking partner, talking with them in the Cortex desktop app. You run on a model on their own computer. " +
      `You have one tool, ${SAVE_TOOL}: it adds a note or a link to their vault's inbox. When they ask you to save, keep or note something, or say they will look at it later, call it. ` +
      'You cannot read or change any other file. Never say you saved something unless the tool said it was saved; if you have no tool or it failed, say so and point them to the inbox button beside Send (Ctrl+Enter). ' +
      'You do not remember this chat elsewhere: do not promise to "keep it in mind". What their vault remembers is given below and with their messages.' +
      (userName ? ` Address them as "${userName}".` : '')
    );
  }
  return (
    'Sen Pyn\'sin: kullanıcının düşünme ortağı. Onunla Cortex masaüstü uygulamasında konuşuyorsun. Kendi bilgisayarındaki bir modelde çalışıyorsun. ' +
    `Tek bir aracın var, ${SAVE_TOOL}: kasasının gelen kutusuna bir not ya da bağlantı ekler. Bir şeyi kaydetmeni, not almanı, saklamanı isterse ya da "sonra bakacağım" derse onu çağır. ` +
    'Başka hiçbir dosyayı okuyamaz, değiştiremezsin. Araç kaydettiğini söylemeden "kaydettim" deme; aracın yoksa ya da çalışmadıysa bunu söyle ve gönder düğmesinin yanındaki "Gelen kutusuna at" düğmesini (Ctrl+Enter) hatırlat. ' +
    'Bu sohbeti başka bir yerde hatırlamazsın: "aklımda tutarım" deme. Kasasının hatırladıkları aşağıda ve mesajlarının yanında verilir.' +
    (userName ? ` Ona "${userName}" diye hitap et.` : '')
  );
}

/** A tool call's arguments as an object: the JSON text a server streams, or an object a server already parsed. */
export function argumentsOf(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One tool call carried out, told to the window as a step; what the model is told back. */
async function runTool(call: ToolCall, turn: Turn, stepId: string): Promise<Record<string, unknown>> {
  const english = readSettings().language === 'en';
  if (call.function.name !== SAVE_TOOL) return { ok: false, error: `There is no tool named ${call.function.name}.` };
  turn.emit({ type: 'tool', id: stepId, title: english ? 'Adding to the inbox' : 'Gelen kutusuna ekleniyor', kind: 'edit', status: 'in_progress' });
  try {
    const saved = await captureToInbox(argumentsOf(call), 'pyn');
    turn.emit({ type: 'tool', id: stepId, title: english ? 'Added to the inbox' : 'Gelen kutusuna eklendi', kind: 'edit', status: 'completed', paths: [saved.path] });
    return { ok: true, saved_to: saved.path, already_there: saved.added === 'existing' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    turn.emit({ type: 'tool', id: stepId, title: english ? 'Not added to the inbox' : 'Gelen kutusuna eklenemedi', kind: 'edit', status: 'failed', output: message });
    return { ok: false, error: message };
  }
}

/** The model's chip: the server's models, the loaded ones first and said so. */
export function localOptions(found: LocalModels, current: string): ConfigOption[] {
  const loadedWord = readSettings().language === 'en' ? 'loaded' : 'yüklü';
  const ordered = [...found.loaded, ...found.models.filter((one) => !found.loaded.includes(one))];
  return [{ id: 'model', name: 'Model', category: 'model', current, choices: ordered.map((one) => ({ value: one, name: found.loaded.includes(one) ? `${one} · ${loadedWord}` : one })) }];
}

/** Two messages of one side running together, made one: the person's two questions with a blank line between. */
function alternating(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const one of messages) {
    const last = out[out.length - 1];
    if (last && last.role === one.role) out[out.length - 1] = { role: one.role, content: `${last.content}\n\n${one.content}` };
    else out.push(one);
  }
  return out;
}

/**
 * The conversation cut to what the model can hold: the session's own context always, the oldest
 * turns dropped first. What goes takes turns, the person first: the chat templates of Gemma and
 * Mistral in LM Studio refuse anything else ("Conversation roles must alternate"), and a turn that
 * failed (two of the person's messages in a row) or a cut that left the model's answer first broke
 * every later message of the chat.
 */
export function fitted(messages: Message[], contextTokens: number | undefined): Message[] {
  const budget = Math.max(4_000, (contextTokens ?? 8_192) * 3);
  const system = messages.filter((one) => one.role === 'system');
  const rest = alternating(messages.filter((one) => one.role !== 'system'));
  let size = [...system, ...rest].reduce((sum, one) => sum + one.content.length, 0);
  while (rest.length > 1 && size > budget) size -= rest.shift()!.content.length;
  while (rest.length > 1 && rest[0].role === 'assistant') rest.shift();
  return [...system, ...rest];
}

/**
 * The answer's words and thinking, in the pieces they come in. A thinking
 * model gives its thinking as `reasoning_content` (LM Studio), `reasoning`
 * (Ollama), or between <think> tags in its words; a tag cut between two
 * pieces is held until the next.
 */
export function splitter(onText: (text: string) => void, onThought: (text: string) => void) {
  let thinking = false;
  let held = '';
  const feed = (piece: string) => {
    let text = held + piece;
    held = '';
    while (text) {
      const tag = thinking ? '</think>' : '<think>';
      const at = text.indexOf(tag);
      if (at >= 0) {
        if (at) (thinking ? onThought : onText)(text.slice(0, at));
        thinking = !thinking;
        text = text.slice(at + tag.length);
        continue;
      }
      // The end of the piece may be the start of a tag.
      const keep = [...Array(tag.length - 1).keys()].map((n) => n + 1).reverse().find((n) => text.endsWith(tag.slice(0, n))) ?? 0;
      const out = text.slice(0, text.length - keep);
      if (out) (thinking ? onThought : onText)(out);
      held = text.slice(text.length - keep);
      text = '';
    }
  };
  return { feed, flush: () => held && ((thinking ? onThought : onText)(held), (held = '')) };
}

/** One answer, streamed from the server; the words it came to, and the tokens it counted where it says. */
function complete(
  id: LocalId,
  model: string,
  messages: Wire[],
  signal: AbortSignal,
  onText: (text: string) => void,
  onThought: (text: string) => void,
  tools?: typeof TOOLS,
): Promise<{ text: string; used: number | null; calls: ToolCall[] }> {
  const url = new URL(`${baseOf(id)}/v1/chat/completions`);
  const body = JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, ...(tools ? { tools } : {}) });
  return new Promise((resolve, reject) => {
    let text = '';
    let used: number | null = null;
    // Tool calls by their index: a name and arguments that may come in pieces (LM Studio), or whole (Ollama).
    const calls: ToolCall[] = [];
    const words = splitter((piece) => ((text += piece), onText(piece)), onThought);
    const request = http.request(
      url,
      { method: 'POST', agent: false, signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (response) => {
        response.setEncoding('utf8');
        if (response.statusCode !== 200) {
          let error = '';
          response.on('data', (chunk: string) => (error = (error + chunk).slice(0, 4000)));
          response.on('end', () => {
            let said = error.trim();
            try {
              const parsed = JSON.parse(error) as { error?: { message?: unknown } | string };
              said = typeof parsed.error === 'string' ? parsed.error : typeof parsed.error?.message === 'string' ? parsed.error.message : said;
            } catch {
              /* as it came */
            }
            reject(new TurnFailure(`${LOCAL[id].name}: ${said || `HTTP ${response.statusCode}`}`, null));
          });
          return;
        }
        let buffer = '';
        const line = (raw: string) => {
          const data = raw.trim();
          if (!data.startsWith('data:')) return;
          const payload = data.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown } }>;
              usage?: { total_tokens?: unknown };
            };
            const delta = chunk.choices?.[0]?.delta;
            const thought = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof thought === 'string' && thought) onThought(thought);
            if (typeof delta?.content === 'string' && delta.content) words.feed(delta.content);
            if (Array.isArray(delta?.tool_calls)) {
              for (const piece of delta.tool_calls as Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
                const at = typeof piece.index === 'number' ? piece.index : calls.length;
                const call = (calls[at] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
                if (typeof piece.id === 'string' && piece.id) call.id = piece.id;
                if (typeof piece.function?.name === 'string') call.function.name += piece.function.name;
                const args = piece.function?.arguments;
                if (typeof args === 'string') call.function.arguments += args;
                else if (args && typeof args === 'object') call.function.arguments = JSON.stringify(args);
              }
            }
            if (typeof chunk.usage?.total_tokens === 'number') used = chunk.usage.total_tokens;
          } catch {
            /* a line that is not JSON */
          }
        };
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
          }
        });
        const finish = () => {
          if (buffer) line(buffer);
          buffer = '';
          words.flush();
          const made = calls.filter(Boolean).map((call, at) => ({ ...call, id: call.id || `call_${at}` }));
          resolve({ text, used, calls: signal.aborted ? [] : made.filter((call) => call.function.name) });
        };
        response.on('end', finish);
        // Stopped mid-answer: what came so far is the answer.
        response.on('error', (err) => (signal.aborted ? finish() : reject(err)));
        response.on('close', () => signal.aborted && finish());
      },
    );
    request.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') resolve({ text, used, calls: [] });
      else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') reject(new TurnFailure(`${LOCAL[id].name} is not running. Open it, load a model, and write again.`, 'local-off'));
      else reject(err);
    });
    request.end(body);
  });
}

/** One turn of a local chat: the hook asked for its memory, the model asked, its tool run; how the turn ended. */
async function answer(turn: Turn, message: string, session: Session, found: LocalModels, model: string, signal: AbortSignal): Promise<string> {
  const id = turn.cli as LocalId;
  const scrub = scrubberFor(turn.vault);
  let content = message;
  if (!session.started) {
    const context = await hookContext(turn.vault, 'SessionStart', session.id, message, signal);
    // Stopped while the hook was asked: nothing of the turn is kept, and the session is begun at the next.
    if (signal.aborted) return 'cancelled';
    session.messages.unshift({ role: 'system', content: [preamble(), context].filter(Boolean).join('\n\n') });
    session.started = true;
  } else {
    const context = await hookContext(turn.vault, 'UserPromptSubmit', session.id, message, signal);
    if (signal.aborted) return 'cancelled';
    if (context) content = `${context}\n\n---\n\n${message}`;
  }
  const asked: Message = { role: 'user', content };
  session.messages.push(asked);
  // A turn that came to no answer - failed, or stopped before a word - is taken back, so the conversation kept goes on taking turns.
  const takeBack = () => {
    const at = session.messages.lastIndexOf(asked);
    if (at >= 0) session.messages.splice(at, 1);
  };
  try {
    const answerId = `turn-${turn.number}`;
    const key = `${id}:${model}`;
    // The tool's exchange in this turn: sent with the conversation while it lasts, never kept.
    const exchange: Wire[] = [];
    let answer = '';
    let used: number | null = null;
    for (let round = 0; ; round += 1) {
      const tools = round < TOOL_ROUNDS && !toolless.has(key) ? TOOLS : undefined;
      let result: { text: string; used: number | null; calls: ToolCall[] };
      try {
        result = await complete(
          id,
          model,
          [...fitted(session.messages, found.contexts[model]), ...exchange],
          signal,
          (piece) => turn.emit({ type: 'text', id: round ? `${answerId}:${round}` : answerId, text: scrub(piece) }),
          (piece) => turn.emit({ type: 'thought', id: `${answerId}:thought`, text: scrub(piece) }),
          tools,
        );
      } catch (err) {
        // A model that takes no tools: asked again without it, and from then on.
        if (tools && err instanceof TurnFailure && NO_TOOLS.test(err.message)) {
          toolless.add(key);
          round -= 1;
          continue;
        }
        throw err;
      }
      used = result.used ?? used;
      if (result.text) answer = answer ? `${answer}\n\n${result.text}` : result.text;
      if (!result.calls.length || signal.aborted) break;
      exchange.push({ role: 'assistant', content: result.text || null, tool_calls: result.calls });
      for (const [at, call] of result.calls.entries()) {
        const outcome = await runTool(call, turn, `${answerId}:tool:${round}:${at}`);
        exchange.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome) });
      }
    }
    if (answer) session.messages.push({ role: 'assistant', content: answer });
    else if (signal.aborted) takeBack();
    const size = found.contexts[model];
    if (used !== null && size) turn.emit({ type: 'usage', used, size, cost: null, currency: null });
    return signal.aborted ? 'cancelled' : 'end_turn';
  } catch (err) {
    takeBack();
    throw err;
  }
}

export const localBackend: Backend = {
  async run(turn, message) {
    const id = turn.cli as LocalId;
    // Stopped by the person, by the chat forgotten, or by the app closing: the hook, the request, all of it.
    const stop = new AbortController();
    const stopped = () => stop.abort();
    turn.signal.addEventListener('abort', stopped, { once: true });
    if (turn.signal.aborted) stop.abort();
    running.set(turn.chatId, stop);
    let session: Session | null = null;
    try {
      const found = await unlessStopped(stop.signal, findLocal(id));
      if (!found.models.length) throw new TurnFailure(`${LOCAL[id].name} is not running, or has no model. Open it, load a model, and write again.`, 'local-off');
      // The conversation is the chat's, by its id: the hook's session and the file it is kept in.
      session = sessions.get(turn.chatId) ?? loadSession(turn.chatId);
      if (!session) {
        session = { id: turn.chatId, chosen: null, started: false, messages: [] };
        turn.setSession(session.id);
      }
      sessions.set(turn.chatId, session);
      const pending = pendingChoice.get(turn.chatId);
      if (pending) session.chosen = pending;
      pendingChoice.delete(turn.chatId);
      // The model chosen on this chat's chip while the server has it; else the one loaded in its app now.
      const model = session.chosen && found.models.includes(session.chosen) ? session.chosen : localModel(found, turn.prefs.model ?? null);
      if (!model) throw new TurnFailure(`${LOCAL[id].name} has no model.`, 'local-off');
      turn.setOptions(localOptions(found, model));
      return await answer(turn, message, session, found, model, stop.signal);
    } catch (err) {
      if (err instanceof Stopped) return 'cancelled';
      throw err;
    } finally {
      turn.signal.removeEventListener('abort', stopped);
      if (running.get(turn.chatId) === stop) running.delete(turn.chatId);
      // A chat deleted while it answered leaves nothing behind: its conversation is not written again.
      if (session && sessions.get(session.id) === session) saveSession(session);
    }
  },

  cancel(chatId) {
    running.get(chatId)?.abort();
  },

  async setOption(chatId, options, option, value) {
    if (option !== 'model') return options;
    const session = sessions.get(chatId);
    if (session) {
      session.chosen = value;
      saveSession(session);
    } else pendingChoice.set(chatId, value);
    return options.map((one) => (one.id === 'model' ? { ...one, current: value } : one));
  },

  forget(chatId) {
    running.get(chatId)?.abort();
    sessions.delete(chatId);
    pendingChoice.delete(chatId);
    if (SESSION_ID.test(chatId)) fs.rmSync(sessionFile(chatId), { force: true });
  },

  shutdown() {
    for (const stop of running.values()) stop.abort();
    running.clear();
  },
};

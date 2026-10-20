import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import type { ConfigOption } from '../../shared/chat';
import { childEnv } from './acp';
import { type Backend, type Turn, TurnFailure, scrubberFor } from './chatKit';
import { onPathFile } from './clis';
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
 * still has the "Gelen kutusuna at" button under their message. The
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
    fs.mkdirSync(sessionDir(), { recursive: true });
    const temp = `${sessionFile(session.id)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ chosen: session.chosen, started: session.started, messages: session.messages.slice(-MESSAGES_MAX) }), 'utf8');
    fs.renameSync(temp, sessionFile(session.id));
  } catch {
    /* Kept in memory for this start. */
  }
}

/**
 * Python as the vault's engine is run: BEYIN_PYTHON where it is set, else Windows' `py -3`, else a `python3` on the PATH.
 * Never the Store's stand-in, which opens the Store. On Windows, where python.org's installer puts a Python for this user
 * too: the one the first-run screen installs is found at once, without the PATH this process started with knowing it.
 */
export function pythonOf(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  if (env.BEYIN_PYTHON) return { command: env.BEYIN_PYTHON, args: [] };
  if (process.platform === 'win32') {
    const launcher = onPathFile(['py.exe'], env);
    if (launcher) return { command: launcher, args: ['-3'] };
    const python = onPathFile(['python.exe'], env, (file) => !/\\WindowsApps\\/i.test(file));
    if (python) return { command: python, args: [] };
    const own = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Python') : null;
    if (!own) return null;
    if (fs.existsSync(path.join(own, 'Launcher', 'py.exe'))) return { command: path.join(own, 'Launcher', 'py.exe'), args: ['-3'] };
    const installed = ['Python313', 'Python312', 'Python311'].map((name) => path.join(own, name, 'python.exe')).find((file) => fs.existsSync(file));
    return installed ? { command: installed, args: [] } : null;
  }
  const python = onPathFile(['python3', 'python'], env);
  return python ? { command: python, args: [] } : null;
}

/** The context the vault's hook gives for this moment of the chat; empty where there is none to give. */
export function hookContext(vault: string, event: 'SessionStart' | 'UserPromptSubmit', sessionId: string, prompt: string): Promise<string> {
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
        { cwd: vault, timeout: HOOK_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }) },
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
      'You cannot read or change any other file. Never say you saved something unless the tool said it was saved; if you have no tool or it failed, say so and point them to the "Add to inbox" button under their message. ' +
      'You do not remember this chat elsewhere: do not promise to "keep it in mind". What their vault remembers is given below and with their messages.' +
      (userName ? ` Address them as "${userName}".` : '')
    );
  }
  return (
    'Sen Pyn\'sin: kullanıcının düşünme ortağı. Onunla Cortex masaüstü uygulamasında konuşuyorsun. Kendi bilgisayarındaki bir modelde çalışıyorsun. ' +
    `Tek bir aracın var, ${SAVE_TOOL}: kasasının gelen kutusuna bir not ya da bağlantı ekler. Bir şeyi kaydetmeni, not almanı, saklamanı isterse ya da "sonra bakacağım" derse onu çağır. ` +
    'Başka hiçbir dosyayı okuyamaz, değiştiremezsin. Araç kaydettiğini söylemeden "kaydettim" deme; aracın yoksa ya da çalışmadıysa bunu söyle ve mesajının altındaki "Gelen kutusuna at" düğmesini hatırlat. ' +
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

/** The conversation cut to what the model can hold: the session's own context always, the oldest turns dropped first. */
export function fitted(messages: Message[], contextTokens: number | undefined): Message[] {
  const budget = Math.max(4_000, (contextTokens ?? 8_192) * 3);
  const system = messages.filter((one) => one.role === 'system');
  const rest = messages.filter((one) => one.role !== 'system');
  let size = [...system, ...rest].reduce((sum, one) => sum + one.content.length, 0);
  while (rest.length > 1 && size > budget) size -= rest.shift()!.content.length;
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

export const localBackend: Backend = {
  async run(turn, message) {
    const id = turn.cli as LocalId;
    const found = await findLocal(id);
    if (!found.models.length) throw new TurnFailure(`${LOCAL[id].name} is not running, or has no model. Open it, load a model, and write again.`, 'local-off');
    // The conversation is the chat's, by its id: the hook's session and the file it is kept in.
    let session = sessions.get(turn.chatId) ?? loadSession(turn.chatId);
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

    const scrub = scrubberFor(turn.vault);
    let content = message;
    if (!session.started) {
      const context = await hookContext(turn.vault, 'SessionStart', session.id, message);
      session.messages.unshift({ role: 'system', content: [preamble(), context].filter(Boolean).join('\n\n') });
      session.started = true;
    } else {
      const context = await hookContext(turn.vault, 'UserPromptSubmit', session.id, message);
      if (context) content = `${context}\n\n---\n\n${message}`;
    }
    session.messages.push({ role: 'user', content });

    const stop = new AbortController();
    running.set(turn.chatId, stop);
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
            stop.signal,
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
        if (!result.calls.length || stop.signal.aborted) break;
        exchange.push({ role: 'assistant', content: result.text || null, tool_calls: result.calls });
        for (const [at, call] of result.calls.entries()) {
          const outcome = await runTool(call, turn, `${answerId}:tool:${round}:${at}`);
          exchange.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome) });
        }
      }
      if (answer) session.messages.push({ role: 'assistant', content: answer });
      const size = found.contexts[model];
      if (used !== null && size) turn.emit({ type: 'usage', used, size, cost: null, currency: null });
      return stop.signal.aborted ? 'cancelled' : 'end_turn';
    } finally {
      running.delete(turn.chatId);
      saveSession(session);
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

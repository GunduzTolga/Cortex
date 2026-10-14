import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import type { ConfigOption } from '../../shared/chat';
import { childEnv } from './acp';
import { type Backend, TurnFailure, scrubberFor } from './chatKit';
import { onPathFile } from './clis';
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
 * The model has no tools here: it reads and writes nothing. The conversation
 * is kept in the app's data folder under the chat's own id, so it goes on
 * after the app is closed, and goes with the chat when the chat is deleted.
 */

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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

/** Python as the vault's engine is run: BEYIN_PYTHON where it is set, else Windows' `py -3`, else a `python3` on the PATH. Never the Store's stand-in, which opens the Store. */
export function pythonOf(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  if (env.BEYIN_PYTHON) return { command: env.BEYIN_PYTHON, args: [] };
  if (process.platform === 'win32') {
    const launcher = onPathFile(['py.exe'], env);
    if (launcher) return { command: launcher, args: ['-3'] };
    const python = onPathFile(['python.exe'], env, (file) => !/\\WindowsApps\\/i.test(file));
    return python ? { command: python, args: [] } : null;
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

/** What the model is told it is, in the window's language: Pyn, on a model of this machine, with no tools. */
function preamble(): string {
  return readSettings().language === 'en'
    ? "You are Pyn, the user's thinking partner, talking with them in the Cortex desktop app. You run on a model on their own computer and have no tools: you cannot read or change files. What their vault remembers is given below and with their messages."
    : 'Sen Pyn\'sin: kullanıcının düşünme ortağı. Onunla Cortex masaüstü uygulamasında konuşuyorsun. Kendi bilgisayarındaki bir modelde çalışıyorsun ve aracın yok: dosya okuyamaz, değiştiremezsin. Kasasının hatırladıkları aşağıda ve mesajlarının yanında verilir.';
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
  messages: Message[],
  signal: AbortSignal,
  onText: (text: string) => void,
  onThought: (text: string) => void,
): Promise<{ text: string; used: number | null }> {
  const url = new URL(`${baseOf(id)}/v1/chat/completions`);
  const body = JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } });
  return new Promise((resolve, reject) => {
    let text = '';
    let used: number | null = null;
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
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>; usage?: { total_tokens?: unknown } };
            const delta = chunk.choices?.[0]?.delta;
            const thought = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof thought === 'string' && thought) onThought(thought);
            if (typeof delta?.content === 'string' && delta.content) words.feed(delta.content);
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
          resolve({ text, used });
        };
        response.on('end', finish);
        // Stopped mid-answer: what came so far is the answer.
        response.on('error', (err) => (signal.aborted ? finish() : reject(err)));
        response.on('close', () => signal.aborted && finish());
      },
    );
    request.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') resolve({ text, used });
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
      const { text, used } = await complete(
        id,
        model,
        fitted(session.messages, found.contexts[model]),
        stop.signal,
        (piece) => turn.emit({ type: 'text', id: answerId, text: scrub(piece) }),
        (piece) => turn.emit({ type: 'thought', id: `${answerId}:thought`, text: scrub(piece) }),
      );
      if (text) session.messages.push({ role: 'assistant', content: text });
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

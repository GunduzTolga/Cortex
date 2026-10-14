import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import type { CliAuth, CliId } from '../../shared/chat';
import { childEnv } from './acp';
import { LOCAL_IDS, onPathAny, programOf } from './clis';
import { LOCAL, type LocalId, findLocal, localModel, shortContext } from './localModels';
import { KEY_ENV, KeyRefusal, forgetKey, hasKey, keptHere, saveKey } from './keys';

/**
 * Signing in to the person's AI tools, from the chat: each one asked, with
 * its own command, whether it is signed in; each one's own sign-in opened in a
 * window of its own (a console, where its browser sign-in or its menu runs as
 * it would in a terminal); a key given where the tool takes one.
 *
 * Recorded on 14 October:
 * - Claude Code: `claude auth status --json` ({ loggedIn, authMethod, email }),
 *   `claude auth login` (the Claude subscription, in the browser). It can say
 *   loggedIn while its token has expired: the chat's "not signed in" card is
 *   then the one that says so, and signing in again mends it.
 * - Codex: `codex login status` ("Logged in using ChatGPT"), `codex login`,
 *   and `codex login --with-api-key`, which reads the key on its input and
 *   keeps it itself.
 * - OpenCode: `opencode auth list` (one line a connection, "stored"),
 *   `opencode auth login` (its menu of providers).
 * - Gemini CLI: the personal Google sign-in is refused now; a key
 *   (GEMINI_API_KEY) is the way in.
 * - Qwen Code: its own sign-in was removed; an OpenAI-compatible key, with its
 *   address.
 *
 * - LM Studio and Ollama: no sign-in; whether their server is up, and with
 *   which models, asked over HTTP on 127.0.0.1 (localModels.ts).
 *
 * Nothing here runs through a shell, and no key is written anywhere but the
 * system's own encrypted store (keys.ts) or, for Codex, Codex's.
 */

const TOOLS: Array<{ id: CliId; login: string[] | null; key: CliAuth['key'] }> = [
  { id: 'claude', login: ['auth', 'login'], key: 'cortex' },
  { id: 'codex', login: ['login'], key: 'cli' },
  { id: 'opencode', login: ['auth', 'login'], key: null },
  { id: 'gemini', login: null, key: 'cortex' },
  { id: 'qwen', login: null, key: 'cortex' },
];

const STATUS_TIMEOUT = 20_000;

let changed: () => void = () => undefined;

/** Where the window hears that a sign-in window was closed: its statuses are asked again. */
export function onAuthChanged(listener: () => void): void {
  changed = listener;
}

/** What `claude auth status --json` says. */
export function claudeStatus(text: string): { signedIn: boolean | null; detail: string | null } {
  try {
    const status = JSON.parse(text) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (typeof status.loggedIn !== 'boolean') return { signedIn: null, detail: null };
    const how = status.authMethod === 'claude.ai' ? 'Claude' : typeof status.authMethod === 'string' ? status.authMethod : null;
    const who = typeof status.email === 'string' && status.email ? status.email : null;
    return { signedIn: status.loggedIn, detail: status.loggedIn ? [how, who].filter(Boolean).join(' · ') || null : null };
  } catch {
    return { signedIn: null, detail: null };
  }
}

/** What `codex login status` says. */
export function codexStatus(text: string): { signedIn: boolean | null; detail: string | null } {
  if (/not logged in/i.test(text)) return { signedIn: false, detail: null };
  if (/logged in using chatgpt/i.test(text)) return { signedIn: true, detail: 'ChatGPT' };
  if (/logged in using an? api key/i.test(text)) return { signedIn: true, detail: 'API key' };
  if (/logged in/i.test(text)) return { signedIn: true, detail: null };
  return { signedIn: null, detail: null };
}

/** What `opencode auth list` says: the connections it keeps, by name. */
export function opencodeStatus(text: string): { signedIn: boolean | null; detail: string | null; names: string[] } {
  const names = text
    .split(/\r?\n/)
    .filter((line) => /\bstored\b/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0]?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 20);
  return { signedIn: names.length > 0, detail: names.length ? names.join(', ') : null, names };
}

/** One of the tool's own commands, its output, or null when it would not answer in time. */
function ask(id: CliId, args: string[]): Promise<string | null> {
  const program = programOf(id);
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(program.command, [...program.args, ...args], { cwd: os.homedir(), env: childEnv(program.env), timeout: STATUS_TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      resolve(err && !text ? null : text);
    });
  });
}

async function statusOf(tool: (typeof TOOLS)[number]): Promise<CliAuth> {
  const installed = programOf(tool.id) !== null;
  const base: CliAuth = {
    id: tool.id,
    installed,
    signedIn: null,
    detail: null,
    canLogin: installed && tool.login !== null && process.platform === 'win32',
    key: installed ? tool.key : null,
    baseUrl: Boolean(KEY_ENV[tool.id]?.baseUrl),
    hasKey: hasKey(tool.id),
  };
  if (!installed) return base;
  // A key kept here is what the chat starts the tool with: said first.
  if (tool.key === 'cortex' && keptHere(tool.id)) return { ...base, signedIn: true, detail: 'API key' };
  if (tool.id === 'claude') return { ...base, ...claudeStatus((await ask('claude', ['auth', 'status', '--json'])) ?? '') };
  if (tool.id === 'codex') return { ...base, ...codexStatus((await ask('codex', ['login', 'status'])) ?? '') };
  if (tool.id === 'opencode') {
    const { signedIn, detail } = opencodeStatus((await ask('opencode', ['auth', 'list'])) ?? '');
    return { ...base, signedIn, detail };
  }
  return { ...base, signedIn: base.hasKey, detail: base.hasKey ? 'API key' : null };
}

/** A model server on this machine: up with its models, or installed and off, or not here; nothing to sign in to. */
async function localStatus(id: LocalId): Promise<CliAuth> {
  const found = await findLocal(id);
  const up = found.models.length > 0;
  const model = localModel(found, null);
  return {
    id,
    installed: up || onPathAny(LOCAL[id].tools),
    signedIn: up,
    detail: null,
    canLogin: false,
    key: null,
    baseUrl: false,
    hasKey: false,
    local: { models: found.models.length, loaded: found.loaded, shortContext: model && found.loaded.includes(model) ? shortContext(found, model) : null },
  };
}

/** Every tool, and whether it is signed in. Asked in parallel: a tool started for its status takes a second or two. */
export function authStatuses(): Promise<CliAuth[]> {
  return Promise.all([...TOOLS.map(statusOf), ...LOCAL_IDS.map(localStatus)]);
}

const toolOf = (id: unknown) => {
  const tool = TOOLS.find((one) => one.id === id);
  if (!tool) throw new KeyRefusal('Not a tool Cortex signs in to.');
  return tool;
};

/**
 * The tool's own sign-in, in a console window of its own: a program started
 * detached on Windows gets one, where a browser sign-in or a menu runs as it
 * would in a terminal. When the window is closed, the window is told, and
 * asks every status again.
 */
export function startLogin(id: unknown): void {
  const tool = toolOf(id);
  const program = programOf(tool.id);
  if (!tool.login || !program) throw new KeyRefusal('This tool is not signed in to from here.');
  if (process.platform !== 'win32') throw new KeyRefusal('Signing in from Cortex opens a console window, which only Windows does here.');
  const child = spawn(program.command, [...program.args, ...tool.login], { cwd: os.homedir(), env: childEnv(program.env), detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.on('error', () => changed());
  child.on('exit', () => changed());
  child.unref();
}

/** A key for a tool: given to Codex itself, kept here for the others. */
export async function setToolKey(id: unknown, key: unknown, baseUrl: unknown): Promise<void> {
  const tool = toolOf(id);
  if (tool.key === 'cortex') {
    saveKey(tool.id, key, baseUrl);
    return;
  }
  if (tool.key !== 'cli') throw new KeyRefusal('This tool keeps its keys in its own sign-in.');
  if (typeof key !== 'string' || !key.trim() || key.length > 500 || /[\r\n]/.test(key)) throw new KeyRefusal('That is not a key.');
  const program = programOf(tool.id);
  if (!program) throw new KeyRefusal('Codex is not installed on this machine.');
  // On its input, never as an argument: an argument is seen by anything that lists processes.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program.command, [...program.args, 'login', '--with-api-key'], { cwd: os.homedir(), env: childEnv(program.env), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new KeyRefusal(stderr.trim().split('\n').pop() || 'Codex did not take the key.'))));
    child.stdin.end(`${key.trim()}\n`);
  });
}

export function forgetToolKey(id: unknown): void {
  const tool = toolOf(id);
  if (tool.key === 'cortex') forgetKey(tool.id);
}

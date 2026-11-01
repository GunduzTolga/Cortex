import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import type { CliAuth, CliId } from '../../shared/chat';
import { childEnv } from './acp';
import { LOCAL_IDS, onPathAny, powerShellExe, programOf, refreshPath } from './clis';
import { LOCAL, type LocalId, findLocal, localModel, shortContext } from './localModels';
import { KEY_ENV, KeyRefusal, forgetKey, hasKey, keptHere, keptReadable, saveKey } from './keys';
import { readSettings } from './settings';

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
 * Claude Code, where it is not installed, is installed from here on Windows by
 * Anthropic's own installer (`irm https://claude.ai/install.ps1 | iex`,
 * code.claude.com/docs/en/setup, 21 October) in a console window, and its
 * sign-in opened when that ends: nobody has to find a terminal first. A
 * sign-in going on is asked after every few seconds, so the window updates when
 * it is done, not only when its console is closed.
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
/** The e2e run (CORTEX_HIDDEN=1, electron/main.ts) signs in to stand-ins: their console is not put in front of the person at the machine. */
const SHOW_CONSOLE = process.env.CORTEX_HIDDEN !== '1';
/** While a sign-in window is open: asked this often whether it is done, for at most this long. */
const LOGIN_POLL = 4_000;
const LOGIN_WATCH = 10 * 60_000;

/**
 * The tools installed from here, each by its maker's own installer run by Windows' PowerShell, and where it puts the
 * program. Claude Code has an installer of its own; the others are npm packages (their makers' Windows instructions),
 * installed where Node.js is there and, where it is not, the console says to install Node.js first (1 November: a fresh
 * install offered only Claude Code, and OpenCode could not be had from the app).
 */
const npm = (pkg: string, bin: string) => ({
  run: `if (Get-Command npm -ErrorAction SilentlyContinue) { npm install -g ${pkg} } else { Write-Host $nodeFirst -ForegroundColor Yellow }`,
  puts: `(Join-Path $env:APPDATA 'npm\\${bin}.cmd')`,
  from: `npm: ${pkg}`,
});
const INSTALLERS: Partial<Record<CliId, { run: string; puts: string; from: string }>> = {
  claude: { run: 'irm https://claude.ai/install.ps1 | iex', puts: "(Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')", from: 'Anthropic: claude.ai/install.ps1' },
  opencode: npm('opencode-ai', 'opencode'),
  codex: npm('@openai/codex', 'codex'),
  gemini: npm('@google/gemini-cli', 'gemini'),
  qwen: npm('@qwen-code/qwen-code', 'qwen'),
};
const TOOL_NAMES: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code' } as Record<CliId, string>;

/** Told with the tool whose sign-in ended or was done; null for an install ended. */
let changed: (cli: CliId | null) => void = () => undefined;

/** Where the window hears that a sign-in window was closed: its statuses are asked again. */
export function onAuthChanged(listener: (cli: CliId | null) => void): void {
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
    canInstall: !installed && Boolean(INSTALLERS[tool.id]) && process.platform === 'win32',
    key: installed ? tool.key : null,
    baseUrl: Boolean(KEY_ENV[tool.id]?.baseUrl),
    hasKey: hasKey(tool.id),
    kept: keptHere(tool.id),
  };
  if (!installed) return base;
  // A key kept here that this computer cannot read back (kept on another one, or under another Windows account) is not
  // one the tool starts with: said as set, the window called the tool signed in and it went without it (30 October).
  const variable = KEY_ENV[tool.id]?.variable;
  const keyUsable = keptReadable(tool.id) || Boolean(variable && process.env[variable]);
  // A key kept here is what the chat starts the tool with: said first.
  if (tool.key === 'cortex' && keptHere(tool.id) && keptReadable(tool.id)) return { ...base, signedIn: true, detail: 'API key' };
  if (tool.id === 'claude') return { ...base, ...claudeStatus((await ask('claude', ['auth', 'status', '--json'])) ?? '') };
  if (tool.id === 'codex') return { ...base, ...codexStatus((await ask('codex', ['login', 'status'])) ?? '') };
  if (tool.id === 'opencode') {
    const { signedIn, detail } = opencodeStatus((await ask('opencode', ['auth', 'list'])) ?? '');
    return { ...base, signedIn, detail };
  }
  return { ...base, signedIn: keyUsable, detail: keyUsable ? 'API key' : null };
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
    canInstall: false,
    key: null,
    baseUrl: false,
    hasKey: false,
    kept: false,
    local: { models: found.models.length, loaded: found.loaded, shortContext: model && found.loaded.includes(model) ? shortContext(found, model) : null },
  };
}

/** Every tool, and whether it is signed in. Asked in parallel: a tool started for its status takes a second or two. A tool installed since the app started is found. */
export async function authStatuses(): Promise<CliAuth[]> {
  await refreshPath();
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
  const child = spawn(program.command, [...program.args, ...tool.login], { cwd: os.homedir(), env: childEnv(program.env), detached: true, stdio: 'ignore', windowsHide: !SHOW_CONSOLE, shell: false });
  let open = true;
  child.on('error', () => {
    open = false;
    changed(tool.id);
  });
  child.on('exit', () => {
    open = false;
    changed(tool.id);
  });
  child.unref();
  void watchLogin(tool, () => open);
}

/**
 * A sign-in going on, asked after until it is done: the browser's sign-in can end with its
 * console still open, or the person back in the app before closing it - and the window said
 * nothing changed until the app was opened again (21 October). Watched only from signed out.
 */
async function watchLogin(tool: (typeof TOOLS)[number], open: () => boolean): Promise<void> {
  if ((await statusOf(tool)).signedIn === true) return;
  const until = Date.now() + LOGIN_WATCH;
  while (open() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL));
    if (!open()) return;
    if ((await statusOf(tool)).signedIn === true) {
      changed(tool.id);
      return;
    }
  }
}

/**
 * What the installer's console runs: the installer as its maker gives it, and, where the
 * program is not where it puts it after, the console kept open until Enter so what went wrong
 * can be read. Single quotes only: a double quote does not survive Windows' command line.
 */
export function installScript(id: CliId, turkish: boolean): string {
  const installer = INSTALLERS[id];
  if (!installer) throw new KeyRefusal('Cortex does not install this tool.');
  const name = TOOL_NAMES[id] ?? id;
  const [going, failed, node] = turkish
    ? [`${name} kuruluyor (${installer.from})...`, `${name} kurulamadı. Yukarıda ne yazdığına bak; kapatmak için Enter`, `${name} Node.js ile kurulur. Önce nodejs.org adresinden Node.js LTS kur, sonra Cortex içinden yeniden dene.`]
    : [`Installing ${name} (${installer.from})...`, `${name} was not installed. See what is written above; press Enter to close`, `${name} is installed with Node.js. Install Node.js LTS from nodejs.org first, then try again in Cortex.`];
  return `$nodeFirst = '${node}'; Write-Host '${going}'; try { ${installer.run} } catch { Write-Host $_ -ForegroundColor Red }; if (-not (Test-Path ${installer.puts})) { Read-Host '${failed}' }`;
}

/**
 * A tool installed by its maker's own installer, in a console window of its own: Claude Code
 * by Anthropic's, the others by npm. When it ends, the PATH is read again, the window told, and the tool's
 * sign-in opened where it is not signed in yet.
 */
export function installTool(id: unknown): void {
  const tool = toolOf(id);
  if (!INSTALLERS[tool.id]) throw new KeyRefusal('Cortex does not install this tool.');
  if (process.platform !== 'win32') throw new KeyRefusal('Installing from Cortex opens a console window, which only Windows does here.');
  if (programOf(tool.id)) throw new KeyRefusal('This tool is installed already.');
  const script = installScript(tool.id, readSettings().language !== 'en');
  const child = spawn(powerShellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: os.homedir(), env: childEnv(), detached: true, stdio: 'ignore', windowsHide: !SHOW_CONSOLE, shell: false });
  let ended = false;
  const after = () => {
    if (ended) return;
    ended = true;
    void afterInstall(tool);
  };
  child.on('error', after);
  child.on('exit', after);
  child.unref();
}

async function afterInstall(tool: (typeof TOOLS)[number]): Promise<void> {
  await refreshPath(true);
  changed(null);
  if (!programOf(tool.id) || !tool.login) return;
  if ((await statusOf(tool)).signedIn === true) return;
  try {
    startLogin(tool.id);
  } catch {
    /* Its sign-in is still a button away. */
  }
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

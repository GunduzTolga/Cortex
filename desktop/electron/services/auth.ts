import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliAuth, CliId } from '../../shared/chat';
import { childEnv } from './acp';
import { LOCAL_IDS, onPathAny, powerShellExe, programOf, refreshPath } from './clis';
import { LOCAL, type LocalId, findLocal, localModel, shortContext } from './localModels';
import { KEY_ENV, KeyRefusal, forgetKey, hasKey, keptHere, keptReadable, saveKey } from './keys';
import { CHAT_TOOLS, chooseChatTool, readSettings, setChatTool } from './settings';
import { PACKAGES, PackageRefusal, archOf, installPackage, ownProgram, starts, toolsDir } from './toolPackages';

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
 * - OpenCode: its key for OpenCode Go (and Zen) kept here is the one way in,
 *   given to the OpenCode Cortex installed (clis.ts, programOf). Its own
 *   sign-ins are not read, opened or signed out of: with a key kept here what
 *   its menu saved went unused, for OpenCode Go the menu only asks for the same
 *   key, and OpenCode 2 kept its old, expired connections through "Sil"
 *   (2 November, "normal giriş çalışmadı ... onu kaldıralım").
 *
 * Taken away with the tool (2 November, "Sil"): `claude auth logout`
 * (code.claude.com/docs/en/cli-reference), `codex logout`, a key kept here.
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
  { id: 'opencode', login: null, key: 'cortex' },
  { id: 'gemini', login: null, key: 'cortex' },
  { id: 'qwen', login: null, key: 'cortex' },
];

const STATUS_TIMEOUT = 20_000;
/** The e2e run (CORTEX_HIDDEN=1, electron/main.ts) installs stand-ins: their installer's console is not put in front of the person at the machine. Read when one opens, so a test can set it. */
const showConsole = (): boolean => process.env.CORTEX_HIDDEN !== '1';
/** While a sign-in is going on: asked this often whether it is done, for at most this long. */
const LOGIN_POLL = 4_000;
const LOGIN_WATCH = 10 * 60_000;

/**
 * Claude Code, installed by Anthropic's own installer run by Windows' PowerShell in a console window, and where it
 * puts the program. OpenCode, Codex, Gemini CLI and Qwen Code are installed by Cortex itself, with no window, no npm
 * and no Node.js (toolPackages.ts).
 */
const INSTALLERS: Partial<Record<CliId, { run: string; puts: string; from: string }>> = {
  claude: { run: 'irm https://claude.ai/install.ps1 | iex', puts: "(Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')", from: 'Anthropic: claude.ai/install.ps1' },
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
    canInstall: !installed && Boolean(INSTALLERS[tool.id] || PACKAGES[tool.id]) && process.platform === 'win32',
    key: installed ? tool.key : null,
    baseUrl: Boolean(KEY_ENV[tool.id]?.baseUrl),
    hasKey: hasKey(tool.id),
    kept: keptHere(tool.id),
    chosen: offeredInChat(tool.id),
    own: ownProgram(tool.id) !== null,
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

/** Whether the chat offers the tool (settings' chatTools; every one where no list is kept). */
const offeredInChat = (id: CliId): boolean => {
  const chosen = readSettings().chatTools;
  return chosen === null || chosen.includes(id);
};

const installedTools = (): CliId[] => CHAT_TOOLS.filter((one) => programOf(one) !== null);

/**
 * "Ekle" in the AI tools window (2 November: "ekle dersin tekrardan her şeyi sıfırdan eklersin"): the tool set up for
 * the chat from the start. Installed where it is not, its sign-in opened after (installTool); otherwise added to the
 * chat, and its sign-in opened where it is not signed in. A tool that takes a key is given one in the window.
 */
export async function addTool(id: unknown): Promise<void> {
  const tool = toolOf(id);
  if (!programOf(tool.id)) {
    await installTool(tool.id);
    return;
  }
  setChatTool(tool.id, true, installedTools());
  changed(tool.id);
  if (!tool.login || process.platform !== 'win32') return;
  if ((await statusOf(tool)).signedIn === true) return;
  startLogin(tool.id);
}

/** Its own command, given its time; whatever it says. A tool that will not answer is not waited on for ever. */
function run(id: CliId, args: string[]): Promise<void> {
  return ask(id, args).then(() => undefined);
}

/**
 * "Sil" in the AI tools window (2 November: "sil dersin siler"; before, "Sohbetten çıkar" took it from the chat and
 * left it signed in, and the window then offered no sign-in again). Everything of it goes, so "Ekle" starts it from
 * scratch, its sign-in opened again: its key kept here forgotten, Claude Code and Codex signed out with their own
 * command; taken from the chat; and the program Cortex downloaded for it (toolPackages.ts) deleted. One the person
 * installed themselves, and Claude Code, which its maker's installer put on the PATH for the terminal too, stay
 * installed. The chats' programs are ended first (ipc.ts), so none of its files is held open.
 */
export async function removeTool(id: unknown): Promise<void> {
  const tool = toolOf(id);
  if (tool.key === 'cortex') forgetKey(tool.id);
  if (programOf(tool.id)) {
    if (tool.id === 'claude') await run('claude', ['auth', 'logout']);
    else if (tool.id === 'codex') await run('codex', ['logout']);
  }
  setChatTool(tool.id, false, installedTools());
  const folder = PACKAGES[tool.id] ? path.join(toolsDir(), tool.id) : null;
  try {
    // Windows lets go of a program's files a moment after it ends: tried again for a few seconds.
    if (folder && fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    throw new KeyRefusal('The tool was signed out and taken from the chat, but its files are in use. Close Cortex, open it again and remove it once more.');
  } finally {
    changed(tool.id);
  }
}

const toolOf = (id: unknown) => {
  const tool = TOOLS.find((one) => one.id === id);
  if (!tool) throw new KeyRefusal('Not a tool Cortex signs in to.');
  return tool;
};

/**
 * One argument as Windows' command line reads it back (CommandLineToArgvW): quoted where it has a space or a quote,
 * a quote escaped, the backslashes before one, or before the closing quote, doubled.
 */
export function commandLineArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * What starts a sign-in: Windows' own launcher (Start-Process), which gives the tool a console of its own with the
 * keyboard and the screen in it, as a double-click would, hidden: the tool opens the browser, where the sign-in is
 * done, and its console is not shown (2 November, "browser açılması yeterli"). It is waited on, so its end is the
 * sign-in's. 2 November: the tool was started straight from here, its input and output Windows' NUL device, not a
 * console; OpenCode 2's menu ended at once there ("Pass an integration ID or name when running without an interactive
 * terminal", after 0.1 s), and a browser sign-in went with it. The program and its arguments come in the environment,
 * so no path is written into the command to survive its quoting.
 */
export const LOGIN_SCRIPT =
  "$o = @{ FilePath = $env:CORTEX_LOGIN_PROGRAM; WindowStyle = 'Hidden'; PassThru = $true }; if ($env:CORTEX_LOGIN_ARGS) { $o.ArgumentList = $env:CORTEX_LOGIN_ARGS }; (Start-Process @o).WaitForExit()";

/** The sign-ins going on, by tool: the PowerShell waiting on each. */
const logins = new Map<CliId, ChildProcess>();

/**
 * A sign-in's hidden console ended, with the tool it started (Start-Process's program is its PowerShell's child): its
 * console is not there to be closed by the person.
 */
function endLogin(id: CliId): void {
  const child = logins.get(id);
  if (!child) return;
  logins.delete(id);
  if (child.pid !== undefined && child.exitCode === null) {
    execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  }
}

/**
 * The tool's own sign-in (LOGIN_SCRIPT): its browser opened, its console hidden. When it ends, the window is told, and
 * asks every status again. Pressed again while one is going on, the one before is ended and the browser opened again:
 * its console hidden, nothing else ends it (before, a second press within ten minutes did nothing).
 */
export function startLogin(id: unknown): void {
  const tool = toolOf(id);
  const program = programOf(tool.id);
  if (!tool.login || !program) throw new KeyRefusal('This tool is not signed in to from here.');
  if (process.platform !== 'win32') throw new KeyRefusal('Signing in from Cortex opens a console window, which only Windows does here.');
  chooseChatTool(tool.id);
  endLogin(tool.id);
  const env = { ...childEnv(program.env), CORTEX_LOGIN_PROGRAM: program.command, CORTEX_LOGIN_ARGS: [...program.args, ...tool.login].map(commandLineArg).join(' ') };
  // Not detached: a PowerShell started detached ran the script and opened nothing, with no word of why (2 November).
  const child = spawn(powerShellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LOGIN_SCRIPT], { cwd: os.homedir(), env, stdio: 'ignore', windowsHide: true, shell: false });
  logins.set(tool.id, child);
  const ended = () => {
    if (logins.get(tool.id) === child) logins.delete(tool.id);
    changed(tool.id);
  };
  child.on('error', ended);
  child.on('exit', ended);
  child.unref();
  void watchLogin(tool, () => logins.get(tool.id) === child);
}

/**
 * A sign-in going on, asked after until it is done: the browser's sign-in ends with the tool still running, and the
 * window said nothing changed until the app was opened again (21 October). Signed in, the window is told and the tool
 * given a moment to end by itself before its hidden console is ended; left unfinished for ten minutes, it is ended.
 * One begun signed in (signing in again) is told by its end.
 */
async function watchLogin(tool: (typeof TOOLS)[number], open: () => boolean): Promise<void> {
  const before = (await statusOf(tool)).signedIn === true;
  const until = Date.now() + LOGIN_WATCH;
  while (open() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL));
    if (!open()) return;
    if (!before && (await statusOf(tool)).signedIn === true) {
      changed(tool.id);
      await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL));
      if (open()) endLogin(tool.id);
      return;
    }
  }
  if (open()) endLogin(tool.id);
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
  const [going, failed] = turkish
    ? [`${name} kuruluyor (${installer.from})...`, `${name} kurulamadı. Yukarıda ne yazdığına bak; kapatmak için Enter`]
    : [`Installing ${name} (${installer.from})...`, `${name} was not installed. See what is written above; press Enter to close`];
  return `Write-Host '${going}'; try { ${installer.run} } catch { Write-Host $_ -ForegroundColor Red }; if (-not (Test-Path ${installer.puts})) { Read-Host '${failed}' }`;
}

/** The tools being installed by Cortex itself: a second click while one is downloading is not a second download. */
const installing = new Set<CliId>();

/**
 * A tool installed: Claude Code by Anthropic's own installer, in a console window of its own; the others by Cortex,
 * their makers' packages downloaded and checked here (toolPackages.ts), the promise ending when they are in place or
 * with what went wrong. Either way, at the end the window is told and the tool's sign-in opened where it has one and
 * is not signed in yet.
 */
export async function installTool(id: unknown): Promise<void> {
  const tool = toolOf(id);
  if (!INSTALLERS[tool.id] && !PACKAGES[tool.id]) throw new KeyRefusal('Cortex does not install this tool.');
  if (process.platform !== 'win32') throw new KeyRefusal('Installing from Cortex opens a console window, which only Windows does here.');
  if (programOf(tool.id)) throw new KeyRefusal('This tool is installed already.');
  chooseChatTool(tool.id);
  if (PACKAGES[tool.id]) {
    if (installing.has(tool.id)) throw new KeyRefusal('This tool is being installed already.');
    installing.add(tool.id);
    try {
      await installPackage(tool.id);
      // A program built for a newer processor ends at once on an older one: its maker's build for those instead.
      const own = ownProgram(tool.id);
      if (own && PACKAGES[tool.id]?.older?.(archOf()) && !(await starts(own))) await installPackage(tool.id, { older: true });
    } catch (err) {
      throw err instanceof PackageRefusal ? new KeyRefusal(err.message) : err;
    } finally {
      installing.delete(tool.id);
    }
    await afterInstall(tool);
    return;
  }
  const script = installScript(tool.id, readSettings().language !== 'en');
  const child = spawn(powerShellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: os.homedir(), env: childEnv(), detached: true, stdio: 'ignore', windowsHide: !showConsole(), shell: false });
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
    chooseChatTool(tool.id);
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
  chooseChatTool(tool.id);
}

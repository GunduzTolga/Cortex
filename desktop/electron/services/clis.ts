import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliId, CliInfo } from '../../shared/chat';
import { hermesConfigured, hermesName } from './hermesChat';
import { keyEnv } from './keys';
import { LOCAL, type LocalId, lastSeen } from './localModels';
import { ownProgram, toolsDir } from './toolPackages';

/**
 * The person's own AI command lines, found where they installed them, and
 * how each is started to talk to the chat: Claude Code in its own stream of
 * JSON (`claude -p --input-format stream-json`, electron/services/claudeChat.ts),
 * and the CLIs that speak the Agent Client Protocol (ACP) - JSON-RPC over
 * standard input and output - OpenCode (`opencode acp`), Gemini CLI and Qwen
 * Code (`--acp`) (acpChat.ts), and Codex through its app server
 * (`codex app-server`, codexChat.ts).
 *
 * The model servers on this machine, LM Studio and Ollama, are talked to
 * directly (localChat.ts): they are offered while they are up with a model.
 * So is a Hermes Agent on another machine, through its gateway's API server
 * (hermesChat.ts): offered once its address is given.
 *
 * Nothing is run through a shell. On Windows an npm install puts a `.cmd`
 * shim on the PATH, and Node refuses to start a `.cmd` without one; the shim
 * is read instead for what it starts - a native `.exe`, or a script for node -
 * and that is started with its arguments as an array.
 */

export type Protocol = 'claude' | 'codex' | 'acp' | 'local' | 'hermes';

interface Known {
  id: CliId;
  name: string;
  protocol: Protocol;
  /** The name it is found by on the PATH. */
  bin: string;
  /** What makes it talk to the chat. */
  args: string[];
}

/**
 * Claude Code's structured mode, as the Claude Agent SDK starts it: a session read and written
 * one JSON object a line, steps it would ask about asked of the host. The host is asked only
 * when it is named (`--permission-prompt-tool stdio`, as the SDK does when it is given a
 * `canUseTool`): without it every such step was refused unasked, and Pyn could not write to
 * Core.md (21 October).
 *
 * The vault's notes are Pyn's to write without asking: its Markdown files, at any depth of the
 * folder it starts in, for every file-editing tool (the rule below), Core.md and the inbox's cards
 * among them. Nothing else in the vault is: it holds code that runs - the engine (`beyin.py`),
 * the other CLIs' hooks and plugins (`.opencode/plugins`, `.gemini/settings.json`,
 * `.codex/hooks.json`…) - and a note with words planted in it could have had Pyn rewrite them
 * unasked, for them to run at the next start (`Edit(/**)` did, until 22 October). Those, and
 * anything outside the vault, ask. So does every command but the one receipt the vault's own Stop
 * hook asks for, in the spelling it gives on Windows (`py -3`) and elsewhere (`python3`).
 */
export const CLAUDE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool',
  'stdio',
  '--allowedTools',
  'Edit(/**/*.md)',
  'Bash(py -3 beyin.py receipt:*)',
  'Bash(python3 beyin.py receipt:*)',
];

const KNOWN: Known[] = [
  { id: 'claude', name: 'Claude Code', protocol: 'claude', bin: 'claude', args: CLAUDE_ARGS },
  { id: 'codex', name: 'Codex', protocol: 'codex', bin: 'codex', args: ['app-server'] },
  { id: 'opencode', name: 'OpenCode', protocol: 'acp', bin: 'opencode', args: ['acp'] },
  { id: 'gemini', name: 'Gemini CLI', protocol: 'acp', bin: 'gemini', args: ['--acp'] },
  { id: 'qwen', name: 'Qwen Code', protocol: 'acp', bin: 'qwen', args: ['--acp'] },
];

export const LOCAL_IDS: readonly LocalId[] = ['lmstudio', 'ollama'];
export const isLocal = (id: CliId): id is LocalId => (LOCAL_IDS as readonly CliId[]).includes(id);
/** Talked to over HTTP, not started: a model server on this machine, or Hermes on another. */
export const isServer = (id: CliId): boolean => isLocal(id) || id === 'hermes';

/** How a CLI talks to the chat. */
export const protocolOf = (id: CliId): Protocol =>
  isLocal(id) ? 'local' : id === 'hermes' ? 'hermes' : id === 'test-claude' ? 'claude' : id === 'test-codex' ? 'codex' : id === 'test' ? 'acp' : (KNOWN.find((one) => one.id === id)?.protocol ?? 'acp');

export interface Launch {
  command: string;
  args: string[];
  /** Extra variables for its environment: a script run by Electron's own node needs ELECTRON_RUN_AS_NODE. */
  env?: Record<string, string>;
}

const WINDOWS = process.platform === 'win32';
const SHIM_TARGET = /"%dp0%\\([^"%]+\.(?:exe|js|cjs|mjs))"/i;

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const value = env.PATH ?? env.Path ?? '';
  return value.split(path.delimiter).filter(Boolean);
}

const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Whether one of these programs is on the PATH, found by its name and never run (Ollama's own command starts its app). */
export function onPathAny(names: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const withExe = WINDOWS ? names.flatMap((name) => [`${name}.exe`, `${name}.cmd`]) : names;
  return onPath(withExe, env) !== null;
}

/** The first of these files on the PATH that the test lets through. */
export function onPathFile(names: string[], env: NodeJS.ProcessEnv = process.env, accept: (file: string) => boolean = () => true): string | null {
  for (const dir of pathDirs(env)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (accept(file) && isFile(file)) return file;
    }
  }
  return null;
}

/** Every one of these files on the PATH that the test lets through, in the PATH's order. */
export function onPathFiles(names: string[], env: NodeJS.ProcessEnv = process.env, accept: (file: string) => boolean = () => true): string[] {
  const found: string[] = [];
  for (const dir of pathDirs(env)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (accept(file) && isFile(file)) found.push(file);
    }
  }
  return found;
}

/**
 * The PATH with those of these folders it lacks added at its end, in their order. Windows'
 * PATH: its folders compared without case or a closing backslash.
 */
export function withDirs(current: string, dirs: string[], delimiter = path.delimiter): string {
  const kept = current.split(delimiter).filter(Boolean);
  const key = (dir: string) => dir.trim().replace(/[\\/]+$/, '').toLowerCase();
  const seen = new Set(kept.map(key));
  for (const dir of dirs) {
    const one = dir.trim();
    if (!one || seen.has(key(one))) continue;
    seen.add(key(one));
    kept.push(one);
  }
  return kept.join(delimiter);
}

/** What `refreshPath` asks PowerShell: the machine's PATH and the person's, written as UTF-8 so a folder named in Turkish letters comes back whole. */
export const READ_PATH = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Environment]::GetEnvironmentVariable('Path', 'Machine'); [Environment]::GetEnvironmentVariable('Path', 'User')";

/** The folders of what READ_PATH wrote. */
export function pathOutput(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .flatMap((line) => line.split(';'))
    .map((dir) => dir.trim())
    .filter(Boolean);
}

/** Where Windows' own PowerShell is, named in full rather than looked for on the PATH. */
export function powerShellExe(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Where the installers run from here put the programs, looked in should they have left the PATH alone: Claude Code's own
 * (claude.ai/install.ps1: `%USERPROFILE%\.local\bin`) and npm's global folder on Windows (`%APPDATA%\npm`).
 */
export const installedDirs = (): string[] => [
  path.join(os.homedir(), '.local', 'bin'),
  ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
];

let refreshing: Promise<void> | null = null;
let refreshedAt = 0;
const REFRESH_EVERY = 10_000;
/** How long whoever asks for the tools waits on the PATH being read again; `now` waits it out. */
const REFRESH_WAIT = 1_500;

/**
 * Work waited for at most this long: over when the work is, or when the time is up, whichever comes first. The work
 * goes on either way, and its failure is nobody's here.
 */
export function waitedAtMost(work: Promise<unknown>, ms: number, timedOut?: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut?.();
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * The PATH as a program started now would have it. Windows hands a program the PATH of the
 * moment it started: a tool installed while the app was open - Claude Code, whose installer
 * adds its folder to the person's PATH - stayed missing until the app was opened again
 * (21 October). The machine's and the person's PATH are read again, and the folders this
 * process lacks are added to its own, so every tool found and started after sees them; the
 * installer's folder with them. At most every ten seconds unless `now`; elsewhere a no-op.
 *
 * Read by PowerShell, which an antivirus can hold up for seconds: whoever asks without `now` - the chat's list of
 * tools, the tools' sign-ins, the setup's status - waits a moment for it and then goes on with the PATH as it is known,
 * the reading finished behind them for the next to ask. They waited it out, up to its fifteen seconds, with an empty
 * list on screen (the review before 1.0.62, K9 and S7). After an install (`now`) it is waited out, as before.
 *
 * CORTEX_NO_PATH_REFRESH=1 (tests only): the PATH a test set is kept as it is. Tests used to point SystemRoot at an
 * empty folder so PowerShell was not found, but a node started from that environment could not start on Windows, and a
 * stand-in CLI run by node answered nothing (6 November, the MCP section's tests on Windows CI).
 */
export function refreshPath(now = false): Promise<void> {
  if (!WINDOWS || process.env.CORTEX_NO_PATH_REFRESH === '1') return Promise.resolve();
  return pathReadAgain(now, readWindowsPath, ';');
}

/** The machine's and the person's PATH as PowerShell reads them; nothing where it would not answer. */
function readWindowsPath(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    execFile(powerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', READ_PATH], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? [] : pathOutput(String(stdout))),
    );
  });
}

let leftBehind = false;
let readLate: () => void = () => undefined;

/**
 * Where the window hears that a reading of the PATH ended after it was answered, with folders this process did not
 * have: a tool or Python installed outside Cortex was shown "not installed" until the window was left and come back
 * to, because whoever asked had gone on with the PATH as it was and nobody was told the reading ended (the second
 * review, R2K-2).
 */
export function onPathReadLate(listener: () => void): void {
  readLate = listener;
}

/** refreshPath's working, with the reading and its times handed in (tests run it off Windows). */
export function pathReadAgain(now: boolean, read: () => Promise<string[]>, delimiter: ':' | ';', wait = REFRESH_WAIT, every = REFRESH_EVERY): Promise<void> {
  if (!refreshing) {
    if (!now && Date.now() - refreshedAt < every) return Promise.resolve();
    const before = process.env.PATH ?? '';
    leftBehind = false;
    refreshing = read()
      .catch(() => [] as string[])
      .then((fresh) => {
        const dirs = [...fresh, ...installedDirs().filter((dir) => fs.existsSync(dir))];
        process.env.PATH = withDirs(process.env.PATH ?? '', dirs, delimiter);
        refreshedAt = Date.now();
        refreshing = null;
        if (!leftBehind || process.env.PATH === before) return;
        try {
          readLate();
        } catch {
          // The window not told is the window as it was: it asks again when it is come back to.
        }
      });
  }
  if (now) return refreshing;
  return waitedAtMost(refreshing, wait, () => {
    leftBehind = true;
  });
}

/** The first of these names in a folder of the PATH. */
function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const dir of pathDirs(env)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/**
 * What an npm `.cmd` shim starts: the quoted `"%dp0%\..."` path in it, beside
 * the shim. A native program is started as it is; a script, by the node the
 * shim would have used (one beside it, else the PATH's), else by Electron's
 * own node.
 */
export function readShim(shim: string, env: NodeJS.ProcessEnv = process.env): Launch | null {
  let text: string;
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  // The program is the last `"%dp0%\..."` in the shim: a script's shim names `"%dp0%\node.exe"` first, to see whether a node sits beside it (14 October).
  const named = [...text.matchAll(new RegExp(SHIM_TARGET.source, 'gi'))].map((one) => one[1]).filter((one) => !/(^|\\)node\.exe$/i.test(one));
  const target = named.length ? path.join(path.dirname(shim), ...named[named.length - 1].split('\\')) : null;
  if (!target || !isFile(target)) return null;
  if (/\.exe$/i.test(target)) return { command: target, args: [] };
  const besideNode = path.join(path.dirname(shim), 'node.exe');
  const node = isFile(besideNode) ? besideNode : onPath(['node.exe'], env);
  if (node) return { command: node, args: [target] };
  return { command: process.execPath, args: [target], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * The CLI itself, as it is started for any of its commands - its sign-in, its status - without what makes it talk to
 * the chat; null when it is not installed. The person's own, found on the PATH, before the one Cortex installed
 * (toolPackages.ts), kept in a folder of Cortex's and on no PATH.
 *
 * OpenCode is only ever the one Cortex installed, started with the key given in Cortex (keys.ts), whose settings' key
 * comes before a sign-in it keeps (1.x: "apiKey === undefined && key"). 2 November: OpenCode 2.0.27 on the PATH went on
 * with its own sign-in's expired key, the key given in Cortex unused ("opencode go api ile girilecek o kadar").
 */
export function programOf(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  const known = KNOWN.find((one) => one.id === id);
  if (!known) return null;
  if (id === 'opencode') return ownProgram(id, toolsDir(env));
  return onPathProgram(known, env) ?? ownProgram(id, toolsDir(env));
}

function onPathProgram(known: Known, env: NodeJS.ProcessEnv): Launch | null {
  if (WINDOWS) {
    // As Windows finds a command: the PATH's folders in their order, a program before a shim within one folder.
    // Every folder searched for the .exe first, a Claude Code left in ~/.local/bin (added at the PATH's end) won over
    // the npm one the person's PATH named first, and was the one whose sign-in was read (29 October).
    const exe = `${known.bin}.exe`;
    const first = onPath([exe, `${known.bin}.cmd`], env);
    if (!first) return null;
    if (path.basename(first).toLowerCase() === exe.toLowerCase()) return { command: first, args: [] };
    const fromShim = readShim(first, env);
    if (fromShim) return fromShim;
    // A shim that names nothing there: a program further on, as before.
    const later = onPath([exe], env);
    return later ? { command: later, args: [] } : null;
  }
  const bin = onPath([known.bin], env);
  return bin ? { command: bin, args: [] } : null;
}

export function launchOf(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  const known = KNOWN.find((one) => one.id === id);
  const program = known ? programOf(id, env) : null;
  return known && program ? { command: program.command, args: [...program.args, ...known.args], env: program.env } : null;
}

/**
 * The stand-ins for the app's tests and end-to-end run: scripts named by
 * CORTEX_TEST_AGENT (speaks ACP), CORTEX_TEST_CLAUDE (as Claude Code does) and
 * CORTEX_TEST_CODEX (as Codex's app server does), each run by Electron's own
 * node as the person's CLIs are run.
 */
type TestId = 'test' | 'test-claude' | 'test-codex';
const TESTS: Record<TestId, { variable: string; args: string[] }> = {
  test: { variable: 'CORTEX_TEST_AGENT', args: [] },
  'test-claude': { variable: 'CORTEX_TEST_CLAUDE', args: CLAUDE_ARGS },
  'test-codex': { variable: 'CORTEX_TEST_CODEX', args: ['app-server'] },
};

export function testLaunch(id: TestId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  const script = env[TESTS[id].variable];
  if (!script || !isFile(script)) return null;
  return { command: process.execPath, args: [script, ...TESTS[id].args], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Every CLI the chat knows, and whether this machine has it. */
export function listClis(env: NodeJS.ProcessEnv = process.env): CliInfo[] {
  const out: CliInfo[] = KNOWN.map((one) => ({ id: one.id, name: one.name, available: launchOf(one.id, env) !== null }));
  // A model server is offered where it is installed or found up: up with a chat model, or off, to be opened.
  for (const id of LOCAL_IDS) {
    const up = lastSeen(id).models.length > 0;
    out.push({ id, name: LOCAL[id].name, available: up || onPathAny(LOCAL[id].tools, env), local: up ? 'up' : 'off' });
  }
  if (hermesConfigured()) out.push({ id: 'hermes', name: hermesName(), available: true });
  if (testLaunch('test', env)) out.push({ id: 'test', name: 'Test agent', available: true });
  if (testLaunch('test-claude', env)) out.push({ id: 'test-claude', name: 'Test Claude', available: true });
  if (testLaunch('test-codex', env)) out.push({ id: 'test-codex', name: 'Test Codex', available: true });
  return out;
}

/** How the chat starts a CLI: with the key the person gave Cortex for it, where it takes one from its environment (electron/services/keys.ts). */
export function launchFor(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  if (id === 'test' || id === 'test-claude' || id === 'test-codex') return testLaunch(id, env);
  // A model server, or Hermes, is no program to start: it is talked to over HTTP (localChat.ts, hermesChat.ts).
  if (isServer(id)) return null;
  const launch = launchOf(id, env);
  if (!launch) return null;
  const keys = keyEnv(id);
  return Object.keys(keys).length ? { ...launch, env: { ...launch.env, ...keys } } : launch;
}

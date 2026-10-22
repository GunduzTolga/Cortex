import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliId, CliInfo } from '../../shared/chat';
import { keyEnv } from './keys';
import { LOCAL, type LocalId, lastSeen } from './localModels';

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
 *
 * Nothing is run through a shell. On Windows an npm install puts a `.cmd`
 * shim on the PATH, and Node refuses to start a `.cmd` without one; the shim
 * is read instead for what it starts - a native `.exe`, or a script for node -
 * and that is started with its arguments as an array.
 */

export type Protocol = 'claude' | 'codex' | 'acp' | 'local';

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

/** How a CLI talks to the chat. */
export const protocolOf = (id: CliId): Protocol =>
  isLocal(id) ? 'local' : id === 'test-claude' ? 'claude' : id === 'test-codex' ? 'codex' : id === 'test' ? 'acp' : (KNOWN.find((one) => one.id === id)?.protocol ?? 'acp');

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

/** Claude Code's own installer's folder (claude.ai/install.ps1: `%USERPROFILE%\.local\bin`), looked in should it have left the PATH alone. */
export const installedDirs = (): string[] => [path.join(os.homedir(), '.local', 'bin')];

let refreshing: Promise<void> | null = null;
let refreshedAt = 0;
const REFRESH_EVERY = 10_000;

/**
 * The PATH as a program started now would have it. Windows hands a program the PATH of the
 * moment it started: a tool installed while the app was open - Claude Code, whose installer
 * adds its folder to the person's PATH - stayed missing until the app was opened again
 * (21 October). The machine's and the person's PATH are read again, and the folders this
 * process lacks are added to its own, so every tool found and started after sees them; the
 * installer's folder with them. At most every ten seconds unless `now`; elsewhere a no-op.
 */
export function refreshPath(now = false): Promise<void> {
  if (!WINDOWS) return Promise.resolve();
  if (refreshing) return refreshing;
  if (!now && Date.now() - refreshedAt < REFRESH_EVERY) return Promise.resolve();
  refreshing = new Promise<void>((resolve) => {
    execFile(powerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', READ_PATH], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err, stdout) => {
      const fresh = err ? [] : pathOutput(String(stdout));
      const dirs = [...fresh, ...installedDirs().filter((dir) => fs.existsSync(dir))];
      process.env.PATH = withDirs(process.env.PATH ?? '', dirs, ';');
      refreshedAt = Date.now();
      refreshing = null;
      resolve();
    });
  });
  return refreshing;
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

/** How one CLI is started on this machine, or null when it is not installed. */
/** The CLI itself, as it is started for any of its commands - its sign-in, its status - without what makes it talk to the chat. */
export function programOf(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  const known = KNOWN.find((one) => one.id === id);
  if (!known) return null;
  if (WINDOWS) {
    const exe = onPath([`${known.bin}.exe`], env);
    if (exe) return { command: exe, args: [] };
    const shim = onPath([`${known.bin}.cmd`], env);
    return shim ? readShim(shim, env) : null;
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
  if (testLaunch('test', env)) out.push({ id: 'test', name: 'Test agent', available: true });
  if (testLaunch('test-claude', env)) out.push({ id: 'test-claude', name: 'Test Claude', available: true });
  if (testLaunch('test-codex', env)) out.push({ id: 'test-codex', name: 'Test Codex', available: true });
  return out;
}

/** How the chat starts a CLI: with the key the person gave Cortex for it, where it takes one from its environment (electron/services/keys.ts). */
export function launchFor(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  if (id === 'test' || id === 'test-claude' || id === 'test-codex') return testLaunch(id, env);
  // A model server is no program to start: it is talked to over HTTP (localChat.ts).
  if (isLocal(id)) return null;
  const launch = launchOf(id, env);
  if (!launch) return null;
  const keys = keyEnv(id);
  return Object.keys(keys).length ? { ...launch, env: { ...launch.env, ...keys } } : launch;
}

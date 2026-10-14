import fs from 'node:fs';
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
 * The model servers on this machine, LM Studio and Ollama, are run through
 * OpenCode (localModels.ts): they are offered while they are up with a model.
 *
 * Nothing is run through a shell. On Windows an npm install puts a `.cmd`
 * shim on the PATH, and Node refuses to start a `.cmd` without one; the shim
 * is read instead for what it starts - a native `.exe`, or a script for node -
 * and that is started with its arguments as an array.
 */

export type Protocol = 'claude' | 'codex' | 'acp';

interface Known {
  id: CliId;
  name: string;
  protocol: Protocol;
  /** The name it is found by on the PATH. */
  bin: string;
  /** What makes it talk to the chat. */
  args: string[];
}

/** Claude Code's structured mode, as the Claude Agent SDK starts it: a session read and written one JSON object a line, steps it would ask about asked of the host. */
export const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

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
  id === 'test-claude' ? 'claude' : id === 'test-codex' ? 'codex' : id === 'test' ? 'acp' : (KNOWN.find((one) => one.id === id)?.protocol ?? 'acp');

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
  // A model server is offered while OpenCode, which runs it, is installed and the server was last found up with a chat model.
  const runner = launchOf('opencode', env) !== null;
  for (const id of LOCAL_IDS) out.push({ id, name: LOCAL[id].name, available: runner && lastSeen(id).models.length > 0 });
  if (testLaunch('test', env)) out.push({ id: 'test', name: 'Test agent', available: true });
  if (testLaunch('test-claude', env)) out.push({ id: 'test-claude', name: 'Test Claude', available: true });
  if (testLaunch('test-codex', env)) out.push({ id: 'test-codex', name: 'Test Codex', available: true });
  return out;
}

/** How the chat starts a CLI: with the key the person gave Cortex for it, where it takes one from its environment (electron/services/keys.ts). */
export function launchFor(id: CliId, env: NodeJS.ProcessEnv = process.env): Launch | null {
  if (id === 'test' || id === 'test-claude' || id === 'test-codex') return testLaunch(id, env);
  // OpenCode, told at its start which server and models (acpChat.ts, localModels.ts).
  if (isLocal(id)) return launchOf('opencode', env);
  const launch = launchOf(id, env);
  if (!launch) return null;
  const keys = keyEnv(id);
  return Object.keys(keys).length ? { ...launch, env: { ...launch.env, ...keys } } : launch;
}

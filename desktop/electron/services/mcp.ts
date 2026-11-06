import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_NAME, MCP_SINCE, type ClaudeLink, type McpAdded, type McpBlocked, type McpLines, type McpStatus } from '../../shared/mcp';
import { childEnv } from './acp';
import { programOf, refreshPath, type Launch } from './clis';
import { type PythonLaunch, usablePython } from './localChat';
import { readSettings } from './settings';
import { compareVersions, installedVersion, isPredecessor } from './setup';

/**
 * The vault connected to the person's AI tools (shared/mcp.ts, docs/v3/MCP.md): its MCP gate is
 * `<python> <vault>/beyin.py mcp`, started by the tool itself and spoken to over its standard input and output.
 *
 * The gate is always the vault open now, run by the Python the engine runs on here (localChat.ts, usablePython): the
 * window asks for the lines and for Claude Code's `claude mcp add`, and gives neither a path nor a program. Claude Code
 * is the one found as the chat finds it (clis.ts, programOf), run with an argument list, never through a shell: a
 * vault's folder can have spaces and Turkish letters in it ("C:\Users\Şule Gündüz\Belgeler\Kasa").
 *
 * Added for every project of the person's (`--scope user`): Claude Code's own default keeps a server to the folder it
 * was added in, and the app's would be the home folder, where nobody works.
 *
 * Whether it is there is Claude Code's word (`claude mcp get cortex`): what it prints is read for this vault's
 * `beyin.py`, and what cannot be read is said as not known. `get` starts the server to see that it answers; the gate
 * only reads to answer that.
 */

/** How long Claude Code is given: `mcp get` starts the gate and waits for it, a first Python start under a virus scan takes seconds. */
let claudeTimeout = 30_000;

/** For a test: a Claude Code that does not answer is not waited on for half a minute. */
export function setClaudeTimeout(ms: number): void {
  claudeTimeout = ms;
}

/** The gate as an AI tool starts it: the Python the engine runs on, the vault's `beyin.py`, `mcp`. Windows' separator on Windows. */
export function mcpLaunch(python: PythonLaunch, vault: string, platform: NodeJS.Platform = process.platform): Launch {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return { command: python.command, args: [...python.args, paths.join(vault, 'beyin.py'), 'mcp'] };
}

/** `claude mcp add` as it is run and shown: options before the name, the gate's program after `--` (`py -3`'s `-3` is not Claude Code's). */
export function claudeAddArgs(launch: Launch): string[] {
  return ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', launch.command, ...launch.args];
}

/**
 * A word of a command line as a terminal reads it back: as it is where nothing in it is special, quoted where it is.
 * Letters of any language are plain words to a shell. Windows: PowerShell's double quotes, its own escape (`) before
 * what it would read inside them ($ and `); a Windows name holds no double quote. Elsewhere: a POSIX shell's single
 * quotes, a single quote in the word closed, escaped and opened again.
 */
export function shellWord(word: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return word && /^[\p{L}\p{N}_\-.\\/:+]+$/u.test(word) ? word : `"${word.replace(/[`$]/g, '`$&')}"`;
  return word && /^[\p{L}\p{N}_\-./:+,=@%]+$/u.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A TOML basic string: JSON's escapes are TOML's for every character a path has; DEL, which TOML wants escaped too. */
const tomlString = (text: string) => JSON.stringify(text).replace(/\u007f/g, '\\u007F');

/** What to give each tool (docs/v3/MCP.md, "Bağlama"): the line to run for Claude Code, Codex's table, OpenCode's file. */
export function mcpLines(launch: Launch, platform: NodeJS.Platform = process.platform): McpLines {
  const claude = ['claude', ...claudeAddArgs(launch).map((word) => shellWord(word, platform))].join(' ');
  const codex = [`[mcp_servers.${MCP_NAME}]`, `command = ${tomlString(launch.command)}`, `args = [${launch.args.map(tomlString).join(', ')}]`].join('\n');
  const command = [launch.command, ...launch.args].map((word) => JSON.stringify(word)).join(', ');
  const opencode = [
    '{',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "mcp": {',
    `    "${MCP_NAME}": {`,
    '      "type": "local",',
    `      "command": [${command}],`,
    '      "enabled": true',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return { claude, codex, opencode };
}

/**
 * Whether the vault's engine has the gate with its four tools: none (no `beyin.py`), or old - older than MCP_SINCE,
 * the predecessor project's 2.x/3.x, a stamp that cannot be read, or the gate's module missing - is said, not run.
 */
export function gateOf(vault: string): Exclude<McpBlocked, 'python'> | null {
  if (!fs.existsSync(path.join(vault, 'beyin.py'))) return 'engine';
  const version = installedVersion(vault);
  if (!version || isPredecessor(version) || compareVersions(version, MCP_SINCE) < 0) return 'old';
  return fs.existsSync(path.join(vault, '.claude', 'scripts', 'beyin_v3_mcp.py')) ? null : 'old';
}

/**
 * What `claude mcp get cortex` said, read: found (exit 0) and naming this vault's `beyin.py` is this vault, found
 * naming something else is another; not found by its own words ("No MCP server named", before "No MCP server found
 * with name") is none. Anything else - no answer, an error - is not known. A Windows path, without its case.
 */
export function linkOf(code: number | null, output: string, beyin: string, platform: NodeJS.Platform = process.platform): ClaudeLink {
  if (code === 0) {
    const fold = (text: string) => (platform === 'win32' ? text.toLowerCase() : text);
    return fold(output).includes(fold(beyin)) ? 'this' : 'other';
  }
  return code !== null && /no mcp server (named|found)/i.test(output) ? 'none' : 'unknown';
}

interface Ran {
  /** The exit code; null where it did not start, or was ended for taking too long. */
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** One of Claude Code's own commands, by its argument list, from the home folder (where no project's servers are). */
function runClaude(program: Launch, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      program.command,
      [...program.args, ...args],
      { cwd: os.homedir(), env: childEnv(program.env), timeout: claudeTimeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        if (!err) return resolve({ code: 0, output, timedOut: false });
        const failure = err as Error & { code?: unknown; killed?: boolean };
        const code = typeof failure.code === 'number' ? failure.code : null;
        resolve({ code, output, timedOut: code === null && failure.killed === true });
      },
    );
  });
}

/** The vault open now, if its folder is still there. */
function vaultNow(): string | null {
  const vault = readSettings().vault;
  return vault && fs.existsSync(vault) ? vault : null;
}

interface Ready {
  status: McpStatus;
  launch: Launch | null;
  claude: Launch | null;
}

/** Everything the status says, and what adding runs with: the gate's program and Claude Code's, never the window's. */
async function prepare(): Promise<Ready> {
  const vault = vaultNow();
  const none = { launch: null, claude: null };
  if (!vault) return { status: { vault: false, blocked: null, engine: null, lines: null, claude: null }, ...none };
  const engine = installedVersion(vault);
  const blocked = gateOf(vault);
  if (blocked) return { status: { vault: true, blocked, engine, lines: null, claude: null }, ...none };
  const python = await usablePython();
  if (!python) return { status: { vault: true, blocked: 'python', engine, lines: null, claude: null }, ...none };
  const launch = mcpLaunch(python, vault);
  // A Claude Code installed while the app was open is found without opening it again (Windows).
  await refreshPath();
  const claude = programOf('claude');
  const claudeNow = claude ? { link: await claudeLink(claude, launch) } : null;
  return { status: { vault: true, blocked: null, engine, lines: mcpLines(launch), claude: claudeNow }, launch, claude };
}

/** The vault's `beyin.py` in the gate's arguments, as Claude Code keeps and prints them. */
const beyinOf = (launch: Launch) => launch.args[launch.args.length - 2] ?? '';

async function claudeLink(claude: Launch, launch: Launch): Promise<ClaudeLink> {
  const ran = await runClaude(claude, ['mcp', 'get', MCP_NAME]);
  return linkOf(ran.code, ran.output, beyinOf(launch));
}

/** The settings' section: the lines for the vault open now, and what Claude Code has under `cortex`. */
export async function mcpStatus(): Promise<McpStatus> {
  return (await prepare()).status;
}

let adding: Promise<McpAdded> | null = null;

/**
 * "Claude Code'a ekle", once the person said yes in the window: `claude mcp add --scope user cortex -- …` for the vault
 * open now, run only where Claude Code does not have it already, and said added only once `claude mcp get` shows it.
 * Takes nothing from the window. Pressed twice, it runs once.
 */
export function addToClaude(): Promise<McpAdded> {
  adding ??= addNow().finally(() => {
    adding = null;
  });
  return adding;
}

async function addNow(): Promise<McpAdded> {
  const { status, launch, claude } = await prepare();
  if (!launch) return { outcome: 'blocked', status };
  if (!claude || !status.claude) return { outcome: 'missing', status };
  if (status.claude.link === 'this') return { outcome: 'already', status };
  // Another server under the name is the person's to remove: `add` would refuse it, and replacing it would lose it.
  if (status.claude.link === 'other') return { outcome: 'other', status };
  const ran = await runClaude(claude, claudeAddArgs(launch));
  if (ran.timedOut) return { outcome: 'timeout', status };
  const link = await claudeLink(claude, launch);
  const after: McpStatus = { ...status, claude: { link } };
  if (ran.code === 0) return { outcome: link === 'this' ? 'added' : 'unverified', status: after };
  // Refused because it is there: by the name, in a scope `get` did not answer for before.
  if (/already exists/i.test(ran.output) && (link === 'this' || link === 'other')) return { outcome: link === 'this' ? 'already' : 'other', status: after };
  return { outcome: 'failed', status: after };
}

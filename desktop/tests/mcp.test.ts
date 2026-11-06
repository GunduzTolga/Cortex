import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { handlers } from 'electron';
import type { McpAdded, McpStatus } from '../shared/mcp';
import { registerIpc, trustPagesWhere } from '../electron/ipc';
import { gateOf, linkOf, mcpLaunch, mcpLines, setClaudeTimeout, shellWord } from '../electron/services/mcp';
import { updateSettings } from '../electron/services/settings';

/**
 * The vault connected to the person's AI tools (electron/services/mcp.ts, Settings › "Yapay zeka araçlarına bağla"):
 * the line each tool is given, the engine that has the gate, and Claude Code's own `claude mcp add` run for the person.
 * Claude Code is a stand-in on the PATH that writes down how it was asked and keeps what it was given: the machine's
 * own, and its settings, are never reached.
 */

const PAGE = 'file:///app/dist/index.html';
trustPagesWhere((url) => url === PAGE);
registerIpc();
const mainFrame = { url: PAGE };
type Call = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const call = <T>(channel: string, ...args: unknown[]) => (handlers.get(channel) as Call)({ sender: { mainFrame }, senderFrame: mainFrame }, ...args) as Promise<T>;

const WINDOWS = process.platform === 'win32';

/** Every folder this file made, gone once its tests are done. */
const made: string[] = [];
const folder = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A vault with an engine of this version, the gate's module in it unless told otherwise; in a folder with spaces and Turkish letters. */
function vaultWith(version: string | null, gate = true): string {
  const vault = path.join(folder('cortex-mcp-'), 'Kasa Notları Şule');
  fs.mkdirSync(path.join(vault, '.claude', 'scripts'), { recursive: true });
  if (version !== null) {
    fs.writeFileSync(path.join(vault, 'beyin.py'), '');
    fs.writeFileSync(path.join(vault, '.beyin-version'), `${version}\n`);
  }
  if (gate) fs.writeFileSync(path.join(vault, '.claude', 'scripts', 'beyin_v3_mcp.py'), '');
  return vault;
}

interface Machine {
  /** Each time the stand-in was run: its arguments and the folder it was run in. */
  asked: () => Array<{ args: string[]; cwd: string }>;
  /** What it keeps under `cortex`: the program and its arguments it was given, or set here. */
  keep: (program: string[]) => void;
  home: string;
  python: string;
  restore: () => void;
}

/**
 * This machine as the test has it: a home with nothing in it (Windows' PowerShell not found there either, so no PATH is
 * read back from the machine's), the Python named by BEYIN_PYTHON - a path with a space in it, never run - and, unless
 * told otherwise, Claude Code's stand-in alone on the PATH, answering in `mode`.
 */
function machine(options: { claude?: boolean; mode?: string } = {}): Machine {
  const names = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'BEYIN_PYTHON', 'FAKE_CLAUDE_MODE'];
  const kept = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const home = fs.realpathSync(folder('cortex-mcp-home-'));
  const bin = folder('cortex-mcp-bin-');
  const log = path.join(bin, 'asked.log');
  const state = path.join(bin, 'servers.json');
  const script = path.join(bin, 'claude-standin.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const saved = fs.existsSync(${JSON.stringify(state)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8')) : null;
if (args[0] === 'mcp' && args[1] === 'get') {
  // As Claude Code 2.1 says it: the server's details and exit 0, or "No MCP server named" and exit 1.
  if (!saved && mode === 'unknown') { process.stderr.write('Something went wrong\\n'); process.exit(1); }
  if (!saved) { process.stderr.write('No MCP server named "' + args[2] + '". Run \`claude mcp add\` to add one.\\n'); process.exit(1); }
  process.stdout.write([args[2] + ':', '  Scope: User config (available in all your projects)', '  Status: \\u2714 Connected', '  Type: stdio', '  Command: ' + saved[0], '  Args: ' + saved.slice(1).join(' '), '', 'To remove this server, run: claude mcp remove "' + args[2] + '" -s user', ''].join('\\n'));
  process.exit(0);
} else if (args[0] === 'mcp' && args[1] === 'add') {
  const program = args.slice(args.indexOf('--') + 1);
  if (mode === 'fail') { process.stderr.write('error: unknown option\\n'); process.exit(1); }
  else if (mode === 'slow') setTimeout(() => process.exit(0), 60000);
  else if (mode === 'silent') { process.stdout.write('Added\\n'); process.exit(0); }
  else if (saved || mode === 'unknown') {
    if (!saved) fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(program));
    process.stderr.write('MCP server cortex already exists in user config\\n');
    process.exit(1);
  } else {
    fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(program));
    process.stdout.write('Added stdio MCP server cortex with command: ' + program.join(' ') + ' to user config\\n');
    process.exit(0);
  }
} else process.exit(2);
`,
  );
  if (options.claude !== false) {
    // As npm writes a script's shim on Windows: the app reads the script it names and runs it with node.
    if (WINDOWS) fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\nnode "%dp0%\\claude-standin.mjs" %*\r\n');
    else fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const python = WINDOWS ? 'C:\\Program Files\\Python 3\\python.exe' : '/opt/py thon/bin/python3';
  process.env.PATH = bin;
  for (const name of ['HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = home;
  process.env.BEYIN_PYTHON = python;
  if (options.mode) process.env.FAKE_CLAUDE_MODE = options.mode;
  else delete process.env.FAKE_CLAUDE_MODE;
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return {
    asked: () => read(log).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; cwd: string }),
    keep: (program) => fs.writeFileSync(state, JSON.stringify(program)),
    home,
    python,
    restore: () => {
      for (const [name, value] of Object.entries(kept)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      updateSettings((settings) => {
        settings.vault = null;
      });
      setClaudeTimeout(30_000);
    },
  };
}

const openVault = (vault: string) =>
  updateSettings((settings) => {
    settings.vault = vault;
  });
const adds = (one: Machine) => one.asked().filter((ran) => ran.args[1] === 'add');

test('each tool gets the gate as it starts it: the Python the engine runs on, the vault’s beyin.py, mcp; a folder with spaces and Turkish letters quoted where a terminal would split it', () => {
  const posix = mcpLaunch({ command: '/usr/bin/python3', args: [] }, '/home/şule/Belgeler/Kasa Notları', 'linux');
  assert.deepEqual(posix, { command: '/usr/bin/python3', args: ['/home/şule/Belgeler/Kasa Notları/beyin.py', 'mcp'] });
  assert.equal(mcpLines(posix, 'linux').claude, "claude mcp add --scope user cortex -- /usr/bin/python3 '/home/şule/Belgeler/Kasa Notları/beyin.py' mcp");
  // Turkish letters alone are a plain word to a shell: not quoted.
  assert.equal(shellWord('/home/şule/Kasa/beyin.py', 'linux'), '/home/şule/Kasa/beyin.py');

  // Windows: its separator, `py -3`, PowerShell's double quotes, its escape before a $ that would be read as a variable.
  const windows = mcpLaunch({ command: 'C:\\Windows\\py.exe', args: ['-3'] }, 'C:\\Users\\Şule Gündüz\\Belgeler\\Kasa', 'win32');
  assert.deepEqual(windows.args, ['-3', 'C:\\Users\\Şule Gündüz\\Belgeler\\Kasa\\beyin.py', 'mcp']);
  const lines = mcpLines(windows, 'win32');
  assert.equal(lines.claude, 'claude mcp add --scope user cortex -- C:\\Windows\\py.exe -3 "C:\\Users\\Şule Gündüz\\Belgeler\\Kasa\\beyin.py" mcp');
  assert.equal(shellWord('C:\\Users\\a$b\\beyin.py', 'win32'), '"C:\\Users\\a`$b\\beyin.py"');

  // Codex's TOML and OpenCode's JSON, as docs/v3/MCP.md writes them, read back to the same program and arguments.
  assert.equal(lines.codex, '[mcp_servers.cortex]\ncommand = "C:\\\\Windows\\\\py.exe"\nargs = ["-3", "C:\\\\Users\\\\Şule Gündüz\\\\Belgeler\\\\Kasa\\\\beyin.py", "mcp"]');
  const [, command, args] = lines.codex.split('\n');
  assert.equal(JSON.parse(command.replace(/^command = /, '')), windows.command);
  assert.deepEqual(JSON.parse(args.replace(/^args = /, '')), windows.args);
  const opencode = JSON.parse(lines.opencode) as { $schema: string; mcp: Record<string, unknown> };
  assert.equal(opencode.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(opencode.mcp, { cortex: { type: 'local', command: ['C:\\Windows\\py.exe', '-3', 'C:\\Users\\Şule Gündüz\\Belgeler\\Kasa\\beyin.py', 'mcp'], enabled: true } });
});

test('the line for Claude Code, read back by a real shell, is the words it was made of', { skip: WINDOWS }, () => {
  const awkward = mcpLaunch({ command: '/opt/py thon/python3', args: [] }, "/tmp/Şule'nin $HOME `x` \"Kasa\" & co", 'linux');
  const words = ['claude', 'mcp', 'add', '--scope', 'user', 'cortex', '--', awkward.command, ...awkward.args];
  const line = mcpLines(awkward, 'linux').claude;
  const read = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' });
  assert.deepEqual(read.split('\n').slice(0, -1), words);
});

test('the gate is offered only from an engine that has it: none, older than 1.0.58, the predecessor’s, a stamp not read or the module missing is not', () => {
  const vault = vaultWith(null);
  assert.equal(gateOf(vault), 'engine');
  fs.writeFileSync(path.join(vault, 'beyin.py'), '');
  assert.equal(gateOf(vault), 'old', 'an engine whose version cannot be read');
  for (const old of ['1.0.57', '1.0.9', '0.9.99', '3.4.0']) {
    fs.writeFileSync(path.join(vault, '.beyin-version'), `${old}\n`);
    assert.equal(gateOf(vault), 'old', old);
  }
  for (const fit of ['1.0.58', '1.0.59', '1.1.0']) {
    fs.writeFileSync(path.join(vault, '.beyin-version'), `${fit}\n`);
    assert.equal(gateOf(vault), null, fit);
  }
  fs.rmSync(path.join(vault, '.claude', 'scripts', 'beyin_v3_mcp.py'));
  assert.equal(gateOf(vault), 'old', 'the version says 1.0.58 but the gate is not there');
});

test('Claude Code’s word on `cortex` is read for this vault: this one, another, none, or not known', () => {
  const beyin = '/home/şule/Kasa Notları/beyin.py';
  const found = (args: string) => `cortex:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: /usr/bin/python3\n  Args: ${args}\n`;
  assert.equal(linkOf(0, found(`${beyin} mcp`), beyin, 'linux'), 'this');
  assert.equal(linkOf(0, found('/home/şule/Başka Kasa/beyin.py mcp'), beyin, 'linux'), 'other');
  assert.equal(linkOf(1, 'No MCP server named "cortex". Run `claude mcp add` to add one.', beyin, 'linux'), 'none');
  assert.equal(linkOf(1, 'No MCP server found with name: cortex', beyin, 'linux'), 'none', 'as Claude Code 1.x said it');
  assert.equal(linkOf(1, 'Error: settings could not be read', beyin, 'linux'), 'unknown');
  assert.equal(linkOf(null, '', beyin, 'linux'), 'unknown', 'no answer in time');
  // A Windows path, without its case.
  assert.equal(linkOf(0, found('-3 c:\\users\\şule\\kasa\\beyin.py mcp'), 'C:\\Users\\Şule\\Kasa\\beyin.py', 'win32'), 'this');
  assert.equal(linkOf(0, found('-3 c:\\users\\şule\\kasa\\beyin.py mcp'), 'C:\\Users\\Şule\\Kasa\\beyin.py', 'linux'), 'other');
});

test('"Claude Code’a ekle" runs Claude Code’s own add as an argument list, for the vault the app knows whatever the window sends; seen there, it is not run again', async () => {
  const one = machine();
  try {
    const vault = vaultWith('1.0.58');
    openVault(vault);
    const beyin = path.join(vault, 'beyin.py');
    const before = await call<McpStatus>('mcp:status');
    assert.equal(before.blocked, null);
    assert.deepEqual(before.claude, { link: 'none' });
    assert.ok(before.lines?.claude.includes(shellWord(beyin)), before.lines?.claude);

    // What the window sends is not read: a path, a command.
    const added = await call<McpAdded>('mcp:addToClaude', '/etc/passwd', { command: 'rm', args: ['-rf', '/'] });
    assert.equal(added.outcome, 'added');
    assert.deepEqual(added.status.claude, { link: 'this' }, 'said added only once `claude mcp get` shows it');
    const ran = adds(one);
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0].args, ['mcp', 'add', '--scope', 'user', 'cortex', '--', one.python, beyin, 'mcp']);
    assert.equal(ran[0].cwd, one.home, 'run from the home folder, where no project’s servers are');

    assert.deepEqual((await call<McpStatus>('mcp:status')).claude, { link: 'this' });
    const again = await call<McpAdded>('mcp:addToClaude');
    assert.equal(again.outcome, 'already');
    assert.equal(adds(one).length, 1, 'nothing run a second time');
  } finally {
    one.restore();
  }
});

test('pressed twice before the first is done, Claude Code’s add is run once', async () => {
  const one = machine();
  try {
    openVault(vaultWith('1.0.58'));
    const both = await Promise.all([call<McpAdded>('mcp:addToClaude'), call<McpAdded>('mcp:addToClaude')]);
    assert.deepEqual(both.map((added) => added.outcome), ['added', 'added']);
    assert.equal(adds(one).length, 1);
  } finally {
    one.restore();
  }
});

test('another server under the name is left alone; a refusal, a silence, a slow Claude Code and one there already are each said as they are', async () => {
  const vault = vaultWith('1.0.59');
  const outcome = async (mode: string | undefined, keep?: string[]) => {
    const one = machine({ mode });
    try {
      openVault(vault);
      if (keep) one.keep(keep);
      const added = await call<McpAdded>('mcp:addToClaude');
      return { added, adds: adds(one).length };
    } finally {
      one.restore();
    }
  };
  // Another vault's gate under `cortex`: the person's to remove, never replaced from here.
  const other = await outcome(undefined, ['/usr/bin/python3', '/home/başka/Kasa/beyin.py', 'mcp']);
  assert.equal(other.added.outcome, 'other');
  assert.deepEqual(other.added.status.claude, { link: 'other' });
  assert.equal(other.adds, 0);

  const failed = await outcome('fail');
  assert.equal(failed.added.outcome, 'failed');
  assert.deepEqual(failed.added.status.claude, { link: 'none' });

  const silent = await outcome('silent');
  assert.equal(silent.added.outcome, 'unverified', 'run without an error, but not seen: not said added');

  // Not known before (its `get` said something else), refused as there already, seen there after.
  const already = await outcome('unknown');
  assert.equal(already.added.outcome, 'already');
  assert.deepEqual(already.added.status.claude, { link: 'this' });

  setClaudeTimeout(3_000);
  const slow = await outcome('slow');
  assert.equal(slow.added.outcome, 'timeout');
});

test('without Claude Code only the lines are given and adding runs nothing; an engine without the gate gets neither', async () => {
  const none = machine({ claude: false });
  try {
    openVault(vaultWith('1.0.58'));
    const status = await call<McpStatus>('mcp:status');
    assert.equal(status.claude, null);
    assert.ok(status.lines?.claude.startsWith('claude mcp add --scope user cortex -- '));
    assert.equal((await call<McpAdded>('mcp:addToClaude')).outcome, 'missing');
    assert.deepEqual(none.asked(), []);
  } finally {
    none.restore();
  }
  const old = machine();
  try {
    openVault(vaultWith('1.0.57'));
    const status = await call<McpStatus>('mcp:status');
    assert.deepEqual(status, { vault: true, blocked: 'old', engine: '1.0.57', lines: null, claude: null });
    assert.equal((await call<McpAdded>('mcp:addToClaude')).outcome, 'blocked');
    openVault(vaultWith(null));
    assert.equal((await call<McpStatus>('mcp:status')).blocked, 'engine');
    assert.deepEqual(old.asked(), [], 'Claude Code not even asked');
  } finally {
    old.restore();
  }
  assert.deepEqual(await call<McpStatus>('mcp:status'), { vault: false, blocked: null, engine: null, lines: null, claude: null });
});

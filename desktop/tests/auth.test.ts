import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import type { CliId } from '../shared/chat';
import { addTool, authStatuses, claudeStatus, codexStatus, commandLineArg, installScript, installTool, LOGIN_SCRIPT, onAuthChanged, removeTool, setToolKey, startLogin } from '../electron/services/auth';
import { READ_PATH, pathOutput, powerShellExe, withDirs } from '../electron/services/clis';
import { forgetKey, hasKey, keyEnv, saveKey } from '../electron/services/keys';
import { readSettings, updateSettings } from '../electron/services/settings';
import { toolsDir } from '../electron/services/toolPackages';

/**
 * Signing in to the AI tools from the chat (electron/services/auth.ts) and
 * the keys kept for those that take one from their environment
 * (electron/services/keys.ts). The tools' answers are as they were recorded
 * on 14 October.
 */

test('each tool’s own word on its sign-in is read: Claude Code’s JSON, Codex’s sentence', () => {
  assert.deepEqual(claudeStatus('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "kisi@example.com"}'), { signedIn: true, detail: 'Claude · kisi@example.com' });
  assert.deepEqual(claudeStatus('{"loggedIn": false}'), { signedIn: false, detail: null });
  assert.deepEqual(claudeStatus('error: something'), { signedIn: null, detail: null }, 'what cannot be read is not known');
  assert.deepEqual(codexStatus('Logged in using ChatGPT'), { signedIn: true, detail: 'ChatGPT' });
  assert.deepEqual(codexStatus('Logged in using an API key - sk-***'), { signedIn: true, detail: 'API key' });
  assert.deepEqual(codexStatus('Not logged in'), { signedIn: false, detail: null });
});

/** A stand-in for a tool Cortex downloaded: a script its record names, run by Electron's node, writing down how it was asked. */
function standIn(id: 'opencode' | 'codex' | 'gemini', home: string, connections: string[]): { folder: string; asked: () => string[][]; kept: () => string[] } {
  const folder = path.join(toolsDir(), id);
  const [log, state] = [path.join(home, `${id}-asked.log`), path.join(home, `${id}-auth.json`)];
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(state, JSON.stringify(connections));
  fs.writeFileSync(
    path.join(folder, 'tool.js'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const names = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (args[0] === 'login' && args.length === 1) {
  // Its sign-in, as a browser's goes: whether it has a terminal written down, signed in a moment later, still running a
  // while after that, as a tool can be.
  fs.writeFileSync(${JSON.stringify(path.join(home, `${id}-login.json`))}, JSON.stringify({ stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) }));
  fs.appendFileSync(${JSON.stringify(path.join(home, `${id}-login-pids`))}, process.pid + '\\n');
  setTimeout(() => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(['ChatGPT'])), Number(process.env.STANDIN_SIGN_IN_AFTER || 1500));
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(path.join(home, `${id}-login-closed`))}, '');
    process.exit(0);
  }, Number(process.env.STANDIN_CLOSE_AFTER || 20000));
} else if (args[0] === 'logout' || (args[0] === 'login' && args[1] === 'status')) {
  if (args[0] === 'logout') fs.writeFileSync(${JSON.stringify(state)}, '[]');
  process.stdout.write(names.length && args[0] !== 'logout' ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
}
`,
  );
  fs.writeFileSync(path.join(folder, 'cortex-tool.json'), JSON.stringify({ program: 'tool.js' }));
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return {
    folder,
    asked: () => read(log).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    kept: () => JSON.parse(read(state) || '[]') as string[],
  };
}

test('"Sil" signs the tool out with its own command, takes it from the chat and deletes the program Cortex downloaded; "Ekle" puts it back', async () => {
  const kept = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  const before = readSettings().chatTools;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-remove-'));
  // Only the stand-ins: no tool of the machine's on the PATH.
  process.env.PATH = '';
  process.env.LOCALAPPDATA = home;
  delete process.env.GEMINI_API_KEY;
  try {
    updateSettings((settings) => {
      settings.chatTools = ['claude', 'opencode', 'codex', 'gemini'];
    });
    // OpenCode's key is its one way in: forgotten, and the program Cortex downloaded deleted; none of its own sign-ins
    // read or signed out (2 November: OpenCode 2 kept them through "Sil" anyway).
    saveKey('opencode', 'sk-opencode', undefined);
    const opencode = standIn('opencode', home, []);
    await removeTool('opencode');
    assert.equal(hasKey('opencode', {}), false, 'its key forgotten');
    assert.deepEqual(opencode.asked(), [], 'nothing of its own run');
    assert.equal(fs.existsSync(opencode.folder), false, 'the program Cortex downloaded is gone');
    assert.deepEqual(readSettings().chatTools, ['claude', 'codex', 'gemini']);

    const codex = standIn('codex', home, ['ChatGPT']);
    await removeTool('codex');
    assert.ok(codex.asked().some((args) => args.join(' ') === 'logout'), 'Codex’s own logout');
    assert.equal(fs.existsSync(codex.folder), false);

    // A tool that only takes a key: the key Cortex kept for it is forgotten.
    saveKey('gemini', 'AIza-kept', undefined);
    const gemini = standIn('gemini', home, []);
    await removeTool('gemini');
    assert.equal(hasKey('gemini', {}), false, 'its key forgotten');
    assert.equal(fs.existsSync(gemini.folder), false);
    assert.deepEqual(readSettings().chatTools, ['claude']);

    // "Ekle" for one installed (the person's own, or Cortex's): offered in the chat again. OpenCode opens no sign-in of
    // its own: its key is given in the window.
    const again = standIn('opencode', home, []);
    await addTool('opencode');
    assert.deepEqual(readSettings().chatTools, ['claude', 'opencode']);
    assert.ok(!again.asked().some((args) => args[1] === 'login'), 'no sign-in of its own opened');
    assert.throws(() => startLogin('opencode'), /not signed in to from here/);
    await assert.rejects(removeTool('nope'), /Not a tool/);
    await assert.rejects(addTool('lmstudio'), /Not a tool/);
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    updateSettings((settings) => {
      settings.chatTools = before;
    });
    forgetKey('gemini');
    forgetKey('opencode');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a sign-in’s arguments reach its program as they were, as Windows’ command line reads them back', () => {
  assert.equal(commandLineArg('auth'), 'auth');
  assert.equal(commandLineArg('C:\\Program Files\\x\\tool.js'), '"C:\\Program Files\\x\\tool.js"');
  assert.equal(commandLineArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(commandLineArg('C:\\with space\\'), '"C:\\with space\\\\"');
  assert.equal(commandLineArg(''), '""');
  if (process.platform !== 'win32') return;
  // Read back by a program as Windows hands it the line.
  const args = ['auth', 'login', 'C:\\Program Files\\x\\tool.js', 'say "hi"', 'C:\\with space\\', 'a\\\\"b', 'Çağrı Öz'];
  const read = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args.map(commandLineArg)], { encoding: 'utf8', windowsVerbatimArguments: true, argv0: commandLineArg(process.execPath) });
  assert.deepEqual(JSON.parse(read), args);
});

test('"Sil", then "Ekle": the tool from scratch, its sign-in in a console with a terminal; signed in there, the window is told while the console is open', { skip: process.platform !== 'win32' }, async () => {
  // 2 November: started with Windows' NUL device for its input and output, OpenCode 2's menu ended in 0.1 s ("Pass an
  // integration ID or name when running without an interactive terminal"), and its button was pressed 23 times. And:
  // "sil diye çıkılıyorsa her şey sıfırdan başlar ... yetkilendirme yapıldığında uygulamada kendi içinde güncellenir".
  const kept = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, CORTEX_HIDDEN: process.env.CORTEX_HIDDEN };
  const before = readSettings().chatTools;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-login-'));
  process.env.PATH = '';
  process.env.LOCALAPPDATA = home;
  // Its console hidden: not put in front of the person at the machine.
  process.env.CORTEX_HIDDEN = '1';
  const closed = path.join(home, 'codex-login-closed');
  const told: Array<{ cli: CliId | null; signedIn: boolean; consoleOpen: boolean }> = [];
  let state: { kept: () => string[] } = { kept: () => [] };
  onAuthChanged((cli) => told.push({ cli, signedIn: state.kept().length > 0, consoleOpen: !fs.existsSync(closed) }));
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done() && waited < 30_000; waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
  };
  try {
    updateSettings((settings) => {
      settings.chatTools = ['codex'];
    });
    const signedIn = standIn('codex', home, ['ChatGPT']);
    await removeTool('codex');
    assert.deepEqual(signedIn.kept(), [], 'signed out with its own command');
    assert.deepEqual(readSettings().chatTools, [], 'taken from the chat');
    // The person's own program stays where they installed it: put back, signed out.
    state = standIn('codex', home, []);
    await addTool('codex');
    assert.deepEqual(readSettings().chatTools, ['codex'], 'in the chat again');
    await until(() => told.some((one) => one.cli === 'codex' && one.signedIn));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'codex-login.json'), 'utf8')), { stdin: true, stdout: true }, 'its input and output a console, not NUL');
    const signed = told.find((one) => one.cli === 'codex' && one.signedIn);
    assert.ok(signed, 'signed in, the window told');
    assert.ok(signed.consoleOpen, 'told while it was still running, not only when it ended');
    // Removed, added, signed in, ended: by Cortex, its console hidden, long before it would have ended by itself.
    await until(() => told.filter((one) => one.cli === 'codex').length >= 4);
    assert.equal(told.filter((one) => one.cli === 'codex').length, 4);
    assert.ok(!fs.existsSync(closed), 'ended by Cortex once signed in, not left running hidden');
  } finally {
    onAuthChanged(() => undefined);
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    updateSettings((settings) => {
      settings.chatTools = before;
    });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('a sign-in’s console is hidden: the browser is where it is done', () => {
  // 2 November: Claude Code's sign-in opened the browser and a terminal beside it ("browser açılması yeterli").
  assert.match(LOGIN_SCRIPT, /WindowStyle = 'Hidden'/);
  assert.ok(!LOGIN_SCRIPT.includes('"'), 'single quotes only: a double quote does not survive Windows’ command line');
});

test('pressed again while a sign-in goes on: the one before is ended, a new one begun', { skip: process.platform !== 'win32' }, async () => {
  // Its console hidden, nothing else ends the one before; a second press used to do nothing for ten minutes.
  const kept = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, STANDIN_SIGN_IN_AFTER: process.env.STANDIN_SIGN_IN_AFTER, STANDIN_CLOSE_AFTER: process.env.STANDIN_CLOSE_AFTER };
  const before = readSettings().chatTools;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-again-'));
  process.env.PATH = '';
  process.env.LOCALAPPDATA = home;
  // Not signed in while this runs; each ends by itself a while after.
  process.env.STANDIN_SIGN_IN_AFTER = '60000';
  process.env.STANDIN_CLOSE_AFTER = '8000';
  const pids = () => (fs.existsSync(path.join(home, 'codex-login-pids')) ? fs.readFileSync(path.join(home, 'codex-login-pids'), 'utf8').split('\n').filter(Boolean).map(Number) : []);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done() && waited < 20_000; waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
  };
  try {
    standIn('codex', home, []);
    startLogin('codex');
    await until(() => pids().length === 1);
    startLogin('codex');
    await until(() => pids().length === 2 && !alive(pids()[0]));
    const [first, second] = pids();
    assert.ok(first && !alive(first), 'the one before ended');
    assert.ok(second && alive(second), 'a new one begun');
    await until(() => !alive(second));
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    updateSettings((settings) => {
      settings.chatTools = before;
    });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('a key is kept encrypted, never as written; it becomes its tool’s environment, with its address; a key that is not one is refused', () => {
  const file = path.join(app.getPath('userData'), 'keys.json');
  saveKey('gemini', 'AIza-secret-key', undefined);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('AIza-secret-key'), 'not on disk as written');
  assert.deepEqual(keyEnv('gemini'), { GEMINI_API_KEY: 'AIza-secret-key' });
  assert.equal(hasKey('gemini', {}), true);
  saveKey('qwen', 'sk-qwen', 'https://dashscope.example.com/compatible-mode/v1');
  assert.deepEqual(keyEnv('qwen'), { OPENAI_API_KEY: 'sk-qwen', OPENAI_BASE_URL: 'https://dashscope.example.com/compatible-mode/v1' });
  assert.throws(() => saveKey('qwen', 'sk', 'javascript:alert(1)'), /not an address/);
  assert.throws(() => saveKey('gemini', 'two\nlines', undefined), /not a key/);
  assert.throws(() => saveKey('gemini', '   ', undefined), /not a key/);
  assert.throws(() => saveKey('codex', 'sk', undefined), /does not take a key here/, 'Codex keeps its own');
  // OpenCode's key: in its environment, and as OpenCode Go's and Zen's settings, which come before a sign-in it keeps itself.
  saveKey('opencode', 'sk-opencode-new', undefined);
  const given = keyEnv('opencode');
  assert.equal(given.OPENCODE_API_KEY, 'sk-opencode-new');
  assert.deepEqual(JSON.parse(given.OPENCODE_CONFIG_CONTENT ?? '{}'), { provider: { 'opencode-go': { options: { apiKey: 'sk-opencode-new' } }, opencode: { options: { apiKey: 'sk-opencode-new' } } } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-opencode-new'), 'not on disk as written');
  forgetKey('opencode');
  assert.deepEqual(keyEnv('opencode'), {});
  forgetKey('gemini');
  assert.deepEqual(keyEnv('gemini'), {});
  assert.equal(hasKey('gemini', {}), false);
  assert.equal(hasKey('gemini', { GEMINI_API_KEY: 'theirs' }), true, 'a key already in the person’s environment counts');
});

test('a keys file Windows says is busy is not written over: a new key never takes the other tools’ keys with it', () => {
  const file = path.join(app.getPath('userData'), 'keys.json');
  saveKey('qwen', 'sk-qwen', undefined);
  const before = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  // A scanner holding the file just written: the read fails, as Windows fails it.
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (target === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return (read as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => saveKey('gemini', 'AIza-new', undefined), /could not be read just now/);
    assert.throws(() => forgetKey('qwen'), /could not be read just now/);
    assert.deepEqual(keyEnv('qwen'), {}, 'a reader takes it as none for now, and starts the tool without');
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = read;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file as it was');
  assert.deepEqual(keyEnv('qwen'), { OPENAI_API_KEY: 'sk-qwen' });
  forgetKey('qwen');
});

test('with no tool installed, each is said to be missing and nothing is offered; a sign-in or a key for one is refused', async () => {
  const kept = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.PATH = '';
  /*
    On Windows the PATH is read again from the machine's and the person's (clis.ts refreshPath), with
    Claude Code's installer's folder and npm's beside it: a machine with the tools installed saw them all here
    (29 October, the owner's PC). Its PowerShell not found and a home with nothing in it, nothing is added. Nor are
    the tools Cortex installed found (toolPackages.ts, under LOCALAPPDATA): 2 November, the owner's OpenCode was.
  */
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-home-'));
  process.env.USERPROFILE = emptyHome;
  process.env.HOME = emptyHome;
  process.env.SystemRoot = emptyHome;
  process.env.APPDATA = emptyHome;
  process.env.LOCALAPPDATA = emptyHome;
  // The model servers asked where nothing answers.
  process.env.CORTEX_TEST_LMSTUDIO = 'http://127.0.0.1:9';
  process.env.CORTEX_TEST_OLLAMA = 'http://127.0.0.1:9';
  try {
    const statuses = await authStatuses();
    assert.deepEqual(statuses.map((one) => one.id), ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama']);
    const [tools, servers] = [statuses.slice(0, 5), statuses.slice(5)];
    assert.ok(tools.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === null && !one.local));
    // Installed from the app in a console window, Windows only: Claude Code by Anthropic's installer, the others by npm
    // (1 November: a fresh install offered only Claude Code; OpenCode could not be had from the app).
    assert.deepEqual(tools.filter((one) => one.canInstall).map((one) => one.id), process.platform === 'win32' ? ['claude', 'codex', 'opencode', 'gemini', 'qwen'] : []);
    assert.ok(servers.every((one) => !one.canInstall));
    if (process.platform !== 'win32') await assert.rejects(installTool('claude'), /only Windows/);
    if (process.platform !== 'win32') await assert.rejects(installTool('opencode'), /only Windows/);
    await assert.rejects(installTool('nope'), /Not a tool/);
    assert.ok(servers.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === false && one.local?.models === 0), 'a model server off and not installed: nothing to sign in to');
    assert.throws(() => startLogin('claude'), /not signed in to from here/);
    assert.throws(() => startLogin('nope'), /Not a tool/);
    await assert.rejects(setToolKey('codex', 'sk-test', undefined), /not installed/);
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(emptyHome, { recursive: true, force: true });
    delete process.env.CORTEX_TEST_LMSTUDIO;
    delete process.env.CORTEX_TEST_OLLAMA;
  }
});

test('Claude Code is installed by Anthropic’s own installer, its window kept open only when the program is not where it puts it', () => {
  const script = installScript('claude', true);
  assert.ok(script.includes('irm https://claude.ai/install.ps1 | iex'), 'the command code.claude.com gives for PowerShell');
  assert.ok(script.includes("Test-Path (Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')"), 'checked where the installer puts it');
  assert.ok(script.includes("Read-Host 'Claude Code kurulamadı."), 'in the window’s language');
  assert.ok(installScript('claude', false).includes('Claude Code was not installed.'));
  // Windows' command line keeps single quotes as they are; a double quote, or a quote inside a quoted sentence, would break it.
  for (const one of [installScript('claude', true), installScript('claude', false)]) {
    assert.ok(!one.includes('"'), 'no double quote');
    for (const said of one.match(/'[^']*'/g) ?? []) assert.ok(!said.slice(1, -1).includes("'"), said);
  }
  assert.throws(() => installScript('nope' as never, true), /does not install/);
});

test('only Claude Code has a console installer: OpenCode, Codex, Gemini CLI and Qwen Code are Cortex’s to install, with no npm and no Node.js', () => {
  for (const id of ['opencode', 'codex', 'gemini', 'qwen'] as const) assert.throws(() => installScript(id, true), /does not install/);
  const source = fs.readFileSync('electron/services/auth.ts', 'utf8');
  assert.ok(!/npm install|nodejs\.org|Node\.js is needed/.test(source), 'no npm and no Node.js anywhere in the installers');
});

test('Claude Code’s console script is PowerShell without a fault (Windows)', { skip: process.platform !== 'win32' }, () => {
  for (const turkish of [true, false]) {
    const parse = '$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:CORTEX_SCRIPT, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }';
    const said = execFileSync(powerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', parse], { encoding: 'utf8', env: { ...process.env, CORTEX_SCRIPT: installScript('claude', turkish) }, windowsHide: true });
    assert.equal(said.trim(), '', turkish ? 'tr' : 'en');
  }
});

test('the PATH is read again for a tool installed while the app was open: what it lacks is added after it, once, whatever its case', () => {
  assert.equal(withDirs('C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm', ['c:\\windows\\', 'C:\\Users\\Tolga\\.local\\bin', '', 'C:\\Users\\Tolga\\.local\\bin'], ';'), 'C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm;C:\\Users\\Tolga\\.local\\bin');
  assert.equal(withDirs('', ['C:\\a'], ';'), 'C:\\a');
  // PowerShell writes the machine's PATH and the person's, one a line, as UTF-8 (a BOM dropped): a Turkish folder comes back whole.
  assert.deepEqual(pathOutput('\uFEFFC:\\Windows\\system32;C:\\Windows;\r\nC:\\Users\\Tolga Gündüz\\.local\\bin;\r\n'), ['C:\\Windows\\system32', 'C:\\Windows', 'C:\\Users\\Tolga Gündüz\\.local\\bin']);
  assert.ok(READ_PATH.includes("GetEnvironmentVariable('Path', 'User')") && READ_PATH.includes('UTF8Encoding $false'));
});

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { addTool, authStatuses, claudeStatus, codexStatus, installScript, installTool, opencodeStatus, removeTool, setToolKey, startLogin } from '../electron/services/auth';
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

test('each tool’s own word on its sign-in is read: Claude Code’s JSON, Codex’s sentence, OpenCode’s list of connections', () => {
  assert.deepEqual(claudeStatus('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "kisi@example.com"}'), { signedIn: true, detail: 'Claude · kisi@example.com' });
  assert.deepEqual(claudeStatus('{"loggedIn": false}'), { signedIn: false, detail: null });
  assert.deepEqual(claudeStatus('error: something'), { signedIn: null, detail: null }, 'what cannot be read is not known');
  assert.deepEqual(codexStatus('Logged in using ChatGPT'), { signedIn: true, detail: 'ChatGPT' });
  assert.deepEqual(codexStatus('Logged in using an API key - sk-***'), { signedIn: true, detail: 'API key' });
  assert.deepEqual(codexStatus('Not logged in'), { signedIn: false, detail: null });
  const listed = opencodeStatus('OpenCode Go       API key                     stored\nLMStudio          API key                     stored\n\n');
  assert.deepEqual(listed, { signedIn: true, detail: 'OpenCode Go, LMStudio', names: ['OpenCode Go', 'LMStudio'] });
  assert.equal(opencodeStatus('').signedIn, false);
});

test('OpenCode 1.19’s list of connections is read: its marks, colours and plain stand-ins are not names, its environment keys not connections', () => {
  // As 1.19.5 writes it (2 November): read as the old table, no connection was found at all.
  const listed = opencodeStatus(
    '┌  Credentials \x1b[2m~/.local/share/opencode/auth.json\n│\n●  OpenCode Go \x1b[2mapi\n│\n●  Anthropic \x1b[2moauth\n│\n└  2 credentials\n\n┌  Environment\n│\n●  OpenAI \x1b[2mOPENAI_API_KEY\n│\n└  1 environment variable\n',
  );
  assert.deepEqual(listed, { signedIn: true, detail: 'OpenCode Go, Anthropic', names: ['OpenCode Go', 'Anthropic'] });
  // A Windows console without Unicode marks: its menus' plain stand-ins.
  assert.deepEqual(opencodeStatus('T  Credentials ~\\.local\\share\\opencode\\auth.json\r\n|\r\n•  Together AI api\r\n|\r\n—  1 credentials\r\n').names, ['Together AI']);
  assert.deepEqual(opencodeStatus('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n'), { signedIn: false, detail: null, names: [] });
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
if (args[0] === 'auth' && args[1] === 'list') {
  process.stdout.write('┌  Credentials \\x1b[2m~/.local/share/opencode/auth.json\\n│\\n' + names.map((name) => '●  ' + name + ' \\x1b[2mapi\\n│\\n').join('') + '└  ' + names.length + ' credentials\\n');
} else if (args[0] === 'auth' && args[1] === 'logout') {
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(names.filter((name) => name.toLowerCase() !== String(args[2]).toLowerCase())));
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
    // 2 November: OpenCode said "Giriş yapıldı", the chat said it had no key for OpenCode Go, and the window offered no
    // way to sign in from scratch. Each connection is signed out by its own name, one argument however many words.
    const opencode = standIn('opencode', home, ['OpenCode Go', 'LM Studio']);
    await removeTool('opencode');
    assert.deepEqual(opencode.kept(), [], 'no connection left');
    assert.deepEqual(
      opencode.asked().filter((args) => args[1] === 'logout'),
      [
        ['auth', 'logout', 'OpenCode Go'],
        ['auth', 'logout', 'LM Studio'],
      ],
    );
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

    // "Ekle" for one installed (the person's own, or Cortex's): offered in the chat again. Its sign-in, opened in a
    // console, is Windows'; elsewhere it is added and left to its sign-in button.
    standIn('opencode', home, []);
    if (process.platform !== 'win32') {
      await addTool('opencode');
      assert.deepEqual(readSettings().chatTools, ['claude', 'opencode']);
    }
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
    fs.rmSync(home, { recursive: true, force: true });
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
  const kept = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot };
  process.env.PATH = '';
  /*
    On Windows the PATH is read again from the machine's and the person's (clis.ts refreshPath), with
    Claude Code's installer's folder beside it: a machine with the tools installed saw them all here
    (29 October, the owner's PC). Its PowerShell not found and a home with nothing in it, nothing is added.
  */
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-home-'));
  process.env.USERPROFILE = emptyHome;
  process.env.HOME = emptyHome;
  process.env.SystemRoot = emptyHome;
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

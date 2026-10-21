import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { authStatuses, claudeStatus, codexStatus, installScript, installTool, opencodeStatus, setToolKey, startLogin } from '../electron/services/auth';
import { READ_PATH, pathOutput, withDirs } from '../electron/services/clis';
import { forgetKey, hasKey, keyEnv, saveKey } from '../electron/services/keys';

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

test('with no tool installed, each is said to be missing and nothing is offered; a sign-in or a key for one is refused', async () => {
  const before = process.env.PATH;
  process.env.PATH = '';
  // The model servers asked where nothing answers.
  process.env.CORTEX_TEST_LMSTUDIO = 'http://127.0.0.1:9';
  process.env.CORTEX_TEST_OLLAMA = 'http://127.0.0.1:9';
  try {
    const statuses = await authStatuses();
    assert.deepEqual(statuses.map((one) => one.id), ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama']);
    const [tools, servers] = [statuses.slice(0, 5), statuses.slice(5)];
    assert.ok(tools.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === null && !one.local));
    // Claude Code is installed from the app by Anthropic's installer in a console window: Windows only, Claude Code only.
    assert.deepEqual(tools.filter((one) => one.canInstall).map((one) => one.id), process.platform === 'win32' ? ['claude'] : []);
    assert.ok(servers.every((one) => !one.canInstall));
    if (process.platform !== 'win32') assert.throws(() => installTool('claude'), /only Windows/);
    assert.throws(() => installTool('codex'), /does not install/);
    assert.throws(() => installTool('nope'), /Not a tool/);
    assert.ok(servers.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === false && one.local?.models === 0), 'a model server off and not installed: nothing to sign in to');
    assert.throws(() => startLogin('claude'), /not signed in to from here/);
    assert.throws(() => startLogin('nope'), /Not a tool/);
    await assert.rejects(setToolKey('codex', 'sk-test', undefined), /not installed/);
  } finally {
    process.env.PATH = before;
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
  assert.throws(() => installScript('codex', true), /does not install/);
});

test('the PATH is read again for a tool installed while the app was open: what it lacks is added after it, once, whatever its case', () => {
  assert.equal(withDirs('C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm', ['c:\\windows\\', 'C:\\Users\\Tolga\\.local\\bin', '', 'C:\\Users\\Tolga\\.local\\bin'], ';'), 'C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm;C:\\Users\\Tolga\\.local\\bin');
  assert.equal(withDirs('', ['C:\\a'], ';'), 'C:\\a');
  // PowerShell writes the machine's PATH and the person's, one a line, as UTF-8 (a BOM dropped): a Turkish folder comes back whole.
  assert.deepEqual(pathOutput('\uFEFFC:\\Windows\\system32;C:\\Windows;\r\nC:\\Users\\Tolga Gündüz\\.local\\bin;\r\n'), ['C:\\Windows\\system32', 'C:\\Windows', 'C:\\Users\\Tolga Gündüz\\.local\\bin']);
  assert.ok(READ_PATH.includes("GetEnvironmentVariable('Path', 'User')") && READ_PATH.includes('UTF8Encoding $false'));
});

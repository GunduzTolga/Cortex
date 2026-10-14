import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { authStatuses, claudeStatus, codexStatus, opencodeStatus, setToolKey, startLogin } from '../electron/services/auth';
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
    assert.ok(servers.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === false && one.local?.runner === false && one.local.models === 0), 'a model server off and not installed: nothing to sign in to');
    assert.throws(() => startLogin('claude'), /not signed in to from here/);
    assert.throws(() => startLogin('nope'), /Not a tool/);
    await assert.rejects(setToolKey('codex', 'sk-test', undefined), /not installed/);
  } finally {
    process.env.PATH = before;
    delete process.env.CORTEX_TEST_LMSTUDIO;
    delete process.env.CORTEX_TEST_OLLAMA;
  }
});

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import type { ChatEvent, ConfigOption } from '../shared/chat';
import type { Turn } from '../electron/services/chatKit';
import { fitted, localBackend, localOptions, pythonOf, splitter } from '../electron/services/localChat';

/**
 * The chat with a model on this machine's own server, talked to directly
 * (electron/services/localChat.ts): the model loaded in LM Studio or Ollama
 * answers through its OpenAI-compatible endpoint, streamed; Pyn's memory
 * comes from the vault's own hook, as the vault's OpenCode plugin asks it.
 * The server here is a stand-in that answers as LM Studio does.
 */

test('thinking is told apart from the words, a <think> tag cut between pieces too', () => {
  const words: string[] = [];
  const thoughts: string[] = [];
  const split = splitter((one) => words.push(one), (one) => thoughts.push(one));
  for (const piece of ['Önce <thi', 'nk>düşünüyorum', ' biraz</th', 'ink>Merhaba', ' dünya <', 'b>']) split.feed(piece);
  split.flush();
  assert.equal(words.join(''), 'Önce Merhaba dünya <b>');
  assert.equal(thoughts.join(''), 'düşünüyorum biraz');
});

test('the conversation is cut to what the model holds: the session’s context kept, the oldest turns dropped, the person always first', () => {
  const messages = [
    { role: 'system' as const, content: 's'.repeat(1000) },
    { role: 'user' as const, content: 'u'.repeat(3000) },
    { role: 'assistant' as const, content: 'a'.repeat(3000) },
    { role: 'user' as const, content: 'son' },
  ];
  const kept = fitted(messages, 1500);
  assert.equal(kept[0].role, 'system');
  // Not the model's answer first, with its question cut away: Gemma's and Mistral's templates in LM Studio refuse that.
  assert.deepEqual(kept.slice(1).map((one) => one.content), ['son']);
  assert.equal(fitted(messages, 100_000).length, 4, 'all of it where it fits');
  // Kept from a turn that failed, two of the person's messages in a row: made one, so the roles take turns.
  const stuck = fitted(
    [
      { role: 'system', content: 's' },
      { role: 'user', content: 'ilk' },
      { role: 'user', content: 'ikinci' },
      { role: 'assistant', content: 'cevap' },
      { role: 'user', content: 'üçüncü' },
    ],
    100_000,
  );
  assert.deepEqual(stuck.map((one) => one.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(stuck[1].content, 'ilk\n\nikinci');
});

test('the model chip: the server’s models, the loaded ones first and said so', () => {
  const [option] = localOptions({ models: ['a', 'b', 'c'], loaded: ['c'], contexts: {} }, 'c');
  assert.equal(option.current, 'c');
  assert.deepEqual(option.choices.map((one) => one.value), ['c', 'a', 'b']);
  assert.match(option.choices[0].name, /^c · /);
});

test('Python is the one the engine runs: BEYIN_PYTHON, else Windows’ py -3, never the Store’s stand-in', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-'));
  const store = path.join(root, 'WindowsApps');
  const real = path.join(root, 'Python312');
  fs.mkdirSync(store);
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(store, 'python.exe'), '');
  fs.writeFileSync(path.join(real, 'python.exe'), '');
  assert.deepEqual(pythonOf({ PATH: [store, real].join(path.delimiter) }), { command: path.join(real, 'python.exe'), args: [] });
  fs.writeFileSync(path.join(real, 'py.exe'), '');
  assert.deepEqual(pythonOf({ PATH: [store, real].join(path.delimiter) }), { command: path.join(real, 'py.exe'), args: ['-3'] });
  assert.deepEqual(pythonOf({ PATH: real, BEYIN_PYTHON: 'C:\\P\\python.exe' }), { command: 'C:\\P\\python.exe', args: [] });
  assert.equal(pythonOf({ PATH: store }), null);
  // Installed for this user by python.org's installer, the PATH not yet told: found where it puts it.
  const local = path.join(root, 'Local');
  fs.mkdirSync(path.join(local, 'Programs', 'Python', 'Python312'), { recursive: true });
  fs.writeFileSync(path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'), '');
  assert.deepEqual(pythonOf({ PATH: store, LOCALAPPDATA: local }), { command: path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'), args: [] });
  fs.mkdirSync(path.join(local, 'Programs', 'Python', 'Launcher'));
  fs.writeFileSync(path.join(local, 'Programs', 'Python', 'Launcher', 'py.exe'), '');
  assert.deepEqual(pythonOf({ PATH: store, LOCALAPPDATA: local }), { command: path.join(local, 'Programs', 'Python', 'Launcher', 'py.exe'), args: ['-3'] });
});

/** A stand-in LM Studio: its model list, and an answer streamed in pieces with its thinking and its count. */
async function standIn() {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url === '/api/v0/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'qwen3-8b', type: 'llm', state: 'loaded', loaded_context_length: 16384 }, { id: 'gemma', type: 'llm', state: 'not-loaded' }] }));
        return;
      }
      if (request.url === '/v1/chat/completions') {
        bodies.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta: object, usage?: object) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...(usage ? { usage } : {}) })}\n\n`);
        send({ reasoning_content: 'kısaca düşündüm' });
        send({ content: 'Merhaba, ' });
        send({ content: 'ben yerel modelim.' });
        send({}, { total_tokens: 321 });
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, bodies, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function fakeTurn(chatId: string, vault: string, number: number, prefs: Record<string, string> = {}) {
  const events: ChatEvent[] = [];
  let options: ConfigOption[] = [];
  let session: string | null = null;
  const stop = new AbortController();
  const turn: Turn = {
    chatId,
    cli: 'lmstudio',
    vault,
    sessionId: session,
    number,
    prefs,
    signal: stop.signal,
    emit: (event) => events.push(event),
    setOptions: (next) => (options = next),
    setSession: (id) => (session = id),
    setTitle: () => undefined,
    ask: async () => null,
  };
  return { turn, events, stop, options: () => options, session: () => session };
}

test('a message goes to the model loaded in LM Studio, streamed back; Pyn’s memory comes from the vault’s hook; the chat goes on where it was', async () => {
  const { server, bodies, base } = await standIn();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'durum-'));
  // The vault's hook, standing in for Cortex's: it answers each moment with a context naming it.
  fs.mkdirSync(path.join(vault, '.claude', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.claude', 'scripts', 'beyin_v3_hook.py'),
    'import json, sys\np = json.load(sys.stdin)\nassert "--harness" in sys.argv and sys.argv[sys.argv.index("--harness") + 1] == "opencode"\nprint(json.dumps({"hookSpecificOutput": {"hookEventName": p["hook_event_name"], "additionalContext": "BAGLAM " + p["hook_event_name"] + " " + p["prompt"]}}))\n',
  );
  fs.writeFileSync(path.join(vault, '.beyin-runtime.json'), JSON.stringify({ state }));
  const hooked = pythonOf() !== null;
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-000000000001';
  try {
    const first = fakeTurn(chatId, vault, 1);
    assert.equal(await localBackend.run(first.turn, 'merhaba'), 'end_turn');
    assert.equal(bodies[0].model, 'qwen3-8b', 'the model loaded in its app, unasked');
    assert.equal(first.events.filter((one) => one.type === 'text').map((one) => (one as { text: string }).text).join(''), 'Merhaba, ben yerel modelim.');
    assert.ok(first.events.some((one) => one.type === 'thought' && one.text === 'kısaca düşündüm'), 'its thinking folded apart');
    assert.ok(first.events.some((one) => one.type === 'usage' && one.used === 321 && one.size === 16384), 'and how full its context is');
    assert.equal(first.options()[0].current, 'qwen3-8b');
    assert.equal(first.session(), chatId, 'the conversation is the chat’s, by its id');
    const system = bodies[0].messages[0];
    assert.equal(system.role, 'system');
    if (hooked) assert.match(system.content, /BAGLAM SessionStart merhaba/, 'the session’s memory from the hook, with the first message');

    const second = fakeTurn(chatId, vault, 2);
    assert.equal(await localBackend.run(second.turn, 'nasılsın'), 'end_turn');
    const sent = bodies[1].messages;
    assert.deepEqual(sent.map((one) => one.role), ['system', 'user', 'assistant', 'user'], 'the conversation so far goes with it');
    assert.equal(sent[2].content, 'Merhaba, ben yerel modelim.', 'the answer without its thinking');
    if (hooked) assert.match(sent[3].content, /^BAGLAM UserPromptSubmit nasılsın[\s\S]*nasılsın$/, 'a later message carries its own memory');

    const kept = path.join(app.getPath('userData'), 'chats', 'local', `${chatId}.json`);
    assert.equal(JSON.parse(fs.readFileSync(kept, 'utf8')).messages.length, 5, 'kept in the app’s data, not in the vault');
    assert.ok(!fs.readdirSync(vault).some((name) => name.startsWith('chats')));

    await localBackend.setOption(chatId, second.options(), 'model', 'gemma');
    await localBackend.run(fakeTurn(chatId, vault, 3).turn, 'üçüncü');
    assert.equal(bodies[2].model, 'gemma', 'a model chosen on the chat’s chip is the chat’s');

    localBackend.forget(chatId);
    assert.equal(fs.existsSync(kept), false, 'and goes with the chat');
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

test('a server that is not running says so in the chat, as a model server off', async () => {
  process.env.CORTEX_TEST_LMSTUDIO = 'http://127.0.0.1:9';
  try {
    const { turn } = fakeTurn('00000000-0000-4000-8000-000000000002', os.tmpdir(), 1);
    await assert.rejects(localBackend.run(turn, 'merhaba'), (err: Error & { kind?: string }) => err.kind === 'local-off' && /LM Studio/.test(err.message));
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
  }
});

test('Stop ends an answer mid-way; what came so far is kept', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v0/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'm', type: 'llm', state: 'loaded' }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'yarım ' } }] })}\n\n`);
    // ...and nothing more: the answer would go on.
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  process.env.CORTEX_TEST_LMSTUDIO = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chatId = '00000000-0000-4000-8000-000000000003';
  try {
    const { turn, events } = fakeTurn(chatId, os.tmpdir(), 1);
    const ran = localBackend.run(turn, 'uzun anlat');
    for (let at = 0; at < 100 && !events.some((one) => one.type === 'text'); at += 1) await new Promise((done) => setTimeout(done, 20));
    localBackend.cancel(chatId);
    assert.equal(await ran, 'cancelled');
    const kept = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chats', 'local', `${chatId}.json`), 'utf8'));
    assert.deepEqual(kept.messages.at(-1), { role: 'assistant', content: 'yarım ' });
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.closeAllConnections();
    server.close();
  }
});

/** A stand-in LM Studio that refuses its first answer, as a server that hiccups does, and answers the rest. */
async function hiccup() {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url === '/api/v0/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'gemma', type: 'llm', state: 'loaded' }] }));
        return;
      }
      bodies.push(JSON.parse(body));
      if (bodies.length === 1) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Model is busy' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Tamam.' } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, bodies, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('a turn that failed is taken back: the next message goes as the conversation’s next, the roles taking turns', async () => {
  const { server, bodies, base } = await hiccup();
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-000000000004';
  try {
    await assert.rejects(localBackend.run(fakeTurn(chatId, os.tmpdir(), 1).turn, 'ilk soru'), /Model is busy/);
    assert.equal(await localBackend.run(fakeTurn(chatId, os.tmpdir(), 2).turn, 'ikinci soru'), 'end_turn');
    assert.deepEqual(bodies[1].messages.map((one) => [one.role, one.role === 'system' ? '' : one.content]), [['system', ''], ['user', 'ikinci soru']]);
    const kept = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chats', 'local', `${chatId}.json`), 'utf8'));
    assert.deepEqual(kept.messages.map((one: { role: string }) => one.role), ['system', 'user', 'assistant']);
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

test('Stop while the vault’s hook is asked ends the turn at once, and nothing of it is kept', { skip: pythonOf() === null }, async () => {
  const { server, bodies, base } = await standIn();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'durum-'));
  fs.mkdirSync(path.join(vault, '.claude', 'scripts'), { recursive: true });
  // A hook that takes its time, as the memory hook can on a slow laptop; it says when it has begun.
  const begun = path.join(state, 'begun');
  fs.writeFileSync(path.join(vault, '.claude', 'scripts', 'beyin_v3_hook.py'), `import time\nopen(${JSON.stringify(begun)}, "w").close()\ntime.sleep(30)\n`);
  fs.writeFileSync(path.join(vault, '.beyin-runtime.json'), JSON.stringify({ state }));
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-000000000005';
  try {
    const { turn, stop } = fakeTurn(chatId, vault, 1);
    const ran = localBackend.run(turn, 'gönderilmeyecek');
    for (let wait = 0; wait < 500 && !fs.existsSync(begun); wait += 1) await new Promise((done) => setTimeout(done, 20));
    assert.ok(fs.existsSync(begun), 'the hook under way');
    const at = Date.now();
    stop.abort();
    assert.equal(await ran, 'cancelled');
    assert.ok(Date.now() - at < 10_000, 'without waiting for the hook');
    assert.equal(bodies.length, 0, 'the model never asked');
    const kept = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'chats', 'local', `${chatId}.json`), 'utf8'));
    assert.deepEqual([kept.started, kept.messages], [false, []]);
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

test('a local chat deleted while it answers leaves no conversation behind', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v0/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'm', type: 'llm', state: 'loaded' }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'gizli ' } }] })}\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  process.env.CORTEX_TEST_LMSTUDIO = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chatId = '00000000-0000-4000-8000-000000000006';
  try {
    const { turn, events } = fakeTurn(chatId, os.tmpdir(), 1);
    const ran = localBackend.run(turn, 'gizli mesaj');
    for (let at = 0; at < 100 && !events.some((one) => one.type === 'text'); at += 1) await new Promise((done) => setTimeout(done, 20));
    localBackend.forget(chatId);
    assert.equal(await ran, 'cancelled');
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'chats', 'local', `${chatId}.json`)), false);
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.closeAllConnections();
    server.close();
  }
});

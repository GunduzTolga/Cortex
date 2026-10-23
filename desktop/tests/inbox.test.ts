import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatEvent, ConfigOption } from '../shared/chat';
import type { Turn } from '../electron/services/chatKit';
import { captureToInbox, inboxParts } from '../electron/services/inbox';
import { SAVE_TOOL, argumentsOf, localBackend, preamble, pythonOf } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';

/**
 * Something kept for later in the vault's inbox (electron/services/inbox.ts):
 * from a chat message's button, and from the local models' one tool
 * (electron/services/localChat.ts). The vault's engine is stood in for by a
 * small beyin.py that writes down what it was asked and answers as
 * `yakala ekle` does.
 */

const STAND_IN = String.raw`import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = [one for one in sys.argv[1:] if one != '--json']
with open(os.path.join(here, 'istenen.json'), 'a', encoding='utf-8') as log:
    log.write(json.dumps(args, ensure_ascii=False) + '\n')
if args[:2] != ['yakala', 'ekle']:
    sys.exit(2)
print(json.dumps({'status': 'yakalandi', 'id': '2026-10-20-1200-not', 'path': '📥 000-Inbox/Yakala/2026-10-20-1200-not.md'}, ensure_ascii=False))
`;

function vaultWithEngine(): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-gelen-'));
  fs.writeFileSync(path.join(vault, 'beyin.py'), STAND_IN);
  fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.27\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'tr';
  });
  return vault;
}

const asked = (vault: string): string[][] =>
  fs.readFileSync(path.join(vault, 'istenen.json'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
const hasPython = pythonOf() !== null;

test('a link alone is the source, a link among words is the source and the words why, words alone are the note', () => {
  assert.deepEqual(inboxParts({ text: 'https://youtu.be/iNVP35IZVNE' }), { url: 'https://youtu.be/iNVP35IZVNE', text: '', why: '' });
  assert.deepEqual(inboxParts({ text: 'https://youtu.be/iNVP35IZVNE\n\nbunu daha sonra inceleyeceğim.' }), {
    url: 'https://youtu.be/iNVP35IZVNE',
    text: '',
    why: 'bunu daha sonra inceleyeceğim.',
  });
  assert.deepEqual(inboxParts({ text: 'Şuna bak: https://example.com/yazi.' }), { url: 'https://example.com/yazi', text: '', why: 'Şuna bak: .' });
  assert.deepEqual(inboxParts({ text: '  Süt al  ' }), { url: null, text: 'Süt al', why: '' });
  assert.deepEqual(inboxParts({ url: 'file:///etc/passwd', text: 'bak' }), { url: null, text: 'file:///etc/passwd\n\nbak', why: '' }, 'only http(s) is a source');
  assert.deepEqual(inboxParts({ text: 42, url: ['x'] }), { url: null, text: '', why: '' }, 'what is not words is nothing');
});

test('nothing to keep is refused before anything runs', async () => {
  const vault = vaultWithEngine();
  await assert.rejects(captureToInbox({ text: '   ' }), /Kaydedilecek bir şey yok/);
  assert.equal(fs.existsSync(path.join(vault, 'istenen.json')), false);
});

test('a message goes to the vault’s own `yakala ekle`: the link as its one item, the words as words', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  const saved = await captureToInbox({ text: 'https://youtu.be/iNVP35IZVNE bunu daha sonra inceleyeceğim.' });
  assert.deepEqual(saved, { path: '📥 000-Inbox/Yakala/2026-10-20-1200-not.md', added: 'new' });
  await captureToInbox({ text: '--json olmayan bir not, tire ile başlayan' });
  assert.deepEqual(asked(vault), [
    ['yakala', 'ekle', 'https://youtu.be/iNVP35IZVNE', '--arac', 'pyn', '--neden=bunu daha sonra inceleyeceğim.'],
    ['yakala', 'ekle', '--arac', 'pyn', '--metin=--json olmayan bir not, tire ile başlayan'],
  ]);
});

test('the local model is told it has one tool that only saves, and not to promise to remember', () => {
  updateSettings((settings) => {
    settings.language = 'tr';
  });
  const said = preamble();
  assert.match(said, new RegExp(SAVE_TOOL));
  assert.match(said, /"kaydettim" deme/);
  assert.match(said, /Gelen kutusuna at/);
  assert.match(said, /"aklımda tutarım" deme/);
  assert.deepEqual(argumentsOf({ id: 'c', type: 'function', function: { name: SAVE_TOOL, arguments: '{"text":"a"}' } }), { text: 'a' });
  assert.deepEqual(argumentsOf({ id: 'c', type: 'function', function: { name: SAVE_TOOL, arguments: 'yarım {' } }), {});
});

/** A stand-in LM Studio that answers the first request with a tool call, in pieces, and the next with words. */
async function toolServer(refuseTools = false) {
  const bodies: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown[] }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url === '/api/v0/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'qwen3-4b', type: 'llm', state: 'loaded', loaded_context_length: 8192 }] }));
        return;
      }
      const asked = JSON.parse(body) as { messages: Array<Record<string, unknown>>; tools?: unknown[] };
      bodies.push(asked);
      if (refuseTools && asked.tools) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: object) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      if (asked.tools && !asked.messages.some((one) => one.role === 'tool')) {
        send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: SAVE_TOOL, arguments: '' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: '{"url":"https://youtu.be/iNVP35IZVNE",' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: '"why":"sonra incelenecek"}' } }] });
      } else {
        send({ content: refuseTools ? 'Aracım yok; mesajının altındaki düğmeyle kaydedebilirsin.' : 'Kaydettim, gelen kutunda.' });
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, bodies, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function fakeTurn(chatId: string, vault: string) {
  const events: ChatEvent[] = [];
  const turn: Turn = {
    chatId,
    cli: 'lmstudio',
    vault,
    sessionId: null,
    number: 1,
    prefs: {},
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    setOptions: (_next: ConfigOption[]) => undefined,
    setSession: () => undefined,
    setTitle: () => undefined,
    ask: async () => null,
  };
  return { turn, events };
}

test('“save this for later” is saved by the model’s one tool, and the answer comes after it', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  const { server, bodies, base } = await toolServer();
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-0000000000a1';
  try {
    const { turn, events } = fakeTurn(chatId, vault);
    assert.equal(await localBackend.run(turn, 'https://youtu.be/iNVP35IZVNE bunu daha sonra inceleyeceğim.'), 'end_turn');
    assert.equal(bodies.length, 2, 'asked once with the tool, once with what it did');
    assert.equal((bodies[0].tools as Array<{ function: { name: string } }>)[0].function.name, SAVE_TOOL);
    const back = bodies[1].messages.slice(-2);
    assert.equal(back[0].role, 'assistant');
    assert.equal((back[0].tool_calls as Array<{ id: string }>)[0].id, 'call_1');
    assert.deepEqual(back[1], { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ ok: true, saved_to: '📥 000-Inbox/Yakala/2026-10-20-1200-not.md', already_there: false }) });
    assert.deepEqual(asked(vault), [['yakala', 'ekle', 'https://youtu.be/iNVP35IZVNE', '--arac', 'pyn', '--neden=sonra incelenecek']]);
    const steps = events.filter((one): one is Extract<ChatEvent, { type: 'tool' }> => one.type === 'tool');
    assert.deepEqual(steps.map((one) => one.status), ['in_progress', 'completed']);
    assert.deepEqual(steps[1].paths, ['📥 000-Inbox/Yakala/2026-10-20-1200-not.md'], 'the card, to be opened from the chat');
    assert.equal(events.filter((one) => one.type === 'text').map((one) => (one as { text: string }).text).join(''), 'Kaydettim, gelen kutunda.');
  } finally {
    localBackend.forget(chatId);
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

test('a model its server says takes no tools is asked again without it, and says so', async () => {
  const vault = vaultWithEngine();
  const { server, bodies, base } = await toolServer(true);
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-0000000000a2';
  try {
    const { turn, events } = fakeTurn(chatId, vault);
    assert.equal(await localBackend.run(turn, 'bunu kaydet'), 'end_turn');
    assert.deepEqual(bodies.map((one) => Boolean(one.tools)), [true, false]);
    assert.match(events.filter((one) => one.type === 'text').map((one) => (one as { text: string }).text).join(''), /düğmeyle/);
    assert.ok(!events.some((one) => one.type === 'error'));
    await localBackend.run(fakeTurn(chatId, vault).turn, 'bir daha');
    assert.equal(bodies[2].tools, undefined, 'not offered the tool again');
  } finally {
    localBackend.forget(chatId);
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { linesOf, officeTalk, pieceOf, scenePrompt, talkModels } from '../electron/services/officeTalk';
import { updateSettings } from '../electron/services/settings';
import { talkPrefsOf } from '../shared/office';

/**
 * The office's live conversations (electron/services/officeTalk.ts): the model chosen in the
 * office's settings writes a short scene about the notes worked on last. LM Studio is stood in
 * for by a server that answers as it does.
 */

const cast = [
  { id: 'defne', name: 'Defne', role: 'Kıdemli yazar', bio: 'Dipnotsuz metin teslim etmez.' },
  { id: 'baran', name: 'Baran', role: 'Mühendis', bio: 'Çalışıyorsa dokunmaz.' },
  { id: 'pyn', name: 'Pyn', role: 'Patron', bio: 'Hmm.' },
];

test('the live conversations’ choice is read back as one of its choices, or its default', () => {
  assert.deepEqual(talkPrefsOf({ live: true, tool: 'ollama', model: 'qwen3.6:27b', every: 30 }), { live: true, tool: 'ollama', model: 'qwen3.6:27b', every: 30 });
  assert.deepEqual(talkPrefsOf({ live: 'yes', tool: 'gpt', model: '', every: 7, followClock: false }), { live: false, tool: null, model: null, every: 20 });
  assert.deepEqual(talkPrefsOf(null), { live: false, tool: null, model: null, every: 20 });
});

test('a scene is read from the JSON a model wrote, its thinking and anyone outside the cast left out', () => {
  const answer = '<think>önce düşüneyim</think>\n```json\n{"lines":[{"who":"defne","text":"«Proje planı» dipnot istiyor."},{"who":"Baran","text":"Çalışıyorsa dokunma."},{"who":"zeynep","text":"Ben kimim?"}]}\n```';
  assert.deepEqual(linesOf(answer, cast), [
    { who: 'defne', text: '«Proje planı» dipnot istiyor.' },
    { who: 'baran', text: 'Çalışıyorsa dokunma.' },
  ]);
});

test('a model that wrote a script instead of JSON is read too', () => {
  assert.deepEqual(linesOf('Defne: Tolga Bey yeni not attı.\n**Pyn**: Hmm.\nAnlatıcı: sahne biter.', cast), [
    { who: 'defne', text: 'Tolga Bey yeni not attı.' },
    { who: 'pyn', text: 'Hmm.' },
  ]);
  assert.deepEqual(linesOf('Bugün hava güzel.', cast), []);
});

test('a note goes as a short plain piece: no properties, no Markdown marks', () => {
  assert.equal(pieceOf('---\ntags: [plan]\n---\n# Plan\n\nSee [[Health]] and **bold**.\n'), 'Plan See Health and bold.');
  assert.ok(pieceOf('x'.repeat(500)).length <= 221);
});

test('the model is told the cast, the notes by title and how the person is addressed', () => {
  const { system, user } = scenePrompt(cast, [{ title: 'Proje planı', piece: 'üçüncü madde' }], 'Tolga Bey', 'tr');
  assert.ok(system.includes('"Tolga Bey"'));
  assert.ok(system.includes('JSON'));
  assert.ok(user.includes('defne · Defne (Kıdemli yazar)'));
  assert.ok(user.includes('«Proje planı» — üçüncü madde'));
  assert.ok(scenePrompt(cast, [], null, 'en').user.includes('No notes worked on yet'));
});

test('LM Studio writes the scene with the model chosen, about the vault’s last notes', async () => {
  // By the real path the disk gives, as the app keeps a chosen vault: on Windows the temporary folder
  // can come by its 8.3 short name, which the vault's reader takes for a link and does not read.
  const vault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-ofis-')));
  fs.writeFileSync(path.join(vault, 'Proje planı.md'), '# Plan\n\nÜçüncü madde havada kaldı.\n');
  fs.mkdirSync(path.join(vault, 'receipts'));
  fs.writeFileSync(path.join(vault, 'receipts', 'abc.md'), '---\n{"kind": "receipt"}\n---\nMakbuz.\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.userName = 'Tolga Bey';
  });
  const asked: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/api/v0/models') {
        response.end(JSON.stringify({ data: [{ id: 'qwen3-8b', type: 'llm', state: 'loaded' }, { id: 'gemma-3-4b', type: 'llm', state: 'not-loaded' }] }));
        return;
      }
      asked.push(JSON.parse(body));
      response.end(JSON.stringify({ choices: [{ message: { content: '{"lines":[{"who":"defne","text":"«Proje planı» dipnot ister, Tolga Bey."},{"who":"pyn","text":"Hmm."}]}' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CORTEX_TEST_LMSTUDIO = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await talkModels('lmstudio'), { models: ['qwen3-8b', 'gemma-3-4b'], loaded: ['qwen3-8b'] }, 'the loaded model first');
    const lines = await officeTalk({ tool: 'lmstudio', model: 'gemma-3-4b', cast, language: 'tr' });
    assert.deepEqual(lines, [
      { who: 'defne', text: '«Proje planı» dipnot ister, Tolga Bey.' },
      { who: 'pyn', text: 'Hmm.' },
    ]);
    assert.equal(asked[0].model, 'gemma-3-4b', 'the model chosen, not the loaded one');
    const prompt = asked[0].messages.map((one) => one.content).join('\n');
    assert.ok(prompt.includes('«Proje planı» — Plan Üçüncü madde havada kaldı.'));
    assert.ok(!prompt.includes('Makbuz'), 'what Cortex’s engine keeps does not go');
    await officeTalk({ tool: 'lmstudio', model: 'yok-boyle-bir-model', cast, language: 'tr' });
    assert.equal(asked[1].model, 'qwen3-8b', 'a model the server no longer has: the loaded one');
    await assert.rejects(officeTalk({ tool: 'codex', model: null, cast, language: 'tr' }));
    await assert.rejects(officeTalk({ tool: 'lmstudio', model: null, cast: cast.slice(0, 1), language: 'tr' }));
    assert.equal((asked[0] as { reasoning_effort?: string }).reasoning_effort, 'none', 'a short scene needs no thinking');
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

test('a thinking model that spent its budget on thought is asked once more, with room to answer', async () => {
  const vault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-dusunen-')));
  fs.writeFileSync(path.join(vault, 'Plan.md'), '# Plan\n\nHedefler.\n');
  updateSettings((settings) => {
    settings.vault = vault;
  });
  const asked: Array<{ max_tokens?: number; reasoning_effort?: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/api/v0/models') {
        response.end(JSON.stringify({ data: [{ id: 'qwen3.5-9b', type: 'vlm', state: 'loaded' }] }));
        return;
      }
      const one = JSON.parse(body) as { max_tokens?: number; reasoning_effort?: string };
      asked.push(one);
      // A server that ignores "no thinking": the first budget all thought, the larger one enough to answer.
      const content = (one.max_tokens ?? 0) > 700 ? '{"lines":[{"who":"defne","text":"Plan hazır."},{"who":"pyn","text":"Hmm."}]}' : '';
      response.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: 'Thinking Process: ...' }, finish_reason: content ? 'stop' : 'length' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CORTEX_TEST_LMSTUDIO = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const lines = await officeTalk({ tool: 'lmstudio', model: null, cast, language: 'tr' });
    assert.deepEqual(lines.map((one) => one.who), ['defne', 'pyn']);
    assert.deepEqual(asked.map((one) => [one.reasoning_effort ?? null, one.max_tokens]), [['none', 700], [null, 3000]]);
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

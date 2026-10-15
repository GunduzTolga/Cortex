import { strict as assert } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { listClis } from '../electron/services/clis';
import { chatModel, findLocal, getJson, lastSeen, lmstudioModels, localModel, ollamaModels, shortContext } from '../electron/services/localModels';

/**
 * The model servers on this machine (electron/services/localModels.ts),
 * held to the rules of Cortex's `pyn` launcher: asked over HTTP only, their
 * embedding models left out, the model loaded now run without asking. The
 * servers' answers are as LM Studio and Ollama give them.
 */

const answers = (table: Record<string, unknown>) => async (url: string) => table[url] ?? null;

test('an embedding model is not a chat model', () => {
  assert.equal(chatModel('qwen3:8b'), true);
  assert.equal(chatModel('bge-m3:latest'), false);
  assert.equal(chatModel('nomic-embed-text'), false);
  assert.equal(chatModel('all-minilm'), false);
  assert.equal(chatModel('something', 'nomic-bert'), false, 'nor is one of a BERT family');
});

test('Ollama: the models pulled, less the embeddings; the ones in memory, with the context they were loaded with', async () => {
  const base = 'http://o';
  const found = await ollamaModels(
    answers({
      [`${base}/api/tags`]: { models: [{ name: 'qwen3.6:27b', details: { family: 'qwen3' } }, { name: 'gpt-oss:20b', details: { family: 'gptoss' } }, { name: 'bge-m3:latest', details: { family: 'bert' } }] },
      [`${base}/api/ps`]: { models: [{ name: 'gpt-oss:20b', context_length: 8192 }] },
    }),
    base,
  );
  assert.deepEqual(found, { models: ['qwen3.6:27b', 'gpt-oss:20b'], loaded: ['gpt-oss:20b'], contexts: { 'gpt-oss:20b': 8192 } });
  assert.deepEqual(await ollamaModels(answers({}), base), { models: [], loaded: [], contexts: {} }, 'a server that does not answer has nothing');
});

test('LM Studio: its own list says which model is loaded and which are embeddings; an older one names its models only', async () => {
  const base = 'http://l';
  const rich = await lmstudioModels(
    answers({
      [`${base}/api/v0/models`]: {
        data: [
          { id: 'qwen2.5-14b-instruct', type: 'llm', state: 'loaded', loaded_context_length: 4096 },
          { id: 'gemma-3-12b', type: 'vlm', state: 'not-loaded' },
          { id: 'text-embedding-nomic', type: 'embeddings', state: 'loaded' },
        ],
      },
    }),
    base,
  );
  assert.deepEqual(rich, { models: ['qwen2.5-14b-instruct', 'gemma-3-12b'], loaded: ['qwen2.5-14b-instruct'], contexts: { 'qwen2.5-14b-instruct': 4096 } });
  const plain = await lmstudioModels(answers({ [`${base}/v1/models`]: { data: [{ id: 'mistral-7b' }, { id: 'text-embedding-bge-small' }] } }), base);
  assert.deepEqual(plain, { models: ['mistral-7b'], loaded: [], contexts: {} });
});

test('the model that runs: the one loaded, the last chosen among the loaded; else the last chosen; else the first', () => {
  const found = { models: ['a', 'b', 'c'], loaded: ['b', 'c'], contexts: {} };
  assert.equal(localModel(found, null), 'b');
  assert.equal(localModel(found, 'c'), 'c');
  assert.equal(localModel(found, 'a'), 'b', 'a model not loaded is not loaded for it while another is');
  assert.equal(localModel({ ...found, loaded: [] }, 'c'), 'c');
  assert.equal(localModel({ ...found, loaded: [] }, 'gone'), 'a');
  assert.equal(localModel({ models: [], loaded: [], contexts: {} }, 'a'), null);
  assert.equal(shortContext({ models: ['a'], loaded: ['a'], contexts: { a: 4096 } }, 'a'), 4096, 'loaded with less than the memory and the chat need');
  assert.equal(shortContext({ models: ['a'], loaded: ['a'], contexts: { a: 8192 } }, 'a'), null);
});

test('a server is asked over HTTP on this machine: an answer, a refusal and silence', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v0/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'm', type: 'llm', state: 'loaded' }] }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await getJson(`${base}/nothing`), null, 'a refusal is nothing');
    assert.equal(await getJson('http://127.0.0.1:9/'), null, 'and so is a port where nothing listens');
    process.env.CORTEX_TEST_LMSTUDIO = base;
    const found = await findLocal('lmstudio');
    assert.deepEqual(found.loaded, ['m']);
    assert.deepEqual(lastSeen('lmstudio'), found, 'kept for the chat list');
    assert.equal(listClis().find((one) => one.id === 'lmstudio')?.available, true, 'offered while it is up with a model');
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.close();
  }
});

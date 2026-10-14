import http from 'node:http';

/**
 * The models on this machine's own servers: LM Studio (127.0.0.1:1234) and
 * Ollama (127.0.0.1:11434), as Cortex's `pyn` launcher finds them
 * (template/.claude/scripts/beyin_v3_pyn.py) and with its rules kept:
 *
 * - Only an HTTP request to a server that is already up. No command of
 *   theirs is run: `ollama list` starts Ollama's app where its bundle does.
 * - An embedding model answers no prompt, and is left out.
 * - The model that runs is the one loaded now; else the last one chosen on
 *   this machine; else the first. The person is not asked which.
 * - OpenCode runs them. It knows only the LM Studio models in its catalog,
 *   so the models are declared for that one start, in its environment
 *   (OPENCODE_CONFIG_CONTENT): nothing is written into the synced vault,
 *   where a desktop and a laptop with different models would overwrite each
 *   other.
 */

export type LocalId = 'lmstudio' | 'ollama';

export interface LocalModels {
  /** The chat models it has, by the id it answers to. */
  models: string[];
  /** Of those, the ones loaded now. */
  loaded: string[];
  /** The context each loaded model was loaded with, where the server says. */
  contexts: Record<string, number>;
}

export const LOCAL: Record<LocalId, { name: string; base: string; tools: string[] }> = {
  lmstudio: { name: 'LM Studio', base: 'http://127.0.0.1:1234', tools: ['lms'] },
  ollama: { name: 'Ollama', base: 'http://127.0.0.1:11434', tools: ['ollama'] },
};

/** Where a server is asked: its own address, or the stand-in the tests and the end-to-end run name (CORTEX_TEST_LMSTUDIO, CORTEX_TEST_OLLAMA). */
export const baseOf = (id: LocalId): string => process.env[`CORTEX_TEST_${id.toUpperCase()}`] || LOCAL[id].base;

/** OpenCode's own system prompt and tools and Pyn's memory take well over 8K tokens; LM Studio often loads a model at 4096. */
export const MIN_CONTEXT = 32_768;

const EMBEDDING = ['embed', 'bge-', 'e5-', 'minilm', 'nomic-bert'];
const NONE: LocalModels = { models: [], loaded: [], contexts: {} };

export function chatModel(name: string, family = ''): boolean {
  const text = `${name} ${family}`.toLowerCase();
  return family !== 'bert' && family !== 'nomic-bert' && !EMBEDDING.some((mark) => text.includes(mark));
}

/** JSON from a server on this machine that is already up, or null when nothing answers in time. No proxy: the request never leaves 127.0.0.1. */
export function getJson(url: string, timeout = 400): Promise<unknown> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy();
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

type Get = (url: string) => Promise<unknown>;
const list = (value: unknown, key: string): Array<Record<string, unknown>> => {
  const items = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
  return Array.isArray(items) ? items.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : [];
};
const contextsOf = (models: Array<Record<string, unknown>>, idField: string, field: string) =>
  Object.fromEntries(models.flatMap((one) => (typeof one[field] === 'number' && (one[field] as number) > 0 ? [[String(one[idField]), one[field] as number]] : [])));

export async function ollamaModels(get: Get = getJson, base = LOCAL.ollama.base): Promise<LocalModels> {
  const tags = await get(`${base}/api/tags`);
  if (!tags || typeof tags !== 'object') return NONE;
  const models = list(tags, 'models')
    .filter((one) => typeof one.name === 'string' && chatModel(one.name, String((one.details as { family?: unknown } | undefined)?.family ?? '')))
    .map((one) => one.name as string);
  const running = list(await get(`${base}/api/ps`), 'models').filter((one) => models.includes(one.name as string));
  return { models, loaded: running.map((one) => one.name as string), contexts: contextsOf(running, 'name', 'context_length') };
}

export async function lmstudioModels(get: Get = getJson, base = LOCAL.lmstudio.base): Promise<LocalModels> {
  const rich = await get(`${base}/api/v0/models`); // says which model is loaded and which are embeddings
  if (rich && typeof rich === 'object') {
    const models = list(rich, 'data').filter((one) => typeof one.id === 'string' && (one.type === 'llm' || one.type === 'vlm'));
    const loaded = models.filter((one) => one.state === 'loaded');
    return { models: models.map((one) => one.id as string), loaded: loaded.map((one) => one.id as string), contexts: contextsOf(loaded, 'id', 'loaded_context_length') };
  }
  const plain = await get(`${base}/v1/models`); // an older server: names only, no load state
  if (!plain || typeof plain !== 'object') return NONE;
  return { models: list(plain, 'data').flatMap((one) => (typeof one.id === 'string' && chatModel(one.id) ? [one.id] : [])), loaded: [], contexts: {} };
}

const FINDERS: Record<LocalId, (get: Get, base: string) => Promise<LocalModels>> = { lmstudio: lmstudioModels, ollama: ollamaModels };

/** What each server had when last asked: the chat list and a chat's start read it without waiting. */
const seen = new Map<LocalId, LocalModels>();

export async function findLocal(id: LocalId, get: Get = getJson): Promise<LocalModels> {
  const found = await FINDERS[id](get, baseOf(id));
  seen.set(id, found);
  return found;
}

export const lastSeen = (id: LocalId): LocalModels => seen.get(id) ?? NONE;

/** The model a chat starts on: the one loaded now, the person's last choice among the loaded; else that choice; else the first. */
export function localModel(found: LocalModels, remembered: string | null): string | null {
  if (found.loaded.length) return remembered && found.loaded.includes(remembered) ? remembered : found.loaded[0];
  if (remembered && found.models.includes(remembered)) return remembered;
  return found.models[0] ?? null;
}

/** A model loaded with too little context for OpenCode and Pyn's memory: its loaded context, else null. */
export function shortContext(found: LocalModels, model: string): number | null {
  const tokens = found.contexts[model];
  return tokens && tokens < MIN_CONTEXT ? tokens : null;
}

function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const had = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && had && typeof had === 'object' && !Array.isArray(had) ? merge(had as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}

/**
 * OpenCode's configuration for one start on a local server: its provider,
 * every chat model it has (each loaded one with the context it was loaded
 * with, so OpenCode compacts before it overflows), and the model it starts on.
 * A value the person set themselves is kept and added to, never replaced.
 */
export function opencodeConfig(id: LocalId, found: LocalModels, model: string, own: string | undefined): string {
  const models = Object.fromEntries(
    found.models.map((one) => {
      const tokens = found.contexts[one];
      return [one, { name: `${one} (${LOCAL[id].name})`, ...(tokens ? { limit: { context: tokens, output: Math.min(Math.floor(tokens / 4), 16_384) } } : {}) }];
    }),
  );
  // LM Studio's provider is built into OpenCode; Ollama is any OpenAI-compatible server to it.
  const provider = id === 'lmstudio' ? { models } : { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: `${baseOf('ollama')}/v1` }, models };
  let mine: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(own || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) mine = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: left out */
  }
  return JSON.stringify(merge(mine, { provider: { [id]: provider }, model: `${id}/${model}` }));
}

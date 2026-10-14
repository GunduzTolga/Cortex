import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { CliId } from '../../shared/chat';

/**
 * The API keys the person gives Cortex for a CLI that takes its key from the
 * environment: Claude Code (ANTHROPIC_API_KEY, instead of its subscription),
 * Gemini CLI (GEMINI_API_KEY) and Qwen Code (OPENAI_API_KEY, with the
 * OpenAI-compatible address it is for). Codex keeps its own key (`codex
 * login --with-api-key`, electron/services/auth.ts) and OpenCode its own
 * connections; neither is kept here.
 *
 * A key is encrypted with the operating system's own store (safeStorage:
 * DPAPI on Windows) into the app's data folder, never into the vault; where
 * that store is not there, no key is kept. It is decrypted only to start its
 * CLI, as that CLI's environment. The window can set a key and forget one,
 * and learns only whether one is kept: it never reads one back.
 */

interface Kept {
  /** The key, encrypted, as base64. */
  key: string;
  baseUrl?: string;
}

/** Where each CLI takes its key from, and its address when it needs one. */
export const KEY_ENV: Partial<Record<CliId, { variable: string; baseUrl?: string }>> = {
  claude: { variable: 'ANTHROPIC_API_KEY' },
  gemini: { variable: 'GEMINI_API_KEY' },
  qwen: { variable: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
};

const file = () => path.join(app.getPath('userData'), 'keys.json');

function readKept(): Partial<Record<CliId, Kept>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<Record<CliId, Kept>>) : {};
  } catch {
    return {};
  }
}

function writeKept(kept: Partial<Record<CliId, Kept>>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const temp = `${file()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(kept), { mode: 0o600 });
  fs.renameSync(temp, file());
}

export class KeyRefusal extends Error {}

/** Whether a key is there for the CLI: one kept here, or one already in the person's own environment. */
export function hasKey(id: CliId, env: NodeJS.ProcessEnv = process.env): boolean {
  const where = KEY_ENV[id];
  if (!where) return false;
  return Boolean(readKept()[id]?.key) || Boolean(env[where.variable]);
}

/** Whether the key the CLI would use is one kept here (not one of the person's own environment). */
export const keptHere = (id: CliId): boolean => Boolean(readKept()[id]?.key);

export function saveKey(id: CliId, key: unknown, baseUrl: unknown): void {
  const where = KEY_ENV[id];
  if (!where) throw new KeyRefusal('This tool does not take a key here.');
  if (typeof key !== 'string' || !key.trim() || key.length > 500 || /[\r\n]/.test(key)) throw new KeyRefusal('That is not a key.');
  if (where.baseUrl && baseUrl !== undefined && baseUrl !== null && baseUrl !== '' && (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]{3,300}$/.test(baseUrl))) throw new KeyRefusal('That is not an address.');
  if (!safeStorage.isEncryptionAvailable()) throw new KeyRefusal('This computer offers no safe place to keep a key.');
  const kept = readKept();
  kept[id] = { key: safeStorage.encryptString(key.trim()).toString('base64'), ...(where.baseUrl && typeof baseUrl === 'string' && baseUrl ? { baseUrl } : {}) };
  writeKept(kept);
}

export function forgetKey(id: CliId): void {
  const kept = readKept();
  if (!kept[id]) return;
  delete kept[id];
  writeKept(kept);
}

/** The environment a CLI is started with for its key: nothing when none is kept here, or when it cannot be read back. */
export function keyEnv(id: CliId): Record<string, string> {
  const where = KEY_ENV[id];
  const kept = readKept()[id];
  if (!where || !kept?.key) return {};
  try {
    const key = safeStorage.decryptString(Buffer.from(kept.key, 'base64'));
    return { [where.variable]: key, ...(where.baseUrl && kept.baseUrl ? { [where.baseUrl]: kept.baseUrl } : {}) };
  } catch {
    return {};
  }
}

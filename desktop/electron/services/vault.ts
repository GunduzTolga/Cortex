import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { VaultStatus } from '../../shared/api';
import { readSettings, updateSettings } from './settings';

/**
 * Which folder is the vault. Chosen by the person through the system's folder
 * dialog in the main process (electron/ipc.ts, `vault:choose`) and kept by its
 * real path in the app's own settings file; the window is never handed the
 * path and never names one - it learns the folder's name, and inside it only
 * paths relative to it (electron/services/vaultNotes.ts).
 *
 * Krewgent's `setCortexVault` (electron/services/cortex.ts) with its refusals:
 * what is not a folder, a folder reached through a link, and the app's own
 * data folder or one around it. Its three coding folders are Krewgent's and
 * are not here.
 */

const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const key = (value: string) => {
  const resolved = path.resolve(value);
  return CASELESS ? resolved.toLowerCase() : resolved;
};
const same = (a: string, b: string) => key(a) === key(b);

/** Whether `inner` is `outer` or lies under it. */
function isWithin(inner: string, outer: string): boolean {
  const a = key(inner);
  const b = key(outer);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
}

/**
 * The app's own data folder, when `dir` is it, lies inside it, or holds it.
 *
 * The app keeps its settings there; as a vault it would have the notes screen
 * listing and writing the app's own files. Holding it is the same thing from
 * above - a home folder, a drive root - so both directions are refused, as
 * Krewgent refuses them (`ownDataTouchedBy`, electron/services/ownData.ts).
 */
export function ownDataTouchedBy(dir: string): string | null {
  const data = path.resolve(app.getPath('userData'));
  return isWithin(dir, data) || isWithin(data, dir) ? data : null;
}

async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The vault chosen, by its real path; refused with a sentence the window shows. */
export async function setVault(dir: string): Promise<VaultStatus> {
  const resolved = path.resolve(dir);
  const data = ownDataTouchedBy(resolved);
  if (data) throw new Error(`${path.basename(resolved) || resolved} cannot be the vault: the app keeps its own files in or around it. Choose the folder your notes are in.`);
  if (!(await isFolder(resolved))) throw new Error(`Not a folder: ${path.basename(resolved) || resolved}`);
  const real = await fs.realpath(resolved);
  if ((await fs.lstat(resolved)).isSymbolicLink() || !same(real, resolved)) {
    throw new Error(`${path.basename(resolved)} leads elsewhere through a link. Choose the folder itself.`);
  }
  updateSettings((settings) => {
    settings.vault = real;
  });
  return vaultStatus();
}

/** The vault by its folder's name, and whether it is still there; never its path. */
export async function vaultStatus(): Promise<VaultStatus> {
  const { vault } = readSettings();
  if (!vault) return { vault: null, missing: false };
  return { vault: { name: path.basename(vault) }, missing: !(await isFolder(vault)) };
}

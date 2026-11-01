import { realpathSync } from 'node:fs';
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
  // As spelled and as the disk names it: either side may come through a Windows short name (below).
  let real = data;
  try {
    real = realpathSync.native(data);
  } catch {
    /* not made yet: as spelled is all there is */
  }
  return [data, real].some((one) => isWithin(dir, one) || isWithin(one, dir)) ? data : null;
}

/**
 * Whether any folder on the way to `dir`, from the drive down, is a link: a
 * symlink, or on Windows a junction, which `lstat` reports as one.
 *
 * Asked part by part rather than by comparing the path with its real one,
 * which was Krewgent's way: on Windows a folder can be named through its 8.3
 * short name (`C:\Users\RUNNER~1`, as GitHub's Windows runner names its
 * temporary folder), and its real path then differs without any link on the
 * way. Taken for a link, such a vault was refused; it is the same folder, and
 * is kept by its real path.
 */
async function throughLink(dir: string): Promise<boolean> {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if ((await fs.lstat(at)).isSymbolicLink()) return true;
    if (path.dirname(at) === at) return false;
  }
}

async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The vault chosen, by its real path; refused with a sentence the window shows.
 * The real path is what every later call holds the vault to
 * (electron/services/vaultNotes.ts, `onDisk`), so it is the one kept.
 */
export async function setVault(dir: string): Promise<VaultStatus> {
  const resolved = path.resolve(dir);
  const refusedAsData = () => new Error(`${path.basename(resolved) || resolved} cannot be the vault: the app keeps its own files in or around it. Choose the folder your notes are in.`);
  if (ownDataTouchedBy(resolved)) throw refusedAsData();
  if (!(await isFolder(resolved))) throw new Error(`Not a folder: ${path.basename(resolved) || resolved}`);
  if (await throughLink(resolved)) throw new Error(`${path.basename(resolved)} leads elsewhere through a link. Choose the folder itself.`);
  const name = path.basename(resolved) || resolved;
  // A folder the person may not open: Node's own EPERM, with the whole path, was the sentence shown (29 October).
  const real = await fs.realpath(resolved).catch(() => {
    throw new Error(`${name} cannot be opened: Cortex cannot reach it. Choose another folder.`);
  });
  if (ownDataTouchedBy(real)) throw refusedAsData();
  await writable(real, name);
  updateSettings((settings) => {
    settings.vault = real;
  });
  return vaultStatus();
}

/**
 * The vault made for the person on the first run: `Cortex` in their Documents folder (Electron's `documents`, which
 * follows a Documents moved to OneDrive), so a first run need not begin with a folder dialog (1 November: "kasa
 * Belgelerim içine otomatik oluşsun, isteyen değiştirebilsin"). A `Cortex` there already that is a vault or is empty is
 * taken; one holding other things is left alone and `Cortex 2`, `Cortex 3`, … tried.
 */
export async function defaultVaultDir(documents: string): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const dir = path.join(documents, n === 1 ? 'Cortex' : `Cortex ${n}`);
    const entries = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : ['?']));
    if (entries === null) {
      await fs.mkdir(dir, { recursive: true });
      return dir;
    }
    if (!entries.length || entries.includes('beyin.py') || entries.includes('.beyin-version')) return dir;
  }
  throw new Error('No folder could be made for the vault in Documents. Choose one.');
}

/**
 * Whether Cortex may write in the folder, tried by writing a small file and taking it away: Windows says a folder
 * may be written to (`fs.access`) from its read-only flag alone, not from who is let in. A folder only to be read
 * was taken as the vault, and the first note written failed with a bare EPERM (29 October).
 */
async function writable(folder: string, name: string): Promise<void> {
  const probe = path.join(folder, `.cortex-yazma-denemesi-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, '', { flag: 'wx' });
  } catch {
    throw new Error(`Cortex cannot write in ${name}: your notes are kept there. Choose a folder you can write in.`);
  }
  await fs.rm(probe, { force: true }).catch(() => undefined);
}

/** The vault by its folder's name, and whether it is still there; never its path. */
export async function vaultStatus(): Promise<VaultStatus> {
  const { vault } = readSettings();
  if (!vault) return { vault: null, missing: false };
  return { vault: { name: path.basename(vault) }, missing: !(await isFolder(vault)) };
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The app's own small files - its settings, the chats' list and logs, a local
 * chat's conversation, the keys - written whole. Each is written beside itself
 * under a name of its own and renamed into place, so a crash mid-write leaves
 * the old file whole, and two writers never share a temporary.
 */

/** A rename tried again for a moment while Windows says the file is busy: an antivirus or the indexer opens a file just written. */
export function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/** The text written beside the file and renamed into place; the temporary taken away when it cannot be. */
export function writeWhole(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    renameRetrying(temp, file);
  } catch (err) {
    // The failure said is the write's: a temporary the same scanner still holds is not what went wrong.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* left beside the file, under a name nothing reads */
    }
    throw err;
  }
}

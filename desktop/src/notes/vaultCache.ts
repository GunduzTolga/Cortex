import type { NoteRead } from '@shared/notes';

/**
 * What the reading view draws from other files of the vault - an image, an
 * embedded note - asked of the main process once per version of the file and
 * kept while the window lives. A key carries the file's time of writing, so a
 * file changed on disk is asked again and the old answer is let go.
 *
 * Kept by how much it holds, not only by how many: an image comes as a data
 * URL, up to some 16 MB of text for the largest one read (vaultNotes.ts,
 * ASSET_MAX), and a window that stays by the clock for days held a hundred
 * and twenty of them (desktop-ui-11). The answers asked first are let go
 * first, and one shown again counts as just asked. An answer that is nothing
 * - a file an antivirus held for a moment - is not kept: it is asked again
 * the next time.
 */

const MAX = 120;
/** What the answers of one kind may hold together, in characters of their text. */
const MAX_CHARS = 64 * 1024 * 1024;

function cacheOf<T>(sizeOf: (value: T) => number) {
  const kept = new Map<string, { asked: Promise<T | null>; size: number }>();
  let total = 0;
  const drop = (key: string) => {
    const one = kept.get(key);
    if (!one) return;
    total -= one.size;
    kept.delete(key);
  };
  return (path: string, modified: number, ask: () => Promise<T | null>): Promise<T | null> => {
    const key = `${path}\n${modified}`;
    const had = kept.get(key);
    if (had) {
      kept.delete(key);
      kept.set(key, had);
      return had.asked;
    }
    // An older version of the same file is not asked for again.
    for (const other of [...kept.keys()]) if (other.startsWith(`${path}\n`)) drop(other);
    const asked = ask();
    const entry = { asked, size: 0 };
    kept.set(key, entry);
    if (kept.size > MAX) drop(kept.keys().next().value as string);
    void asked.then((value) => {
      if (kept.get(key) !== entry) return;
      if (value === null) {
        kept.delete(key);
        return;
      }
      entry.size = sizeOf(value);
      total += entry.size;
      for (const oldest of [...kept.keys()]) {
        if (total <= MAX_CHARS) break;
        if (oldest !== key) drop(oldest);
      }
    });
    return asked;
  };
}

const images = cacheOf<string>((url) => url.length);
const notes = cacheOf<NoteRead>((read) => read.text?.length ?? 0);

export const imageOf = (path: string, modified: number) => images(path, modified, () => window.cortex.notes.asset(path).catch(() => null));

export const noteTextOf = (path: string, modified: number) => notes(path, modified, () => window.cortex.notes.read(path).catch(() => null));

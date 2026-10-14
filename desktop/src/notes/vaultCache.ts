import type { NoteRead } from '@shared/notes';

/**
 * What the reading view draws from other files of the vault - an image, an
 * embedded note - asked of the main process once per version of the file and
 * kept for the window's life. A key carries the file's time of writing, so a
 * file changed on disk is asked again and the old answer is let go.
 */

const MAX = 120;
const images = new Map<string, Promise<string | null>>();
const notes = new Map<string, Promise<NoteRead | null>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, ask: () => Promise<T>): Promise<T> {
  const had = cache.get(key);
  if (had) return had;
  const asked = ask();
  cache.set(key, asked);
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return asked;
}

export const imageOf = (path: string, modified: number) =>
  remember(images, `${path}\n${modified}`, () => window.cortex.notes.asset(path).catch(() => null));

export const noteTextOf = (path: string, modified: number) =>
  remember(notes, `${path}\n${modified}`, () => window.cortex.notes.read(path).catch(() => null));

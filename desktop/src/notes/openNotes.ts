/**
 * The notes open on screen, each with what leaving it does (NotePane.tsx):
 * what it holds unsaved is saved over the version read, or, where that
 * cannot be, kept as a note of its own beside it. A delete, another vault
 * chosen and the window going away each wait for that first. Before, a note
 * left within the second before its save, or while it said it had changed on
 * disk, lost what was typed into it, and nothing said so (desktop-ui-3, -8).
 *
 * Plain code with nothing of React in it, so that a store can call it without
 * importing the screen.
 */

const open = new Map<string, () => Promise<void>>();

/** A note on screen and what leaving it does; the function returned takes it off. */
export function holdOpenNote(path: string, leave: () => Promise<void>): () => void {
  open.set(path, leave);
  return () => {
    if (open.get(path) === leave) open.delete(path);
  };
}

/** Every open note under a path - the note itself, or a folder that holds it - or every one, left: each saved, or kept aside. */
export async function leaveOpenNotes(under?: string): Promise<void> {
  const inside = (path: string) => under === undefined || path === under || path.startsWith(`${under}/`);
  await Promise.all([...open].filter(([path]) => inside(path)).map(([, leave]) => leave().catch(() => undefined)));
}

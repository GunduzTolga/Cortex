import { useEffect, useState } from 'react';

/** Above this many characters, a note's text is read for its facts (words, links, headings) only once typing pauses. */
const LONG = 100_000;

/**
 * The text as it is, or for a long note as it was when typing last paused: each whole-note read (its words, its
 * links, its outline) ran on every key, and in a note of a megabyte a key took a second to appear (29 October).
 *
 * `owner` names the note the text belongs to. A view that stays up while the notes change under it (the sidebar)
 * passes the note's path: a paused text is kept with its note, and the outline of one long note showed the
 * headings of the long note opened before it until typing would have paused (29 October).
 */
export function useSettled(text: string, owner: string | null = null, delay = 400): string {
  const [settled, setSettled] = useState({ owner, text });
  const long = text.length > LONG;
  useEffect(() => {
    if (!long) return;
    const timer = setTimeout(() => setSettled({ owner, text }), delay);
    return () => clearTimeout(timer);
  }, [text, owner, long, delay]);
  // Until a text of this note has settled (a note just opened), the text as it is: it said 0 words until typing paused.
  return long && settled.text && settled.owner === owner ? settled.text : text;
}

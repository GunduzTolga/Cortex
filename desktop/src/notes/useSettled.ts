import { useEffect, useState } from 'react';

/** Above this many characters, a note's text is read for its facts (words, links, headings) only once typing pauses. */
const LONG = 100_000;

/**
 * The text as it is, or for a long note as it was when typing last paused: each whole-note read (its words, its
 * links, its outline) ran on every key, and in a note of a megabyte a key took a second to appear (29 October).
 */
export function useSettled(text: string, delay = 400): string {
  const [settled, setSettled] = useState(text);
  const long = text.length > LONG;
  useEffect(() => {
    if (!long) return;
    const timer = setTimeout(() => setSettled(text), delay);
    return () => clearTimeout(timer);
  }, [text, long, delay]);
  // Until a first text has settled (a note just opened), the text as it is: it said 0 words until typing paused.
  return long && settled ? settled : text;
}

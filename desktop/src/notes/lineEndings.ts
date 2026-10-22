import type { Text } from '@codemirror/state';

/**
 * A note's line endings, kept through the editor (NoteEditor.tsx). CodeMirror
 * holds a note as lines, broken wherever the text has `\r\n`, `\r` or `\n`;
 * the note is given back with the line break it is mostly written with. A
 * note written on Windows with `\r\n` is saved with them, and a note opened
 * and not touched is not saved at all: the editor once gave every note back
 * with `\n`, so a Windows note was rewritten, every line of it, the moment it
 * was opened to write in (desktop-ui-6).
 */

export type LineBreak = '\r\n' | '\n';

/**
 * The line break a text is mostly written with; `\n` for one with none, or as
 * many of each. Counted in place, nothing cut out of it: it is asked at every
 * key, of a note that can be megabytes long.
 */
export function lineBreakOf(text: string): LineBreak {
  let crlf = 0;
  let lf = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (at > 0 && text.charCodeAt(at - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** The editor's text with this line break between its lines. */
export const textWith = (doc: Text, eol: LineBreak): string => doc.sliceString(0, doc.length, eol);

/** Whether the editor already holds this text, whatever line breaks either is written with. */
export const holds = (doc: Text, text: string): boolean => doc.toString() === (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text);

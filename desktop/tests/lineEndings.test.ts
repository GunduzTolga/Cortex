import { strict as assert } from 'node:assert';
import test from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { insertTemplate } from '../core/vaultNotes';
import { holds, lineBreakOf, textWith } from '../src/notes/lineEndings';

/**
 * A note's line endings through the editor (src/notes/NoteEditor.tsx), with
 * CodeMirror's own document, as the editor holds it: the editor once gave
 * every note back with `\n`, so a note written on Windows was rewritten, every
 * line of it, the moment it was opened to write in, and a template put into
 * it ran its lines together (desktop-ui-6).
 */

const editorOf = (text: string) => EditorState.create({ doc: text });

test('a note is given back with the line break it is mostly written with', () => {
  assert.equal(lineBreakOf('a\r\nb\r\nc'), '\r\n');
  assert.equal(lineBreakOf('a\nb\nc'), '\n');
  assert.equal(lineBreakOf('one line'), '\n');
  assert.equal(lineBreakOf('a\r\nb\r\nc\nd'), '\r\n');
  assert.equal(lineBreakOf('a\r\nb\nc\nd'), '\n');
});

test('the line breaks are counted where they stand: a \\r alone is neither kind, and a long note is counted whole', () => {
  assert.equal(lineBreakOf('\n'), '\n');
  assert.equal(lineBreakOf('\r\n'), '\r\n');
  assert.equal(lineBreakOf('a\r\n\nb\r\n'), '\r\n', 'two of one, one of the other');
  assert.equal(lineBreakOf('a\r\r\nb'), '\r\n');
  assert.equal(lineBreakOf('a\rb\rc\nd'), '\n');
  const long = Array.from({ length: 50_000 }, (_, at) => `line ${at}`);
  assert.equal(lineBreakOf(`${long.join('\r\n')}\n${long.slice(0, 100).join('\n')}`), '\r\n');
});

test('a Windows note opened is what the editor holds: nothing to put back, nothing to save', () => {
  const note = '# Plan\r\n\r\n- [ ] first\r\n- [x] second\r\n';
  const state = editorOf(note);
  assert.equal(state.doc.lines, 5);
  assert.ok(holds(state.doc, note), 'the editor holds it, so the screen does not replace it and says nothing back');
  assert.equal(textWith(state.doc, lineBreakOf(note)), note, 'given back byte for byte');
});

test('one letter typed into it is saved with \\r\\n on every line still', () => {
  const note = 'a\r\nb\r\nc';
  const state = editorOf(note);
  const typed = state.update({ changes: { from: state.doc.length, insert: '!' } }).state;
  assert.equal(textWith(typed.doc, lineBreakOf(note)), 'a\r\nb\r\nc!');
});

test('a note with both kinds of line break is a line per line, and left as it is until written in', () => {
  const note = 'one\r\ntwo\nthree';
  const state = editorOf(note);
  assert.equal(state.doc.lines, 3, 'the lone \\n breaks the line too');
  assert.equal(state.doc.line(2).text, 'two');
  assert.ok(holds(state.doc, note), 'held already: not replaced, so not saved with one kind');
});

test('a template put into a Windows note keeps its lines, and the note its \\r\\n', () => {
  const note = '# Day\r\n\r\n';
  const state = editorOf(note);
  // As the editor does (NoteEditor.tsx, insertTemplate): counted with one character a line break.
  const doc = state.doc.sliceString(0, state.doc.length, '\n');
  const { text, cursor } = insertTemplate(doc, state.doc.length, '## Plan\n- one\n- two');
  const after = state.update({ changes: { from: 0, to: state.doc.length, insert: text }, selection: EditorSelection.cursor(cursor) }).state;
  assert.equal(after.doc.lines, 5, 'the template\'s lines stay lines');
  assert.equal(textWith(after.doc, lineBreakOf(note)), '# Day\r\n\r\n## Plan\r\n- one\r\n- two');
});

test('a version read again with other line breaks is the same text, not a change', () => {
  const state = editorOf('a\nb');
  assert.ok(holds(state.doc, 'a\r\nb'));
  assert.ok(holds(state.doc, 'a\rb'));
  assert.ok(!holds(state.doc, 'a\r\nc'));
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { sectionOf } from '../src/notes/NoteMarkdown';

/**
 * A heading found by the name a link gives after `#`, for an embed and a note
 * shown over the page (src/notes/NoteMarkdown.tsx, `sectionOf`), folded as a
 * click on the same link finds it (NotePane.tsx): `Işık` is `ışık` in any
 * locale (core/titles.ts). Lowercased, the embed said the heading was not
 * there while the click went to it (desktop-ui-12).
 */

const note = '# Not\n\n## Işık\nGün ışığı.\n\n## İstanbul\nBoğaz.\n\n## Son\nBitti.\n';

test('a heading is found whatever its dotted or dotless I', () => {
  assert.equal(sectionOf(note, 'ışık')?.source, '## Işık\nGün ışığı.\n');
  assert.equal(sectionOf(note, 'IŞIK')?.source, '## Işık\nGün ışığı.\n');
  assert.equal(sectionOf(note, 'istanbul')?.source, '## İstanbul\nBoğaz.\n');
  assert.equal(sectionOf(note, 'Not#İSTANBUL')?.source, '## İstanbul\nBoğaz.\n', 'the last part of a nested subpath');
});

test('a heading the note does not have is still not found', () => {
  assert.equal(sectionOf(note, 'Yok'), null);
});

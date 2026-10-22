import { strict as assert } from 'node:assert';
import test from 'node:test';
import { holdOpenNote, leaveOpenNotes } from '../src/notes/openNotes';

/**
 * The notes open on screen, asked to save what they hold before a delete,
 * another vault or the window going away (src/notes/openNotes.ts): the note
 * itself and what is in a folder, and none other; one that fails does not
 * hold the others up (desktop-ui-3, -8).
 */

test('a note is left when it, or a folder holding it, is; the others stay as they are', async () => {
  const left: string[] = [];
  const hold = (path: string) => holdOpenNote(path, async () => void left.push(path));
  const offs = [hold('Notes/Plan.md'), hold('Notes/Deep/Idea.md'), hold('Notes Old/Other.md'), hold('Top.md')];
  await leaveOpenNotes('Notes/Plan.md');
  assert.deepEqual(left, ['Notes/Plan.md']);
  left.length = 0;
  await leaveOpenNotes('Notes');
  assert.deepEqual(left.sort(), ['Notes/Deep/Idea.md', 'Notes/Plan.md'], 'a folder of a like name is not inside it');
  left.length = 0;
  await leaveOpenNotes();
  assert.equal(left.length, 4, 'every one, for another vault or the window going');
  for (const off of offs) off();
  left.length = 0;
  await leaveOpenNotes();
  assert.deepEqual(left, [], 'a pane gone is not asked');
});

test('a note that fails to be left holds no other up, and the wait ends', async () => {
  const left: string[] = [];
  const offs = [holdOpenNote('A.md', async () => Promise.reject(new Error('disk gone'))), holdOpenNote('B.md', async () => void left.push('B.md'))];
  await leaveOpenNotes();
  assert.deepEqual(left, ['B.md']);
  for (const off of offs) off();
});

test('a pane put back for the same note is not taken off by the one it replaced', async () => {
  const left: string[] = [];
  const offOld = holdOpenNote('Same.md', async () => void left.push('old'));
  const offNew = holdOpenNote('Same.md', async () => void left.push('new'));
  offOld();
  await leaveOpenNotes('Same.md');
  assert.deepEqual(left, ['new']);
  offNew();
});

test('another vault is chosen only once the note open is saved in the one it was read from', async () => {
  const said: string[] = [];
  Object.assign(globalThis, {
    window: {
      cortex: {
        vault: {
          choose: async () => {
            said.push('dialog');
            return { vault: { name: 'Other' }, missing: false };
          },
        },
      },
    },
  });
  const { useApp } = await import('../src/store/app');
  const off = holdOpenNote('Notes/Plan.md', async () => {
    await new Promise((done) => setImmediate(done));
    said.push('saved');
  });
  await useApp.getState().chooseVault('failed');
  off();
  assert.deepEqual(said, ['saved', 'dialog']);
  assert.equal(useApp.getState().vault.vault?.name, 'Other');
});

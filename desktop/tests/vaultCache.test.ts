import { strict as assert } from 'node:assert';
import test from 'node:test';
import { imageOf, noteTextOf } from '../src/notes/vaultCache';

/**
 * What the reading view keeps of the vault's images and embedded notes
 * (src/notes/vaultCache.ts), with the main process stood in for: kept by how
 * much it holds, not only by how many, and an answer that is nothing - a file
 * held for a moment by an antivirus - asked again (desktop-ui-11).
 */

const asked: string[] = [];
let answer: (path: string) => string | null = () => 'data:image/png;base64,AAAA';

Object.assign(globalThis, {
  window: {
    cortex: {
      notes: {
        asset: async (path: string) => {
          asked.push(path);
          return answer(path);
        },
        read: async (path: string) => {
          asked.push(path);
          return { path, text: 'x'.repeat(1024), hash: 'h', modified: 1, tooLarge: false, readOnly: null };
        },
      },
    },
  },
});

const times = (path: string) => asked.filter((one) => one === path).length;

test('an image read is asked once per version of the file', async () => {
  assert.equal(await imageOf('a.png', 1), 'data:image/png;base64,AAAA');
  await imageOf('a.png', 1);
  assert.equal(times('a.png'), 1);
});

test('one that could not be read is asked again the next time, not remembered as missing', async () => {
  answer = (path) => (path === 'held.png' && times('held.png') === 1 ? null : 'data:image/png;base64,BBBB');
  assert.equal(await imageOf('held.png', 5), null);
  assert.equal(await imageOf('held.png', 5), 'data:image/png;base64,BBBB');
  assert.equal(times('held.png'), 2);
});

test('the older version of a file is let go when a newer one is read', async () => {
  answer = () => 'data:image/png;base64,CCCC';
  await imageOf('b.png', 1);
  await imageOf('b.png', 2);
  await imageOf('b.png', 1);
  assert.equal(times('b.png'), 3);
});

test('large images are let go, the first read first, once they hold more than the cache keeps', async () => {
  // Four phone photos of some 20 MB of data URL each: more than the 64 MB kept.
  const big = `data:image/jpeg;base64,${'A'.repeat(20 * 1024 * 1024)}`;
  answer = () => big;
  for (const name of ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']) await imageOf(name, 1);
  // Let go a moment after it is kept: its size is known once it has come.
  await new Promise((done) => setImmediate(done));
  await imageOf('p4.jpg', 1);
  await imageOf('p3.jpg', 1);
  assert.equal(times('p4.jpg') + times('p3.jpg'), 2, 'the last read are still kept');
  await imageOf('p1.jpg', 1);
  assert.equal(times('p1.jpg'), 2, 'the first read was let go, and is asked again');
});

test('an image shown again counts as just read, and is kept over one not shown since', async () => {
  const big = `data:image/jpeg;base64,${'B'.repeat(20 * 1024 * 1024)}`;
  answer = () => big;
  for (const name of ['q1.jpg', 'q2.jpg', 'q3.jpg']) await imageOf(name, 1);
  await imageOf('q1.jpg', 1);
  await imageOf('q4.jpg', 1);
  await new Promise((done) => setImmediate(done));
  await imageOf('q1.jpg', 1);
  assert.equal(times('q1.jpg'), 1, 'shown again, kept');
  await imageOf('q2.jpg', 1);
  assert.equal(times('q2.jpg'), 2, 'not shown since, let go');
});

test('an embedded note is kept the same way', async () => {
  await noteTextOf('Notes/A.md', 1);
  await noteTextOf('Notes/A.md', 1);
  assert.equal(times('Notes/A.md'), 1);
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { ChatEvent } from '../shared/chat';
import { linksOf, notesOf, optionOf, turnsOf, usageOf, waitingIn, waitingOn } from '../src/chat/turns';

/**
 * A chat's events as the screen reads them (src/chat/turns.ts): a turn per
 * message, its thinking and its steps gathered, a card waiting until it is
 * answered, the last word on the context.
 */

const events: ChatEvent[] = [
  { type: 'user', text: 'merhaba', at: 1 },
  { type: 'thought', id: 'm:t', text: 'Düşün' },
  { type: 'thought', id: 'm:t', text: 'üyorum' },
  { type: 'tool', id: 'c1', title: 'read', kind: 'read', status: 'pending', paths: [] },
  { type: 'text', id: 'm1', text: 'Bakıyorum.' },
  { type: 'tool', id: 'c1', status: 'completed', paths: ['Notes/Plan.md'], output: 'ok' },
  { type: 'text', id: 'm2', text: 'Buldum' },
  { type: 'text', id: 'm2', text: ': [[Plan]].' },
  { type: 'usage', used: 10, size: 100, cost: 0, currency: 'USD' },
  { type: 'done', reason: 'end_turn' },
  { type: 'user', text: 'düzenle', at: 2 },
  { type: 'permission', id: 'p1', title: 'edit Notes/Plan.md', kind: 'edit', paths: ['Notes/Plan.md'], options: [{ id: 'once', name: 'Once', kind: 'allow_once' }] },
  { type: 'usage', used: 20, size: 100, cost: null, currency: null },
];

test('a turn per message: its thinking joined, a step updated in place, its messages one paragraph each', () => {
  const turns = turnsOf(events);
  assert.equal(turns.length, 2);
  const [first, second] = turns;
  assert.deepEqual(first.user, { text: 'merhaba', at: 1 });
  assert.equal(first.thought, 'Düşünüyorum');
  assert.deepEqual(first.steps, [{ id: 'c1', title: 'read', kind: 'read', status: 'completed', paths: ['Notes/Plan.md'], output: 'ok' }]);
  assert.equal(first.text, 'Bakıyorum.\n\nBuldum: [[Plan]].');
  assert.deepEqual(first.end, { kind: 'done', reason: 'end_turn' });
  assert.equal(second.end, null);
  assert.equal(waitingOn(turns)?.id, 'p1', 'the card waits until it is answered');
  assert.equal(waitingOn(turnsOf([...events, { type: 'answered', id: 'p1', option: 'once' }])), null);
  assert.equal(turnsOf([...events, { type: 'answered', id: 'p1', option: null }])[1].asked[0].answer, null, 'refused or cancelled');
  assert.deepEqual(usageOf(events), { type: 'usage', used: 20, size: 100, cost: null, currency: null });
});

test('an error ends a turn with what was said; an answer that comes before any message is a turn of its own', () => {
  const turns = turnsOf([
    { type: 'text', id: 'm', text: 'Kaldığımız yerden.' },
    { type: 'user', text: 'hata', at: 3 },
    { type: 'error', message: 'Insufficient balance', kind: 'provider.quota' },
  ]);
  assert.equal(turns[0].user, null);
  assert.equal(turns[0].text, 'Kaldığımız yerden.');
  assert.deepEqual(turns[1].end, { kind: 'error', message: 'Insufficient balance', error: 'provider.quota' });
});

test('a CLI that began the conversation anew says so on that answer, once', () => {
  const turns = turnsOf([
    { type: 'user', text: 'kaldığımız yerden', at: 4 },
    { type: 'notice', notice: 'new-session' },
    { type: 'notice', notice: 'new-session' },
    { type: 'text', id: 'm', text: 'Merhaba.' },
    { type: 'done', reason: 'end_turn' },
    { type: 'user', text: 'sonra', at: 5 },
  ]);
  assert.deepEqual(turns.map((one) => one.notices), [['new-session'], []]);
});

test('a setting is found by its category, else its id', () => {
  const options = [
    { id: 'm', name: 'Model', category: 'model', current: 'a', choices: [] },
    { id: 'mode', name: 'Mode', category: null, current: 'build', choices: [] },
  ];
  assert.equal(optionOf(options, 'model')?.id, 'm');
  assert.equal(optionOf(options, 'mode')?.id, 'mode');
  assert.equal(optionOf(options, 'thought_level'), null);
});

test('the notes a chat touched: read and changed by its steps, named in its answers, the most recent first; nothing that is not a note of the vault', () => {
  const vault = new Map([
    ['notes/plan.md', 'Notes/Plan.md'],
    ['notes/ideas.md', 'Notes/Ideas.md'],
    ['other.md', 'Other.md'],
  ]);
  const note = (path: string) => vault.get(path.toLowerCase()) ?? null;
  const resolve = (target: string) => (target === 'Plan' ? 'Notes/Plan.md' : target === 'Other.md' ? 'Other.md' : target === 'pic.png' ? 'pic.png' : null);
  const turns = turnsOf([
    { type: 'user', text: 'oku', at: 1 },
    { type: 'tool', id: 'a', title: 'read', kind: 'read', status: 'completed', paths: ['Notes/Plan.md', '…/win.ini', 'Gone.md'] },
    { type: 'text', id: 'm', text: 'Bak: [[Plan]], ![[pic.png]], [[Yazılmamış]] ve `[[Kodda]]`.' },
    { type: 'user', text: 'düzenle', at: 2 },
    { type: 'tool', id: 'b', title: 'edit', kind: 'edit', status: 'completed', paths: ['notes/ideas.md'] },
    { type: 'text', id: 'n', text: 'Şuna da bak: [öteki](Other.md).' },
  ]);
  assert.deepEqual(notesOf(turns, note, resolve), [
    { path: 'Notes/Ideas.md', read: false, edited: true, mentioned: false },
    { path: 'Other.md', read: false, edited: false, mentioned: true },
    { path: 'Notes/Plan.md', read: true, edited: false, mentioned: true },
  ]);
});

test('the card a chat waits on is found from its last turn alone, the same card the turns find', () => {
  const asked = (id: string): ChatEvent => ({ type: 'permission', id, title: `edit ${id}`, kind: 'edit', paths: [], options: [{ id: 'once', name: 'Once', kind: 'allow_once' }] });
  const runs: ChatEvent[][] = [
    events,
    [...events, { type: 'answered', id: 'p1', option: 'once' }],
    [...events, { type: 'answered', id: 'p1', option: null }],
    // Two cards in one turn, the first answered: the second waits.
    [{ type: 'user', text: 'iki', at: 1 }, asked('a'), { type: 'answered', id: 'a', option: 'once' }, asked('b')],
    // Two waiting at once: the first, as the card shows it.
    [{ type: 'user', text: 'iki', at: 1 }, asked('a'), asked('b')],
    // A card of an earlier turn left unanswered does not wait now.
    [{ type: 'user', text: 'bir', at: 1 }, asked('old'), { type: 'done', reason: 'cancelled' }, { type: 'user', text: 'yeni', at: 2 }, { type: 'text', id: 'm', text: 'tamam' }],
    // Before the person wrote anything: the chat's first turn.
    [asked('first')],
    [],
  ];
  for (const run of runs) assert.equal(waitingIn(run)?.id ?? null, waitingOn(turnsOf(run))?.id ?? null, JSON.stringify(run.map((one) => one.type)));
  assert.equal(waitingIn(runs[3])?.id, 'b');
  assert.equal(waitingIn(runs[4])?.id, 'a');
  assert.equal(waitingIn(runs[5]), null);
});

test('an ended answer’s links are read once and kept by its words; the answer still coming is read anew each time', () => {
  const ended = turnsOf([
    { type: 'user', text: 'bak', at: 1 },
    { type: 'text', id: 'm', text: 'Şuna bak: [[Plan]] ve [öteki](Other.md).' },
    { type: 'done', reason: 'end_turn' },
  ])[0];
  const first = linksOf(ended);
  assert.deepEqual(first.map((one) => one.target), ['Plan', 'Other.md']);
  assert.equal(linksOf(ended), first, 'kept: the same list, not parsed again');
  // Another reading of the same chat - every frame makes new turns - finds it by the words.
  assert.equal(linksOf({ ...ended }), first);
  const coming = { ...ended, end: null, text: 'Yazıyorum: [[Pl' };
  assert.deepEqual(linksOf(coming), []);
  assert.notEqual(linksOf(coming), linksOf(coming), 'not kept while it is still being written');
  assert.deepEqual(linksOf({ ...coming, text: 'Yazıyorum: [[Plan]]' }).map((one) => one.target), ['Plan'], 'and read as it grows');
});

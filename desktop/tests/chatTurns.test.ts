import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { ChatEvent } from '../shared/chat';
import { optionOf, turnsOf, usageOf, waitingOn } from '../src/chat/turns';

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

test('a setting is found by its category, else its id', () => {
  const options = [
    { id: 'm', name: 'Model', category: 'model', current: 'a', choices: [] },
    { id: 'mode', name: 'Mode', category: null, current: 'build', choices: [] },
  ];
  assert.equal(optionOf(options, 'model')?.id, 'm');
  assert.equal(optionOf(options, 'mode')?.id, 'mode');
  assert.equal(optionOf(options, 'thought_level'), null);
});

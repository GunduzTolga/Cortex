import { strict as assert } from 'node:assert';
import test from 'node:test';
import { addSpend } from '../electron/services/chat';
import { spendOf } from '../electron/services/claudeChat';
import { spendWords } from '../src/chat/spend';

// 2 November notes: "sohbet kısmında session maliyetini görme". Claude Code's total_cost_usd counts the whole session,
// across a resume too (measured 4 November with Haiku: the resumed turn reported twice the first turn's dollars).

type Stored = Parameters<typeof addSpend>[0];
const chat = (): Stored => ({ id: 'c1', title: '', cli: 'claude', createdAt: 0, updatedAt: 0, vault: '/v', sessionId: null });

test('a session’s running total counts its rise once, a new session whole, and a resumed one is not counted twice', () => {
  const one = chat();
  addSpend(one, { type: 'spend', usd: null, tokens: 100, subscription: true, total: { session: 's1', usd: 0.1 } });
  addSpend(one, { type: 'spend', usd: null, tokens: 50, subscription: true, total: { session: 's1', usd: 0.15 } });
  assert.equal(one.spend?.usd?.toFixed(4), '0.1500');
  // The app restarted and the chat resumed s1: the CLI's total carries the session's past, which is not added again.
  addSpend(one, { type: 'spend', usd: null, tokens: 50, subscription: true, total: { session: 's1', usd: 0.2 } });
  assert.equal(one.spend?.usd?.toFixed(4), '0.2000');
  // The CLI could not resume and began anew: its total starts from nothing, and is the chat's on top.
  addSpend(one, { type: 'spend', usd: null, tokens: 10, subscription: true, total: { session: 's2', usd: 0.03 } });
  assert.equal(one.spend?.usd?.toFixed(4), '0.2300');
  assert.equal(one.spend?.tokens, 210);
  assert.equal(one.spend?.subscription, true);
});

test('tokens alone leave the dollars as none; a damaged total is not counted', () => {
  const one = chat();
  addSpend(one, { type: 'spend', usd: null, tokens: 4096, subscription: true });
  assert.deepEqual(one.spend, { usd: null, tokens: 4096, subscription: true });
  addSpend(one, { type: 'spend', usd: Number.NaN, tokens: -5, subscription: true, total: { session: 's', usd: -1 } });
  assert.deepEqual(one.spend, { usd: null, tokens: 4096, subscription: true });
});

test('Claude Code’s result gives its tokens, cache included, and the session’s total', () => {
  const result = { type: 'result', session_id: 'ses', total_cost_usd: 0.42, usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 118419, cache_creation_input_tokens: 7422 } };
  assert.deepEqual(spendOf(result, null), { type: 'spend', usd: null, tokens: 125847, subscription: true, total: { session: 'ses', usd: 0.42 } });
  assert.deepEqual(spendOf({ type: 'result', usage: {} }, 'ses'), null, 'nothing told, nothing shown');
  assert.deepEqual(spendOf({ type: 'result', total_cost_usd: 0.1 }, 'known'), { type: 'spend', usd: null, tokens: 0, subscription: true, total: { session: 'known', usd: 0.1 } });
});

const words = (key: string, values: Record<string, string>) => `${key}|${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')}`;

test('the list’s word: dollars marked as the API’s price on a subscription, tokens where no price is told', () => {
  assert.equal(spendWords(undefined, 'tr', words), null);
  assert.equal(spendWords({ usd: null, tokens: 0, subscription: true }, 'tr', words), null);
  const sub = spendWords({ usd: 0.4213, tokens: 1234567, subscription: true }, 'en', words);
  assert.equal(sub?.short, '≈$0.42');
  assert.match(sub?.title ?? '', /^chat\.spend\.title\.subscription\|usd=\$0\.4213,tokens=1,234,567$/);
  assert.equal(spendWords({ usd: 0.004, tokens: 10, subscription: false }, 'en', words)?.short, '<$0.01');
  assert.equal(spendWords({ usd: 0.004, tokens: 10, subscription: true }, 'en', words)?.short, '<$0.01', 'no “about” before “under a cent”');
  const tokens = spendWords({ usd: null, tokens: 12400, subscription: true }, 'en', words);
  assert.equal(tokens?.short, 'chat.spend.tokens|tokens=12.4K');
});

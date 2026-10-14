import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sameTitle, titleKey } from '../core/titles';

/**
 * Krewgent's tests of the title rule (core/titles.ts), less its journal's.
 * The whole point of this file is the pair of names below. `Iceberg` and
 * `İşlem` fold in opposite directions, and every earlier version of Krewgent
 * picked one locale and quietly lost the other.
 */

test('a title matches itself whatever case it is typed in', () => {
  assert.equal(sameTitle('Status · Atlas', 'status · atlas'), true);
  assert.equal(sameTitle('  status · atlas  ', 'status · atlas'), true);
  assert.equal(sameTitle('status ·  atlas', 'status · atlas'), true);
});

test('an ASCII capital I still matches its lowercase, as invariant casing does', () => {
  // Turkish casing would send this to `ıceberg` and stop matching.
  assert.equal(sameTitle('status · Iceberg', 'status · iceberg'), true);
  // And the dotless lowercase a Turkish keyboard types is the same title again.
  assert.equal(sameTitle('status · ıceberg', 'status · Iceberg'), true);
});

test('a Turkish dotted capital still matches, as Turkish casing does', () => {
  // Invariant casing leaves a combining dot behind and stops matching.
  assert.equal(sameTitle('status · İşlem', 'status · işlem'), true);
  assert.equal(sameTitle('İŞLEM', 'işlem'), true);
});

test('a title already lowered somewhere else, combining dot and all, still matches', () => {
  assert.equal(sameTitle('i̇şlem', 'İşlem'), true);
});

test('different titles stay different', () => {
  assert.equal(sameTitle('status · atlas', 'status · atlas-app'), false);
  assert.equal(sameTitle('journal · atlas · 2026-08-27', 'journal · atlas · 2026-08-28'), false);
});

test('the key is only for comparing - it is never what is shown', () => {
  assert.equal(titleKey('Status · İşlem'), 'status · işlem');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nameIcon, sameTitle, titleKey, withoutIcon } from '../core/titles';
import { listedByDefault } from '../core/vaultNotes';

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

test('a name is shown without the emoji it starts with, and only that: the name on disk keeps it', () => {
  assert.equal(withoutIcon('📥 000-Inbox'), '000-Inbox');
  assert.equal(nameIcon('📥 000-Inbox'), '📥 ');
  assert.equal(withoutIcon('🔮 850-Companion'), '850-Companion');
  assert.equal(withoutIcon('❤️ Sağlık'), 'Sağlık', 'with its variation selector');
  assert.equal(withoutIcon('👩‍💻 Kod'), 'Kod', 'a joined emoji is one');
  assert.equal(withoutIcon('000-Inbox'), '000-Inbox', 'a number is not an emoji');
  assert.equal(withoutIcon('_drafts'), '_drafts', 'nor is a mark');
  assert.equal(withoutIcon('📥'), '📥', 'a name that is only the emoji keeps it');
  assert.equal(withoutIcon('📥Inbox'), '📥Inbox', 'one not set apart by a space is part of the word');
});

test('the tree lists notes and what notes show; scripts, JSON and text files only when asked', () => {
  for (const path of ['Notes/Plan.md', 'a/b.MD', 'img/x.png', 'docs/paper.pdf', 'Board.canvas', 'clip.mp4']) assert.equal(listedByDefault(path), true, path);
  for (const path of ['beyin.py', 'scratch_repos.json', 'scratch_repo_analysis.txt', 'Beyni Guncelle.cmd', 'data.csv']) assert.equal(listedByDefault(path), false, path);
});

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { enterAnswers, type EnterPlace, type EnterPress } from '../src/chat/permissionKey';

/**
 * When Enter answers Pyn's card with "once" (src/chat/permissionKey.ts). The
 * card heard every Enter in the window: a newline typed in a note, with the chat
 * hidden behind the notes, approved a step the person never saw, and Enter on a
 * focused "Reject" allowed it (desktop-ui-2, security-3). Elements here are
 * stand-ins with what the rule reads of the DOM's: `closest` and
 * `isContentEditable`, and the card's `contains`.
 */

/** An element: the selectors it would match as `closest` reads them, by tag and by being written in. */
function element(tag: string, options: { editable?: boolean; inside?: string[] } = {}) {
  const tags = [tag, ...(options.inside ?? [])];
  return {
    isContentEditable: Boolean(options.editable),
    closest(selector: string) {
      const wanted = selector.split(',').map((one) => one.trim());
      const hit = tags.some((one) => wanted.some((want) => want === one || (one === 'contenteditable' && want.startsWith('[contenteditable]'))));
      return hit ? {} : null;
    },
  };
}

const body = { body: true };
const cardText = element('p');
const cardButton = element('button');
const cardItself = element('div');
const inCard = new Set<unknown>([cardText, cardButton, cardItself]);
const card = { contains: (node: never) => inCard.has(node) };

const press = (target: unknown, more: Partial<EnterPress> = {}): EnterPress => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  target,
  ...more,
});
const place = (more: Partial<EnterPlace> = {}): EnterPlace => ({ visible: true, layers: 0, card, body, ...more });

test('with the chat in front and nothing focused, Enter is "once", as the card says', () => {
  assert.equal(enterAnswers(press(body), place()), true);
  assert.equal(enterAnswers(press(cardItself), place()), true, 'on the card itself');
  assert.equal(enterAnswers(press(cardText), place()), true, 'on its words');
});

test('the chat hidden behind another view: no Enter answers, not even on the page', () => {
  assert.equal(enterAnswers(press(body), place({ visible: false })), false);
  assert.equal(enterAnswers(press(cardText), place({ visible: false })), false);
});

test('Enter in a note’s editor - a contenteditable, not a field - never answers', () => {
  const editor = element('div', { editable: true, inside: ['contenteditable'] });
  assert.equal(enterAnswers(press(editor), place({ visible: false })), false);
  assert.equal(enterAnswers(press(editor), place()), false, 'not even with the chat in front (the side panel, a later editor)');
});

test('a control keeps its own Enter: the card’s buttons, the field, a button or a link anywhere', () => {
  assert.equal(enterAnswers(press(cardButton), place()), false, 'Reject pressed by keyboard rejects');
  for (const tag of ['textarea', 'input', 'button', 'a', 'select']) assert.equal(enterAnswers(press(element(tag)), place()), false, tag);
  assert.equal(enterAnswers(press(element('div')), place()), false, 'focus somewhere that is not the card or the page');
});

test('a dialog or a menu over the page takes Enter for itself', () => {
  assert.equal(enterAnswers(press(body), place({ layers: 1 })), false);
});

test('only a plain Enter: not held down, not ending a word being composed, not with a modifier, not one already taken', () => {
  for (const more of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'a' }, { key: ' ' }]) {
    assert.equal(enterAnswers(press(body, more), place()), false, JSON.stringify(more));
  }
});

test('no card on screen, no answer', () => {
  assert.equal(enterAnswers(press(cardText), place({ card: null })), false);
});

/*
  What the rule cannot hold by itself: that the card uses it, with the chat's
  visibility, and that no other Enter listener answers. Read from the source,
  as tests/escapeLayers.test.ts does for the layers.
*/
test('the card answers Enter only through the rule, told whether the chat is in front', () => {
  const composer = fs.readFileSync('src/chat/Composer.tsx', 'utf8');
  const card = composer.slice(composer.indexOf('function PermissionCard'), composer.indexOf('const OPTION_ORDER'));
  assert.match(card, /enterAnswers\(event, \{ visible, layers: escapeLayers\.size\(\), card: card\.current, body: document\.body \}\)/);
  assert.match(card, /if \(!visible \|\| !once\) return;/, 'no listener at all while the chat is hidden');
  assert.doesNotMatch(composer, /closest\('textarea, input'\)/, 'the old rule is gone');
  assert.match(composer, /<PermissionCard asked=\{asked\} onAnswer=\{onAnswer\} visible=\{visible\} \/>/);
  const view = fs.readFileSync('src/chat/ChatView.tsx', 'utf8');
  assert.match(view, /visible=\{visible\}/, 'ChatView tells the composer');
});

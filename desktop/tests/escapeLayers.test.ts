import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ABOVE_LAYERS,
  createLayerStack,
  focusFellOff,
  holdBackground,
  inertOutside,
  wrapTarget,
} from '../src/ui/escapeLayers';
import type { Layer, LayerNode } from '../src/ui/escapeLayers';

/**
 * Escape and the page behind a layer.
 *
 * Four components each had their own window listener, and one key press closed
 * every layer that was up. The stack is plain code with the window and the
 * elements passed in, so what is held here is the rule itself: which layer
 * answers, when the listener is on the window, and what is made inert. What is
 * not held here is that the components use it - the last test reads the source
 * for that, because a fifth listener written next year would pass everything
 * else in this file.
 */

/** A window that counts what was added to it. */
function fakeWindow() {
  const listeners = new Set<(event: { key: string }) => void>();
  let added = 0;
  let removed = 0;
  return {
    target: {
      addEventListener: (_type: 'keydown', listener: (event: { key: string }) => void) => {
        added++;
        listeners.add(listener);
      },
      removeEventListener: (_type: 'keydown', listener: (event: { key: string }) => void) => {
        removed++;
        listeners.delete(listener);
      },
    },
    press: (key: string) => [...listeners].forEach((listener) => listener({ key })),
    count: () => listeners.size,
    added: () => added,
    removed: () => removed,
  };
}

/** A layer that writes its name to a shared list when Escape reaches it. */
function layerNamed(name: string, heard: string[]): Layer {
  return { onEscape: () => heard.push(name) };
}

test('only the topmost layer answers Escape', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  stack.enter(layerNamed('settings', heard));
  stack.enter(layerNamed('dialog', heard));
  win.press('Escape');
  assert.deepEqual(heard, ['dialog']);
});

test('layers leave in the order they are closed, and Escape follows the stack down', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  const settings = layerNamed('settings', heard);
  const picker = layerNamed('picker', heard);
  const drive = layerNamed('drive', heard);
  stack.enter(settings);
  stack.enter(picker);
  const leaveDrive = stack.enter(drive);
  win.press('Escape');
  leaveDrive();
  win.press('Escape');
  stack.leave(picker);
  win.press('Escape');
  assert.deepEqual(heard, ['drive', 'picker', 'settings']);
});

test('a layer that is not on top can leave without disturbing the one that is', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  const under = layerNamed('under', heard);
  stack.enter(under);
  stack.enter(layerNamed('over', heard));
  stack.leave(under); // its component unmounted while something was above it
  win.press('Escape');
  assert.deepEqual(heard, ['over']);
  assert.equal(stack.size(), 1);
});

test('a layer that opens again goes on top, once', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  const first = layerNamed('first', heard);
  stack.enter(first);
  stack.enter(layerNamed('second', heard));
  stack.enter(first);
  assert.equal(stack.size(), 2);
  win.press('Escape');
  assert.deepEqual(heard, ['first']);
});

test('a new callback keeps the layer where it was', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  const settings = layerNamed('settings', heard);
  const dialog = layerNamed('dialog', heard);
  stack.enter(settings);
  stack.enter(dialog);
  // What a re-render does to the layer under a dialog: a fresh callback.
  settings.onEscape = () => heard.push('settings, re-rendered');
  win.press('Escape');
  assert.deepEqual(heard, ['dialog'], 'the one underneath did not climb above the dialog');
  stack.leave(dialog);
  win.press('Escape');
  assert.deepEqual(heard, ['dialog', 'settings, re-rendered'], 'and it answers with the callback it has now');
});

test('Escape with nothing up does nothing, and so does every other key', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  win.press('Escape');
  const heard: string[] = [];
  stack.enter(layerNamed('only', heard));
  win.press('Enter');
  win.press('Tab');
  win.press('escape');
  assert.deepEqual(heard, []);
});

test('the window has one listener while anything is up and none when the stack empties', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const a = layerNamed('a', []);
  const b = layerNamed('b', []);
  assert.equal(win.count(), 0, 'nothing is added until a layer opens');
  stack.enter(a);
  stack.enter(b);
  assert.equal(win.added(), 1, 'a second layer shares the first one’s listener');
  stack.enter(a); // moved to the top: the list is empty for an instant inside, and that is not a new listener
  assert.equal(win.added(), 1);
  stack.leave(a);
  assert.equal(win.count(), 1, 'still one layer, still listening');
  stack.leave(b);
  assert.equal(win.count(), 0);
  assert.equal(win.removed(), 1);
  stack.leave(b); // already gone
  assert.equal(win.removed(), 1);
  stack.enter(a);
  assert.equal(win.added(), 2, 'and it comes back when a layer does');
});

test('the only layer re-entered keeps exactly one listener', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const a = layerNamed('a', []);
  stack.enter(a);
  stack.enter(a);
  assert.equal(win.added(), 1);
  assert.equal(win.count(), 1);
});

test('a callback that closes its own layer does not make the next layer answer the same key', () => {
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  const heard: string[] = [];
  const under = layerNamed('under', heard);
  const over: Layer = {
    onEscape: () => {
      heard.push('over');
      stack.leave(over);
    },
  };
  stack.enter(under);
  stack.enter(over);
  win.press('Escape');
  assert.deepEqual(heard, ['over']);
});

/* ------------------------------------------------------------------ */
/* The page behind a modal layer                                        */
/* ------------------------------------------------------------------ */

class FakeNode implements LayerNode {
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  inert = false;
  private readonly marks: Set<string>;
  constructor(public readonly name: string, marks: string[] = []) {
    this.marks = new Set(marks);
  }
  hasAttribute(attribute: string) {
    return this.marks.has(attribute);
  }
  add(...nodes: FakeNode[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
    return this;
  }
}

/**
 * html > [head, body > [app > [header, side > [picker, drive], settings > [panel > [form, notes]]], toasts]]
 * Settings, the picker and the Drive dialog are the layers; the toasts are above all of them.
 */
function page() {
  const head = new FakeNode('head');
  const header = new FakeNode('header');
  const picker = new FakeNode('picker');
  const drive = new FakeNode('drive');
  const side = new FakeNode('side').add(picker, drive);
  const form = new FakeNode('form');
  const notes = new FakeNode('notes');
  const panel = new FakeNode('panel').add(form, notes);
  const settings = new FakeNode('settings').add(panel);
  const approval = new FakeNode('approval', [ABOVE_LAYERS]);
  const app = new FakeNode('app').add(header, side, settings, approval);
  const toasts = new FakeNode('toasts', [ABOVE_LAYERS]);
  const body = new FakeNode('body').add(app, toasts);
  const html = new FakeNode('html').add(head, body);
  return { html, head, body, app, header, side, picker, drive, settings, panel, form, notes, approval, toasts };
}

const inertNames = (...nodes: FakeNode[]) => nodes.filter((node) => node.inert).map((node) => node.name);
const exempt = (node: LayerNode) => node.hasAttribute(ABOVE_LAYERS);

test('everything outside the layer is inert, and the layer and the way to it are not', () => {
  const p = page();
  const restore = inertOutside(p.settings, exempt);
  assert.deepEqual(inertNames(p.header, p.side, p.picker, p.drive), ['header', 'side']);
  assert.equal(p.settings.inert, false);
  assert.equal(p.app.inert, false, 'its ancestors have to stay reachable or it would be inert too');
  assert.equal(p.body.inert, false);
  restore();
  assert.deepEqual(inertNames(p.header, p.side), []);
});

test('what is above every layer stays reachable', () => {
  const p = page();
  inertOutside(p.settings, exempt);
  assert.equal(p.approval.inert, false);
  assert.equal(p.toasts.inert, false);
});

test('the head is left alone', () => {
  const p = page();
  inertOutside(p.settings, exempt);
  assert.equal(p.head.inert, false);
});

test('a dialog inside Settings makes the rest of Settings inert and leaves Settings itself alone', () => {
  const p = page();
  inertOutside(p.notes, exempt);
  assert.deepEqual(inertNames(p.form, p.header, p.side), ['form', 'header', 'side']);
  assert.equal(p.settings.inert, false);
  assert.equal(p.panel.inert, false);
  assert.equal(p.notes.inert, false);
});

test('what was already inert is not the layer’s to undo', () => {
  const p = page();
  p.side.inert = true; // a side that marked itself, for its own reasons
  const restore = inertOutside(p.settings, exempt);
  restore();
  assert.equal(p.side.inert, true);
  assert.equal(p.header.inert, false);
});

test('the background follows the top layer: the picker comes back when the Drive dialog goes', () => {
  const p = page();
  const win = fakeWindow();
  const stack = createLayerStack(win.target);
  holdBackground(stack);
  const picker: Layer = { onEscape: () => {}, modalRoot: () => p.picker };
  const drive: Layer = { onEscape: () => {}, modalRoot: () => p.drive };

  stack.enter(picker);
  assert.deepEqual(inertNames(p.drive, p.header, p.settings), ['drive', 'header', 'settings']);
  assert.equal(p.picker.inert, false);
  assert.equal(p.drive.inert, true, 'the other dialog beside it is part of the page behind it');

  stack.enter(drive);
  assert.equal(p.drive.inert, false);
  assert.equal(p.picker.inert, true, 'with the Drive dialog up, the picker is the page behind it');

  stack.leave(drive);
  assert.equal(p.picker.inert, false, 'and it is reachable again as soon as the dialog is gone');
  assert.equal(p.drive.inert, true);

  stack.leave(picker);
  assert.deepEqual(inertNames(p.header, p.side, p.picker, p.drive, p.settings), [], 'nothing left up, nothing inert');
});

test('a layer with no element asks for no inertness', () => {
  const p = page();
  const stack = createLayerStack(fakeWindow().target);
  holdBackground(stack);
  stack.enter({ onEscape: () => {}, modalRoot: () => p.settings });
  assert.equal(p.header.inert, true);
  stack.enter({ onEscape: () => {} }); // the office's fullscreen: a keyboard claim only
  assert.equal(p.header.inert, false, 'it is on top, and it did not ask for the page to be held back');
});

/* ------------------------------------------------------------------ */
/* Focus                                                                */
/* ------------------------------------------------------------------ */

test('focus goes back to the opener only when it fell off the page', () => {
  const body = {};
  assert.equal(focusFellOff(null, body), true);
  assert.equal(focusFellOff(undefined, body), true);
  assert.equal(focusFellOff(body, body), true);
  // The person moved to the header, or a higher layer took it: not ours to pull back.
  assert.equal(focusFellOff({ name: 'header button' }, body), false);
});

test('Tab wraps at the two ends and nowhere else', () => {
  const [a, b, c] = ['a', 'b', 'c'];
  const all = [a, b, c];
  assert.equal(wrapTarget(all, c, false), a);
  assert.equal(wrapTarget(all, a, true), c);
  assert.equal(wrapTarget(all, b, false), null);
  assert.equal(wrapTarget(all, b, true), null);
  assert.equal(wrapTarget(all, a, false), null);
  assert.equal(wrapTarget(all, c, true), null);
  // Focus on the layer itself or on a scroller that is not tabbable: the browser's next step is right.
  assert.equal(wrapTarget(all, 'the dialog', false), null);
  assert.equal(wrapTarget(all, 'the dialog', true), null);
  assert.equal(wrapTarget([], 'x', false), null);
  assert.equal(wrapTarget([a], a, false), a);
  assert.equal(wrapTarget([a], a, true), a);
});

/* ------------------------------------------------------------------ */
/* The components use it                                                */
/* ------------------------------------------------------------------ */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test('nothing in src listens for Escape on its own', () => {
  const src = path.resolve('src');
  const allowed = new Map([
    // The stack itself, which is the one listener.
    [path.join('ui', 'escapeLayers.ts'), 'the one listener'],
  ]);
  const offenders = sourceFiles(src)
    .map((file) => path.relative(src, file))
    .filter((file) => !allowed.has(file))
    .filter((file) => /['"]Escape['"]/.test(readFileSync(path.join(src, file), 'utf8')));
  assert.deepEqual(offenders, [], 'a window-level Escape listener belongs in useEscapeLayer, or a dialog over it closes with it');
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { BrowserLinkStatus } from '../shared/browserLink';

/**
 * What the window holds of Cortex Browser's link (src/store/browserLink.ts), with the main process stood in for: the
 * link's state as it is told, the person's answer to a browser waiting, and the leave taken back.
 */

const NONE: BrowserLinkStatus = { on: true, listening: true, allowed: false, connected: false, asking: false, code: null, locked: false };
let now: BrowserLinkStatus = { ...NONE };
let fails = false;
let push: (status: BrowserLinkStatus) => void = () => undefined;
let listeners = 0;
const calls: Array<[string, unknown?]> = [];
const answer = async (name: string, next: Partial<BrowserLinkStatus>, arg?: unknown): Promise<BrowserLinkStatus> => {
  calls.push(arg === undefined ? [name] : [name, arg]);
  if (fails) throw new Error('Refused: not the app’s own page.');
  now = { ...now, ...next };
  return now;
};

Object.assign(globalThis, {
  window: {
    cortex: {
      browserLink: {
        status: () => answer('status', {}),
        decide: (allow: boolean) => answer('decide', { asking: false, code: null, allowed: allow }, allow),
        setOn: (on: boolean) => answer('setOn', { on, listening: on, connected: false }, on),
        allow: () => answer('allow', now.asking ? { asking: false, code: null, allowed: true } : { locked: false }),
        unpair: () => answer('unpair', { allowed: false, connected: false }),
      },
      on: {
        browserLink: (handler: (status: BrowserLinkStatus) => void) => {
          listeners += 1;
          push = handler;
          return () => undefined;
        },
      },
    },
  },
});

const { useBrowserLink } = await import('../src/store/browserLink');

test('the link’s state is asked for once and followed after; a browser waiting is answered, and the leave taken back', async () => {
  assert.equal(useBrowserLink.getState().status, null);
  await useBrowserLink.getState().boot();
  await useBrowserLink.getState().boot();
  assert.equal(listeners, 1, 'listened to once, however often it is begun');
  assert.deepEqual(useBrowserLink.getState().status, NONE);
  // A browser connects while the window is there: told, not asked for, with the code to compare.
  push({ ...NONE, asking: true, code: '4821' });
  assert.deepEqual([useBrowserLink.getState().status?.asking, useBrowserLink.getState().status?.code], [true, '4821']);
  now = { ...NONE, asking: true, code: '4821' };
  await useBrowserLink.getState().decide(true);
  assert.deepEqual(calls.at(-1), ['decide', true]);
  assert.deepEqual(useBrowserLink.getState().status, { ...NONE, allowed: true }, 'the answer’s own word, without waiting for a push');
  push({ ...NONE, allowed: true, connected: true });
  await useBrowserLink.getState().unpair();
  assert.deepEqual(calls.at(-1), ['unpair']);
  assert.deepEqual(useBrowserLink.getState().status, NONE);
});

test('the switch closes and opens the link; "allow" in the settings lets a refused browser ask again', async () => {
  await useBrowserLink.getState().setOn(false);
  assert.deepEqual(calls.at(-1), ['setOn', false]);
  assert.deepEqual([useBrowserLink.getState().status?.on, useBrowserLink.getState().status?.listening], [false, false]);
  await useBrowserLink.getState().setOn(true);
  assert.deepEqual(calls.at(-1), ['setOn', true]);
  assert.equal(useBrowserLink.getState().status?.listening, true);
  now = { ...NONE, locked: true };
  push(now);
  assert.equal(useBrowserLink.getState().status?.locked, true);
  await useBrowserLink.getState().allow();
  assert.deepEqual(calls.at(-1), ['allow']);
  assert.equal(useBrowserLink.getState().status?.locked, false);
});

test('an answer the main process would not take leaves the question where it was, and says so', async () => {
  push({ ...NONE, asking: true, code: '0042' });
  fails = true;
  assert.equal(useBrowserLink.getState().failed, false);
  await useBrowserLink.getState().decide(false);
  assert.equal(useBrowserLink.getState().status?.asking, true);
  assert.equal(useBrowserLink.getState().failed, true);
  fails = false;
  now = { ...NONE, asking: true, code: '0042' };
  await useBrowserLink.getState().decide(false);
  assert.deepEqual([useBrowserLink.getState().status?.asking, useBrowserLink.getState().failed], [false, false]);
});

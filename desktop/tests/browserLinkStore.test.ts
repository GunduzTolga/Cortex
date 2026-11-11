import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { BrowserLinkStatus } from '../shared/browserLink';

/**
 * What the window holds of Cortex Browser's link (src/store/browserLink.ts), with the main process stood in for: the
 * link's state as it is told, the person's answer to a browser waiting, and the leave taken back.
 */

let now: BrowserLinkStatus = { allowed: false, connected: false, asking: false };
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
        decide: (allow: boolean) => answer('decide', { asking: false, allowed: allow }, allow),
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
  assert.deepEqual(useBrowserLink.getState().status, { allowed: false, connected: false, asking: false });
  // A browser connects while the window is there: told, not asked for.
  push({ allowed: false, connected: false, asking: true });
  assert.equal(useBrowserLink.getState().status?.asking, true);
  now = { allowed: false, connected: false, asking: true };
  await useBrowserLink.getState().decide(true);
  assert.deepEqual(calls.at(-1), ['decide', true]);
  assert.deepEqual(useBrowserLink.getState().status, { allowed: true, connected: false, asking: false }, 'the answer’s own word, without waiting for a push');
  push({ allowed: true, connected: true, asking: false });
  await useBrowserLink.getState().unpair();
  assert.deepEqual(calls.at(-1), ['unpair']);
  assert.deepEqual(useBrowserLink.getState().status, { allowed: false, connected: false, asking: false });
});

test('an answer the main process would not take leaves the question where it was, and says so', async () => {
  push({ allowed: false, connected: false, asking: true });
  fails = true;
  assert.equal(useBrowserLink.getState().failed, false);
  await useBrowserLink.getState().decide(false);
  assert.equal(useBrowserLink.getState().status?.asking, true);
  assert.equal(useBrowserLink.getState().failed, true);
  fails = false;
  now = { allowed: false, connected: false, asking: true };
  await useBrowserLink.getState().decide(false);
  assert.deepEqual([useBrowserLink.getState().status?.asking, useBrowserLink.getState().failed], [false, false]);
});

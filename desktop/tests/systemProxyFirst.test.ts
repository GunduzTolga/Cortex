import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, learnSystemProxy, systemProxyKnown } from '../electron/services/acp';

/*
  The second review, R2S-4: a chat's program started in the app's first seconds took its environment before Windows had
  answered about the proxy, and went without it for as long as it ran. In a file of its own: "the first answer" is
  this process's, and systemProxy.test.ts has asked already.
*/
test('a program started as the app opens waits for the first answer about the proxy, and not for ever', async () => {
  const began = Date.now();
  await systemProxyKnown(5_000);
  assert.ok(Date.now() - began < 1_000, 'nothing asked yet (a test, a tool run by hand): nothing to wait for');

  // A proxy file takes a moment to read.
  const asking = learnSystemProxy(() => new Promise((resolve) => setTimeout(() => resolve('PROXY proxy.sirket.local:8080; DIRECT'), 400)));
  const short = Date.now();
  await systemProxyKnown(40);
  assert.ok(Date.now() - short < 350, `the wait is up before the answer is in, and the program is started (${Date.now() - short} ms)`);
  assert.equal(childEnv({}, { PATH: 'p' }).HTTPS_PROXY, undefined, 'without a proxy, as before this wait was here');

  await systemProxyKnown(5_000);
  assert.ok(Date.now() - short < 3_000, 'over as soon as the answer is in, not when the wait is up');
  assert.equal(childEnv({}, { PATH: 'p' }).HTTPS_PROXY, 'http://proxy.sirket.local:8080', 'started after the answer: with the proxy');
  await asking;

  // Once answered, nothing is waited for again: the proxy asked about every few minutes is not a first answer.
  void learnSystemProxy(() => new Promise((resolve) => setTimeout(() => resolve('DIRECT'), 300)));
  const later = Date.now();
  await systemProxyKnown(5_000);
  assert.ok(Date.now() - later < 200, 'a later asking holds nothing up');
  await new Promise((resolve) => setTimeout(resolve, 350));
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { childEnv, learnSystemProxy, proxyUrlOf, withSystemProxy } from '../electron/services/acp';

/**
 * Windows' proxy handed on to the programs Cortex starts (the review of 10 November, S4 and N5): on a company network
 * Cortex's own downloads worked and the AI tool and the voice setup's Python could not reach the internet.
 */

test('Chromium\'s answer is read as the address a program\'s environment takes; "DIRECT" and SOCKS are none', () => {
  assert.equal(proxyUrlOf('PROXY proxy.sirket.local:8080; DIRECT'), 'http://proxy.sirket.local:8080');
  assert.equal(proxyUrlOf('proxy 10.0.0.5:3128'), 'http://10.0.0.5:3128');
  assert.equal(proxyUrlOf('HTTPS guvenli.sirket.local:443'), 'https://guvenli.sirket.local:443');
  assert.equal(proxyUrlOf('PROXY [fd00::1]:8080'), 'http://[fd00::1]:8080');
  assert.equal(proxyUrlOf('DIRECT'), null);
  assert.equal(proxyUrlOf('SOCKS5 127.0.0.1:1080; DIRECT'), null);
  assert.equal(proxyUrlOf('PROXY yalniz-ad'), null, 'no port: not an address');
  assert.equal(proxyUrlOf('PROXY a:80 & calc'), null, 'nothing but an address is taken');
  assert.equal(proxyUrlOf(''), null);
});

test('a program started by Cortex gets Windows\' proxy, and reaches this computer without it', () => {
  const env = withSystemProxy({ PATH: 'p' }, 'http://proxy.sirket.local:8080');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.sirket.local:8080');
  assert.equal(env.HTTP_PROXY, 'http://proxy.sirket.local:8080');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1', 'a model server on this computer is not asked through the proxy');
  assert.equal(env.PATH, 'p');
});

test('a proxy the person set themselves is left as it is, whatever its case; so is their no-proxy list', () => {
  for (const mine of [{ HTTPS_PROXY: 'http://benim:1' }, { https_proxy: 'http://benim:1' }, { ALL_PROXY: 'socks5://benim:1' }, { Http_Proxy: 'http://benim:1' }]) {
    assert.deepEqual(withSystemProxy({ ...mine }, 'http://proxy:8080'), mine, JSON.stringify(mine));
  }
  // Their list is kept and this computer added to it: a model server here is not asked for through the proxy
  // because the person listed their company's own addresses (the second review, R2S-3).
  const listed = withSystemProxy({ no_proxy: 'ic.sirket.local' }, 'http://proxy:8080');
  assert.equal(listed.no_proxy, 'ic.sirket.local,localhost,127.0.0.1,::1');
  assert.equal(listed.NO_PROXY, undefined, 'under the name they used');
  assert.equal(withSystemProxy({ NO_PROXY: 'localhost,ic.sirket.local' }, 'http://proxy:8080').NO_PROXY, 'localhost,ic.sirket.local,127.0.0.1,::1', 'nothing said twice');
  assert.deepEqual(withSystemProxy({ HTTPS_PROXY: '' }, 'http://proxy:8080').HTTPS_PROXY, 'http://proxy:8080', 'an empty one is none');
});

test('no proxy in Windows: the environment is the person\'s own, as before', () => {
  const env = { PATH: 'p' };
  assert.equal(withSystemProxy(env, null), env);
});

test('a person who wants none of it says so once: CORTEX_NO_SYSTEM_PROXY', () => {
  const env = { PATH: 'p', CORTEX_NO_SYSTEM_PROXY: '1' };
  assert.equal(withSystemProxy(env, 'http://proxy:8080'), env);
});

test('what Chromium answered is what childEnv hands on; an answer that fails keeps what was known', async () => {
  await learnSystemProxy(async () => 'PROXY proxy.sirket.local:8080; DIRECT');
  assert.equal(childEnv({}, { PATH: 'p' }).HTTPS_PROXY, 'http://proxy.sirket.local:8080');
  assert.equal(childEnv({ HTTPS_PROXY: 'http://ayri:1' }, { PATH: 'p' }).HTTPS_PROXY, 'http://ayri:1', 'what a caller asks for wins');
  await learnSystemProxy(async () => {
    throw new Error('the session is gone');
  });
  assert.equal(childEnv({}, { PATH: 'p' }).HTTPS_PROXY, 'http://proxy.sirket.local:8080', 'kept');
  await learnSystemProxy(async () => 'DIRECT');
  assert.equal(childEnv({}, { PATH: 'p' }).HTTPS_PROXY, undefined, 'home again: none');
});

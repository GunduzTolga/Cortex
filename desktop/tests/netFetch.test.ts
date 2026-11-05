import { strict as assert } from 'node:assert';
import http from 'node:http';
import test from 'node:test';
import { netCalls } from 'electron';
import { netFetch } from '../electron/services/netFetch';

/**
 * The main process's requests go through Chromium (Windows' proxy and certificates), never from its HTTP cache: GitHub
 * answers `private, max-age=60`, and a repository list read again after "Yeni repo aç" came back without the new one.
 */
test('a request goes through Chromium, asked of the server every time, with what its caller gave', async () => {
  const server = http.createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const answer = await netFetch(`http://127.0.0.1:${port}/x`, { headers: { Accept: 'application/json' }, cache: 'force-cache' } as RequestInit);
    assert.deepEqual(await answer.json(), { ok: true });
    const [url, init] = netCalls.at(-1) as [string, RequestInit];
    assert.equal(url, `http://127.0.0.1:${port}/x`);
    assert.equal(init.cache, 'no-store', 'never from the cache, whatever the caller asked');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
  } finally {
    server.close();
  }
});

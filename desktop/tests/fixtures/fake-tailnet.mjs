// A stand-in for tools/cortex-tailnet (electron/services/tailnet.ts, tests/tailnet.test.ts): the same contract - settings
// from CORTEX_TAILNET_* in its environment, the auth key on the first line of stdin, one JSON line on stdout, a proxy on
// 127.0.0.1 that wants X-Cortex-Tailnet: <token>, alive until stdin closes - with no tailnet behind it. The proxy
// forwards to FAKE_TAILNET_UPSTREAM (a stand-in for the agent) instead of CORTEX_TAILNET_TARGET.
//
// FAKE_TAILNET_MODE: ready | error (says {"error":"baglanamadi"}) | silent (says nothing) | crash-once (ready, then
// gone once; ready again after) | crash-always (ready, then gone, every time) | exit (gone before a word).
// FAKE_TAILNET_LOG: a file each start appends a JSON line to: its command, argv, environment and the first stdin line.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const command = process.argv[2];
const mode = process.env.FAKE_TAILNET_MODE || 'ready';
const log = (entry) => {
  if (process.env.FAKE_TAILNET_LOG) fs.appendFileSync(process.env.FAKE_TAILNET_LOG, `${JSON.stringify(entry)}\n`);
};
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command === 'logout') {
  log({ command, argv: process.argv.slice(2), env: process.env });
  say({ ok: true });
  process.exit(0);
}

let input = '';
let first = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const at = input.indexOf('\n');
  if (first === null && at >= 0) {
    first = input.slice(0, at);
    begin();
  }
});
// Cortex gone, or done with it: so is the helper.
process.stdin.on('end', () => process.exit(0));

function begin() {
  const dir = process.env.CORTEX_TAILNET_DIR;
  log({ command, argv: process.argv.slice(2), env: process.env, first, dirExists: Boolean(dir && fs.existsSync(dir)) });
  // A line on stderr, as tsnet's own: with a key in it, which the app must not log as it is.
  process.stderr.write(`fake tsnet: joining with ${first || 'saved state'}\n`);
  if (mode === 'exit') process.exit(3);
  if (mode === 'error') {
    say({ error: 'baglanamadi', message: "tailnet'e katılınamadı (süre doldu); kod kullanılmış ya da geçersiz olabilir" });
    process.exit(1);
  }
  if (mode === 'silent') return;
  const token = `tok${Math.random().toString(16).slice(2).padEnd(24, '0')}`;
  const upstream = new URL(process.env.FAKE_TAILNET_UPSTREAM || 'http://127.0.0.1:9');
  const server = http.createServer((request, response) => {
    if (request.headers['x-cortex-tailnet'] !== token) {
      response.writeHead(403);
      return response.end('yetkisiz');
    }
    const headers = { ...request.headers, host: upstream.host, 'x-fake-tailnet': '1' };
    delete headers['x-cortex-tailnet'];
    const out = http.request({ host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    out.on('error', () => {
      response.writeHead(502);
      response.end('sunucuya ulaşılamıyor');
    });
    request.pipe(out);
  });
  server.listen(0, '127.0.0.1', () => {
    say({ ready: true, port: server.address().port, token });
    const marker = path.join(dir || '.', 'crashed-once');
    if (mode === 'crash-always' || (mode === 'crash-once' && !fs.existsSync(marker))) {
      if (mode === 'crash-once') fs.writeFileSync(marker, '1');
      setTimeout(() => process.exit(2), 100);
    }
  });
}

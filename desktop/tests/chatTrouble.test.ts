import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatEvent, ChatPush } from '../shared/chat';
import { turkishOf } from '../shared/refusalsTr';
import { READY_MAX } from '../electron/services/acpChat';
import { cancelChat, forgetChats, onChatPush, openChat, sendChat, shutdownChats } from '../electron/services/chat';
import { type Turn, TurnFailure, failureEvent } from '../electron/services/chatKit';
import { IDLE, kindOfFailure, startFailure } from '../electron/services/claudeChat';
import { TURN_WAIT, localBackend } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';
import { memoryOff } from '../src/chat/memoryNote';
import { turnsOf } from '../src/chat/turns';
import { en } from '../src/i18n/en';
import { tr } from '../src/i18n/tr';

/**
 * What the chat says when its tool is in trouble, as a person who installed Cortex for the first time meets it (the
 * review of 10 November, S1-S10): a tool that cannot be started, no internet, a start that hangs, a model server
 * that is busy, a subscription's limit, a vault without its memory. Each was a chat that said "working", "stopped" or
 * "could not be completed", with no word of why or of what to do.
 */

const CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
const AGENT = path.resolve('tests/fixtures/fake-acp-agent.mjs');
const CODEX = path.resolve('tests/fixtures/fake-codex.mjs');
const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const pushes: ChatPush[] = [];
onChatPush((message) => pushes.push(message));
const eventsOf = (chatId: string) => pushes.filter((one) => one.chatId === chatId && one.event).map((one) => one.event as ChatEvent);
async function until<T>(find: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 15));
  }
}
const doneOf = (chatId: string, after = 0) => until(() => eventsOf(chatId).slice(after).find((one) => one.type === 'done' || one.type === 'error'), 'the turn to end');
const noticesOf = (events: ChatEvent[]) => events.filter((one): one is Extract<ChatEvent, { type: 'notice' }> => one.type === 'notice').map((one) => one.notice);

function useVault(): { vault: string; log: string } {
  const vault = temp('trouble-vault-');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  const log = path.join(temp('trouble-log-'), 'tool.jsonl');
  process.env.CORTEX_TEST_CLAUDE = CLAUDE;
  process.env.CORTEX_TEST_AGENT = AGENT;
  process.env.CORTEX_TEST_CODEX = CODEX;
  process.env.FAKE_AGENT_LOG = log;
  return { vault, log };
}
const linesIn = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as { argv?: string[]; pid?: number; method?: string }) : []);
const starts = (log: string) => linesIn(log).filter((one) => one.argv);
const initializes = (log: string) => linesIn(log).filter((one) => one.method === 'initialize').length;
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.after(() => shutdownChats());

/* ------------------------------------------------------------------ */
/* S1: Claude Code cannot be started                                   */
/* ------------------------------------------------------------------ */

test('S1: why Claude Code could not be started is said by the system’s code, never by a path, and in Turkish', () => {
  const refused = startFailure(Object.assign(new Error('spawn C:\\Users\\ayse\\.local\\bin\\claude.exe EPERM'), { code: 'EPERM' }));
  assert.equal(refused.kind, 'not-started');
  assert.equal(refused.message, 'Claude Code could not start (EPERM).');
  assert.equal(turkishOf(refused.message), 'Claude Code başlatılamadı (sistem hatası: EPERM).');
  const unnamed = startFailure(new Error('something else'));
  assert.equal(unnamed.message, 'Claude Code could not start.', 'a failure with no code says no more than that');
  assert.equal(turkishOf(unnamed.message), 'Claude Code başlatılamadı.');
  // The sentence over it says what may be in the way and what to do, in both languages.
  assert.match(tr['chat.error.notStarted'], /antivirüs/i);
  assert.match(tr['chat.error.notStarted'], /yeniden kur/);
  assert.match(en['chat.error.notStarted'], /antivirus/i);
});

test('R2S: a limit of the conversation is not said to be the subscription’s, and a proxy’s refusal is not a sign-in to make', () => {
  // "limit reached" alone took every limit for the subscription's: a full context was answered with "wait for the
  // limit to come back", and the person waited for nothing (the second review, R2S-1).
  assert.equal(kindOfFailure('Context limit reached · /compact or /clear to continue'), null);
  assert.equal(kindOfFailure('Output token limit reached'), null);
  assert.equal(kindOfFailure('5-hour limit reached · resets 3pm'), 'limit');
  assert.equal(kindOfFailure('Weekly limit reached · resets Monday'), 'limit');
  assert.equal(kindOfFailure("You've hit your session limit · resets 4:40am"), 'limit');
  assert.equal(kindOfFailure('Claude usage limit reached.'), 'limit');
  // A company's proxy asking for its own password is the network's trouble, not Claude's sign-in (R2S-2).
  assert.equal(kindOfFailure('API Error: 407 Proxy Authentication Required'), 'network');
  assert.equal(kindOfFailure('OAuth token refresh failed: fetch failed'), 'network');
  assert.equal(kindOfFailure('OAuth token has expired. Please run /login'), 'auth', 'a sign-in that ended is still one to make');
  assert.equal(kindOfFailure('Not logged in · Please run /login'), 'auth');
});

test('S1: a Claude Code that cannot be started says so in the chat, not that it "stopped"', async () => {
  const { vault } = useVault();
  // The folder it is started in is gone: the system refuses the start, and tells it as an `error` after the start was asked for.
  fs.rmSync(vault, { recursive: true, force: true });
  const { id } = sendChat(null, 'test-claude', 'merhaba');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error', JSON.stringify(failed));
  // Not "an antivirus may be blocking it": nothing is blocked, the folder is not there (the second review, R2S-7).
  assert.equal(failed.kind, 'not-found', JSON.stringify(failed));
  assert.match(failed.message, /^Claude Code could not start \(ENOENT\)\.$/);
  assert.match(tr['chat.error.notFound'], /kasa/i);
  assert.match(tr['chat.error.notFound'], /yeniden kur/);
  assert.doesNotMatch(tr['chat.error.notFound'], /antivirüs/i);
  assert.match(en['chat.error.notFound'], /vault/i);
  assert.notEqual(turkishOf(failed.message), failed.message, 'said in Turkish in a Turkish window');
  assert.equal(openChat(id).running, false);
});

test('S1: a start the system refuses at once is said the same way', { skip: process.platform === 'win32' }, async () => {
  useVault();
  // An environment larger than a program may be started with: the start is refused as it is asked for (E2BIG), thrown rather than told later.
  process.env.CORTEX_TEST_HUGE = 'x'.repeat(4 * 1024 * 1024);
  try {
    const { id } = sendChat(null, 'test-claude', 'merhaba');
    const failed = await doneOf(id);
    assert.ok(failed.type === 'error' && failed.kind === 'not-started', JSON.stringify(failed).slice(0, 300));
    assert.match(failed.message, /^Claude Code could not start \([A-Z0-9_]+\)\.$/);
  } finally {
    delete process.env.CORTEX_TEST_HUGE;
  }
});

/* ------------------------------------------------------------------ */
/* S3, S10: no internet, a provider that is busy, a limit used up      */
/* ------------------------------------------------------------------ */

test('S3, S10: a failed turn’s sentence is told apart: no connection, a subscription’s limit, a balance, a sign-in', () => {
  for (const said of ['API Error: Connection error.', 'Unable to connect to API (ENOTFOUND)', 'request to https://api.anthropic.com/v1/messages failed, reason: connect ETIMEDOUT 160.79.104.10:443', 'TypeError: fetch failed', 'read ECONNRESET', 'connect ECONNREFUSED 127.0.0.1:8080']) {
    assert.equal(kindOfFailure(said), 'network', said);
  }
  // A sign-in that could not be renewed for want of a connection is a connection to mend, not a sign-in to make again.
  assert.equal(kindOfFailure('Failed to refresh OAuth token: getaddrinfo ENOTFOUND console.anthropic.com'), 'network');
  for (const said of ['You’ve hit your session limit · resets 3pm (Europe/Istanbul)', 'Claude AI usage limit reached|1762800000', '5-hour limit reached ∙ resets 5pm', 'You’ve hit your weekly limit · resets Nov 14', 'Weekly limit reached']) {
    assert.equal(kindOfFailure(said), 'limit', said);
  }
  assert.equal(kindOfFailure('Credit balance is too low'), 'provider.quota');
  assert.equal(kindOfFailure('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'), 'provider.quota');
  assert.equal(kindOfFailure('Rate limit reached for requests'), 'provider.quota', 'a rate limit stays what it was');
  assert.equal(kindOfFailure('Failed to authenticate. API Error: 401 OAuth access token is invalid.'), 'auth');
  assert.equal(kindOfFailure('The model produced no output.'), null);
  // What each is said as: when the limit comes back and what to do meanwhile; what to check with no connection.
  assert.match(tr['chat.error.limit'], /yenilenince/);
  assert.match(tr['chat.error.limit'], /başka bir araç ya da model/);
  assert.match(tr['chat.error.network'], /bağlantını kontrol/);
  assert.match(tr['chat.error.network'], /proxy/);
});

test('S3: with no internet the chat says Claude Code is trying again, once, and the turn ends as a connection that failed', async () => {
  useVault();
  const hold = path.join(temp('trouble-hold-'), 'go');
  process.env.FAKE_CLAUDE_HOLD = hold;
  try {
    const { id } = sendChat(null, 'test-claude', 'kopuk');
    await until(() => noticesOf(eventsOf(id)).includes('retry-network'), 'the retry to be said');
    // While it tries again the answer reads as that, not as "working".
    assert.equal(turnsOf(eventsOf(id)).at(-1)?.retrying, 'network');
    fs.writeFileSync(hold, '');
    const failed = await doneOf(id);
    assert.ok(failed.type === 'error' && failed.kind === 'network', JSON.stringify(failed));
    assert.deepEqual(noticesOf(eventsOf(id)), ['retry-network'], 'two tries in a row, said once');
    assert.equal(turnsOf(eventsOf(id)).at(-1)?.retrying, null, 'over once the turn has ended');
  } finally {
    delete process.env.FAKE_CLAUDE_HOLD;
  }
});

test('S3: a provider that is busy is said as that while Claude Code tries again, and no more once the answer comes', async () => {
  useVault();
  const { id } = sendChat(null, 'test-claude', 'yoğun');
  assert.deepEqual(await doneOf(id), { type: 'done', reason: 'end_turn' });
  const events = eventsOf(id);
  assert.deepEqual(noticesOf(events), ['retry-busy']);
  const at = events.findIndex((one) => one.type === 'notice');
  assert.equal(turnsOf(events.slice(0, at + 1)).at(-1)?.retrying, 'busy', 'said while it tries');
  const next = events.findIndex((one, index) => index > at && (one.type === 'thought' || one.type === 'text' || one.type === 'tool'));
  assert.ok(next > at, 'the answer went on');
  assert.equal(turnsOf(events.slice(0, next + 1)).at(-1)?.retrying, null, 'gone with the first word of the answer');
  assert.deepEqual(turnsOf(events).at(-1)?.notices, [], 'not kept as a line on the answer');
});

test('S10: a subscription’s limit is told as a limit that comes back, the tool’s own line kept as the detail', async () => {
  useVault();
  const { id } = sendChat(null, 'test-claude', 'limit');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error' && failed.kind === 'limit', JSON.stringify(failed));
  assert.match(failed.message, /resets 3pm/, 'its own words, with when it resets, under the sentence');
});

test('S10: Codex’s own name for its plan’s limit is told the same way', async () => {
  useVault();
  const { id } = sendChat(null, 'test-codex', 'limit');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error' && failed.kind === 'limit', JSON.stringify(failed));
});

test('S3: another tool whose provider was not reached is said the same way; a model server on this machine is not', async () => {
  useVault();
  const { id } = sendChat(null, 'test', 'ağsız');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error' && failed.kind === 'network', JSON.stringify(failed));
  const plain = (text: string) => text;
  // A kind its backend gave stands; a model server's failure is never "the internet".
  assert.equal((failureEvent(new TurnFailure('connect ETIMEDOUT 10.0.0.1:443', 'auth'), plain, true) as { kind: string | null }).kind, 'auth');
  assert.equal((failureEvent(new Error('connect ETIMEDOUT 127.0.0.1:1234'), plain, false) as { kind: string | null }).kind, null);
  assert.equal((failureEvent(new Error('connect ETIMEDOUT 10.0.0.1:443'), plain, true) as { kind: string | null }).kind, 'network');
});

/* ------------------------------------------------------------------ */
/* S9: a program left with no message                                  */
/* ------------------------------------------------------------------ */

test('S9: Claude Code left with no message is ended, and the next message goes on in the same session; a turn is never ended for it', async () => {
  const idle = IDLE.ms;
  IDLE.ms = 400;
  try {
    const { log } = useVault();
    const { id } = sendChat(null, 'test-claude', 'merhaba');
    assert.deepEqual(await doneOf(id), { type: 'done', reason: 'end_turn' });
    const first = starts(log)[0].pid as number;
    await until(() => !running(first), 'the idle program to be ended', 5000);

    const before = eventsOf(id).length;
    sendChat(id, 'test-claude', 'yavaş olsun');
    await until(() => eventsOf(id).slice(before).some((one) => one.type === 'text' && one.text.startsWith('Uzun')), 'the slow answer');
    const again = starts(log)[1];
    assert.deepEqual(again.argv?.slice(-2), ['--resume', `claude-ses-${first}`], 'started again on the chat’s session');
    // A turn longer than the idle time is a turn, not idleness.
    await new Promise((done) => setTimeout(done, IDLE.ms * 3));
    assert.equal(running(again.pid as number), true, 'not ended under its turn');
    assert.equal(openChat(id).running, true);
    cancelChat(id);
    assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'cancelled' });
    assert.equal(starts(log).length, 2);
  } finally {
    IDLE.ms = idle;
    forgetChats();
  }
});

/* ------------------------------------------------------------------ */
/* S5: an ACP tool stuck in its start                                  */
/* ------------------------------------------------------------------ */

test('S5: Stop on a tool stuck in its start ends that program: the next message starts a new one', async () => {
  const { log } = useVault();
  shutdownChats();
  process.env.FAKE_ACP_HANG_INIT = '1';
  let id: string;
  try {
    id = sendChat(null, 'test', 'merhaba').id;
    await until(() => initializes(log) === 1, 'the stuck program to be asked');
    cancelChat(id);
    assert.deepEqual(await doneOf(id), { type: 'done', reason: 'cancelled' });
  } finally {
    delete process.env.FAKE_ACP_HANG_INIT;
  }
  // The tool starts as it should now; the stuck one is not waited on.
  const before = eventsOf(id).length;
  sendChat(id, 'test', 'tekrar');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' });
  assert.equal(initializes(log), 2, 'a new program, asked anew');
  shutdownChats();
});

test('S5: a tool that never finishes starting is given up on after a while, said so, and started anew at the next message', async () => {
  const { log } = useVault();
  shutdownChats();
  const wait = READY_MAX.ms;
  READY_MAX.ms = 400;
  process.env.FAKE_ACP_HANG_INIT = '1';
  let id: string;
  try {
    id = sendChat(null, 'test', 'merhaba').id;
    const failed = await doneOf(id);
    assert.ok(failed.type === 'error' && failed.kind === 'start-timeout', JSON.stringify(failed));
    assert.notEqual(turkishOf(failed.message), failed.message, 'said in Turkish in a Turkish window');
    assert.match(tr['chat.error.startTimeout'], /yeniden yaz/);
  } finally {
    delete process.env.FAKE_ACP_HANG_INIT;
    READY_MAX.ms = wait;
  }
  const before = eventsOf(id).length;
  sendChat(id, 'test', 'tekrar');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' });
  assert.equal(initializes(log), 2);
  shutdownChats();
});

/* ------------------------------------------------------------------ */
/* S6: a model server that is slow to answer                           */
/* ------------------------------------------------------------------ */

/** A stand-in for LM Studio that says what models it has only after `delay` ms (never, with null), and answers a message at once. */
async function slowServer(delay: number | null): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/api/v0/models') {
        if (delay === null) return;
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'qwen3-8b', type: 'llm', state: 'loaded', loaded_context_length: 16384 }] }));
        }, delay);
        return;
      }
      if (request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Buradayım.' } }] })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      if (delay === null) return;
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function localTurn(chatId: string): { turn: Turn; events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  const turn: Turn = {
    chatId,
    cli: 'lmstudio',
    vault: temp('trouble-local-'),
    sessionId: null,
    attachments: [],
    number: 1,
    prefs: {},
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    setOptions: () => undefined,
    setSession: () => undefined,
    setTitle: () => undefined,
    ask: async () => null,
  };
  return { turn, events };
}

test('S6: a model server slower than the tools’ list waits for is still answered by, not called off', async () => {
  // Slower than the 400 ms a status is given; a server loading a model, or answering another request.
  const { server, base } = await slowServer(900);
  process.env.CORTEX_TEST_LMSTUDIO = base;
  const chatId = '00000000-0000-4000-8000-0000000000a1';
  try {
    const { turn, events } = localTurn(chatId);
    assert.equal(await localBackend.run(turn, 'merhaba'), 'end_turn');
    assert.ok(events.some((one) => one.type === 'text' && one.text === 'Buradayım.'));
  } finally {
    delete process.env.CORTEX_TEST_LMSTUDIO;
    localBackend.forget(chatId);
    server.closeAllConnections();
    server.close();
  }
});

test('S6: a model server that is there and does not answer in time is said to be busy, not off', async () => {
  const { server, base } = await slowServer(null);
  const wait = TURN_WAIT.ms;
  TURN_WAIT.ms = 300;
  process.env.CORTEX_TEST_LMSTUDIO = base;
  try {
    const { turn } = localTurn('00000000-0000-4000-8000-0000000000a2');
    await assert.rejects(localBackend.run(turn, 'merhaba'), (err: Error & { kind?: string }) => {
      assert.equal(err.kind, 'local-busy', err.message);
      assert.match(err.message, /^LM Studio did not answer in time/);
      assert.match(turkishOf(err.message), /^LM Studio zamanında cevap vermedi: meşgul olabilir\./);
      return true;
    });
    assert.match(tr['chat.error.localBusy'], /meşgul olabilir/);
    // One that is off is still said to be off.
    process.env.CORTEX_TEST_LMSTUDIO = 'http://127.0.0.1:9';
    await assert.rejects(localBackend.run(localTurn('00000000-0000-4000-8000-0000000000a3').turn, 'merhaba'), (err: Error & { kind?: string }) => err.kind === 'local-off');
  } finally {
    TURN_WAIT.ms = wait;
    delete process.env.CORTEX_TEST_LMSTUDIO;
    server.closeAllConnections();
    server.close();
  }
});

/* ------------------------------------------------------------------ */
/* S8: a chat without the vault's memory                               */
/* ------------------------------------------------------------------ */

test('S8: the chat says its memory is off while the vault has no engine or no Python runs it, and only then', () => {
  const engine = { installed: '1.0.61', bundled: '1.0.61', legacy: false, stale: false };
  const ready = { python: true, vault: true, engine };
  assert.equal(memoryOff(ready, 'claude'), false);
  assert.equal(memoryOff({ ...ready, engine: { ...engine, installed: null } }, 'claude'), true, 'no engine in the vault');
  assert.equal(memoryOff({ ...ready, python: false }, 'opencode'), true, 'no Python to run it');
  assert.equal(memoryOff({ ...ready, python: false }, 'lmstudio'), true, 'a model server’s memory comes from the same hook');
  assert.equal(memoryOff({ ...ready, python: false }, null), true, 'said before a tool is chosen too');
  assert.equal(memoryOff(null, 'claude'), false, 'not before the setup’s status is known');
  assert.equal(memoryOff({ ...ready, vault: false, python: false }, 'claude'), false, 'no vault yet: the first-run screen’s to say');
  assert.equal(memoryOff({ ...ready, python: false }, 'hermes'), false, 'Pyn on a server has the server’s memory');
  // While the app itself is setting the engine up, "finish the setup in Settings" is not said (R2S-8).
  assert.equal(memoryOff({ ...ready, engine: { ...engine, installed: null }, job: 'engine' }, 'claude'), false, 'being set up now');
  assert.equal(memoryOff({ ...ready, engine: { ...engine, installed: null }, job: null }, 'claude'), true);
  assert.match(tr['chat.notice.memoryOff'], /^Hafıza kapalı: kurulum tamamlanmamış/);
  assert.match(tr['chat.notice.memoryOff'], /Ayarlar › Cortex/);
  assert.match(en['chat.notice.memoryOff'], /^Memory is off/);
});

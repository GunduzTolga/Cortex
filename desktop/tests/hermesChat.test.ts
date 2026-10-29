import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import type { ChatEvent, ChatPush, ConfigOption } from '../shared/chat';
import { hermesAddress } from '../shared/hermes';
import { beginChat, cancelChat, offerChat, onChatPush, openChat, sendChat } from '../electron/services/chat';
import type { Between, Card, Turn } from '../electron/services/chatKit';
import { listClis } from '../electron/services/clis';
import { forgetHermes, hermesBackend, hermesStatus, saveHermes, sseReader, testHermes } from '../electron/services/hermesChat';
import { updateSettings } from '../electron/services/settings';

/**
 * The chat with a Hermes Agent on another machine, through its gateway's API
 * server (electron/services/hermesChat.ts). The server here is a stand-in
 * that answers as Hermes's does (gateway/platforms/api_server.py): its
 * sessions, a turn streamed as server-sent events, a command's approval and
 * a run's stop at `/v1/runs/{run}/...`, every route also under `/p/<profile>/`.
 */

const KEY = 'hermes-test-key-0123456789abcdef';

interface Seen {
  method: string;
  path: string;
  profile: string | null;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}

/** How a turn's stream goes: what it writes, given a way to write an event, to wait for an approval or a stop, and to end. */
type Script = (io: { send: (name: string, data?: Record<string, unknown>) => void; approval: () => Promise<Record<string, unknown>>; stopped: () => Promise<void>; end: () => void }) => Promise<void> | void;

const answered: Script = ({ send, end }) => {
  send('run.started', { user_message: { role: 'user', content: 'x' } });
  send('message.started', { message: { id: 'msg_1', role: 'assistant' } });
  send('tool.progress', { tool_name: '_thinking', delta: 'kısaca düşündüm' });
  send('assistant.delta', { delta: 'Bakıyorum.' });
  send('tool.started', { tool_name: 'terminal', preview: 'ls -la', args: { command: 'ls -la' } });
  send('tool.completed', { tool_name: 'terminal', preview: 'a.txt\nb.txt' });
  send('assistant.delta', { delta: 'Merhaba, ' });
  send('assistant.delta', { delta: 'ben Hermes.' });
  send('assistant.completed', { content: 'Bakıyorum.Merhaba, ben Hermes.', completed: true, partial: false, interrupted: false });
  send('run.completed', { completed: true, partial: false, interrupted: false, usage: {} });
  send('done');
  end();
};

async function standIn(options: { refuseKey?: boolean } = {}) {
  const seen: Seen[] = [];
  const sessions: Array<Record<string, unknown>> = [];
  const messages = new Map<string, unknown[]>();
  let script: Script = answered;
  let runs = 0;
  const approvals: Array<(body: Record<string, unknown>) => void> = [];
  const stops: Array<() => void> = [];

  const json = (response: http.ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://x');
      const profiled = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
      const route = profiled ? profiled[2] : url.pathname;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      seen.push({ method: request.method ?? '', path: route, profile: profiled?.[1] ?? null, auth: request.headers.authorization, body });
      if (options.refuseKey || request.headers.authorization !== `Bearer ${KEY}`) {
        return json(response, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      if (request.method === 'GET' && route === '/api/sessions') return json(response, 200, { object: 'list', data: sessions, limit: 20, offset: 0, has_more: false });
      if (request.method === 'POST' && route === '/api/sessions') {
        const id = `api_${sessions.length + 1}`;
        const session = { id, title: body?.title ?? null, source: body?.source ?? 'api_server', started_at: Date.now() / 1000, last_active: Date.now() / 1000, preview: null };
        sessions.unshift(session);
        messages.set(id, []);
        return json(response, 201, { object: 'hermes.session', session });
      }
      const messagesOf = /^\/api\/sessions\/([^/]+)\/messages$/.exec(route);
      if (request.method === 'GET' && messagesOf) {
        const id = decodeURIComponent(messagesOf[1]);
        if (!messages.has(id)) return json(response, 404, { error: { message: `Session not found: ${id}`, code: 'session_not_found' } });
        return json(response, 200, { object: 'list', session_id: id, data: messages.get(id) });
      }
      const streamOf = /^\/api\/sessions\/([^/]+)\/chat\/stream$/.exec(route);
      if (request.method === 'POST' && streamOf) {
        const id = decodeURIComponent(streamOf[1]);
        if (!messages.has(id)) return json(response, 404, { error: { message: `Session not found: ${id}`, code: 'session_not_found' } });
        const runId = `run_${++runs}`;
        let seq = 0;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        void script({
          send: (name, data = {}) => response.write(`event: ${name}\ndata: ${JSON.stringify({ session_id: id, run_id: runId, seq: ++seq, ts: Date.now() / 1000, ...data })}\n\n`),
          approval: () => new Promise((done) => approvals.push(done)),
          stopped: () => new Promise((done) => stops.push(done)),
          end: () => response.end(),
        });
        return;
      }
      const approvalOf = /^\/v1\/runs\/([^/]+)\/approval$/.exec(route);
      if (request.method === 'POST' && approvalOf) {
        approvals.shift()?.(body ?? {});
        return json(response, 200, { object: 'hermes.run.approval_response', run_id: approvalOf[1], choice: body?.choice, resolved: 1 });
      }
      const stopOf = /^\/v1\/runs\/([^/]+)\/stop$/.exec(route);
      if (request.method === 'POST' && stopOf) {
        json(response, 200, { run_id: stopOf[1], status: 'stopping' });
        stops.shift()?.();
        return;
      }
      json(response, 404, { error: { message: 'Not found' } });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    server,
    seen,
    sessions,
    messages,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    script: (next: Script) => (script = next),
  };
}

function fakeTurn(sessionId: string | null = null, answer: (card: Card) => string | null = () => null) {
  const events: ChatEvent[] = [];
  const cards: Card[] = [];
  let options: ConfigOption[] = [];
  let session = sessionId;
  const stop = new AbortController();
  const turn: Turn = {
    chatId: `chat-${Math.random()}`,
    cli: 'hermes',
    vault: fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')),
    sessionId,
    number: 1,
    prefs: {},
    signal: stop.signal,
    emit: (event) => events.push(event),
    setOptions: (next) => (options = next),
    setSession: (id) => (session = id),
    setTitle: () => undefined,
    ask: async (card) => {
      cards.push(card);
      return answer(card);
    },
  };
  return { turn, events, cards, stop, options: () => options, session: () => session };
}

const words = (events: ChatEvent[]) =>
  events
    .filter((one): one is Extract<ChatEvent, { type: 'text' }> => one.type === 'text')
    .map((one) => one.text)
    .join('');

/** Nothing the window is told carries the key: not an event, not a failure, not the status. */
const keyless = (what: unknown) => assert.ok(!JSON.stringify(what).includes(KEY), 'the key is in what the window is told');

async function until<T>(find: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() - started > ms) throw new Error(`Waited for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test('an address is kept as http(s)://host[:port][/path]; anything else is not one', () => {
  assert.equal(hermesAddress(' https://host:8642/ '), 'https://host:8642');
  assert.equal(hermesAddress('http://host:8642/gateway//'), 'http://host:8642/gateway');
  for (const bad of ['', 'host:8642', 'ftp://host', 'https://user:pass@host', 'https://host/?a=1', 'https://host/#x', 'https://ho st']) assert.equal(hermesAddress(bad), null, bad);
});

test('set up: the address and the profile kept, the key kept encrypted and never told back; Hermes offered in the chat only then', async () => {
  forgetHermes();
  assert.equal(listClis({ PATH: '' }).some((one) => one.id === 'hermes'), false, 'not offered before an address is given');
  assert.throws(() => saveHermes({ url: 'not an address', key: KEY }), /not the address of a Pyn server/);
  assert.throws(() => saveHermes({ url: 'https://host:8642' }), /needs its API key/);
  assert.throws(() => saveHermes({ url: 'https://host:8642', key: KEY, profile: 'a/b' }), /not the name of a profile/);
  const status = saveHermes({ url: 'https://host:8642/', profile: '/p/work/', key: KEY });
  assert.deepEqual(status, { url: 'https://host:8642', profile: 'work', key: true });
  keyless(status);
  keyless(hermesStatus());
  // Written encrypted, never as it was given.
  assert.ok(!fs.readFileSync(path.join(app.getPath('userData'), 'keys.json'), 'utf8').includes(KEY));
  assert.ok(!fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8').includes(KEY));
  // The key left out: the one kept stays.
  assert.equal(saveHermes({ url: 'https://other:8642', profile: '' }).key, true);
  assert.ok(listClis({ PATH: '' }).some((one) => one.id === 'hermes' && one.available));
  assert.deepEqual(forgetHermes(), { url: null, profile: null, key: false });
});

test('server-sent events are read across pieces, keepalives and CRLF ignored', () => {
  const got: Array<[string, Record<string, unknown>]> = [];
  const reader = sseReader((name, data) => got.push([name, data]));
  for (const piece of [': keepalive\n\n', 'event: assistant.de', 'lta\r\ndata: {"delta":"Mer', 'haba"}\r\n\r\n', 'data: {"event":"x","a":1}\n', '\n', 'event: bad\ndata: not json\n\n', 'event: done\ndata: {}']) reader.feed(piece);
  reader.end();
  assert.deepEqual(got, [
    ['assistant.delta', { delta: 'Merhaba' }],
    ['x', { event: 'x', a: 1 }],
    ['done', {}],
  ]);
});

test('a new chat begins a Hermes session marked as Cortex’s; the answer, its thinking and its steps are streamed in', async () => {
  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, key: KEY });
    const { turn, events, session, options } = fakeTurn();
    assert.equal(await hermesBackend.run(turn, 'merhaba Hermes'), 'end_turn');
    const created = fake.seen.find((one) => one.method === 'POST' && one.path === '/api/sessions');
    assert.equal(created?.body?.source, 'cortex-desktop');
    assert.match(String(created?.body?.title), /^merhaba Hermes · /);
    assert.equal(session(), 'api_1');
    const stream = fake.seen.find((one) => one.path === '/api/sessions/api_1/chat/stream');
    assert.deepEqual(stream?.body, { input: 'merhaba Hermes' });
    // Every request carries the key, as Hermes asks it; it is sent to this address only.
    assert.ok(fake.seen.every((one) => one.auth === `Bearer ${KEY}`));
    assert.equal(words(events), 'Bakıyorum.Merhaba, ben Hermes.', 'the whole answer once: not again from assistant.completed');
    const texts = events.filter((one) => one.type === 'text') as Array<{ id: string }>;
    assert.notEqual(texts[0].id, texts[texts.length - 1].id, 'the words after a step are a message of their own');
    assert.ok(events.some((one) => one.type === 'thought' && one.text === 'kısaca düşündüm'));
    const steps = events.filter((one) => one.type === 'tool') as Array<Extract<ChatEvent, { type: 'tool' }>>;
    assert.equal(steps.length, 2);
    assert.equal(steps[0].id, steps[1].id, 'the end is told on the step it ends');
    assert.equal(steps[0].title, 'terminal: ls -la');
    assert.equal(steps[0].kind, 'execute');
    assert.equal(steps[1].status, 'completed');
    assert.equal(steps[1].output, 'a.txt\nb.txt');
    // The session chip: a new one, then Hermes's own, this chat's chosen.
    assert.equal(options()[0].id, 'session');
    assert.equal(options()[0].current, 'api_1');
    assert.deepEqual(
      options()[0].choices.map((one) => one.value),
      ['new', 'api_1'],
    );
    keyless(events);

    // The next turn goes on in the same session: none begun.
    const next = fakeTurn('api_1');
    assert.equal(await hermesBackend.run(next.turn, 'devam'), 'end_turn');
    assert.equal(fake.seen.filter((one) => one.method === 'POST' && one.path === '/api/sessions').length, 1);
  } finally {
    fake.server.close();
  }
});

test('the profile’s path is put before every route', async () => {
  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, profile: 'work', key: KEY });
    assert.deepEqual(await testHermes(), { sessions: 0 });
    const { turn } = fakeTurn();
    assert.equal(await hermesBackend.run(turn, 'selam'), 'end_turn');
    assert.ok(fake.seen.length >= 3);
    assert.ok(fake.seen.every((one) => one.profile === 'work'));
  } finally {
    saveHermes({ url: fake.base, profile: '' });
    fake.server.close();
  }
});

test('a session begun elsewhere is continued: chosen before the first message, its last messages shown, the next message sent into it', async () => {
  const fake = await standIn();
  const pushes: ChatPush[] = [];
  onChatPush((push) => pushes.push(push));
  try {
    saveHermes({ url: fake.base, key: KEY });
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-'));
    updateSettings((settings) => {
      settings.vault = vault;
    });
    // On the phone: a session with a conversation in it, and a child of Hermes's own, never listed.
    fake.sessions.push({ id: 'api_phone', title: 'Telefondan', source: 'api_server', last_active: 1_700_000_000, preview: 'yarın' });
    fake.sessions.push({ id: 'api_child', title: 'alt', is_internal_child: true });
    fake.messages.set('api_phone', [
      { id: 1, role: 'user', content: 'Yarın ne var?', timestamp: 1_700_000_000 },
      { id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      { id: 3, role: 'tool', content: '{"ok":true}' },
      { id: 4, role: 'assistant', content: [{ type: 'text', text: 'Saat 10’da toplantı var.' }] },
      { id: 5, role: 'user', content: 'özetlenmiş geçmiş', display_kind: 'hidden' },
    ]);

    const [offered] = await offerChat('hermes');
    assert.equal(offered.id, 'session');
    assert.equal(offered.current, 'new');
    assert.deepEqual(
      offered.choices.map((one) => one.value),
      ['new', 'api_phone'],
    );
    assert.deepEqual(await offerChat('claude'), [], 'an engine with nothing to offer before a message offers nothing');

    const { id } = await beginChat('hermes', 'session', 'api_phone');
    const opened = openChat(id);
    assert.match(opened.chat.title, /^Telefondan/);
    assert.equal(opened.options[0].current, 'api_phone');
    // Where it left off: the person's question and Hermes's answer; the tools' exchange and what Hermes hides left out.
    assert.deepEqual(
      opened.events.map((one) => (one.type === 'user' || one.type === 'text' ? [one.type, one.text] : [one.type])),
      [
        ['user', 'Yarın ne var?'],
        ['text', 'Saat 10’da toplantı var.'],
      ],
    );
    assert.equal(fake.seen.filter((one) => one.method === 'POST' && one.path === '/api/sessions').length, 0, 'no session begun to continue one');

    sendChat(id, 'hermes', 've sonra?');
    await until(() => pushes.some((one) => one.chatId === id && one.event?.type === 'done'), 'the answer');
    const stream = fake.seen.find((one) => one.path === '/api/sessions/api_phone/chat/stream');
    assert.deepEqual(stream?.body, { input: 've sonra?' });
    assert.equal(fake.seen.filter((one) => one.method === 'POST' && one.path === '/api/sessions').length, 0);
    keyless(pushes);
    keyless(openChat(id));

    // A session Hermes does not list is not begun on.
    await assert.rejects(beginChat('hermes', 'session', 'api_nowhere'), /Not a choice this chat offers/);
    assert.equal(
      openChat(id).events.filter((one) => one.type === 'user').length,
      2,
      'the chat holds what it showed and what was written',
    );
  } finally {
    onChatPush(() => undefined);
    fake.server.close();
  }
});

test('a session chosen in a chat binds it, and a session deleted in Hermes is begun anew, said so', async () => {
  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, key: KEY });
    fake.sessions.push({ id: 'api_old', title: 'eski', last_active: 1_700_000_000 });
    fake.messages.set('api_old', [{ role: 'user', content: 'eski soru' }]);
    const shown: ChatEvent[] = [];
    let bound: string | null = 'api_mine';
    const between: Between = { emit: (event) => shown.push(event), setSession: (one) => (bound = one) };
    const [offered] = await hermesBackend.offer!('api_mine');
    assert.equal(offered.current, 'api_mine');
    assert.equal(offered.choices[1].value, 'api_mine', 'this chat’s own session listed even where Hermes no longer lists it');
    const next = await hermesBackend.setOption('c', [offered], 'session', 'api_old', between);
    assert.equal(next[0].current, 'api_old');
    assert.equal(bound, 'api_old');
    assert.deepEqual(shown.map((one) => one.type), ['user']);
    await hermesBackend.setOption('c', next, 'session', 'new', between);
    assert.equal(bound, null, '"new": the next message begins a session');

    // Deleted in Hermes since: the message goes to a new session.
    const { turn, events, session } = fakeTurn('api_deleted');
    assert.equal(await hermesBackend.run(turn, 'hâlâ orada mısın'), 'end_turn');
    assert.equal(session(), fake.sessions[0].id);
    assert.notEqual(session(), 'api_deleted');
    assert.ok(events.some((one) => one.type === 'notice' && one.notice === 'new-session'));
  } finally {
    fake.server.close();
  }
});

test('a command Hermes asks leave for is a card; the choice goes back to the run, and the answer goes on', async () => {
  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, key: KEY });
    let approval: Record<string, unknown> | null = null;
    fake.script(async ({ send, approval: waitApproval, end }) => {
      send('approval.request', { request_id: 'req-1', command: 'rm -rf build', description: 'recursive delete', pattern_key: 'rm', choices: ['once', 'session', 'always', 'deny'] });
      approval = await waitApproval();
      send('tool.started', { tool_name: 'terminal', preview: 'rm -rf build' });
      send('tool.completed', { tool_name: 'terminal', preview: '' });
      send('assistant.delta', { delta: 'Silindi.' });
      send('run.completed', { completed: true });
      send('done');
      end();
    });
    const { turn, events, cards } = fakeTurn(null, (card) => card.options.find((one) => one.id === 'session')?.id ?? null);
    assert.equal(await hermesBackend.run(turn, 'build klasörünü sil'), 'end_turn');
    assert.equal(cards.length, 1);
    assert.match(cards[0].title, /recursive delete/);
    assert.match(cards[0].title, /rm -rf build/);
    assert.deepEqual(
      cards[0].options.map((one) => [one.id, one.kind]),
      [
        ['once', 'allow_once'],
        ['session', 'allow_always'],
        ['always', 'allow_always'],
        ['deny', 'reject_once'],
      ],
    );
    assert.deepEqual(approval, { choice: 'session', request_id: 'req-1' });
    assert.ok(fake.seen.some((one) => one.path === '/v1/runs/run_1/approval'));
    assert.equal(words(events), 'Silindi.');

    // No answer - the card refused, or the turn ended first: denied, never left waiting.
    fake.script(async ({ send, approval: waitApproval, end }) => {
      send('approval.request', { request_id: 'req-2', command: 'shutdown now', choices: ['once', 'deny'] });
      approval = await waitApproval();
      send('run.completed', { completed: true });
      end();
    });
    const refused = fakeTurn('api_1', () => null);
    assert.equal(await hermesBackend.run(refused.turn, 'kapat'), 'end_turn');
    assert.deepEqual(approval, { choice: 'deny', request_id: 'req-2' });
  } finally {
    fake.server.close();
  }
});

test('Stop asks Hermes to stop the run, and ends the turn as cancelled with what came so far', async () => {
  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, key: KEY });
    fake.script(async ({ send, stopped, end }) => {
      send('assistant.delta', { delta: 'Uzun bir iş başlıyor' });
      await stopped();
      send('assistant.completed', { content: 'Uzun bir iş başlıyor', interrupted: true });
      send('run.cancelled', { interrupted: true });
      send('done');
      end();
    });
    const { turn, events, stop } = fakeTurn();
    const running = hermesBackend.run(turn, 'uzun bir iş yap');
    await until(() => words(events), 'the first words');
    stop.abort();
    hermesBackend.cancel(turn.chatId);
    assert.equal(await running, 'cancelled');
    assert.ok(fake.seen.some((one) => one.method === 'POST' && one.path === '/v1/runs/run_1/stop'));
    assert.equal(words(events), 'Uzun bir iş başlıyor');
  } finally {
    fake.server.close();
  }
});

test('Stop through the chat: the running chat ends as stopped', async () => {
  const fake = await standIn();
  const pushes: ChatPush[] = [];
  onChatPush((push) => pushes.push(push));
  try {
    saveHermes({ url: fake.base, key: KEY });
    updateSettings((settings) => {
      settings.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-'));
    });
    fake.script(async ({ send, stopped, end }) => {
      send('assistant.delta', { delta: 'Başladım' });
      await stopped();
      send('run.cancelled', { interrupted: true });
      end();
    });
    const { id } = sendChat(null, 'hermes', 'başla');
    await until(() => pushes.some((one) => one.chatId === id && one.event?.type === 'text'), 'the first words');
    cancelChat(id);
    const done = await until(() => pushes.find((one) => one.chatId === id && one.event?.type === 'done')?.event, 'the end');
    assert.deepEqual(done, { type: 'done', reason: 'cancelled' });
  } finally {
    onChatPush(() => undefined);
    fake.server.close();
  }
});

test('a key Hermes refuses is a sign-in failure, said plainly; the key is in no sentence', async () => {
  const fake = await standIn({ refuseKey: true });
  try {
    saveHermes({ url: fake.base, key: KEY });
    const { turn, events } = fakeTurn();
    await assert.rejects(hermesBackend.run(turn, 'merhaba'), (err: Error & { kind?: string }) => {
      keyless(err.message);
      return err.kind === 'auth' && /did not take the key/.test(err.message);
    });
    await assert.rejects(testHermes(), /did not take the key/);
    keyless(events);
  } finally {
    fake.server.close();
  }
});

test('a server not reached, one with no Hermes behind it, a busy session and a failed run: each a sentence, never a stack', async () => {
  // Not reached: the port closed.
  const closed = await standIn();
  closed.server.close();
  await new Promise((done) => setTimeout(done, 20));
  saveHermes({ url: closed.base, key: KEY });
  await assert.rejects(hermesBackend.run(fakeTurn().turn, 'merhaba'), (err: Error) => /^Pyn on the server could not be reached \(ECONNREFUSED\)\./.test(err.message) && !err.message.includes('\n'));

  // Something else at the address.
  const other = http.createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<h1>nope</h1>');
  });
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
  try {
    saveHermes({ url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, key: KEY });
    await assert.rejects(hermesBackend.run(fakeTurn().turn, 'merhaba'), /There is no Pyn API server at this address/);
  } finally {
    other.close();
  }

  const fake = await standIn();
  try {
    saveHermes({ url: fake.base, key: KEY });
    fake.sessions.push({ id: 'api_busy', title: 'meşgul' });
    fake.messages.set('api_busy', []);
    // A run that fails, its reason said; one whose server says the key back is told without it.
    fake.script(({ send, end }) => {
      send('assistant.delta', { delta: 'Yarım' });
      send('run.failed', { completed: false, turn_exit_reason: 'iteration budget exhausted' });
      end();
    });
    await assert.rejects(hermesBackend.run(fakeTurn('api_busy').turn, 'x'), /: Pyn on the server could not finish the answer: iteration budget exhausted$/);
    fake.script(({ send, end }) => {
      send('error', { message: `provider rejected ${KEY}` });
      send('done');
      end();
    });
    await assert.rejects(hermesBackend.run(fakeTurn('api_busy').turn, 'x'), (err: Error) => {
      keyless(err.message);
      return /^Pyn on the server stopped: provider rejected …$/.test(err.message);
    });
  } finally {
    fake.server.close();
  }

  // Busy: Hermes's 409, its own words with it.
  const busy = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/sessions?')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Session is busy with another turn', code: 'session_busy' } }));
  });
  await new Promise<void>((done) => busy.listen(0, '127.0.0.1', done));
  try {
    saveHermes({ url: `http://127.0.0.1:${(busy.address() as AddressInfo).port}`, key: KEY });
    await assert.rejects(hermesBackend.run(fakeTurn('api_x').turn, 'x'), /: Pyn on the server is busy with this session: Session is busy with another turn$/);
  } finally {
    busy.close();
  }
});

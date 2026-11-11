import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { LINE_MAX, readCortexMessage, readRendezvous } from '../shared/browserLink';
import type { ChatEvent, CliInfo } from '../shared/chat';
import { PAGE_TEXT_MAX } from '../electron/services/browserPage';
import { MAX_CONNECTIONS, REASK, browserLinkStatus, decidePairing, defaultTool, errorCodeOf, onBrowserLink, onPairingAsked, pipeFor, startBrowserLink, stopBrowserLink, unpairBrowser } from '../electron/services/browserLink';
import { MESSAGE_MAX, answerChat, browserChat, forgetChats, listChats, openChat, sendChat, shutdownChats, tapChat } from '../electron/services/chat';
import { listClis } from '../electron/services/clis';
import { pythonOf } from '../electron/services/localChat';
import { forgetSettings, readSettings, settingsPath, updateSettings } from '../electron/services/settings';

/**
 * Cortex's end of the link to Cortex Browser (electron/services/browserLink.ts), spoken to as the browser speaks to it
 * (shared/browser-link-contract.json): over the socket the meeting file names, one JSON object a line. The AI tool is
 * the stand-in for Claude Code (tests/fixtures/fake-claude.mjs). Every line Cortex writes is held to the contract's
 * types as it is read.
 */

const CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const userData = () => app.getPath('userData');
const meeting = () => path.join(userData(), 'browser-link.json');

async function until<T>(find: () => T | undefined | false | null, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Everything written to the console while the tests run: a token must never be in it. */
const consoleSaid: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    consoleSaid.push(args.map((one) => (typeof one === 'string' ? one : one instanceof Error ? `${one.stack}` : JSON.stringify(one))).join(' '));
    // The failures of the chat's own tests are still to be read.
    if (level === 'error') real(...args);
  };
}
/** Every token a test was given. */
const tokens: string[] = [];

type Line = Record<string, unknown>;
/** The browser's end, stood in for. */
class Client {
  lines: Line[] = [];
  closed = false;
  private rest = '';
  private constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.rest += chunk;
      let at: number;
      while ((at = this.rest.indexOf('\n')) >= 0) {
        const line = JSON.parse(this.rest.slice(0, at)) as Line;
        this.rest = this.rest.slice(at + 1);
        // Whatever Cortex writes is a message of the contract's, with nothing beside what the contract names.
        assert.deepEqual(readCortexMessage(line), line, `not the contract’s: ${JSON.stringify(line)}`);
        if (typeof line.token === 'string') tokens.push(line.token);
        this.lines.push(line);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => (this.closed = true));
  }
  static open(): Promise<Client> {
    const pipe = (readRendezvous(JSON.parse(fs.readFileSync(meeting(), 'utf8'))) as { pipe: string }).pipe;
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipe);
      socket.once('error', reject);
      socket.once('connect', () => resolve(new Client(socket)));
    });
  }
  send(message: Line): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
  hello(token: string | null = null): void {
    this.send({ type: 'hello', protocol: 1, client: 'cortex-browser', client_version: '0.0.1', token });
  }
  /** The next line of that type after `from`. */
  next(type: string, from = 0): Promise<Line> {
    return until(() => this.lines.slice(from).find((one) => one.type === type), `a ${type}`);
  }
  /** The events of one ask, in their order. */
  events(id: string): Line[] {
    return this.lines.filter((one) => one.type === 'event' && one.id === id);
  }
  /** That ask's last event, once it has ended. */
  ended(id: string): Promise<Line> {
    return until(() => this.events(id).find((one) => one.kind === 'done' || one.kind === 'error'), `ask ${id} to end`);
  }
  gone(): Promise<true> {
    return until(() => this.closed, 'the link to close');
  }
  close(): void {
    this.socket.destroy();
  }
}

/** The tools Cortex has, as the test says: the stand-in for Claude Code, or none. */
let toolEnv: NodeJS.ProcessEnv = { CORTEX_TEST_CLAUDE: CLAUDE };
const tools = async (): Promise<CliInfo[]> => listClis(toolEnv);
const statuses: Array<{ allowed: boolean; connected: boolean; asking: boolean; clients: number }> = [];
let asked = 0;

/** Each test from a first run: no settings, no chats, a vault of its own, the link opened anew. */
async function fresh(): Promise<{ vault: string; log: string }> {
  stopBrowserLink();
  shutdownChats();
  forgetChats();
  fs.rmSync(path.join(userData(), 'chats'), { recursive: true, force: true });
  fs.rmSync(settingsPath(), { force: true });
  forgetSettings();
  REASK.now = () => Date.now();
  toolEnv = { CORTEX_TEST_CLAUDE: CLAUDE };
  process.env.CORTEX_TEST_CLAUDE = CLAUDE;
  const vault = temp('link-vault-');
  fs.mkdirSync(path.join(vault, 'Notes'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  const log = path.join(temp('link-log-'), 'claude.jsonl');
  process.env.FAKE_AGENT_LOG = log;
  statuses.length = 0;
  asked = 0;
  onBrowserLink((status, clients) => statuses.push({ ...status, clients }));
  onPairingAsked(() => (asked += 1));
  assert.equal(await startBrowserLink({ tools }), true);
  return { vault, log };
}

/** A browser the person let in: connected, greeted, allowed. */
async function paired(): Promise<{ client: Client; token: string }> {
  const client = await Client.open();
  client.hello();
  await client.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  decidePairing(true);
  const ok = await client.next('hello_ok');
  return { client, token: ok.token as string };
}

const textOf = (events: Line[]) =>
  events
    .filter((one) => one.kind === 'text')
    .map((one) => one.text as string)
    .join('');
const kinds = (events: Line[]) => events.map((one) => (one.kind === 'status' ? `status:${one.phase}` : (one.kind as string)));
const PAGE = { title: 'Örnek sayfa', url: 'https://example.com/yazi', text: 'Sayfanın metni.', truncated: false };

test.after(() => {
  stopBrowserLink();
  shutdownChats();
});

test('where the link is: a pipe named by the install on Windows, a socket in the data folder elsewhere', () => {
  assert.equal(pipeFor('3f9a1c0d2b4e6f80', 'win32', 'C:\\Users\\ornek\\AppData\\Roaming\\Cortex'), '\\\\.\\pipe\\cortex-browser-link-3f9a1c0d2b4e6f80');
  assert.equal(pipeFor('3f9a1c0d2b4e6f80', 'linux', '/home/ornek/.config/Cortex'), path.join('/home/ornek/.config/Cortex', 'browser-link.sock'));
  assert.equal(pipeFor('3f9a1c0d2b4e6f80', 'darwin', '/Users/ornek/Library/Application Support/Cortex'), path.join('/Users/ornek/Library/Application Support/Cortex', 'browser-link.sock'));
});

test('started, the link is open and the meeting file says where; stopped, a browser is told and the file is gone', async () => {
  await fresh();
  const said = readRendezvous(JSON.parse(fs.readFileSync(meeting(), 'utf8')));
  assert.deepEqual(said, { version: 1, pipe: pipeFor(readSettings().browserLinkId as string), exe: app.getPath('exe'), pid: process.pid });
  assert.match(readSettings().browserLinkId ?? '', /^[0-9a-f]{16}$/, 'the install’s id, drawn at the first start');
  assert.ok(!fs.readdirSync(userData()).some((name) => name.startsWith('browser-link.json.')), 'written whole: no temporary left beside it');
  if (process.platform !== 'win32') {
    assert.ok(path.dirname(said?.pipe ?? '') === userData(), 'in the app’s own data folder');
    assert.equal(fs.statSync(said?.pipe ?? '').mode & 0o777, 0o600, 'the person’s alone');
  }
  const client = await Client.open();
  client.hello();
  await client.next('pairing');
  const id = readSettings().browserLinkId;
  stopBrowserLink();
  assert.deepEqual(await client.next('bye'), { type: 'bye', reason: 'shutdown' });
  await client.gone();
  assert.equal(fs.existsSync(meeting()), false);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(said?.pipe ?? ''), false);
  assert.deepEqual(browserLinkStatus(), { allowed: false, connected: false, asking: false }, 'and a question nobody is left to hear the answer to is gone');
  // Started again - the app opened again - it is the same pipe, and a socket left by a run that died is no obstacle.
  if (process.platform !== 'win32') fs.writeFileSync(said?.pipe ?? '', '');
  assert.equal(await startBrowserLink({ tools }), true);
  assert.equal(readSettings().browserLinkId, id);
  assert.equal((readRendezvous(JSON.parse(fs.readFileSync(meeting(), 'utf8'))) as { pipe: string }).pipe, said?.pipe);
  (await Client.open()).close();
  // Another program's meeting file is not this one's to take away.
  stopBrowserLink();
  fs.writeFileSync(meeting(), JSON.stringify({ version: 1, pipe: 'x', exe: 'x', pid: process.pid + 1 }));
  stopBrowserLink();
  assert.equal(fs.existsSync(meeting()), true);
  fs.rmSync(meeting());
});

test('the first message is a hello: anything else the contract knows closes the link as unpaired, a kind it does not know is passed over', async () => {
  await fresh();
  for (const first of [
    { type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null },
    { type: 'answer', id: 'a1', permission: 'p1', option: 'allow' },
    { type: 'cancel', id: 'a1' },
    { type: 'capture', id: 'k1', title: 'T', url: 'https://example.com/', note: '' },
  ]) {
    const client = await Client.open();
    client.send(first);
    await client.gone();
    assert.deepEqual(client.lines, [{ type: 'bye', reason: 'unpaired' }], first.type);
  }
  assert.equal(listChats().length, 0, 'and nothing was asked of any tool');
  const client = await Client.open();
  client.send({ type: 'from-the-future', id: 'x' });
  client.send({});
  await client.gone();
  assert.deepEqual(client.lines, [{ type: 'bye', reason: 'bad_message' }], 'the unknown kind was passed over; the line with no kind is a bad message');
  // A browser that says goodbye is let go without a word.
  const leaving = await Client.open();
  leaving.send({ type: 'bye', reason: 'shutdown' });
  await leaving.gone();
  assert.deepEqual(leaving.lines, []);
});

test('a hello of another protocol is told so; a line that is not JSON, or longer than the limit, is a bad message', async () => {
  await fresh();
  const newer = await Client.open();
  newer.send({ type: 'hello', protocol: 2, client: 'cortex-browser', client_version: '9.0.0', token: null });
  await newer.gone();
  assert.deepEqual(newer.lines, [{ type: 'bye', reason: 'protocol' }]);
  assert.equal(browserLinkStatus().asking, false, 'nobody is asked about a browser Cortex cannot talk to');

  const garbled = await Client.open();
  garbled.socket.write('hello there\n');
  await garbled.gone();
  assert.deepEqual(garbled.lines, [{ type: 'bye', reason: 'bad_message' }]);

  const invalid = await Client.open();
  invalid.socket.write(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]));
  await invalid.gone();
  assert.deepEqual(invalid.lines, [{ type: 'bye', reason: 'bad_message' }], 'bytes that are not UTF-8');

  // Longer than the limit before its end is in sight: not waited for, not kept.
  const endless = await Client.open();
  const piece = Buffer.alloc(1024 * 1024, 0x61);
  for (let sent = 0; sent <= LINE_MAX && !endless.closed; sent += piece.length) endless.socket.write(piece);
  await endless.gone();
  assert.deepEqual(endless.lines, [{ type: 'bye', reason: 'bad_message' }]);

  // An empty line is nothing; a line split across writes, and two in one write, are read as they are.
  const { client } = await paired();
  const from = client.lines.length;
  client.socket.write('\n  \r\n{"type":"hel');
  client.socket.write('lo","protocol":1}\n{"type":"hello","protocol":1}\n');
  await until(() => client.lines.slice(from).filter((one) => one.type === 'hello_ok').length === 2, 'both hellos answered');
  assert.equal(client.closed, false);
});

test('a browser not let in yet is asked about once, in Cortex; allowed, it is given a token Cortex keeps only the digest of', async () => {
  await fresh();
  const client = await Client.open();
  client.hello();
  assert.deepEqual(await client.next('pairing'), { type: 'pairing', state: 'waiting' });
  await until(() => asked === 1, 'the person to be asked');
  assert.deepEqual(browserLinkStatus(), { allowed: false, connected: false, asking: true });
  // Still waiting: nothing is asked of a tool, and nothing is asked of the person twice.
  client.hello();
  await until(() => client.lines.filter((one) => one.type === 'pairing').length === 2, 'the second hello answered');
  assert.equal(asked, 1);
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  await client.gone();
  assert.deepEqual(client.lines.at(-1), { type: 'bye', reason: 'unpaired' }, 'a question before leave is given closes the link');
  await until(() => !browserLinkStatus().asking, 'the question to go with the browser that asked');

  const again = await Client.open();
  again.hello();
  await again.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  assert.deepEqual(decidePairing(true), { allowed: true, connected: false, asking: false });
  const ok = await again.next('hello_ok');
  const token = ok.token as string;
  assert.deepEqual(ok, { type: 'hello_ok', protocol: 1, app_version: app.getVersion(), tool: { id: 'test-claude', name: 'Test Claude' }, vault_name: path.basename(readSettings().vault as string), token });
  assert.match(token, /^[A-Za-z0-9_-]{43,}$/, 'base64url');
  assert.ok(Buffer.from(token, 'base64url').length >= 32, 'of at least 32 random bytes');
  assert.equal(readSettings().browserLinkToken, createHash('sha256').update(token).digest('hex'));
  assert.ok(!fs.readFileSync(settingsPath(), 'utf8').includes(token), 'the token itself is the browser’s to keep');
  assert.deepEqual(browserLinkStatus(), { allowed: true, connected: true, asking: false });
  assert.deepEqual(statuses.at(-1), { allowed: true, connected: true, asking: false, clients: 1 }, 'the window is told');

  // The next time it connects, the token is its leave: nobody is asked, and no new token is drawn.
  again.close();
  await until(() => !browserLinkStatus().connected, 'the link to be seen closed');
  assert.deepEqual(browserLinkStatus(), { allowed: true, connected: false, asking: false }, 'allowed, and not connected now');
  const later = await Client.open();
  later.hello(token);
  assert.equal((await later.next('hello_ok')).token, null);
  assert.equal(asked, 2);
  // A token that is not the one given is no leave: asked again.
  const other = await Client.open();
  other.hello(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
  assert.deepEqual(await other.next('pairing'), { type: 'pairing', state: 'waiting' });
  await until(() => asked === 3, 'the person to be asked');
  // Allowed, it has a token of its own, and the earlier one is no leave any more: one browser at a time.
  decidePairing(true);
  const second = (await other.next('hello_ok')).token as string;
  assert.notEqual(second, token);
  const old = await Client.open();
  old.hello(token);
  assert.deepEqual(await old.next('pairing'), { type: 'pairing', state: 'waiting' });
  decidePairing(false);
});

test('refused, a browser is told so and not asked about again at once: each refusal makes the wait longer', async () => {
  await fresh();
  let now = 1_000_000;
  REASK.now = () => now;
  const client = await Client.open();
  client.hello();
  await client.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  assert.deepEqual(decidePairing(false), { allowed: false, connected: false, asking: false });
  await until(() => client.lines.length === 2, 'the refusal');
  assert.deepEqual(client.lines.at(-1), { type: 'pairing', state: 'refused' });
  assert.equal(readSettings().browserLinkToken, null);
  assert.equal(client.closed, false, 'the link stays: the browser may ask again');
  // At once, and from another connection too: refused unasked.
  client.hello();
  await until(() => client.lines.length === 3, 'the second answer');
  assert.deepEqual(client.lines.at(-1), { type: 'pairing', state: 'refused' });
  const other = await Client.open();
  other.hello();
  assert.deepEqual(await other.next('pairing'), { type: 'pairing', state: 'refused' });
  assert.equal(asked, 1);
  assert.equal(browserLinkStatus().asking, false);
  // After the wait, a hello asks again.
  now += REASK.ms;
  client.hello();
  await until(() => client.lines.length === 4, 'the third answer');
  assert.deepEqual(client.lines.at(-1), { type: 'pairing', state: 'waiting' });
  assert.equal(asked, 2);
  decidePairing(false);
  await until(() => client.lines.length === 5, 'the second refusal');
  // Refused twice: the same wait is not enough now.
  now += REASK.ms;
  client.hello();
  await until(() => client.lines.length === 6, 'the answer');
  assert.deepEqual(client.lines.at(-1), { type: 'pairing', state: 'refused' });
  now += REASK.ms;
  client.hello();
  await until(() => client.lines.length === 7, 'the answer');
  assert.deepEqual(client.lines.at(-1), { type: 'pairing', state: 'waiting' });
  // Allowed in the end: the refusals are forgotten.
  decidePairing(true);
  await client.next('hello_ok');
  unpairBrowser();
  const fresher = await Client.open();
  fresher.hello();
  assert.deepEqual(await fresher.next('pairing'), { type: 'pairing', state: 'waiting' });
  // An answer with no question is nothing.
  decidePairing(false);
  assert.deepEqual(decidePairing(true), { allowed: false, connected: false, asking: false });
  assert.equal(readSettings().browserLinkToken, null);
});

test('one question at a time: a second browser waits on the first one’s, takes it over when the first goes, and only the one asked about is let in', async () => {
  await fresh();
  const first = await Client.open();
  first.hello();
  await first.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  const second = await Client.open();
  second.hello();
  assert.deepEqual(await second.next('pairing'), { type: 'pairing', state: 'waiting' });
  assert.equal(asked, 1);
  // The first goes (the browser started again while the card was up): the card stays, and is now about the second.
  first.close();
  await until(() => statuses.at(-1)?.clients === 1, 'the first to be seen gone');
  assert.equal(browserLinkStatus().asking, true);
  const third = await Client.open();
  third.hello();
  await third.next('pairing');
  decidePairing(true);
  assert.equal(typeof (await second.next('hello_ok')).token, 'string');
  await until(() => third.lines.length === 2, 'the third to be answered');
  assert.deepEqual(third.lines.at(-1), { type: 'pairing', state: 'refused' }, 'not let in on another’s leave');
  assert.equal(third.lines.some((one) => one.type === 'hello_ok'), false);
});

test('leave taken back: the browser is told and its link closed, and its token is no leave any more', async () => {
  await fresh();
  const { client, token } = await paired();
  assert.deepEqual(unpairBrowser(), { allowed: false, connected: false, asking: false });
  assert.deepEqual(await client.next('bye'), { type: 'bye', reason: 'unpaired' });
  await client.gone();
  assert.equal(readSettings().browserLinkToken, null);
  const again = await Client.open();
  again.hello(token);
  assert.deepEqual(await again.next('pairing'), { type: 'pairing', state: 'waiting' });
});

test('a question is answered by the tool a new chat in Cortex would be written to, told as it comes: starting, thinking, answering, the words, done', async () => {
  const { log } = await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a1'), { type: 'event', id: 'a1', kind: 'done', cancelled: false });
  const events = client.events('a1');
  assert.deepEqual([...new Set(kinds(events))], ['status:starting', 'status:thinking', 'status:answering', 'text', 'done']);
  assert.deepEqual(kinds(events).slice(0, 3), ['status:starting', 'status:thinking', 'status:answering'], 'each said once, in its order');
  assert.equal(textOf(events), 'Merhaba dünya, [[Ideas]] notuna baktım.');
  // Only the answer's words: not what the tool thought, read or ran.
  assert.ok(!JSON.stringify(client.lines).includes('Düşünüyorum') && !JSON.stringify(client.lines).includes('Plan.md'));
  assert.equal(fs.readFileSync(log, 'utf8').includes('"merhaba"'), true, 'the tool was sent the question as it was written');

  // It is a chat of Cortex's, marked as the browser's; the same conversation goes on in it.
  const chat = browserChat('c1') as string;
  assert.deepEqual(listChats().map((one) => [one.id, one.origin, one.cli, one.title]), [[chat, 'browser', 'test-claude', 'merhaba']]);
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'devam', page: null });
  await client.ended('a2');
  assert.deepEqual(kinds(client.events('a2')).slice(0, 3), ['status:starting', 'status:thinking', 'status:answering']);
  assert.equal(listChats().length, 1);
  assert.equal(openChat(chat).events.filter((one) => one.type === 'user').length, 2);
  client.send({ type: 'ask', id: 'a3', conversation: 'c2', text: 'başka konu', page: null });
  await client.ended('a3');
  assert.equal(listChats().length, 2, 'another conversation, another chat');

  // Written to from Cortex, the chat answers in Cortex: nothing of it is sent to the browser.
  const heard: ChatEvent[] = [];
  const untap = tapChat((message) => {
    if (message.chatId === chat && message.event) heard.push(message.event);
  });
  const before = client.lines.length;
  sendChat(chat, 'test-claude', 'bunu Cortex’ten yazdım');
  await until(() => heard.find((one) => one.type === 'done'), 'the answer in Cortex');
  untap();
  assert.equal(client.lines.length, before);
  assert.equal(client.closed, false);
});

test('which tool: the one last written to while it is still offered, else the first offered; with none, the browser is told and a question fails as having no tool', async () => {
  await fresh();
  const all = (...available: string[]): CliInfo[] => (['claude', 'codex', 'test', 'test-claude'] as const).map((id) => ({ id, name: id, available: available.includes(id) }));
  // No chat yet: the first tool offered.
  stopBrowserLink();
  await startBrowserLink({ tools: async () => all('codex', 'test-claude') });
  assert.equal((await defaultTool())?.id, 'codex');
  // A chat written to: its tool, as the window keeps the one last written to.
  const { id } = sendChat(null, 'test-claude', 'merhaba');
  await until(() => !openChat(id).running, 'the answer');
  assert.equal((await defaultTool())?.id, 'test-claude');
  // That tool gone since: the first offered again.
  stopBrowserLink();
  await startBrowserLink({ tools: async () => all('test') });
  assert.equal((await defaultTool())?.id, 'test');

  // None at all.
  stopBrowserLink();
  toolEnv = {};
  await startBrowserLink({ tools });
  assert.equal(await defaultTool(), null);
  const { client } = await paired();
  assert.equal(client.lines.find((one) => one.type === 'hello_ok')?.tool, null);
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a1'), { type: 'event', id: 'a1', kind: 'error', code: 'no_tool', detail: '' });
  assert.equal(browserChat('c1'), null, 'no chat is begun for it');
  // A tool there by the next hello: said then, on the same link.
  toolEnv = { CORTEX_TEST_CLAUDE: CLAUDE };
  const from = client.lines.length;
  client.hello();
  assert.deepEqual((await client.next('hello_ok', from)).tool, { id: 'test-claude', name: 'Test Claude' });

  // No vault: said in the hello, and a question cannot be answered.
  updateSettings((settings) => {
    settings.vault = null;
  });
  const at = client.lines.length;
  client.hello();
  assert.equal((await client.next('hello_ok', at)).vault_name, null);
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'error', code: 'internal', detail: 'no vault' });
});

test('Stop from the browser ends the answer, and says it was stopped', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'yavaş olsun', page: null });
  await until(() => client.events('a1').some((one) => one.kind === 'text'), 'the first words');
  client.send({ type: 'cancel', id: 'a1' });
  assert.deepEqual(await client.ended('a1'), { type: 'event', id: 'a1', kind: 'done', cancelled: true });
  // A cancel for nothing that runs is nothing.
  client.send({ type: 'cancel', id: 'a1' });
  client.send({ type: 'cancel', id: 'never' });
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'done', cancelled: false });
});

test('a step the tool asks leave for is asked in the browser and answered from it; answered in Cortex, the browser’s card is closed', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'izin iste', page: null });
  const card = (await until(() => client.events('a1').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string; title: string; kind: string; paths: string[]; options: Array<{ id: string; name: string; kind: string }>; after_page: boolean };
  assert.deepEqual(card, {
    id: card.id,
    title: 'Write Notes/Plan.md',
    kind: 'edit',
    paths: ['Notes/Plan.md'],
    options: [
      { id: 'allow', name: 'Allow once', kind: 'allow_once' },
      { id: 'always', name: 'Always allow', kind: 'allow_always' },
      { id: 'deny', name: 'Reject', kind: 'reject_once' },
    ],
    after_page: false,
  });
  client.send({ type: 'answer', id: 'a1', permission: card.id, option: 'allow' });
  await client.ended('a1');
  assert.deepEqual(client.events('a1').find((one) => one.kind === 'permission_closed'), { type: 'event', id: 'a1', kind: 'permission_closed', permission: card.id, option: 'allow' });
  assert.ok(textOf(client.events('a1')).startsWith('izin: allow.'));
  assert.deepEqual(kinds(client.events('a1')).filter((one) => one !== 'text'), ['status:starting', 'status:thinking', 'permission', 'permission_closed', 'status:answering', 'done']);

  // Given up in the browser: `option` null, and the step is refused.
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'izin iste', page: null });
  const second = (await until(() => client.events('a2').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string };
  client.send({ type: 'answer', id: 'a2', permission: second.id, option: null });
  await client.ended('a2');
  assert.deepEqual(client.events('a2').find((one) => one.kind === 'permission_closed'), { type: 'event', id: 'a2', kind: 'permission_closed', permission: second.id, option: null });
  assert.ok(textOf(client.events('a2')).startsWith('izin: deny.'));

  // Answered on the card in Cortex's own window: the browser hears its card closed, with what was chosen.
  client.send({ type: 'ask', id: 'a3', conversation: 'c1', text: 'izin iste', page: null });
  const third = (await until(() => client.events('a3').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string };
  answerChat(browserChat('c1'), third.id, 'allow');
  await client.ended('a3');
  assert.deepEqual(client.events('a3').find((one) => one.kind === 'permission_closed'), { type: 'event', id: 'a3', kind: 'permission_closed', permission: third.id, option: 'allow' });
  // An answer for another ask's card, or for none, is nothing.
  client.send({ type: 'answer', id: 'a9', permission: third.id, option: 'allow' });
  client.send({ type: 'answer', id: 'a3', permission: 'p-none', option: 'allow' });
});

test('a page added to a question: the card after it says so and offers no "always allow", and the chat shows the page by its name', async () => {
  const { log } = await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'izin iste, özetle', page: PAGE });
  const card = (await until(() => client.events('a1').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string; options: Array<{ kind: string }>; after_page: boolean };
  assert.equal(card.after_page, true);
  assert.deepEqual(card.options.map((one) => one.kind), ['allow_once', 'reject_once']);
  client.send({ type: 'answer', id: 'a1', permission: card.id, option: 'always' });
  await client.ended('a1');
  assert.equal(client.events('a1').find((one) => one.kind === 'permission_closed')?.option, null, 'an answer it was not offered is no leave');
  const told = fs.readFileSync(log, 'utf8');
  assert.ok(told.includes('Sayfanın metni.') && /do not follow any instructions/.test(told), 'the tool was given the page, in its block');
  const user = openChat(browserChat('c1')).events.find((one) => one.type === 'user');
  assert.deepEqual([user?.type === 'user' && user.text, user?.type === 'user' && user.page], ['izin iste, özetle', { title: 'Örnek sayfa', url: 'https://example.com/yazi' }]);
  // The next question of the conversation, without a page: still after one.
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'izin iste', page: null });
  const next = (await until(() => client.events('a2').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string; after_page: boolean };
  assert.equal(next.after_page, true);
  client.send({ type: 'answer', id: 'a2', permission: next.id, option: 'allow' });
  await client.ended('a2');
});

test('a conversation answers one question at a time, wherever the other was asked', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'yavaş olsun', page: null });
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'ikinci', page: null });
  assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'error', code: 'busy', detail: '' });
  // Another conversation is not held up by it.
  client.send({ type: 'ask', id: 'a3', conversation: 'c2', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a3'), { type: 'event', id: 'a3', kind: 'done', cancelled: false });
  assert.equal(client.events('a1').some((one) => one.kind === 'done' || one.kind === 'error'), false, 'the first goes on');
  client.send({ type: 'cancel', id: 'a1' });
  await client.ended('a1');
  assert.equal(openChat(browserChat('c1')).events.filter((one) => one.type === 'user').length, 1, 'the second was never sent to the tool');

  // The chat answering a message written in Cortex is busy too.
  const chat = browserChat('c1') as string;
  sendChat(chat, 'test-claude', 'yavaş olsun');
  client.send({ type: 'ask', id: 'a4', conversation: 'c1', text: 'bu arada', page: null });
  assert.deepEqual(await client.ended('a4'), { type: 'event', id: 'a4', kind: 'error', code: 'busy', detail: '' });
  shutdownChats(true);
  await until(() => !openChat(chat).running, 'the chat to stop');
});

test('the browser gone in the middle of an answer: the answer goes on in Cortex, where the chat is', async () => {
  await fresh();
  const { client, token } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'izin iste', page: null });
  await until(() => client.events('a1').find((one) => one.kind === 'permission'), 'the card');
  const chat = browserChat('c1') as string;
  client.close();
  await until(() => !browserLinkStatus().connected, 'the link to be seen closed');
  assert.equal(openChat(chat).running, true, 'not stopped: its card waits in Cortex');
  // Back, the browser finds the conversation busy until the card is answered there.
  const back = await Client.open();
  back.hello(token);
  await back.next('hello_ok');
  back.send({ type: 'ask', id: 'b1', conversation: 'c1', text: 'ne oldu', page: null });
  assert.equal((await back.ended('b1')).code, 'busy');
  const card = openChat(chat).events.find((one) => one.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
  answerChat(chat, card.id, 'allow');
  await until(() => !openChat(chat).running, 'the answer to end');
  assert.ok(openChat(chat).events.some((one) => one.type === 'done' && one.reason === 'end_turn'));
  assert.equal(back.events('a1').length, 0, 'what was asked on the link that closed is not told on another');
});

test('a tool’s failure is told by its kind, in the contract’s codes', async () => {
  assert.deepEqual(
    ['auth', 'provider-auth', 'provider-key', 'limit', 'provider.quota', 'network', 'not-started', 'not-found', 'start-timeout', 'stopped', 'local-off', 'local-busy', 'model', 'unsupported', 'APIError', null].map((kind) => errorCodeOf(kind)),
    ['not_signed_in', 'not_signed_in', 'not_signed_in', 'limit', 'limit', 'network', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed', 'tool_failed'],
  );
  await fresh();
  const { client } = await paired();
  const failed = async (id: string, text: string) => {
    client.send({ type: 'ask', id, conversation: id, text, page: null });
    const end = await client.ended(id);
    assert.equal(end.kind, 'error', text);
    return [end.code, typeof end.detail === 'string' && end.detail.length <= 300];
  };
  // As Claude Code fails: its sign-in gone, its subscription's allowance used up, its server not reached, the program dying.
  assert.deepEqual(await failed('e1', 'hata ver'), ['not_signed_in', true]);
  assert.deepEqual(await failed('e2', 'limit doldu'), ['limit', true]);
  assert.deepEqual(await failed('e3', 'kopuk bağlantı'), ['network', true]);
  assert.deepEqual(await failed('e4', 'çök'), ['tool_failed', true]);
  assert.equal(client.events('e4').at(-1)?.kind, 'error', 'an error is the last word of its ask');
  assert.ok(!JSON.stringify(client.lines).includes(readSettings().vault as string), 'no failure says where the vault is');

  // Longer than Cortex sends to a tool: refused as too long, the question or its page.
  client.send({ type: 'ask', id: 't1', conversation: 't1', text: 'x'.repeat(MESSAGE_MAX + 1), page: null });
  assert.deepEqual(await client.ended('t1'), { type: 'event', id: 't1', kind: 'error', code: 'too_long', detail: '' });
  client.send({ type: 'ask', id: 't2', conversation: 't2', text: 'özetle', page: { ...PAGE, text: 'x'.repeat(PAGE_TEXT_MAX + 1) } });
  assert.deepEqual(await client.ended('t2'), { type: 'event', id: 't2', kind: 'error', code: 'too_long', detail: '' });
  assert.deepEqual([browserChat('t1'), browserChat('t2')], [null, null]);
  // A question with no words is not one: nothing is begun for it.
  client.send({ type: 'ask', id: 't3', conversation: 't3', text: '   ', page: null });
  assert.equal((await client.ended('t3')).code, 'internal');
  assert.equal(browserChat('t3'), null);
});

const STAND_IN = String.raw`import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = [one for one in sys.argv[1:] if one != '--json']
with open(os.path.join(here, 'istenen.json'), 'a', encoding='utf-8') as log:
    log.write(json.dumps(args, ensure_ascii=False) + '\n')
if '--neden=bozuk' in args:
    print('yakala: kart yazilamadi', file=sys.stderr)
    sys.exit(1)
print(json.dumps({'status': 'yakalandi', 'id': '2026-11-11-1200-ornek', 'path': '📥 000-Inbox/Yakala/2026-11-11-1200-ornek.md'}, ensure_ascii=False))
`;

test('"save to Cortex" is one card in the vault’s inbox: the page’s address, its title and the note', { skip: pythonOf() === null }, async () => {
  const { vault } = await fresh();
  const { client } = await paired();
  // A vault without Cortex's memory cannot keep a card: said as a failure, with why.
  client.send({ type: 'capture', id: 'k0', title: 'Örnek sayfa', url: 'https://example.com/yazi', note: 'sonra bak' });
  const none = await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k0'), 'the answer');
  assert.deepEqual([none.ok, none.code], [false, 'capture_failed']);
  assert.match(none.detail as string, /Settings/);

  fs.writeFileSync(path.join(vault, 'beyin.py'), STAND_IN);
  fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.62\n');
  client.send({ type: 'capture', id: 'k1', title: 'Örnek sayfa', url: 'https://example.com/yazi', note: 'sonra bak' });
  assert.deepEqual(await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k1'), 'the answer'), { type: 'captured', id: 'k1', ok: true, path: '📥 000-Inbox/Yakala/2026-11-11-1200-ornek.md' });
  const args = fs.readFileSync(path.join(vault, 'istenen.json'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(args, [['yakala', 'ekle', 'https://example.com/yazi', '--arac', 'cortex-browser', '--neden=sonra bak', '--baslik=Örnek sayfa']]);
  // The engine failing is a failure of the capture, in one sentence.
  client.send({ type: 'capture', id: 'k2', title: 'Örnek sayfa', url: 'https://example.com/yazi', note: 'bozuk' });
  const failed = await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k2'), 'the answer');
  assert.deepEqual([failed.ok, failed.code, typeof failed.detail], [false, 'capture_failed', 'string']);
  assert.ok(!(failed.detail as string).includes(vault), 'without the vault’s place');

  // No vault, or one whose folder is gone: there is nowhere to keep it.
  fs.rmSync(vault, { recursive: true, force: true });
  client.send({ type: 'capture', id: 'k3', title: 'Örnek sayfa', url: 'https://example.com/yazi', note: '' });
  assert.deepEqual(await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k3'), 'the answer'), { type: 'captured', id: 'k3', ok: false, code: 'no_vault', detail: '' });
  updateSettings((settings) => {
    settings.vault = null;
  });
  client.send({ type: 'capture', id: 'k4', title: 'Örnek sayfa', url: 'https://example.com/yazi', note: '' });
  assert.deepEqual(await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k4'), 'the answer'), { type: 'captured', id: 'k4', ok: false, code: 'no_vault', detail: '' });
});

test('more links at once than a browser opens are not taken', async () => {
  await fresh();
  const held: Client[] = [];
  for (let n = 0; n < MAX_CONNECTIONS; n += 1) held.push(await Client.open());
  held[0].hello();
  await held[0].next('pairing');
  const extra = await Client.open();
  await extra.gone();
  assert.deepEqual(extra.lines, []);
  // One let go makes room for another, once it is seen gone.
  held[1].close();
  for (let tries = 0; ; tries += 1) {
    const one = await Client.open();
    one.send({ type: 'hello', protocol: 2 });
    await one.gone();
    if (one.lines.length) {
      assert.deepEqual(one.lines, [{ type: 'bye', reason: 'protocol' }]);
      break;
    }
    assert.ok(tries < 200, 'room for another');
    await new Promise((done) => setTimeout(done, 10));
  }
  for (const one of held) one.close();
});

test('the token is told to the browser and to nobody else: not to the console, not to a file', async () => {
  await fresh();
  const { client, token } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  await client.ended('a1');
  // A wrong one, a broken line that carries one, a failure after one: none of it is written down.
  const wrong = await Client.open();
  wrong.hello('KANARYA-YANLIS-JETON-0123456789abcdefghijklmnopqrstuv');
  await wrong.next('pairing');
  const broken = await Client.open();
  broken.socket.write(`{"type":"hello","protocol":1,"token":"${token}"\n`);
  await broken.gone();
  unpairBrowser();
  stopBrowserLink();
  assert.ok(tokens.length >= 5 && tokens.includes(token), 'the tokens this run gave were seen');
  const secrets = [...new Set(tokens), 'KANARYA-YANLIS-JETON-0123456789abcdefghijklmnopqrstuv'];
  for (const said of consoleSaid) for (const secret of secrets) assert.ok(!said.includes(secret), 'a token in the console');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []));
  const kept = files(userData());
  assert.ok(kept.some((file) => file.endsWith('settings.json')) && kept.some((file) => file.includes(`${path.sep}chats${path.sep}`)), 'the files Cortex keeps were looked through');
  for (const file of kept) for (const secret of secrets) assert.ok(!fs.readFileSync(file).includes(secret), `a token in ${path.basename(file)}`);
});

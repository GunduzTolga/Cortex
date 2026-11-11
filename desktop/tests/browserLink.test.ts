import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { type BrowserLinkStatus, LIMITS, LINE_MAX, readCortexMessage, readRendezvous } from '../shared/browserLink';
import type { ChatEvent, CliInfo } from '../shared/chat';
import { PAGE_TEXT_MAX } from '../electron/services/browserPage';
import {
  HELLO_WAIT,
  MAX_CONNECTIONS,
  REASK,
  allowBrowserFromSettings,
  browserLinkBusy,
  browserLinkStatus,
  decidePairing,
  defaultTool,
  errorCodeOf,
  linkPermissionOf,
  linkToolOf,
  onBrowserLink,
  onPairingAsked,
  pipeFor,
  safeDetail,
  setBrowserLinkOn,
  startBrowserLink,
  stopBrowserLink,
  unpairBrowser,
} from '../electron/services/browserLink';
import { MESSAGE_MAX, answerChat, beginChat, browserChat, forgetChats, listChats, openChat, sendChat, shutdownChats, tapChat } from '../electron/services/chat';
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
/** The meeting file as it is now. */
const said = () => readRendezvous(JSON.parse(fs.readFileSync(meeting(), 'utf8')));
/** What most checks ask of the link's state: let in, connected, asking. */
const brief = (status: BrowserLinkStatus) => ({ allowed: status.allowed, connected: status.connected, asking: status.asking });
/** A browser told to wait is told a code of four digits with it: looked at, and taken off for the comparison. */
function noCode(line: Line | undefined): Line | undefined {
  if (line?.type !== 'pairing' || line.state !== 'waiting') return line;
  assert.match(String(line.code), /^\d{4}$/);
  const { code: _code, ...rest } = line;
  return rest;
}
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
    const pipe = said()?.pipe;
    assert.equal(typeof pipe, 'string', 'the meeting file names a pipe');
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipe as string);
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
/** While a test holds it, the tools are not told: what is asked meanwhile waits where a slow machine would make it wait. */
let toolsHeld: Promise<void> | null = null;
const tools = async (): Promise<CliInfo[]> => {
  if (toolsHeld) await toolsHeld;
  return listClis(toolEnv);
};
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
  onBrowserLink((status, clients) => statuses.push({ ...brief(status), clients }));
  onPairingAsked(() => (asked += 1));
  HELLO_WAIT.ms = LIMITS.hello_wait_ms;
  toolsHeld = null;
  // As started by the browser: the listener opened, and kept on from then.
  assert.equal(await startBrowserLink({ tools, asked: true }), true);
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

test('where the link is: a pipe under a name drawn for this run on Windows, a socket in a folder of the person’s own elsewhere', () => {
  assert.equal(pipeFor('3f9a1c0b7d2e4a65', 'win32', 'C:\\Users\\ornek\\AppData\\Roaming\\Cortex'), '\\\\.\\pipe\\cortex-browser-link-3f9a1c0b7d2e4a65');
  assert.equal(pipeFor('3f9a1c0b7d2e4a65', 'linux', '/var/ornek/Cortex'), path.join('/var/ornek/Cortex', 'link', '3f9a1c0b7d2e.sock'));
  assert.equal(pipeFor('3f9a1c0b7d2e4a65', 'darwin', '/Users/ornek/Library/Application Support/Cortex'), path.join('/Users/ornek/Library/Application Support/Cortex', 'link', '3f9a1c0b7d2e.sock'));
});

test('the listener is closed until the person opens it, or Cortex is started for the browser; the meeting file is written at every start all the same', async () => {
  await fresh();
  stopBrowserLink();
  fs.rmSync(settingsPath(), { force: true });
  forgetSettings();
  // A stale file from a run that died: written over, never trusted.
  fs.writeFileSync(meeting(), JSON.stringify({ version: 1, pipe: '\\\\.\\pipe\\cortex-browser-link-0000000000000000', exe: 'old', pid: 1 }));
  // A first start, nobody having asked for the link: no listener, and the file says so.
  assert.equal(await startBrowserLink({ tools }), false);
  assert.equal(readSettings().browserLink, false);
  assert.deepEqual(said(), { version: 1, pipe: null, exe: app.getPath('exe'), pid: process.pid });
  assert.deepEqual(browserLinkStatus(), { on: false, listening: false, allowed: false, connected: false, asking: false, code: null, locked: false });
  if (process.platform !== 'win32') assert.deepEqual(fs.existsSync(path.join(userData(), 'link')) ? fs.readdirSync(path.join(userData(), 'link')) : [], [], 'nothing listens anywhere');

  // The switch in the settings: opened now, kept on, and the file names the pipe.
  assert.deepEqual(await setBrowserLinkOn(true), { on: true, listening: true, allowed: false, connected: false, asking: false, code: null, locked: false });
  assert.equal(readSettings().browserLink, true);
  const first = said()?.pipe as string;
  assert.deepEqual(said(), { version: 1, pipe: first, exe: app.getPath('exe'), pid: process.pid });
  assert.ok(!fs.readdirSync(userData()).some((name) => name.startsWith('browser-link.json.')), 'written whole: no temporary left beside it');
  if (process.platform !== 'win32') {
    assert.match(path.basename(first), /^[0-9a-f]{12}\.sock$/);
    assert.equal(path.dirname(first), path.join(userData(), 'link'), 'in a folder of the app’s own data');
    assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700, 'which only the person may enter, from before anything listens in it');
    assert.equal(fs.statSync(first).mode & 0o777, 0o600, 'the socket the person’s alone');
  }
  const { client, token } = await paired();
  // Switched off: the browser is told, the listener is gone, the file names no pipe - and the leave given stays.
  assert.deepEqual(await setBrowserLinkOn(false), { on: false, listening: false, allowed: true, connected: false, asking: false, code: null, locked: false });
  assert.deepEqual(await client.next('bye'), { type: 'bye', reason: 'shutdown' });
  await client.gone();
  assert.equal(said()?.pipe, null);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(first), false);
  assert.equal(readSettings().browserLink, false);
  // What is not a yes or a no changes nothing.
  assert.equal((await setBrowserLinkOn('yes')).on, false);

  // On again: another name, and the token is still the browser's leave.
  await setBrowserLinkOn(true);
  const second = said()?.pipe as string;
  assert.notEqual(second, first, 'a name drawn anew each time the listener opens');
  const back = await Client.open();
  back.hello(token);
  assert.equal((await back.next('hello_ok')).token, null);

  // Cortex closing: the browser is told; the file is left, for the browser to find the program by.
  stopBrowserLink();
  assert.deepEqual(await back.next('bye'), { type: 'bye', reason: 'shutdown' });
  assert.equal(fs.existsSync(meeting()), true);
  assert.equal(said()?.exe, app.getPath('exe'));
  // Opened again with the setting kept on: listening without being asked, under yet another name; a socket left behind is cleared.
  if (process.platform !== 'win32') fs.writeFileSync(path.join(userData(), 'link', 'aaaaaaaaaaaa.sock'), '');
  assert.equal(await startBrowserLink({ tools }), true);
  assert.ok(typeof said()?.pipe === 'string' && said()?.pipe !== second);
  if (process.platform !== 'win32') assert.deepEqual(fs.readdirSync(path.join(userData(), 'link')), [path.basename(said()?.pipe as string)]);

  // Started for the browser (`--tarayici`), with the setting off: opened, and kept on from then.
  stopBrowserLink();
  updateSettings((settings) => {
    settings.browserLink = false;
  });
  assert.equal(await startBrowserLink({ tools, asked: true }), true);
  assert.equal(readSettings().browserLink, true);
  // And the same word reaching a Cortex that already runs with the listener closed (a second launch): opened.
  await setBrowserLinkOn(false);
  assert.equal(said()?.pipe, null);
  assert.equal((await setBrowserLinkOn(true)).listening, true);
});

test('a listener that cannot be opened is said so: the setting stays on, the file names no pipe, and the settings can tell', { skip: process.platform === 'win32' }, async () => {
  await fresh();
  stopBrowserLink();
  // The folder its socket lies in cannot be made: a file stands where it would be.
  fs.rmSync(path.join(userData(), 'link'), { recursive: true, force: true });
  fs.writeFileSync(path.join(userData(), 'link'), '');
  try {
    assert.equal(await startBrowserLink({ tools }), false);
    assert.deepEqual(browserLinkStatus(), { on: true, listening: false, allowed: false, connected: false, asking: false, code: null, locked: false });
    assert.equal(said()?.pipe, null);
  } finally {
    fs.rmSync(path.join(userData(), 'link'), { force: true });
  }
  // Tried again from the settings once what stood in the way is gone.
  assert.equal((await setBrowserLinkOn(true)).listening, true);
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

  // An empty line is nothing; a line split across writes, and two in one write, are read as they are.
  const { client, token } = await paired();
  // Let in, a line may be long - and one longer than the limit before its end is in sight is not waited for, not kept.
  const endless = await Client.open();
  endless.hello(token);
  await endless.next('hello_ok');
  const piece = Buffer.alloc(1024 * 1024, 0x61);
  for (let sent = 0; sent <= LINE_MAX && !endless.closed; sent += piece.length) endless.socket.write(piece);
  await endless.gone();
  assert.deepEqual(endless.lines.at(-1), { type: 'bye', reason: 'bad_message' });
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
  assert.deepEqual(noCode(await client.next('pairing')), { type: 'pairing', state: 'waiting' });
  await until(() => asked === 1, 'the person to be asked');
  assert.deepEqual(brief(browserLinkStatus()), { allowed: false, connected: false, asking: true });
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
  assert.deepEqual(brief(decidePairing(true)), { allowed: true, connected: false, asking: false });
  const ok = await again.next('hello_ok');
  const token = ok.token as string;
  assert.deepEqual(ok, { type: 'hello_ok', protocol: 1, app_version: app.getVersion(), tool: { id: 'test-claude', name: 'Test Claude', permission: 'ask', can_ask: true }, vault_name: path.basename(readSettings().vault as string), token });
  assert.match(token, /^[A-Za-z0-9_-]{43,}$/, 'base64url');
  assert.ok(Buffer.from(token, 'base64url').length >= 32, 'of at least 32 random bytes');
  assert.equal(readSettings().browserLinkToken, createHash('sha256').update(token).digest('hex'));
  assert.ok(!fs.readFileSync(settingsPath(), 'utf8').includes(token), 'the token itself is the browser’s to keep');
  assert.deepEqual(brief(browserLinkStatus()), { allowed: true, connected: true, asking: false });
  assert.deepEqual(statuses.at(-1), { allowed: true, connected: true, asking: false, clients: 1 }, 'the window is told');

  // The next time it connects, the token is its leave: nobody is asked, and no new token is drawn.
  again.close();
  await until(() => !browserLinkStatus().connected, 'the link to be seen closed');
  assert.deepEqual(brief(browserLinkStatus()), { allowed: true, connected: false, asking: false }, 'allowed, and not connected now');
  const later = await Client.open();
  later.hello(token);
  assert.equal((await later.next('hello_ok')).token, null);
  assert.equal(asked, 2);
  // A token that is not the one given is no leave: asked again.
  const other = await Client.open();
  other.hello(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
  assert.deepEqual(noCode(await other.next('pairing')), { type: 'pairing', state: 'waiting' });
  await until(() => asked === 3, 'the person to be asked');
  // Allowed, it has a token of its own, and the earlier one is no leave any more: one browser at a time.
  decidePairing(true);
  const second = (await other.next('hello_ok')).token as string;
  assert.notEqual(second, token);
  const old = await Client.open();
  old.hello(token);
  assert.deepEqual(noCode(await old.next('pairing')), { type: 'pairing', state: 'waiting' });
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
  assert.deepEqual(brief(decidePairing(false)), { allowed: false, connected: false, asking: false });
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
  assert.deepEqual(noCode(client.lines.at(-1)), { type: 'pairing', state: 'waiting' });
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
  assert.deepEqual(noCode(client.lines.at(-1)), { type: 'pairing', state: 'waiting' });
  // Allowed in the end: the refusals are forgotten.
  decidePairing(true);
  await client.next('hello_ok');
  unpairBrowser();
  const fresher = await Client.open();
  fresher.hello();
  assert.deepEqual(noCode(await fresher.next('pairing')), { type: 'pairing', state: 'waiting' });
  // An answer with no question is nothing.
  decidePairing(false);
  assert.deepEqual(brief(decidePairing(true)), { allowed: false, connected: false, asking: false });
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
  assert.deepEqual(noCode(await second.next('pairing')), { type: 'pairing', state: 'waiting' });
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
  assert.deepEqual(brief(unpairBrowser()), { allowed: false, connected: false, asking: false });
  assert.deepEqual(await client.next('bye'), { type: 'bye', reason: 'unpaired' });
  await client.gone();
  assert.equal(readSettings().browserLinkToken, null);
  const again = await Client.open();
  again.hello(token);
  assert.deepEqual(noCode(await again.next('pairing')), { type: 'pairing', state: 'waiting' });
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
  await startBrowserLink({ tools: async () => all('codex', 'test-claude'), asked: true });
  assert.equal((await defaultTool())?.id, 'codex');
  // A chat written to: its tool, as the window keeps the one last written to.
  const { id } = sendChat(null, 'test-claude', 'merhaba');
  await until(() => !openChat(id).running, 'the answer');
  assert.equal((await defaultTool())?.id, 'test-claude');
  // That tool gone since: the first offered again.
  stopBrowserLink();
  await startBrowserLink({ tools: async () => all('test'), asked: true });
  assert.equal((await defaultTool())?.id, 'test');

  // None at all.
  stopBrowserLink();
  toolEnv = {};
  await startBrowserLink({ tools, asked: true });
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
  assert.deepEqual((await client.next('hello_ok', from)).tool, { id: 'test-claude', name: 'Test Claude', permission: 'ask', can_ask: true });

  // No vault: said in the hello, and a question cannot be answered.
  updateSettings((settings) => {
    settings.vault = null;
  });
  const at = client.lines.length;
  client.hello();
  assert.equal((await client.next('hello_ok', at)).vault_name, null);
  client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'error', code: 'no_vault', detail: '' });
  // A vault whose folder is gone is none either: nothing is started in a place that is not there.
  const lost = temp('link-lost-');
  updateSettings((settings) => {
    settings.vault = lost;
  });
  fs.rmSync(lost, { recursive: true, force: true });
  client.send({ type: 'ask', id: 'a3', conversation: 'c1', text: 'merhaba', page: null });
  assert.deepEqual(await client.ended('a3'), { type: 'event', id: 'a3', kind: 'error', code: 'no_vault', detail: '' });
});

test('the browser is told how the tool asks leave, as the person chose it, and whether Cortex can hold it to asking once a page is added', async () => {
  await fresh();
  const tool = (id: string): CliInfo => ({ id: id as CliInfo['id'], name: id, available: true });
  // Claude Code and Codex: the mode a new chat with them starts in. Nothing chosen, each asks first.
  assert.deepEqual(linkToolOf(tool('test-claude')), { id: 'test-claude', name: 'test-claude', permission: 'ask', can_ask: true });
  assert.deepEqual(linkToolOf(tool('test-codex')), { id: 'test-codex', name: 'test-codex', permission: 'ask', can_ask: true });
  for (const [cli, mode, permission] of [['test-claude', 'acceptEdits', 'auto'], ['test-claude', 'auto', 'auto'], ['test-claude', 'plan', 'ask'], ['test-claude', 'default', 'ask'], ['test-codex', 'auto', 'auto'], ['test-codex', 'readonly', 'ask'], ['test-codex', 'ask', 'ask']] as const) {
    process.env.CORTEX_TEST_CODEX = path.resolve('tests/fixtures/fake-codex.mjs');
    await beginChat(cli, 'mode', mode);
    assert.deepEqual([linkToolOf(tool(cli)).permission, linkToolOf(tool(cli)).can_ask], [permission, true], `${cli} ${mode}`);
  }
  // Read from what is kept, as after a start in the background: no new chat was shown its chips.
  await beginChat('test-claude', 'mode', 'acceptEdits');
  shutdownChats();
  forgetChats();
  assert.equal(linkToolOf(tool('test-claude')).permission, 'auto');
  // A tool that names its own modes: Cortex cannot tell which of them asks, nor put it in one.
  for (const cli of ['opencode', 'gemini', 'qwen', 'test']) assert.deepEqual([linkToolOf(tool(cli)).permission, linkToolOf(tool(cli)).can_ask], ['unknown', false], cli);
  // Pyn on a server runs its steps there, under that server's own rules: not Cortex's to tell or to change.
  assert.deepEqual([linkToolOf(tool('hermes')).permission, linkToolOf(tool('hermes')).can_ask], ['unknown', false]);
  // A model server on this computer runs nothing: its one tool only saves a card, and is not offered once a page is added.
  for (const cli of ['lmstudio', 'ollama']) assert.deepEqual([linkToolOf(tool(cli)).permission, linkToolOf(tool(cli)).can_ask], ['ask', true], cli);

  // As the hello says it.
  const { client } = await paired();
  assert.deepEqual(client.lines.find((one) => one.type === 'hello_ok')?.tool, { id: 'test-claude', name: 'Test Claude', permission: 'auto', can_ask: true });
});

test('"ask again" passes over the wait after a refusal, once a minute at most; refused three times running, a browser is not asked about again until the person says so in the settings', async () => {
  await fresh();
  let now = 5_000_000;
  REASK.now = () => now;
  const client = await Client.open();
  const hello = async (extra: Line = {}) => {
    const from = client.lines.length;
    client.send({ type: 'hello', protocol: 1, client: 'cortex-browser', client_version: '0.0.1', token: null, ...extra });
    return noCode(await until(() => client.lines[from], 'the answer'));
  };
  const refuse = async () => {
    await until(() => browserLinkStatus().asking, 'the question');
    const from = client.lines.length;
    decidePairing(false);
    await until(() => client.lines[from], 'the refusal');
  };
  assert.deepEqual(await hello(), { type: 'pairing', state: 'waiting' });
  await refuse();
  assert.equal(client.closed, false, 'refused, the link is the browser’s to close');
  // A hello that says it is not asking again, or says nothing of it: refused unasked.
  assert.deepEqual(await hello({ ask_again: false }), { type: 'pairing', state: 'refused' });
  assert.deepEqual(await hello(), { type: 'pairing', state: 'refused' });
  assert.equal(asked, 1);
  // The person pressed "ask again": asked at once. It is no way in: a wrong token with it asks the person, and gives nothing.
  assert.deepEqual(await hello({ ask_again: true, token: 'not-the-token' }), { type: 'pairing', state: 'waiting' });
  assert.equal(asked, 2);
  assert.equal(client.lines.some((one) => one.type === 'hello_ok'), false);
  await refuse();
  // Pressed again within the minute: not asked, however often.
  now += 20_000;
  for (let n = 0; n < 5; n += 1) assert.deepEqual(await hello({ ask_again: true }), { type: 'pairing', state: 'refused' });
  assert.equal(asked, 2);
  // A minute on: once more.
  now += 41_000;
  assert.deepEqual(await hello({ ask_again: true }), { type: 'pairing', state: 'waiting' });
  assert.equal(asked, 3);
  assert.equal(browserLinkStatus().locked, false);
  await refuse();
  // Refused three times running: no hello asks any more, with the word or without it, now or an hour on.
  assert.deepEqual(brief(browserLinkStatus()), { allowed: false, connected: false, asking: false });
  assert.equal(browserLinkStatus().locked, true);
  now += 3_600_000;
  assert.deepEqual(await hello({ ask_again: true }), { type: 'pairing', state: 'refused' });
  assert.deepEqual(await hello(), { type: 'pairing', state: 'refused' });
  assert.equal(asked, 3);
  // The person, in the settings, lets it ask again: the next hello is asked about as the first was.
  assert.equal(allowBrowserFromSettings().locked, false);
  assert.equal(readSettings().browserLinkToken, null, 'which lets nobody in by itself');
  assert.deepEqual(await hello(), { type: 'pairing', state: 'waiting' });
  assert.equal(asked, 4);
  // And with a browser waiting, the same button lets that one in.
  await until(() => browserLinkStatus().asking, 'the question');
  assert.deepEqual(brief(allowBrowserFromSettings()), { allowed: true, connected: false, asking: false });
  assert.equal(typeof (await client.next('hello_ok')).token, 'string');
});

test('Stop from the browser ends the answer, and says it was stopped', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'yavaş olsun', page: null });
  await until(() => client.events('a1').some((one) => one.kind === 'text'), 'the first words');
  client.send({ type: 'cancel', id: 'a1' });
  assert.deepEqual(await client.ended('a1'), { type: 'event', id: 'a1', kind: 'done', cancelled: true });
  // Stop that comes while the tool is still being looked for, before anything began: ended as stopped, nothing begun.
  let letGo: () => void = () => undefined;
  toolsHeld = new Promise((done) => (letGo = done));
  client.send({ type: 'ask', id: 'b1', conversation: 'c7', text: 'çök', page: null });
  client.send({ type: 'cancel', id: 'b1' });
  // Messages are taken in their order: once this one is answered, the cancel before it has been read.
  client.send({ type: 'capture', id: 'k9', title: '', url: '', note: '' });
  await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k9'), 'the cancel to be read');
  toolsHeld = null;
  letGo();
  assert.deepEqual(await client.ended('b1'), { type: 'event', id: 'b1', kind: 'done', cancelled: true });
  assert.deepEqual(kinds(client.events('b1')), ['done'], 'nothing was started, so nothing is said to have been');
  assert.equal(browserChat('c7'), null);
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

test('a full house makes room by its oldest stranger, never by a browser let in or the one being asked about', async () => {
  await fresh();
  const { client, token } = await paired();
  const waiting = await Client.open();
  waiting.hello('not-the-token');
  await waiting.next('pairing');
  const strangers: Client[] = [];
  for (let n = 0; n < MAX_CONNECTIONS - 2; n += 1) strangers.push(await Client.open());
  // Full. The browser connects again: the oldest link that never said hello goes, and no other.
  const back = await Client.open();
  back.hello(token);
  assert.equal((await back.next('hello_ok')).token, null);
  await strangers[0].gone();
  assert.deepEqual(strangers[0].lines, []);
  assert.deepEqual([client.closed, waiting.closed, strangers[1].closed], [false, false, false]);
  for (const one of strangers) one.close();
  await until(() => statuses.at(-1)?.clients === 3, 'the strangers to be seen gone');
  // A house full of browsers let in, and the one asked about: a newcomer is the one that is not taken.
  const held: Client[] = [];
  for (let n = 0; n < MAX_CONNECTIONS - 3; n += 1) {
    const one = await Client.open();
    one.hello(token);
    await one.next('hello_ok');
    held.push(one);
  }
  const extra = await Client.open();
  await extra.gone();
  assert.deepEqual(extra.lines, []);
  assert.equal([client, waiting, back, ...held].some((one) => one.closed), false);
  decidePairing(false);
});

test('a link that says nothing is closed after a while; before a browser is let in a line is short, and a long one is neither kept nor read', async () => {
  await fresh();
  HELLO_WAIT.ms = 150;
  const silent = await Client.open();
  await silent.gone();
  assert.deepEqual(silent.lines, [], 'closed without a word');
  // One that said hello and waits on the person is not: the wait is the person's.
  const waiting = await Client.open();
  waiting.hello();
  await waiting.next('pairing');
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(waiting.closed, false);
  waiting.close();
  await until(() => !browserLinkStatus().asking, 'the question to go with it');
  HELLO_WAIT.ms = LIMITS.hello_wait_ms;

  const limit = LIMITS.line_bytes_before_hello_ok;
  const head = '{"type":"from-the-future","a":"';
  const tail = '"}';
  // A line of exactly the limit is read (and passed over, its kind not known); one byte more is a bad message.
  const fits = await Client.open();
  fits.socket.write(`${head}${'x'.repeat(limit - head.length - tail.length)}${tail}\n`);
  fits.hello();
  assert.deepEqual(noCode(await fits.next('pairing')), { type: 'pairing', state: 'waiting' });
  fits.close();
  const long = await Client.open();
  long.socket.write(`${head}${'x'.repeat(limit - head.length - tail.length + 1)}${tail}\n`);
  await long.gone();
  assert.deepEqual(long.lines, [{ type: 'bye', reason: 'bad_message' }]);
  // Never ended: given up as soon as it is longer than a line may be, not kept until sixteen megabytes of it are in.
  const endless = await Client.open();
  let written = 0;
  const piece = Buffer.alloc(8192, 0x61);
  while (!endless.closed && written < 4 * 1024 * 1024) {
    await new Promise<void>((done) => endless.socket.write(piece, () => done()));
    written += piece.length;
    await new Promise((done) => setImmediate(done));
  }
  await endless.gone();
  assert.deepEqual(endless.lines, [{ type: 'bye', reason: 'bad_message' }]);
  assert.ok(written <= limit + 64 * piece.length, `closed after ${written} bytes`);
  // Waiting on the person is still "before": a long line from a browser not yet let in is a bad message too.
  await until(() => !browserLinkStatus().asking, 'no question open');
  const early = await Client.open();
  early.hello();
  await early.next('pairing');
  early.socket.write(`${head}${'x'.repeat(limit)}${tail}\n`);
  await early.gone();
  assert.deepEqual(early.lines.at(-1), { type: 'bye', reason: 'bad_message' });

  // Let in, a long line is taken however it arrives: in small pieces, cut through the middle of its letters.
  const { client } = await paired();
  const note = 'ş'.repeat(300_000);
  const line = Buffer.from(`${JSON.stringify({ type: 'capture', id: 'k1', title: 'T', url: 'https://example.com/', note })}\n`);
  for (let at = 0; at < line.length; at += 7919) client.socket.write(line.subarray(at, at + 7919));
  const kept = await until(() => client.lines.find((one) => one.type === 'captured' && one.id === 'k1'), 'the long line to be read', 20_000);
  assert.equal(kept.ok, false, 'read whole, and answered (this vault has no memory to keep it in)');
  assert.equal(client.closed, false);
});

test('the code a waiting browser is told is the one the person is shown: of the browser being asked about, and gone with the question', async () => {
  await fresh();
  const first = await Client.open();
  first.hello();
  const code = (await first.next('pairing')).code as string;
  assert.match(code, /^\d{4}$/);
  await until(() => browserLinkStatus().asking, 'the question');
  assert.equal(browserLinkStatus().code, code);
  // Said again to the same browser, it is the same code.
  first.hello();
  await until(() => first.lines.length === 2, 'the second answer');
  assert.equal(first.lines[1].code, code);
  // Another that waits has a code of its own; the person is shown the first one's until the first goes.
  const second = await Client.open();
  second.hello();
  const other = (await second.next('pairing')).code as string;
  assert.equal(browserLinkStatus().code, code);
  first.close();
  await until(() => browserLinkStatus().code !== code, 'the question to pass on');
  assert.equal(browserLinkStatus().code, other);
  decidePairing(true);
  await second.next('hello_ok');
  assert.equal(browserLinkStatus().code, null);
});

test('leave taken back while a browser is on its way in: it is not let in after all, whichever step it was at', async () => {
  await fresh();
  const { client, token } = await paired();
  client.close();
  await until(() => !browserLinkStatus().connected, 'closed');
  let letGo: () => void = () => undefined;
  // Its hello, with a token that is good, is being answered (the tools are slow to tell) when the leave is taken back.
  toolsHeld = new Promise((done) => (letGo = done));
  const back = await Client.open();
  back.hello(token);
  await until(() => statuses.at(-1)?.clients === 1, 'the hello to be read');
  assert.deepEqual(brief(unpairBrowser()), { allowed: false, connected: false, asking: false });
  toolsHeld = null;
  letGo();
  await back.gone();
  assert.deepEqual(back.lines, [{ type: 'bye', reason: 'unpaired' }], 'told so, and never welcomed');
  assert.equal(browserLinkStatus().connected, false);

  // Allowed, and the leave taken back before the welcome was written: the token drawn for it is given to nobody.
  const again = await Client.open();
  again.hello();
  await again.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  toolsHeld = new Promise((done) => (letGo = done));
  decidePairing(true);
  unpairBrowser();
  toolsHeld = null;
  letGo();
  await again.gone();
  assert.equal(again.lines.some((one) => one.type === 'hello_ok'), false);
  assert.deepEqual(again.lines.at(-1), { type: 'bye', reason: 'unpaired' });
  assert.equal(readSettings().browserLinkToken, null);

  // A browser waiting to be asked about goes with it too: nothing of the link is left open for the leave that is gone.
  const waiting = await Client.open();
  waiting.hello();
  await waiting.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  unpairBrowser();
  await waiting.gone();
  assert.deepEqual([waiting.lines.at(-1), browserLinkStatus().asking], [{ type: 'bye', reason: 'unpaired' }, false]);
});

test('a new leave ends the one before it: a browser connected by the earlier token is told and closed', async () => {
  await fresh();
  const { client, token } = await paired();
  const other = await Client.open();
  other.hello('not-the-token');
  await other.next('pairing');
  await until(() => browserLinkStatus().asking, 'the question');
  decidePairing(true);
  const second = (await other.next('hello_ok')).token as string;
  await client.gone();
  assert.deepEqual(client.lines.at(-1), { type: 'bye', reason: 'unpaired' });
  assert.equal(other.closed, false);
  assert.notEqual(second, token);
  assert.deepEqual(brief(browserLinkStatus()), { allowed: true, connected: true, asking: false });
});

test('a question is told the tool that answers it: its conversation’s own. A page for a tool Cortex cannot hold to asking is not sent unless the person said so', async () => {
  await fresh();
  const AGENT = path.resolve('tests/fixtures/fake-acp-agent.mjs');
  process.env.CORTEX_TEST_AGENT = AGENT;
  toolEnv = { CORTEX_TEST_CLAUDE: CLAUDE, CORTEX_TEST_AGENT: AGENT };
  const agent = { id: 'test', name: 'Test agent', permission: 'unknown', can_ask: false };
  const claude = { id: 'test-claude', name: 'Test Claude', permission: 'ask', can_ask: true };
  try {
    const { client } = await paired();
    assert.deepEqual(client.lines.find((one) => one.type === 'hello_ok')?.tool, agent, 'the first tool offered, for a new conversation');
    client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
    await client.ended('a1');
    const statuses1 = client.events('a1').filter((one) => one.kind === 'status');
    assert.deepEqual(statuses1[0], { type: 'event', id: 'a1', kind: 'status', phase: 'starting', tool: agent }, 'said with the first status');
    assert.ok(statuses1.slice(1).every((one) => !('tool' in one)), 'and once');
    // The person writes to Claude Code in Cortex: a new conversation would now go to it...
    const own = sendChat(null, 'test-claude', 'merhaba');
    await until(() => !openChat(own.id).running, 'the answer in Cortex');
    const from = client.lines.length;
    client.hello();
    assert.deepEqual((await client.next('hello_ok', from)).tool, claude);
    // ...and the conversation begun goes on with its own tool. A page for it is refused, the tool named, nothing run.
    const asked1 = openChat(browserChat('c1')).events.filter((one) => one.type === 'user').length;
    client.send({ type: 'ask', id: 'a2', conversation: 'c1', text: 'bu sayfayı özetle', page: PAGE });
    assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'error', code: 'page_unprotected', detail: '', tool: agent });
    assert.deepEqual(client.events('a2').length, 1, 'no status: nothing was started');
    assert.equal(openChat(browserChat('c1')).events.filter((one) => one.type === 'user').length, asked1, 'the tool was sent nothing');
    assert.ok(!JSON.stringify(openChat(browserChat('c1')).events).includes(PAGE.url));
    // The same question without its page is an ordinary one.
    client.send({ type: 'ask', id: 'a3', conversation: 'c1', text: 'bu sayfayı özetle', page: null });
    assert.equal((await client.ended('a3')).kind, 'done');
    // The person, warned in the browser, says to send it all the same: sent, the tool said again.
    client.send({ type: 'ask', id: 'a4', conversation: 'c1', text: 'bu sayfayı özetle', page: PAGE, page_ack: true });
    assert.equal((await client.ended('a4')).kind, 'done');
    assert.deepEqual(client.events('a4')[0], { type: 'event', id: 'a4', kind: 'status', phase: 'starting', tool: agent });
    const user = openChat(browserChat('c1')).events.findLast((one) => one.type === 'user');
    assert.deepEqual(user?.type === 'user' && user.page, { title: PAGE.title, url: PAGE.url });
    // A new conversation goes to the tool last written to: the agent again, and its page is refused the same way...
    client.send({ type: 'ask', id: 'b1', conversation: 'c9', text: 'bu sayfayı özetle', page: PAGE });
    assert.deepEqual(await client.ended('b1'), { type: 'event', id: 'b1', kind: 'error', code: 'page_unprotected', detail: '', tool: agent });
    assert.equal(browserChat('c9'), null, 'no chat is begun for a question refused');
    // ...and, Claude Code written to since, to a tool Cortex can hold to asking: its page needs no such word.
    sendChat(own.id, 'test-claude', 'devam');
    await until(() => !openChat(own.id).running, 'the answer in Cortex');
    client.send({ type: 'ask', id: 'a5', conversation: 'c2', text: 'bu sayfayı özetle', page: PAGE });
    assert.equal((await client.ended('a5')).kind, 'done');
    assert.deepEqual(client.events('a5')[0], { type: 'event', id: 'a5', kind: 'status', phase: 'starting', tool: claude });
    assert.equal(openChat(browserChat('c2')).chat.cli, 'test-claude');
  } finally {
    delete process.env.CORTEX_TEST_AGENT;
  }
});

test('the id of a question still being answered is not used again: the link is closed for it', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'yavaş olsun', page: null });
  await until(() => client.events('a1').some((one) => one.kind === 'text'), 'the first words');
  const before = client.events('a1').length;
  client.send({ type: 'ask', id: 'a1', conversation: 'c2', text: 'ikinci', page: null });
  await client.gone();
  assert.deepEqual(client.lines.at(-1), { type: 'bye', reason: 'bad_message' });
  assert.equal(client.events('a1').length, before, 'nothing more was said under that id');
  assert.equal(browserChat('c2'), null);
  // Ended, an id is free again.
  shutdownChats(true);
  await until(() => !openChat(browserChat('c1')).running, 'the first to stop');
  const { client: again } = await paired();
  again.send({ type: 'ask', id: 'a1', conversation: 'c3', text: 'merhaba', page: null });
  assert.equal((await again.ended('a1')).kind, 'done');
  again.send({ type: 'ask', id: 'a1', conversation: 'c3', text: 'merhaba', page: null });
  await until(() => again.events('a1').filter((one) => one.kind === 'done').length === 2, 'the second answer under the same id');
});

test('a failure’s detail is for a log, and never says where anything is on this computer', async () => {
  const home = os.homedir();
  assert.equal(safeDetail(`EACCES: permission denied, open '/var/lib/cortex/chats/index.json.tmp'`), 'EACCES: permission denied, open \'…\'');
  assert.equal(safeDetail('Claude Code stopped: cannot read C:\\Users\\ornek\\AppData\\Roaming\\Cortex\\x.json now'), 'Claude Code stopped: cannot read … now');
  assert.equal(safeDetail(`no such file ${path.join(home, 'notes', 'a.md')} or ~/.config/x and \\\\server\\share\\f`), 'no such file … or … and …');
  assert.equal(safeDetail('fetch https://example.com/a/b failed: 5/7 done'), 'fetch https://example.com/a/b failed: 5/7 done', 'an address on the web is not a place on this computer');
  assert.equal(safeDetail(`${'ş'.repeat(400)}`), 'ş'.repeat(LIMITS.detail_chars));
  assert.equal(safeDetail('😀'.repeat(400)).length, 2 * LIMITS.detail_chars, 'cut by characters, not through one');

  await fresh();
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const { client } = await paired();
  // Cortex's own failure: the chats' list cannot be written.
  const chats = path.join(userData(), 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.chmodSync(chats, 0o500);
  try {
    client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
    const end = await client.ended('a1');
    assert.deepEqual([end.kind, end.code], ['error', 'internal']);
    assert.ok(!/[\\/]/.test(end.detail as string), `a path in the detail: ${end.detail}`);
    assert.ok(!JSON.stringify(client.lines).includes(userData()));
  } finally {
    fs.chmodSync(chats, 0o700);
  }
});

test('lengths are counted in characters, and what Cortex writes is cut to the contract’s limits', async () => {
  // A card as a tool may send it: longer in every way than the contract takes.
  const card = linkPermissionOf({
    type: 'permission',
    id: 'p1',
    title: '😀'.repeat(LIMITS.permission_title_chars + 50),
    kind: 'k'.repeat(LIMITS.name_chars + 5),
    paths: Array.from({ length: LIMITS.permission_paths + 5 }, (_, n) => `Notes/${n}.md`),
    options: [
      ...Array.from({ length: LIMITS.permission_options + 2 }, (_, n) => ({ id: `o${n}`, name: 'n'.repeat(LIMITS.name_chars + 5), kind: 'allow_once' as const })),
    ],
  });
  assert.equal(card.title, '😀'.repeat(LIMITS.permission_title_chars));
  assert.equal(card.kind.length, LIMITS.name_chars);
  assert.equal(card.paths.length, LIMITS.permission_paths);
  assert.deepEqual([card.options.length, card.options[0].name.length, card.after_page], [LIMITS.permission_options, LIMITS.name_chars, false]);
  assert.notEqual(readCortexMessage({ type: 'event', id: 'a', kind: 'permission', permission: card }), null, 'as cut, it is the contract’s');
  // After a page: said so, and no leave for good among its answers; an answer whose id the browser could not send back is left out.
  const after = linkPermissionOf({ type: 'permission', id: 'p2', title: 't', kind: 'edit', paths: [], afterPage: true, options: [{ id: 'allow', name: 'Allow once', kind: 'allow_once' }, { id: 'always', name: 'Always', kind: 'allow_always' }, { id: 'x'.repeat(LIMITS.id_chars + 1), name: 'Long', kind: 'reject_once' }, { id: 'deny', name: 'Reject', kind: 'reject_once' }] });
  assert.deepEqual([after.after_page, after.options.map((one) => one.id)], [true, ['allow', 'deny']]);
  assert.equal(linkToolOf({ id: 'test-claude', name: 'n'.repeat(500), available: true }).name.length, LIMITS.name_chars);

  await fresh();
  const { client } = await paired();
  // A hundred thousand characters of two halves each: as many characters as a question may have, twice as many halves.
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: '😀'.repeat(LIMITS.text_chars), page: null });
  assert.equal((await client.ended('a1')).kind, 'done');
  client.send({ type: 'ask', id: 'a2', conversation: 'c2', text: '😀'.repeat(LIMITS.text_chars + 1), page: null });
  assert.deepEqual(await client.ended('a2'), { type: 'event', id: 'a2', kind: 'error', code: 'too_long', detail: '' });
  client.send({ type: 'ask', id: 'a3', conversation: 'c3', text: 'özetle', page: { ...PAGE, text: '😀'.repeat(LIMITS.page_text_chars) } });
  assert.equal((await client.ended('a3')).kind, 'done');
});

test('a card still open when its answer ends is closed with it, in the browser and in Cortex', async () => {
  await fresh();
  const { client } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'izin iste', page: null });
  const card = (await until(() => client.events('a1').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string };
  client.send({ type: 'cancel', id: 'a1' });
  assert.deepEqual(await client.ended('a1'), { type: 'event', id: 'a1', kind: 'done', cancelled: true });
  // Stopped by the person: told closed before the end, so no card is left waiting on either side.
  const closed = client.events('a1').findIndex((one) => one.kind === 'permission_closed');
  assert.deepEqual(client.events('a1')[closed], { type: 'event', id: 'a1', kind: 'permission_closed', permission: card.id, option: null });
  assert.ok(closed > 0 && closed < client.events('a1').length - 1);
  await until(() => !openChat(browserChat('c1')).running, 'the chat to stop');
  assert.deepEqual(openChat(browserChat('c1')).events.find((one) => one.type === 'answered'), { type: 'answered', id: card.id, option: null });

  // The tool gone under a card that waits: the answer ends as a failure, which is its last word to the browser and
  // closes the card there (the contract says so); in Cortex the card is closed by the chat itself.
  client.send({ type: 'ask', id: 'a2', conversation: 'c2', text: 'izin iste', page: null });
  const second = (await until(() => client.events('a2').find((one) => one.kind === 'permission'), 'the card')).permission as { id: string };
  shutdownChats();
  const end = await client.ended('a2');
  assert.deepEqual([end.kind, end.code], ['error', 'tool_failed']);
  assert.equal(client.events('a2').at(-1), end, 'nothing is said after the end');
  await until(() => openChat(browserChat('c2')).events.some((one) => one.type === 'answered' && one.id === second.id), 'the card closed in Cortex');
  assert.deepEqual(openChat(browserChat('c2')).events.find((one) => one.type === 'answered' && one.id === second.id), { type: 'answered', id: second.id, option: null });
});

test('Cortex is not closed to install an update unasked while a browser is there, or has just asked', async () => {
  await fresh();
  let now = 1_000_000;
  REASK.now = () => now;
  assert.equal(browserLinkBusy(), false);
  const { client } = await paired();
  assert.equal(browserLinkBusy(), true, 'a browser connected');
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  await client.ended('a1');
  client.close();
  await until(() => !browserLinkStatus().connected, 'closed');
  assert.equal(browserLinkBusy(), true, 'gone a moment ago, a question just answered');
  now += 9 * 60_000;
  assert.equal(browserLinkBusy(), true);
  now += 2 * 60_000;
  assert.equal(browserLinkBusy(), false, 'ten minutes on, nobody is waiting on it');
});

test('the token is told to the browser and to nobody else: not to the console, not to a file', async () => {
  await fresh();
  const seen = tokens.length;
  consoleSaid.length = 0;
  const { client, token } = await paired();
  client.send({ type: 'ask', id: 'a1', conversation: 'c1', text: 'merhaba', page: null });
  await client.ended('a1');
  // A wrong one, a broken line that carries one, a second leave, a leave taken back, the listener closed and opened: none of it is written down.
  const wrong = await Client.open();
  wrong.hello('KANARYA-YANLIS-JETON-0123456789abcdefghijklmnopqrstuv');
  await wrong.next('pairing');
  const broken = await Client.open();
  broken.socket.write(`{"type":"hello","protocol":1,"token":"${token}"\n`);
  await broken.gone();
  await until(() => browserLinkStatus().asking, 'the question');
  decidePairing(true);
  const second = (await wrong.next('hello_ok')).token as string;
  unpairBrowser();
  await setBrowserLinkOn(false);
  await setBrowserLinkOn(true);
  const { token: third } = await paired();
  stopBrowserLink();
  // The tokens of this test alone: it holds whichever other tests ran before it, or none.
  const given = tokens.slice(seen);
  assert.deepEqual([...new Set(given)].sort(), [token, second, third].sort());
  assert.equal(new Set(given).size, 3);
  const secrets = [...given, 'KANARYA-YANLIS-JETON-0123456789abcdefghijklmnopqrstuv'];
  for (const line of consoleSaid) for (const secret of secrets) assert.ok(!line.includes(secret), 'a token in the console');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.isFile() ? [path.join(dir, entry.name)] : []));
  const kept = files(userData());
  assert.ok(kept.some((file) => file.endsWith('settings.json')) && kept.some((file) => file.endsWith('browser-link.json')) && kept.some((file) => file.includes(`${path.sep}chats${path.sep}`)), 'the files Cortex keeps were looked through');
  for (const file of kept) for (const secret of secrets) assert.ok(!fs.readFileSync(file).includes(secret), `a token in ${path.basename(file)}`);
});

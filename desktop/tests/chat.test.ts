import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import type { ChatEvent, ChatPush } from '../shared/chat';
import { launchOf, listClis, readShim } from '../electron/services/clis';
import {
  answerChat,
  cancelChat,
  compact,
  forgetChats,
  listChats,
  onChatPush,
  openChat,
  removeChat,
  restartIdleChats,
  scrubberFor,
  sendChat,
  setChatOption,
  shownPath,
  shutdownChats,
} from '../electron/services/chat';
import { STOP_GRACE, cardTextFor } from '../electron/services/chatKit';
import { renameRetrying, writeWhole } from '../electron/services/fileWrite';
import { pythonOf } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';
import { settleVault } from '../electron/services/setup';

/**
 * The chat with the person's own AI CLIs (electron/services/chat.ts): found
 * without a shell, spoken to over ACP, and what they say made safe to show.
 * Driven against a stand-in that answers as OpenCode was recorded answering
 * (tests/fixtures/fake-acp-agent.mjs).
 */

const AGENT = path.resolve('tests/fixtures/fake-acp-agent.mjs');
// A path in the CLI's own words keeps the separators it was written with; only the vault's place is taken off.
const NOTE = path.join('Notes', 'Plan.md');
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

function useVault(): { vault: string; log: string } {
  const vault = temp('chat-vault-');
  fs.mkdirSync(path.join(vault, 'Notes'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n');
  updateSettings((settings) => {
    settings.vault = vault;
  });
  const log = path.join(temp('chat-log-'), 'agent.jsonl');
  process.env.CORTEX_TEST_AGENT = AGENT;
  process.env.FAKE_AGENT_LOG = log;
  return { vault, log };
}
const methodsIn = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown>; cwd: string }) : []);

test.after(() => shutdownChats());

test('a CLI is found without a shell: an npm shim read for the program or the script it starts', () => {
  const bin = temp('clis-');
  fs.mkdirSync(path.join(bin, 'node_modules', 'x', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'node_modules', 'x', 'bin', 'opencode.exe'), '');
  fs.writeFileSync(path.join(bin, 'node_modules', 'x', 'cli.js'), '');
  fs.writeFileSync(path.join(bin, 'node.exe'), '');
  fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\x\\bin\\opencode.exe"   %*\r\n');
  // As npm writes a script's shim: it looks for a node beside itself first.
  fs.writeFileSync(
    path.join(bin, 'gemini.cmd'),
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n',
  );
  assert.deepEqual(readShim(path.join(bin, 'opencode.cmd'), {}), { command: path.join(bin, 'node_modules', 'x', 'bin', 'opencode.exe'), args: [] });
  assert.deepEqual(readShim(path.join(bin, 'gemini.cmd'), {}), { command: path.join(bin, 'node.exe'), args: [path.join(bin, 'node_modules', 'x', 'cli.js')] }, 'a script, by the node beside the shim');
  fs.writeFileSync(path.join(bin, 'broken.cmd'), 'echo nothing here');
  assert.equal(readShim(path.join(bin, 'broken.cmd'), {}), null);
  if (process.platform === 'win32') {
    assert.deepEqual(launchOf('opencode', { PATH: bin }), { command: path.join(bin, 'node_modules', 'x', 'bin', 'opencode.exe'), args: ['acp'], env: undefined });
    assert.deepEqual(launchOf('gemini', { PATH: bin })?.args, [path.join(bin, 'node_modules', 'x', 'cli.js'), '--acp']);
    assert.equal(launchOf('qwen', { PATH: bin }), null, 'not installed');
  }
  const listed = listClis({ PATH: bin, CORTEX_TEST_AGENT: AGENT });
  assert.deepEqual(listed.map((one) => one.id), ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama', 'test']);
  assert.equal(listed.find((one) => one.id === 'qwen')?.available, false);
  assert.equal(listed.find((one) => one.id === 'ollama')?.available, false, 'a model server neither installed nor up is not offered');
  // Installed, its server off: offered, said to be off (a red dot), to be opened.
  const lms = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-'));
  fs.writeFileSync(path.join(lms, process.platform === 'win32' ? 'lms.exe' : 'lms'), '');
  const withLms = listClis({ PATH: lms }).find((one) => one.id === 'lmstudio');
  assert.deepEqual([withLms?.available, withLms?.local], [true, 'off']);
  assert.equal(listClis({ PATH: bin }).some((one) => one.id === 'test'), false, 'the test agent only when named');
});

test('what a CLI says is made safe to show: the vault taken off every path, home said as ~, a path outside cut to its name', () => {
  const vault = process.platform === 'win32' ? 'C:\\Users\\kisi\\Documents\\Pyn' : '/home/kisi/Pyn';
  const home = process.platform === 'win32' ? 'C:\\Users\\kisi' : '/home/kisi';
  const scrub = scrubberFor(vault, home);
  const inside = process.platform === 'win32' ? 'Read c:/users/kisi/documents/pyn/Notes/Plan.md and C:\\Users\\kisi\\.config\\x' : 'Read /home/kisi/Pyn/Notes/Plan.md and /home/kisi/.config/x';
  assert.equal(scrub(inside), process.platform === 'win32' ? 'Read Notes/Plan.md and ~\\.config\\x' : 'Read Notes/Plan.md and ~/.config/x');
  assert.equal(shownPath(vault, path.join(vault, 'Notes', 'Plan.md')), 'Notes/Plan.md');
  assert.equal(shownPath(vault, 'Notes/Plan.md'), 'Notes/Plan.md', 'relative to the vault as given');
  assert.equal(shownPath(vault, path.join(home, 'secret.txt')), '…/secret.txt');
  assert.equal(shownPath(vault, path.join(vault, '..', 'Other', 'x.md')), '…/x.md', 'climbing out is outside');
  // A folder beside the vault whose name begins as its does is not the vault; the vault at a sentence's end is.
  assert.equal(scrub(`${vault}2${path.sep}x.md`), process.platform === 'win32' ? '~\\Documents\\Pyn2\\x.md' : '~/Pyn2/x.md');
  assert.equal(scrub(`Working in ${vault}.`), 'Working in .');
  // A vault at a drive's root - a USB stick, D:\ - is a place that ends with its separator: what follows it is in it.
  const drive = scrubberFor('D:\\', home);
  assert.equal(drive('Read D:\\Notes\\Plan.md and d:/Notes/b.md'), 'Read Notes\\Plan.md and Notes/b.md');
  const card = cardTextFor('D:\\', '‹Kasa›', home);
  assert.equal(card('Remove-Item -Recurse D:\\Notes; ls d:/'), 'Remove-Item -Recurse ‹Kasa›\\Notes; ls ‹Kasa›/');
});

test('a chat is kept short: the pieces of a message joined, every word on a step joined into it', () => {
  const kept = compact([
    { type: 'user', text: 'merhaba', at: 1 },
    { type: 'thought', id: 'm:t', text: 'Düşün' },
    { type: 'thought', id: 'm:t', text: 'üyorum' },
    { type: 'tool', id: 'c1', title: 'read', status: 'pending' },
    { type: 'text', id: 'm', text: 'Mer' },
    { type: 'tool', id: 'c1', status: 'completed', output: 'ok' },
    { type: 'text', id: 'm', text: 'haba' },
    { type: 'done', reason: 'end_turn' },
  ]);
  assert.deepEqual(kept, [
    { type: 'user', text: 'merhaba', at: 1 },
    { type: 'thought', id: 'm:t', text: 'Düşünüyorum' },
    { type: 'tool', id: 'c1', title: 'read', status: 'completed', output: 'ok' },
    { type: 'text', id: 'm', text: 'Merhaba' },
    { type: 'done', reason: 'end_turn' },
  ]);
  // One step's id in two turns - a local model's steps are numbered again at every start of the app - is two steps.
  const twice = compact([
    { type: 'user', text: 'bunu kaydet', at: 1 },
    { type: 'tool', id: 'turn-1:tool:0:0', title: 'Gelen kutusuna eklendi', status: 'completed', paths: ['Inbox/a.md'] },
    { type: 'done', reason: 'end_turn' },
    { type: 'user', text: 'şunu da kaydet', at: 2 },
    { type: 'tool', id: 'turn-1:tool:0:0', title: 'Gelen kutusuna eklendi', status: 'completed', paths: ['Inbox/b.md'] },
    { type: 'done', reason: 'end_turn' },
  ]);
  assert.deepEqual(
    twice.filter((one) => one.type === 'tool').map((one) => (one as { paths?: string[] }).paths),
    [['Inbox/a.md'], ['Inbox/b.md']],
  );
});

test('a message gets its answer streamed from the CLI started in the vault: its thinking, its steps with paths made safe, its words, its usage', async () => {
  const { vault, log } = useVault();
  const { id } = sendChat(null, 'test', 'merhaba Pyn');
  const end = await doneOf(id);
  assert.deepEqual(end, { type: 'done', reason: 'end_turn' });
  const events = eventsOf(id);
  assert.equal(events[0].type, 'user');
  assert.deepEqual(events.find((one) => one.type === 'thought'), { type: 'thought', id: 'msg-1:reasoning:thought', text: 'Düşünüyorum' });
  const tool = compact(events).find((one) => one.type === 'tool');
  assert.deepEqual(tool, { type: 'tool', id: 'call-1', title: 'read', kind: 'read', status: 'completed', paths: ['Notes/Plan.md', '…/win.ini'], output: `Read file ${NOTE}` });
  assert.equal(
    events
      .filter((one): one is Extract<ChatEvent, { type: 'text' }> => one.type === 'text')
      .map((one) => one.text)
      .join(''),
    'Merhaba dünya, [[Ideas]] notuna baktım.',
  );
  assert.deepEqual(events.find((one) => one.type === 'usage'), { type: 'usage', used: 6088, size: 262144, cost: 0, currency: 'USD' });
  assert.ok(!JSON.stringify(events).includes(vault), 'the vault’s place is never in what the window is told');

  const opened = openChat(id);
  assert.equal(opened.chat.title, 'merhaba Pyn');
  assert.equal(opened.running, false);
  assert.deepEqual(
    opened.options.map((one) => [one.id, one.current, one.choices.map((choice) => choice.value)]),
    [
      ['model', 'fake/a', ['fake/a', 'fake/b']],
      ['mode', 'build', ['build', 'plan']],
    ],
    'its settings, a list in groups read whole',
  );
  const sent = methodsIn(log);
  assert.ok(sent.every((one) => one.cwd === vault), 'started in the vault, where its hooks give it the vault’s memory');
  assert.deepEqual(sent.find((one) => one.method === 'initialize')?.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(sent.find((one) => one.method === 'session/new')?.params, { cwd: vault, mcpServers: [] });
});

test('a step the CLI asks leave for waits for the person’s answer, and Stop ends a turn', async () => {
  useVault();
  const { id } = sendChat(null, 'test', 'izin iste');
  const asked = await until(() => eventsOf(id).find((one): one is Extract<ChatEvent, { type: 'permission' }> => one.type === 'permission'), 'the permission card');
  // A card says the vault's place as a word, never takes it off (chatKit.ts, cardTextFor).
  assert.equal(asked.title, `edit ${path.join('‹Kasa›', NOTE)}`);
  assert.deepEqual(asked.paths, ['Notes/Plan.md']);
  assert.deepEqual(asked.options.map((one) => [one.id, one.kind]), [
    ['once', 'allow_once'],
    ['always', 'allow_always'],
    ['reject', 'reject_once'],
  ]);
  assert.throws(() => sendChat(id, 'test', 'bir daha'), /Wait for the answer/);
  answerChat(id, asked.id, 'always');
  await doneOf(id);
  assert.ok(eventsOf(id).some((one) => one.type === 'answered' && one.option === 'always'));
  assert.ok(eventsOf(id).some((one) => one.type === 'text' && one.text.includes('izin: always')));

  const before = eventsOf(id).length;
  sendChat(id, 'test', 'yavaş olsun');
  await until(() => eventsOf(id).slice(before).some((one) => one.type === 'text' && one.text.startsWith('Uzun')), 'the slow answer to begin');
  cancelChat(id);
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'cancelled' });
  assert.equal(openChat(id).running, false);
});

test('a CLI out of quota says so, one that dies says why, and the next message starts it again', async () => {
  useVault();
  const { id } = sendChat(null, 'test', 'hata ver');
  const failed = await doneOf(id);
  assert.equal(failed.type, 'error');
  assert.ok(failed.type === 'error' && failed.kind === 'provider.quota' && /Insufficient balance/.test(failed.message));

  let before = eventsOf(id).length;
  sendChat(id, 'test', 'giriş yapmadım');
  const logged = await doneOf(id, before);
  assert.ok(logged.type === 'error' && logged.kind === 'auth', 'one not logged in says so');

  before = eventsOf(id).length;
  sendChat(id, 'test', 'çök');
  const died = await doneOf(id, before);
  assert.ok(died.type === 'error' && died.kind === 'stopped' && /boom/.test(died.message), JSON.stringify(died));

  before = eventsOf(id).length;
  sendChat(id, 'test', 'tekrar merhaba');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' }, 'started again, in a new session');
});

test('a setting chosen is kept for the CLI’s next sessions; chats are kept per vault across a restart, and a chat forgotten is gone', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test', 'ilk');
  await doneOf(id);
  const options = await setChatOption(id, 'model', 'fake/b');
  assert.equal(options.find((one) => one.id === 'model')?.current, 'fake/b');
  await assert.rejects(setChatOption(id, 'model', 'not/offered'), /Not a choice/);

  const second = sendChat(null, 'test', 'ikinci').id;
  await doneOf(second);
  const sets = methodsIn(log).filter((one) => one.method === 'session/set_config_option');
  assert.deepEqual(sets[sets.length - 1].params.value, 'fake/b', 'given to the new session before its first message');
  assert.equal(openChat(second).options.find((one) => one.id === 'model')?.current, 'fake/b');

  forgetChats();
  const listed = listChats().map((one) => one.id);
  assert.ok(listed.includes(id) && listed.includes(second));
  assert.deepEqual(
    openChat(id)
      .events.filter((one) => one.type === 'text')
      .map((one) => (one as { text: string }).text),
    ['Merhaba dünya, [[Ideas]] notuna baktım.'],
    'reopened as it read, its pieces joined',
  );
  updateSettings((settings) => {
    settings.vault = temp('chat-other-');
  });
  assert.deepEqual(listChats(), [], 'another vault has its own chats');
  assert.throws(() => sendChat(id, 'test', 'x'), /another vault/);

  removeChat(id);
  assert.throws(() => openChat(id), /gone/);
  assert.throws(() => sendChat(null, 'test', '   '), /empty/);
  assert.throws(() => sendChat(null, 'nope', 'x'), /Not a CLI/);
  assert.throws(() => openChat('../index'), /Not a chat/);
});

test('a restart asked for while a turn goes on is made when the last turn ends, not lost', async () => {
  const { log } = useVault();
  const busy = sendChat(null, 'test', 'yavaş olsun').id;
  await until(() => eventsOf(busy).some((one) => one.type === 'text' && one.text.startsWith('Uzun')), 'the slow answer');
  assert.equal(restartIdleChats(), false, 'not cut off');
  const starts = () => methodsIn(log).filter((one) => one.method === 'initialize').length;
  assert.equal(starts(), 1);
  cancelChat(busy);
  await doneOf(busy);
  const other = sendChat(null, 'test', 'merhaba').id;
  await doneOf(other);
  assert.equal(starts(), 2, 'the CLI started again, with the new sign-in');
  assert.equal(restartIdleChats(), true, 'nothing running: at once');
});

test('a chat deleted while it answers leaves nothing behind', async () => {
  useVault();
  const { id } = sendChat(null, 'test', 'yavaş olsun: gizli mesaj');
  await until(() => eventsOf(id).some((one) => one.type === 'text' && one.text.startsWith('Uzun')), 'the slow answer');
  const before = pushes.length;
  removeChat(id);
  await until(() => pushes.slice(before).some((one) => one.chatId === id && one.state?.running === false), 'the turn to settle');
  const kept = path.join(app.getPath('userData'), 'chats', `${id}.json`);
  assert.equal(fs.existsSync(kept), false, 'its log not written again');
  assert.ok(!pushes.slice(before).some((one) => one.chatId === id && one.summary), 'not put back in the list');
  assert.ok(!listChats().some((one) => one.id === id));
});

test('Stop ends a turn whose CLI never finishes starting', async () => {
  useVault();
  shutdownChats();
  process.env.FAKE_ACP_HANG_INIT = '1';
  try {
    const { id } = sendChat(null, 'test', 'merhaba');
    cancelChat(id);
    assert.deepEqual(await doneOf(id), { type: 'done', reason: 'cancelled' });
    assert.equal(openChat(id).running, false);
  } finally {
    delete process.env.FAKE_ACP_HANG_INIT;
    shutdownChats();
  }
});

test('Stop while the vault just opened is still being bound ends the turn without starting its CLI', { skip: pythonOf() === null }, async () => {
  const { vault, log } = useVault();
  shutdownChats();
  // The vault's engine, its `relocate` held until the test lets it go (services/setup.ts, settleVault).
  fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.9\n');
  fs.writeFileSync(
    path.join(vault, 'beyin.py'),
    "import json, os, time\nhere = os.path.dirname(os.path.abspath(__file__))\nwhile not os.path.exists(os.path.join(here, 'devam')): time.sleep(0.02)\nprint(json.dumps({'status': 'unchanged'}))\n",
  );
  const settled = settleVault();
  try {
    const { id } = sendChat(null, 'test', 'merhaba');
    cancelChat(id);
    assert.deepEqual(await doneOf(id), { type: 'done', reason: 'cancelled' });
    assert.equal(openChat(id).running, false);
    assert.deepEqual(methodsIn(log), [], 'no CLI started for a turn already stopped');
  } finally {
    fs.writeFileSync(path.join(vault, 'devam'), '');
    assert.equal(await settled, null);
    shutdownChats();
  }
});

test('Stop on one chat of a CLI that will not stop lets that chat go; the other chats of the CLI go on', async () => {
  const grace = STOP_GRACE.ms;
  STOP_GRACE.ms = 300;
  try {
    const { log } = useVault();
    const waiting = sendChat(null, 'test', 'izin iste').id;
    const card = await until(() => eventsOf(waiting).find((one): one is Extract<ChatEvent, { type: 'permission' }> => one.type === 'permission'), 'the card');
    const stubborn = sendChat(null, 'test', 'inatçı ol').id;
    await until(() => eventsOf(stubborn).some((one) => one.type === 'text' && one.text.startsWith('Durmayacağım')), 'the stubborn answer');
    cancelChat(stubborn);
    assert.deepEqual(await doneOf(stubborn), { type: 'done', reason: 'cancelled' });
    answerChat(waiting, card.id, 'once');
    assert.deepEqual(await doneOf(waiting), { type: 'done', reason: 'end_turn' }, 'the other chat answered');
    assert.equal(methodsIn(log).filter((one) => one.method === 'initialize').length, 1, 'the program was never closed');
    // Alone on its program, a chat that will not stop has the program ended under it: still a stop.
    const before = eventsOf(stubborn).length;
    sendChat(stubborn, 'test', 'inatçı ol');
    await until(() => eventsOf(stubborn).slice(before).some((one) => one.type === 'text' && one.text.startsWith('Durmayacağım')), 'the stubborn answer again');
    cancelChat(stubborn);
    assert.deepEqual(await doneOf(stubborn, before), { type: 'done', reason: 'cancelled' });
  } finally {
    STOP_GRACE.ms = grace;
  }
});

test('a CLI whose start failed is started again at the next message, not kept failing until the app is opened again', async () => {
  const { log } = useVault();
  shutdownChats();
  process.env.FAKE_ACP_FAIL_INIT = '1';
  let id: string;
  try {
    id = sendChat(null, 'test', 'merhaba').id;
    const failed = await doneOf(id);
    assert.ok(failed.type === 'error' && /could not read its settings/.test(failed.message), JSON.stringify(failed));
  } finally {
    delete process.env.FAKE_ACP_FAIL_INIT;
  }
  const before = eventsOf(id).length;
  sendChat(id, 'test', 'tekrar');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' });
  assert.equal(methodsIn(log).filter((one) => one.method === 'initialize').length, 2);
});

test('an agent that says only the protocol’s “authentication required” is said to be not signed in', async () => {
  useVault();
  const { id } = sendChat(null, 'test', 'yetkisiz');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error' && failed.kind === 'auth', JSON.stringify(failed));
});

test('a file written whole is tried again while Windows holds it, and its temporary is never left', () => {
  const folder = temp('write-');
  const file = path.join(folder, 'index.json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const rename = fs.renameSync;
  let refused = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (refused < 2) {
      refused += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    rename(from, to);
  }) as typeof fs.renameSync;
  try {
    writeWhole(file, '{"a":1}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
    assert.equal(refused, 2);
    refused = -100;
    assert.throws(() => writeWhole(file, '{"a":2}'), /EPERM/, 'given up after a while');
    assert.deepEqual(fs.readdirSync(folder), ['index.json'], 'no temporary left');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}', 'the old file whole');
    // Any other error is not tried again, nor a busy file on another system.
    refused = 2;
    let calls = 0;
    const counted = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      counted(from, to);
    }) as typeof fs.renameSync;
    assert.throws(() => renameRetrying(path.join(folder, 'none'), file), /ENOENT/);
    assert.equal(calls, 1);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    refused = 0;
    calls = 0;
    assert.throws(() => renameRetrying(path.join(folder, 'index.json'), file), /EPERM/);
    assert.equal(calls, 1);
  } finally {
    fs.renameSync = rename;
    Object.defineProperty(process, 'platform', platform);
  }
});

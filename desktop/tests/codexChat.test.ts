import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatEvent, ChatPush } from '../shared/chat';
import { answerChat, cancelChat, forgetChats, onChatPush, openChat, restartIdleChats, sendChat, setChatOption, shutdownChats } from '../electron/services/chat';
import { STOP_GRACE } from '../electron/services/chatKit';
import { codexOptions, sentenceOf } from '../electron/services/codexChat';
import { updateSettings } from '../electron/services/settings';

/**
 * The chat with Codex through its app server (electron/services/codexChat.ts),
 * driven against a stand-in that writes what Codex 0.162.1 was recorded writing
 * (tests/fixtures/fake-codex.mjs).
 */

const CODEX = path.resolve('tests/fixtures/fake-codex.mjs');
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
const textOf = (events: ChatEvent[]) =>
  events
    .filter((one): one is Extract<ChatEvent, { type: 'text' }> => one.type === 'text')
    .map((one) => one.text)
    .join('|');
const cardOf = (chatId: string, after = 0) => until(() => eventsOf(chatId).slice(after).find((one): one is Extract<ChatEvent, { type: 'permission' }> => one.type === 'permission'), 'a card');

function useVault(): { vault: string; log: string } {
  const vault = temp('codex-vault-');
  fs.mkdirSync(path.join(vault, 'Notes'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  const log = path.join(temp('codex-log-'), 'codex.jsonl');
  process.env.CORTEX_TEST_CODEX = CODEX;
  process.env.FAKE_AGENT_LOG = log;
  return { vault, log };
}
const sent = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown>; cwd: string; pid: number }) : []);
const turnsStarted = (log: string) => sent(log).filter((one) => one.method === 'turn/start');
/** What a turn that will not stop was answered when it asked leave after its interrupt, as the stand-in wrote it down. */
const answered = (log: string) => sent(log).filter((one) => one.method === 'answered').map((one) => one.params as { turnId: string; decision: string | null });
const lastText = (chatId: string, after = 0) => textOf(eventsOf(chatId).slice(after));
/** What the stand-in was given for more permissions, as it said it back. */
const granted = (chatId: string, after = 0) => JSON.parse(/yetki: (\{.*?\})\. /.exec(lastText(chatId, after))?.[1] ?? 'null') as { permissions: Record<string, unknown>; scope: string } | null;

test.after(() => shutdownChats());

test('Codex’s failures are said by the sentence inside them; a chat starts on the model the server marks, not an old one in its config; full access is never offered', () => {
  assert.equal(sentenceOf(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'The model is not supported.' } })), 'The model is not supported.');
  assert.equal(sentenceOf('plain words'), 'plain words');
  const models = [
    { id: 'a', name: 'A', isDefault: false, efforts: ['low'] },
    { id: 'b', name: 'B', isDefault: true, efforts: ['low', 'high'] },
  ];
  const first = codexOptions(models, {});
  assert.deepEqual(first.map((one) => [one.id, one.current]), [['model', 'b'], ['mode', 'ask'], ['effort', 'default']]);
  assert.deepEqual(first.find((one) => one.id === 'effort')?.choices.map((one) => one.value), ['default', 'low', 'high']);
  assert.deepEqual(codexOptions(models, { model: 'a', effort: 'high', mode: 'auto' }).map((one) => one.current), ['a', 'auto', 'default'], 'an effort the model does not offer goes back to the default');
  assert.deepEqual(first.find((one) => one.id === 'mode')?.choices.map((one) => one.value), ['ask', 'readonly', 'auto']);
});

test('a message to Codex gets its thinking, its words as they come and its final answer whole, its steps with paths made safe, its plan and its context', async () => {
  const { vault, log } = useVault();
  const { id } = sendChat(null, 'test-codex', 'merhaba, plan yap');
  assert.deepEqual(await doneOf(id), { type: 'done', reason: 'end_turn' });
  const events = eventsOf(id);
  assert.equal(textOf(events), 'Notu |okuyorum.|Merhaba dünya, [[Ideas]] notuna baktım.', 'the commentary in pieces, not again whole; the final answer whole');
  assert.deepEqual(
    events.filter((one) => one.type === 'thought'),
    [{ type: 'thought', id: 'rs_1:thought', text: 'Düşünüyorum' }],
    'the reasoning once',
  );
  const steps = events.filter((one): one is Extract<ChatEvent, { type: 'tool' }> => one.type === 'tool' && one.id === 'exec-1');
  assert.deepEqual(steps[0], { type: 'tool', id: 'exec-1', title: `Get-Content -Raw ${NOTE}`, kind: 'read', paths: ['Notes/Plan.md'], status: 'in_progress', output: undefined });
  assert.deepEqual(steps[1], { type: 'tool', id: 'exec-1', status: 'completed', output: `# Plan (${NOTE})\n` });
  assert.deepEqual(events.find((one) => one.type === 'plan'), { type: 'plan', entries: [{ content: 'Notu oku', status: 'completed' }, { content: 'Özet yaz', status: 'in_progress' }] });
  assert.deepEqual(events.find((one) => one.type === 'usage'), { type: 'usage', used: 4096, size: 258400, cost: null, currency: null });
  assert.ok(!JSON.stringify(events).includes(vault));

  const opened = openChat(id);
  assert.deepEqual(opened.options.find((one) => one.id === 'model')?.choices.map((one) => one.value), ['gpt-6-luna', 'gpt-5.6-terra'], 'the server’s models, a hidden one left out');
  const [started] = turnsStarted(log);
  assert.equal(started.params.model, 'gpt-6-luna', 'the model the server marks as default');
  assert.equal(started.params.approvalPolicy, 'on-request');
  assert.equal((started.params.sandboxPolicy as { type: string }).type, 'workspaceWrite');
  assert.equal(started.params.effort, undefined, 'the model’s own effort, unless one is chosen');
  assert.deepEqual(sent(log).find((one) => one.method === 'thread/start')?.params, { cwd: vault, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.ok(sent(log).every((one) => one.cwd === vault));
  assert.ok(sent(log).some((one) => one.method === 'initialized'), 'told it is initialized, as its protocol asks');
});

test('a command and a file change Codex asks to make are asked of the person: for this chat, or refused', async () => {
  useVault();
  const { id } = sendChat(null, 'test-codex', 'izin iste ve dosya yaz');
  const command = await cardOf(id);
  assert.equal(command.kind, 'execute');
  assert.ok(command.title.startsWith('$ git status') && !command.title.includes(path.sep + 'codex-vault-'));
  assert.deepEqual(command.options.map((one) => [one.id, one.kind]), [['once', 'allow_once'], ['session', 'allow_always'], ['decline', 'reject_once']]);
  answerChat(id, command.id, 'session');
  const change = await until(() => eventsOf(id).filter((one): one is Extract<ChatEvent, { type: 'permission' }> => one.type === 'permission')[1], 'the file card');
  assert.equal(change.kind, 'edit');
  assert.deepEqual(change.paths, ['Notes/Plan.md']);
  answerChat(id, change.id, 'decline');
  await doneOf(id);
  assert.ok(textOf(eventsOf(id)).includes('komut: acceptForSession. dosya: decline.'));
  const patch = eventsOf(id).filter((one): one is Extract<ChatEvent, { type: 'tool' }> => one.type === 'tool' && one.id === 'patch-1');
  assert.equal(patch[patch.length - 1].status, 'failed', 'a change refused is a step that did not happen');
});

test('a setting chosen goes with the next message, without starting Codex again; the model brings its own efforts', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-codex', 'merhaba');
  await doneOf(id);
  const options = await setChatOption(id, 'model', 'gpt-5.6-terra');
  assert.deepEqual(options.find((one) => one.id === 'effort')?.choices.map((one) => one.value), ['default', 'low', 'ultra']);
  await setChatOption(id, 'effort', 'ultra');
  await setChatOption(id, 'mode', 'readonly');
  const before = eventsOf(id).length;
  sendChat(id, 'test-codex', 'tekrar');
  await doneOf(id, before);
  const turns = turnsStarted(log);
  const last = turns[turns.length - 1].params;
  assert.equal(last.model, 'gpt-5.6-terra');
  assert.equal(last.effort, 'ultra');
  assert.equal((last.sandboxPolicy as { type: string }).type, 'readOnly');
  assert.equal(sent(log).filter((one) => one.method === 'initialize').length, 1, 'one server for both messages');
  assert.equal(sent(log).filter((one) => one.method === 'thread/start').length, 1, 'one thread for the chat');
});

test('Codex not signed in, or on a model the account may not use, says so; Stop interrupts the turn; a chat reopened after a restart resumes its thread', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-codex', 'hata ver');
  const unsigned = await doneOf(id);
  assert.ok(unsigned.type === 'error' && unsigned.kind === 'auth', JSON.stringify(unsigned));

  let before = eventsOf(id).length;
  sendChat(id, 'test-codex', 'eski model');
  const refused = await doneOf(id, before);
  assert.ok(refused.type === 'error' && refused.kind === 'model' && refused.message === "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", JSON.stringify(refused));

  before = eventsOf(id).length;
  sendChat(id, 'test-codex', 'yavaş olsun');
  await until(() => eventsOf(id).slice(before).some((one) => one.type === 'text' && one.text.includes('Uzun')), 'the slow answer');
  cancelChat(id);
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'cancelled' });
  const interrupt = sent(log).find((one) => one.method === 'turn/interrupt');
  assert.match(String(interrupt?.params.turnId), /^turn-\d+$/);

  forgetChats();
  before = eventsOf(id).length;
  sendChat(id, 'test-codex', 'yeniden');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' });
  const resumed = sent(log).find((one) => one.method === 'thread/resume');
  assert.match(String(resumed?.params.threadId), /^thr-\d+-1$/, 'the thread the chat had, resumed');
});

test('more permissions asked for are given only when allowed: Reject gives nothing, as does a turn stopped while the card waits; the card says what would be given', async () => {
  const outside = path.join(os.homedir(), 'Dis', 'indirilenler');
  process.env.FAKE_CODEX_OUTSIDE = outside;
  try {
    useVault();
    const { id } = sendChat(null, 'test-codex', 'yetki iste');
    let card = await cardOf(id);
    assert.equal(card.title, 'Paketleri indirmem gerekiyor', 'the reason, as the model wrote it');
    assert.deepEqual(card.paths, ['Network access', `Write: ${path.join('~', 'Dis', 'indirilenler')}`], 'and beside it what would be given, a folder outside the vault whole');
    answerChat(id, card.id, 'decline');
    await doneOf(id);
    assert.deepEqual(granted(id), { permissions: {}, scope: 'turn' }, 'Reject grants nothing');

    for (const [answer, scope] of [['once', 'turn'], ['session', 'session']] as const) {
      const before = eventsOf(id).length;
      sendChat(id, 'test-codex', 'yetki iste');
      card = await cardOf(id, before);
      answerChat(id, card.id, answer);
      await doneOf(id, before);
      const given = granted(id, before);
      assert.equal(given?.scope, scope, answer);
      assert.deepEqual(given?.permissions.network, { enabled: true }, answer);
      // Said back in the chat, where home is said as ~.
      const write = (given?.permissions.fileSystem as { write?: string[] } | undefined)?.write ?? [];
      assert.ok(write.length === 1 && write[0].endsWith(path.join('Dis', 'indirilenler')), `${answer}: ${JSON.stringify(given)}`);
    }

    const before = eventsOf(id).length;
    sendChat(id, 'test-codex', 'yetki iste');
    await cardOf(id, before);
    cancelChat(id);
    await doneOf(id, before);
    assert.deepEqual(granted(id, before)?.permissions, {}, 'a card left by Stop is no');
  } finally {
    delete process.env.FAKE_CODEX_OUTSIDE;
  }
});

test('a command card says the whole command, the vault as a word: not its first part, not an empty string', async () => {
  const { vault } = useVault();
  const { id } = sendChat(null, 'test-codex', 'izin iste');
  const card = await cardOf(id);
  assert.equal(card.title, `$ git status ‹Vault›`, 'the command as the server will run it, the vault named');
  assert.ok(!card.title.includes(vault));
  answerChat(id, card.id, 'decline');
  await doneOf(id);
});

test('a Codex server that dies mid-turn ends the turn, and the next message starts it again', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-codex', 'yavaş olsun');
  await until(() => eventsOf(id).some((one) => one.type === 'text' && one.text.includes('Uzun')), 'the slow answer');
  process.kill(sent(log)[0].pid, 'SIGKILL');
  const ended = await doneOf(id);
  assert.ok(ended.type === 'error' && ended.kind === 'stopped', JSON.stringify(ended));
  assert.equal(openChat(id).running, false);
  const before = eventsOf(id).length;
  sendChat(id, 'test-codex', 'tekrar merhaba');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' }, 'started again');
  assert.equal(new Set(sent(log).map((one) => one.pid)).size, 2);
});

test('Stop ends a Codex turn that will not stop, and a turn whose server is closed for another vault', async () => {
  const grace = STOP_GRACE.ms;
  STOP_GRACE.ms = 300;
  try {
    useVault();
    const { id } = sendChat(null, 'test-codex', 'inatçı ol');
    await until(() => eventsOf(id).some((one) => one.type === 'text' && one.text.includes('Durmayacağım')), 'the stubborn answer');
    cancelChat(id);
    assert.deepEqual(await doneOf(id), { type: 'done', reason: 'cancelled' }, 'ended after its grace, as stopped');

    const before = eventsOf(id).length;
    sendChat(id, 'test-codex', 'yavaş olsun');
    await until(() => eventsOf(id).slice(before).some((one) => one.type === 'text' && one.text.includes('Uzun')), 'the slow answer');
    shutdownChats();
    const ended = await doneOf(id, before);
    assert.ok(ended.type === 'error' && ended.kind === 'stopped', JSON.stringify(ended));
    assert.equal(openChat(id).running, false);
  } finally {
    STOP_GRACE.ms = grace;
  }
});

test('Stop pressed before Codex has named the turn still interrupts it', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-codex', 'geç ve yavaş');
  await until(() => turnsStarted(log).length > 0, 'the turn sent');
  cancelChat(id);
  assert.deepEqual(await doneOf(id), { type: 'done', reason: 'cancelled' });
  assert.match(String(sent(log).find((one) => one.method === 'turn/interrupt')?.params.turnId), /^turn-\d+$/);
});

test('Stop on one Codex chat that will not stop lets that one go, and the other chats on the server go on', async () => {
  const grace = STOP_GRACE.ms;
  STOP_GRACE.ms = 300;
  try {
    const { log } = useVault();
    const waiting = sendChat(null, 'test-codex', 'izin iste').id;
    const card = await cardOf(waiting);
    const stubborn = sendChat(null, 'test-codex', 'inatçı ol').id;
    await until(() => eventsOf(stubborn).some((one) => one.type === 'text' && one.text.includes('Durmayacağım')), 'the stubborn answer');
    cancelChat(stubborn);
    assert.deepEqual(await doneOf(stubborn), { type: 'done', reason: 'cancelled' });
    answerChat(waiting, card.id, 'once');
    assert.deepEqual(await doneOf(waiting), { type: 'done', reason: 'end_turn' }, 'the other chat answered');
    assert.equal(sent(log).filter((one) => one.method === 'initialize').length, 1, 'on the same server, never closed');
    assert.equal(restartIdleChats(), true);
  } finally {
    STOP_GRACE.ms = grace;
  }
});

test('a Codex server closed before it has answered a turn’s start ends that turn, and leaves no failure unheard', async () => {
  const { log } = useVault();
  const unheard: unknown[] = [];
  const hear = (reason: unknown) => unheard.push(reason);
  process.on('unhandledRejection', hear);
  try {
    const { id } = sendChat(null, 'test-codex', 'geç olsun');
    await until(() => turnsStarted(log).length > 0, 'the turn sent');
    // Another vault chosen while the server has not yet named the turn.
    shutdownChats();
    const ended = await doneOf(id);
    assert.ok(ended.type === 'error' && ended.kind === 'stopped', JSON.stringify(ended));
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(unheard, [], 'the turn’s end is heard once, by the turn');
  } finally {
    process.off('unhandledRejection', hear);
  }
});

test('a turn let go after Stop is never heard as its chat’s next turn, on the thread that turn resumes; nor is any leave it asks after Stop asked of the person', async () => {
  const grace = STOP_GRACE.ms;
  STOP_GRACE.ms = 300;
  try {
    const { log } = useVault();
    const waiting = sendChat(null, 'test-codex', 'izin iste').id;
    const card = await cardOf(waiting);
    const stubborn = sendChat(null, 'test-codex', 'inatçı ol').id;
    await until(() => eventsOf(stubborn).some((one) => one.type === 'text' && one.text.includes('Durmayacağım')), 'the stubborn answer');
    cancelChat(stubborn);
    assert.deepEqual(await doneOf(stubborn), { type: 'done', reason: 'cancelled' });
    // Interrupted, it asked leave for a command while its grace ran: refused, no card shown after Stop.
    await until(() => answered(log).length === 1, 'the leave it asked after Stop');
    // Asked again at once, on the same thread, while the turn let go still talks on it: the new turn's start is answered late.
    const before = eventsOf(stubborn).length;
    sendChat(stubborn, 'test-codex', 'geç gel');
    assert.deepEqual(await doneOf(stubborn, before), { type: 'done', reason: 'end_turn' });
    const threadOf = (method: string) => sent(log).filter((one) => one.method === method).map((one) => one.params.threadId);
    assert.ok(threadOf('thread/resume').length === 1 && threadOf('turn/start').at(-1) === threadOf('thread/resume')[0], 'the same thread, resumed');
    assert.ok(!lastText(stubborn, before).includes('Hâlâ buradayım'), lastText(stubborn, before));
    assert.ok(lastText(stubborn, before).includes('Merhaba dünya'));
    // The turn let go asked leave again once the next turn had begun on its thread: refused, not put on that turn's card.
    await until(() => answered(log).length === 2, 'the leave it asked during the next turn');
    assert.deepEqual(answered(log).map((one) => one.decision), ['decline', 'decline']);
    assert.ok(!eventsOf(stubborn).some((one) => one.type === 'permission'), 'no card in the stopped chat, then or after');
    answerChat(waiting, card.id, 'once');
    assert.deepEqual(await doneOf(waiting), { type: 'done', reason: 'end_turn' });
  } finally {
    STOP_GRACE.ms = grace;
    shutdownChats();
  }
});

test('a turn let go before Codex has named it is interrupted, and never heard again, once it is named', async () => {
  const grace = STOP_GRACE.ms;
  STOP_GRACE.ms = 100;
  try {
    const { log } = useVault();
    const waiting = sendChat(null, 'test-codex', 'izin iste').id;
    const card = await cardOf(waiting);
    const late = sendChat(null, 'test-codex', 'geç ve inatçı').id;
    await until(() => turnsStarted(log).length === 2, 'its turn sent');
    // Stopped, and its grace over, before its start is answered: let go, the other chat still running on the server.
    cancelChat(late);
    assert.deepEqual(await doneOf(late), { type: 'done', reason: 'cancelled' });
    const interrupt = await until(() => sent(log).find((one) => one.method === 'turn/interrupt'), 'the turn interrupted once named');
    assert.equal(interrupt.params.threadId, turnsStarted(log)[1].params.threadId);
    answerChat(waiting, card.id, 'once');
    assert.deepEqual(await doneOf(waiting), { type: 'done', reason: 'end_turn' }, 'the other chat answered');
    assert.equal(sent(log).filter((one) => one.method === 'initialize').length, 1, 'on the same server, never closed');
  } finally {
    STOP_GRACE.ms = grace;
    shutdownChats();
  }
});

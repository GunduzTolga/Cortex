import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatEvent, ChatPush } from '../shared/chat';
import { answerChat, cancelChat, forgetChats, onChatPush, openChat, sendChat, setChatOption, shutdownChats } from '../electron/services/chat';
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
const sent = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown>; cwd: string }) : []);
const turnsStarted = (log: string) => sent(log).filter((one) => one.method === 'turn/start');

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

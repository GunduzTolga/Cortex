import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatEvent, ChatPush } from '../shared/chat';
import { childEnv } from '../electron/services/acp';
import { answerChat, cancelChat, onChatPush, openChat, sendChat, setChatOption, shutdownChats } from '../electron/services/chat';
import { claudeArgs, claudeOptions, stepOf } from '../electron/services/claudeChat';
import { CLAUDE_ARGS } from '../electron/services/clis';
import { updateSettings } from '../electron/services/settings';

/**
 * The chat with Claude Code in its own structured mode
 * (electron/services/claudeChat.ts), driven against a stand-in that writes
 * the lines Claude Code 2.1.296 was recorded writing
 * (tests/fixtures/fake-claude.mjs).
 */

const CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
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
    .join('');

function useVault(): { vault: string; log: string } {
  const vault = temp('claude-vault-');
  fs.mkdirSync(path.join(vault, 'Notes'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  const log = path.join(temp('claude-log-'), 'claude.jsonl');
  process.env.CORTEX_TEST_CLAUDE = CLAUDE;
  process.env.FAKE_AGENT_LOG = log;
  return { vault, log };
}
const linesIn = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv?: string[]; cwd?: string; in?: Record<string, unknown> }) : []);
const starts = (log: string) => linesIn(log).filter((one) => one.argv);

test.after(() => shutdownChats());

test('a program started from inside a Claude Code session does not carry that session’s variables; one started by the person does', () => {
  const inside = childEnv({ X: '1' }, { PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_AGENT_SDK_VERSION: 'v', ANTHROPIC_BASE_URL: 'http://host', CLAUDE_CONFIG_DIR: 'c', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(inside, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c', X: '1' });
  const theirs = childEnv({}, { PATH: 'p', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepEqual(theirs, { PATH: 'p', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CODE_USE_BEDROCK: '1' }, 'the person’s own settings stay');
});

test('a step is shown by its tool and what it works on; settings become flags, the session is resumed', () => {
  const vault = path.resolve('/kasa');
  const plain = (text: string) => text;
  assert.deepEqual(stepOf('Bash', { command: 'git status' }, vault, plain), { title: 'Bash git status', kind: 'execute', paths: [] });
  assert.deepEqual(stepOf('Edit', { file_path: path.join(vault, 'Notes', 'a.md'), old_string: 'x' }, vault, plain), { title: `Edit Notes/a.md`, kind: 'edit', paths: ['Notes/a.md'] });
  assert.equal(stepOf('Mystery', {}, vault, plain).kind, 'other');
  const options = claudeOptions({ model: 'opus', mode: 'acceptEdits', effort: 'nope' });
  assert.deepEqual(options.map((one) => [one.id, one.current]), [['model', 'opus'], ['mode', 'acceptEdits'], ['effort', 'default']], 'a value not offered falls back');
  assert.ok(!options.find((one) => one.id === 'mode')?.choices.some((one) => one.value === 'bypassPermissions'), 'skipping every permission is never offered');
  assert.deepEqual(claudeArgs(['-p'], options, 'ses-1'), ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits', '--resume', 'ses-1']);
  assert.deepEqual(claudeArgs(['-p'], claudeOptions({}), null), ['-p']);
});

test('a message to Claude Code gets its answer streamed in pieces, its steps with paths made safe, its plan, its context; a sub-agent’s words stay its own', async () => {
  const { vault, log } = useVault();
  const { id } = sendChat(null, 'test-claude', 'merhaba, plan yap');
  assert.deepEqual(await doneOf(id), { type: 'done', reason: 'end_turn' });
  const events = eventsOf(id);
  assert.equal(textOf(events), 'Merhaba dünya, [[Ideas]] notuna baktım.', 'the whole message after its pieces is not shown again');
  assert.ok(!JSON.stringify(events).includes('SUBAGENT'));
  assert.deepEqual(events.find((one) => one.type === 'thought'), { type: 'thought', id: 'msg_1:thought', text: 'Düşünüyorum' });
  const read = events.filter((one): one is Extract<ChatEvent, { type: 'tool' }> => one.type === 'tool' && one.id === 'toolu_1');
  assert.deepEqual(read[0], { type: 'tool', id: 'toolu_1', title: `Read Notes/Plan.md`, kind: 'read', paths: ['Notes/Plan.md'], status: 'in_progress' });
  assert.deepEqual(read[1], { type: 'tool', id: 'toolu_1', status: 'completed', output: `Read file ${NOTE}` });
  assert.deepEqual(events.find((one) => one.type === 'plan'), { type: 'plan', entries: [{ content: 'Notu oku', status: 'completed' }, { content: 'Özet yaz', status: 'in_progress' }] });
  assert.deepEqual(events.find((one) => one.type === 'usage'), { type: 'usage', used: 4240, size: 200000, cost: null, currency: null }, 'no dollars: on a subscription they are not what is paid');
  assert.ok(!JSON.stringify(events).includes(vault));

  const opened = openChat(id);
  assert.deepEqual(opened.options.find((one) => one.id === 'model')?.choices.map((one) => one.value), ['default', 'haiku', 'opus'], 'the models Claude Code named');
  const [first] = starts(log);
  assert.deepEqual(first.argv, CLAUDE_ARGS, 'started as the SDK starts it, with nothing else on a first message');
  assert.equal(first.cwd, vault, 'in the vault, where its hooks are');
  assert.deepEqual(linesIn(log).find((one) => one.in?.type === 'control_request')?.in, { type: 'control_request', request_id: (linesIn(log).find((one) => one.in?.type === 'control_request')?.in as { request_id: string }).request_id, request: { subtype: 'initialize', hooks: null } });
});

test('a step Claude Code would ask about is asked of the person; "always" passes on the rule it suggested; Stop interrupts', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-claude', 'izin iste');
  const asked = await until(() => eventsOf(id).find((one): one is Extract<ChatEvent, { type: 'permission' }> => one.type === 'permission'), 'the card');
  assert.equal(asked.title, `Write Notes/Plan.md`);
  assert.deepEqual(asked.options.map((one) => [one.id, one.kind]), [['allow', 'allow_once'], ['always', 'allow_always'], ['deny', 'reject_once']]);
  answerChat(id, asked.id, 'always');
  await doneOf(id);
  assert.ok(textOf(eventsOf(id)).startsWith('izin: allow always.'));
  const reply = linesIn(log).find((one) => one.in?.type === 'control_response')?.in as { response: { response: { behavior: string; updatedPermissions?: unknown[] } } };
  assert.equal(reply.response.response.behavior, 'allow');
  assert.equal(reply.response.response.updatedPermissions?.length, 1);

  const before = eventsOf(id).length;
  sendChat(id, 'test-claude', 'yavaş olsun');
  await until(() => eventsOf(id).slice(before).some((one) => one.type === 'text' && one.text.startsWith('Uzun')), 'the slow answer');
  cancelChat(id);
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'cancelled' });
  assert.ok(linesIn(log).some((one) => (one.in?.request as { subtype?: string } | undefined)?.subtype === 'interrupt'));
});

test('a sign-in that has expired says so once; a setting chosen starts Claude Code again on the same session with its flag; one that dies is started again', async () => {
  const { log } = useVault();
  const { id } = sendChat(null, 'test-claude', 'hata ver');
  const failed = await doneOf(id);
  assert.ok(failed.type === 'error' && failed.kind === 'auth' && /401/.test(failed.message), JSON.stringify(failed));
  assert.equal(textOf(eventsOf(id)), '', 'the made-up message carrying the error is not shown as an answer');

  let before = eventsOf(id).length;
  sendChat(id, 'test-claude', 'merhaba');
  await doneOf(id, before);
  await setChatOption(id, 'model', 'opus');
  before = eventsOf(id).length;
  sendChat(id, 'test-claude', 'tekrar');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' });
  const restarted = starts(log)[1].argv ?? [];
  assert.deepEqual(restarted.slice(-4), ['--model', 'opus', '--resume', restarted[restarted.length - 1]]);
  assert.match(restarted[restarted.length - 1], /^claude-ses-\d+$/, 'the session Claude Code named, resumed');

  before = eventsOf(id).length;
  sendChat(id, 'test-claude', 'çök');
  const died = await doneOf(id, before);
  assert.ok(died.type === 'error' && died.kind === 'stopped' && /boom/.test(died.message), JSON.stringify(died));
  before = eventsOf(id).length;
  sendChat(id, 'test-claude', 'yine merhaba');
  assert.deepEqual(await doneOf(id, before), { type: 'done', reason: 'end_turn' }, 'started again');
  assert.ok((starts(log)[2].argv ?? []).includes('--resume'));
});

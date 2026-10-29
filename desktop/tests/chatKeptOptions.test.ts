import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import type { ChatPush } from '../shared/chat';
import { onChatPush, openChat, sendChat, shutdownChats } from '../electron/services/chat';
import { claudeOptions } from '../electron/services/claudeChat';
import { updateSettings } from '../electron/services/settings';

/**
 * A chat reopened after the app started again runs as its chips say (electron/services/chat.ts, turnOf). Its own
 * file: the chat list is read once per run, and this one is written before it is.
 */

const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const pushes: ChatPush[] = [];
onChatPush((push) => pushes.push(push));
test.after(() => shutdownChats());

test('a chat reopened after a restart runs with the options its chips show, not the CLI’s last choices', async () => {
  // 30 October: the chip said "Ask first" and the turn ran with the edits accepted that another chat had chosen.
  const vault = temp('cortex-kept-vault-');
  fs.mkdirSync(path.join(vault, 'Notes'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Plan.md'), '# Plan\n');
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  const log = path.join(temp('cortex-kept-log-'), 'claude.jsonl');
  process.env.CORTEX_TEST_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
  process.env.FAKE_AGENT_LOG = log;
  const id = '11111111-2222-4333-8444-555555555555';
  const dir = path.join(app.getPath('userData'), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const chat = { id, title: 'A', cli: 'test-claude', createdAt: 1, updatedAt: 1, vault, sessionId: null, options: claudeOptions({ mode: 'default' }) };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, prefs: { 'test-claude': { mode: 'acceptEdits' } }, chats: [chat] }));

  assert.equal(openChat(id).options.find((one) => one.id === 'mode')?.current, 'default');
  sendChat(id, 'test-claude', 'merhaba');
  const end = Date.now() + 10_000;
  while (!pushes.some((push) => push.chatId === id && (push.event?.type === 'done' || push.event?.type === 'error')) && Date.now() < end) {
    await new Promise((done) => setTimeout(done, 20));
  }
  const argv = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { argv?: string[] })
    .find((entry) => entry.argv)?.argv;
  assert.ok(argv, 'the CLI was started');
  assert.ok(!argv.includes('acceptEdits'), `started with ${JSON.stringify(argv)}`);
  const after = [...pushes].reverse().find((push) => push.chatId === id && push.state)?.state?.options.find((one) => one.id === 'mode')?.current;
  assert.equal(after, 'default');
});

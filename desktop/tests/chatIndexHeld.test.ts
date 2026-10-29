import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { listChats, sendChat, shutdownChats, takeIndexBroken } from '../electron/services/chat';
import { updateSettings } from '../electron/services/settings';

/**
 * A chat list another program holds as the app starts is left as it is (electron/services/chat.ts, readIndex). Its
 * own file: the chat list is read once per run.
 */

test.after(() => shutdownChats());

test('a chat list held by another program at the start is not written over', { skip: process.platform !== 'win32' }, async () => {
  // 30 October: a list held at the start was taken as damaged, no copy was made, and the next chat left a list of one.
  const vault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-held-vault-')));
  updateSettings((settings) => {
    settings.vault = vault;
    settings.language = 'en';
  });
  process.env.CORTEX_TEST_AGENT = path.resolve('tests/fixtures/fake-acp-agent.mjs');
  const dir = path.join(app.getPath('userData'), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  const ids = ['aaaaaaaa-2222-4333-8444-555555555555', 'bbbbbbbb-2222-4333-8444-555555555555'];
  fs.writeFileSync(file, JSON.stringify({ version: 1, prefs: {}, chats: ids.map((id, n) => ({ id, title: `old ${n}`, cli: 'test', createdAt: 1, updatedAt: 1, vault, sessionId: null })) }));
  // Held with no sharing, as a backup or a scan would hold it, for as long as the list is read.
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file}','Open','Read','None'); 'held'; Start-Sleep -Milliseconds 1500; $f.Close()`]);
  await new Promise<void>((done) => holder.stdout.on('data', (data) => String(data).includes('held') && done()));
  assert.equal(listChats().length, 0);
  assert.equal(takeIndexBroken(), 'left');
  await new Promise((done) => holder.on('exit', done));

  sendChat(null, 'test', 'merhaba');
  const titles = (JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: Array<{ title: string }> }).chats.map((one) => one.title);
  assert.deepEqual(titles, ['old 0', 'old 1']);
});

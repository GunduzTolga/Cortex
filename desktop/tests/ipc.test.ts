import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dialogAnswer, handlers, sent } from 'electron';
import { registerIpc, trustPagesWhere } from '../electron/ipc';
import { forgetSettings, readSettings, settingsPath } from '../electron/services/settings';

/**
 * What the window can ask (electron/ipc.ts): the channels the preload names
 * and no others, answered for the app's own page alone, with the vault coming
 * through the system's dialog and never from the window.
 */

const PAGE = 'file:///app/dist/index.html';
trustPagesWhere((url) => url === PAGE);
registerIpc();

/** Each test from a first run: no settings file, nothing remembered. */
function firstRun(): void {
  fs.rmSync(settingsPath(), { force: true });
  forgetSettings();
}

type Call = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mainFrame = { url: PAGE };
const ownEvent = { sender: { mainFrame }, senderFrame: mainFrame };
const call = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Call)(ownEvent, ...args);

test('the channels are the ones the preload names, no more and no fewer', () => {
  const preload = fs.readFileSync('electron/preload.ts', 'utf8');
  const named = [...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual([...handlers.keys()].sort(), named);
  const notes = named.filter((channel) => channel.startsWith('notes:'));
  assert.deepEqual(notes, ['notes:asset', 'notes:backlinks', 'notes:create', 'notes:createFolder', 'notes:index', 'notes:move', 'notes:open', 'notes:read', 'notes:rename', 'notes:save', 'notes:search', 'notes:trash']);
});

test('a frame that is not the page, or a page that is not the app’s, is refused before anything is read', async () => {
  const listener = handlers.get('app:bootstrap') as Call;
  const child = { url: PAGE };
  await assert.throws(() => listener({ sender: { mainFrame }, senderFrame: child }), /not the app/);
  const elsewhere = { url: 'https://example.com/' };
  await assert.throws(() => listener({ sender: { mainFrame: elsewhere }, senderFrame: elsewhere }), /not the app/);
  await assert.throws(() => listener({ sender: { mainFrame }, senderFrame: null }), /not the app/);
});

test('the window may set the language, and never the vault', async () => {
  firstRun();
  assert.deepEqual(await call('settings:set', { language: 'en', vault: '/etc' }), { language: 'en' });
  assert.equal(readSettings().vault, null);
  assert.deepEqual(await call('settings:set', { language: 'de' }), { language: 'en' }, 'a language the app does not have changes nothing');
  assert.deepEqual(await call('settings:set', { language: null }), { language: null });
});

test('the vault comes through the dialog, and what the window is told of it holds no path', async () => {
  firstRun();
  dialogAnswer.value = { canceled: true, filePaths: [] };
  assert.equal(await call('vault:choose'), null, 'closed without a choice');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
  dialogAnswer.value = { canceled: false, filePaths: [dir] };
  sent.length = 0;
  const chosen = await call('vault:choose');
  assert.deepEqual(chosen, { vault: { name: path.basename(dir) }, missing: false });
  assert.deepEqual(sent, [['notes:changed', null]], 'the notes screen is told to read the vault now chosen');
  const boot = await call('app:bootstrap');
  assert.ok(!JSON.stringify(boot).includes(path.dirname(dir)), 'no path in the bootstrap either');
  assert.equal(readSettings().vault, dir);
});

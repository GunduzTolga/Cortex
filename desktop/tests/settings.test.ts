import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { offered } from '../electron/services/chat';
import { chooseChatTool, forgetSettings, readSettings, setChatTool, settingsPath, settingsUnreadable, tidyName, updateSettings } from '../electron/services/settings';
import type { CliInfo } from '../shared/chat';

/**
 * The app's own settings file (electron/services/settings.ts), held to
 * Krewgent's rules for its state file: only a missing file is a first run, a
 * damaged one is copied aside before an empty one is saved, one the disk will
 * not hand over is never written over, and every write is through a temporary.
 */

const dir = () => path.dirname(settingsPath());
const fresh = () => {
  fs.rmSync(dir(), { recursive: true, force: true });
  fs.mkdirSync(dir(), { recursive: true });
  forgetSettings();
};

test('a missing file is a first run, and what is changed is written at once, through a temporary', () => {
  fresh();
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  assert.equal(settingsUnreadable(), null);
  updateSettings((settings) => {
    settings.language = 'en';
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), { theme: 'system', vault: null, language: 'en', allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  assert.deepEqual(fs.readdirSync(dir()).filter((name) => name.endsWith('.tmp')), [], 'no temporary left');
  forgetSettings();
  assert.equal(readSettings().language, 'en', 'read back from disk');
});

test('a file that will not parse is copied aside before an empty one is saved', () => {
  fresh();
  fs.writeFileSync(settingsPath(), '{"vault": "C:\\\\Notlar", "lang');
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  assert.equal(settingsUnreadable(), 'copied');
  const copies = fs.readdirSync(dir()).filter((name) => name.startsWith('settings.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir(), copies[0]), 'utf8'), '{"vault": "C:\\\\Notlar", "lang', 'the copy is the file as it was');
  updateSettings((settings) => {
    settings.language = 'tr';
  });
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).language, 'tr');
});

test('a file the disk will not hand over is left as it is, and nothing is written over it in this run', () => {
  fresh();
  // A folder where the file should be: read fails without the text ever arriving, as a locked file's does.
  fs.mkdirSync(settingsPath());
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  assert.equal(settingsUnreadable(), 'left');
  updateSettings((settings) => {
    settings.language = 'en';
  });
  assert.ok(fs.statSync(settingsPath()).isDirectory(), 'not written over');
  fs.rmSync(settingsPath(), { recursive: true, force: true });
});

test('what is not a known value is read as none', () => {
  fresh();
  fs.writeFileSync(settingsPath(), JSON.stringify({ vault: 42, language: 'de', other: true, allFiles: 'yes', nameIcons: 1, userName: 7, onboarded: 'yes' }));
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  fs.writeFileSync(settingsPath(), JSON.stringify(['not', 'an', 'object']));
  forgetSettings();
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null });
  assert.equal(settingsUnreadable(), 'copied');
});

test('a name is kept tidied and cut to a way of addressing somebody; an empty one is none', () => {
  fresh();
  fs.writeFileSync(settingsPath(), JSON.stringify({ userName: '  Tolga \n Bey ', onboarded: true }));
  assert.deepEqual([readSettings().userName, readSettings().onboarded], ['Tolga Bey', true]);
  assert.equal(tidyName('   '), null);
  assert.equal(tidyName('x'.repeat(100))?.length, 40);
});

test('a file saved with a BOM in front (Notepad, PowerShell 5.1) is read as it is, not taken for a damaged one', () => {
  // Read as damaged, it was set aside and the app opened on a first run: vault, name and language gone (29 October).
  fresh();
  fs.writeFileSync(settingsPath(), '\uFEFF' + JSON.stringify({ theme: 'system', vault: null, language: 'en', userName: 'Deniz', onboarded: true }));
  const read = readSettings();
  assert.deepEqual([read.language, read.userName, read.onboarded], ['en', 'Deniz', true]);
  assert.equal(settingsUnreadable(), null);
  assert.deepEqual(fs.readdirSync(dir()).filter((name) => name.includes('corrupt')), []);
});

test('the chat offers the tools set up on the first run: the first one begins the list, a tool set up later joins it', () => {
  fresh();
  // On a first run, nothing chosen yet: every installed tool, until one is set up.
  assert.equal(readSettings().chatTools, null);
  chooseChatTool('opencode');
  assert.deepEqual(readSettings().chatTools, ['opencode'], 'OpenCode signed in to on the first run: the list begins');
  chooseChatTool('opencode');
  chooseChatTool('lmstudio');
  assert.deepEqual(readSettings().chatTools, ['opencode'], 'once each; a model server is not one of them');
  updateSettings((settings) => {
    settings.onboarded = true;
  });
  chooseChatTool('claude');
  assert.deepEqual(readSettings().chatTools, ['opencode', 'claude'], 'signed in to later, from the AI tools window');
  forgetSettings();
  assert.deepEqual(readSettings().chatTools, ['opencode', 'claude'], 'kept');
  // An install from before the list, or a first run through which nothing was set up: every tool, and so it stays.
  fs.writeFileSync(settingsPath(), JSON.stringify({ onboarded: true, chatTools: 'all' }));
  forgetSettings();
  assert.equal(readSettings().chatTools, null);
  chooseChatTool('codex');
  assert.equal(readSettings().chatTools, null);
  fs.writeFileSync(settingsPath(), JSON.stringify({ onboarded: true, chatTools: ['qwen', 'nope', 'hermes', 'opencode'] }));
  forgetSettings();
  assert.deepEqual(readSettings().chatTools, ['qwen', 'opencode'], 'only the tools, whatever was written');
});

test('a tool not chosen is listed as not offered; a model server, Hermes and the stand-ins are offered as before', () => {
  const clis: CliInfo[] = (['claude', 'codex', 'opencode', 'lmstudio', 'hermes', 'test-claude'] as const).map((id) => ({ id, name: id, available: true }));
  const chosen = offered(clis, ['opencode']);
  assert.deepEqual(chosen.filter((one) => one.available).map((one) => one.id), ['opencode', 'lmstudio', 'hermes', 'test-claude']);
  assert.deepEqual(chosen.map((one) => one.id), clis.map((one) => one.id), 'still listed: a chat begun with one goes on');
  assert.equal(offered(clis, null), clis, 'no list: every one');
});

test('from the AI tools window a tool is added to the chat or taken from it; with no list yet, only the one taken goes', () => {
  fresh();
  updateSettings((settings) => {
    settings.onboarded = true;
  });
  // Every installed tool offered (an install from before the list): Codex taken away, the others stay.
  setChatTool('codex', false, ['claude', 'codex', 'opencode']);
  assert.deepEqual(readSettings().chatTools, ['claude', 'opencode']);
  // Codex, signed in only in a terminal, added back with that sign-in.
  setChatTool('codex', true, ['claude', 'codex', 'opencode']);
  assert.deepEqual(readSettings().chatTools, ['claude', 'opencode', 'codex']);
  setChatTool('codex', true, ['claude', 'codex', 'opencode']);
  assert.deepEqual(readSettings().chatTools, ['claude', 'opencode', 'codex'], 'once');
  setChatTool('lmstudio', false, ['claude']);
  assert.deepEqual(readSettings().chatTools, ['claude', 'opencode', 'codex'], 'a model server is not one of them');
});

test('the theme is read as one of its three values; anything else is the system theme (2 November notes)', () => {
  fresh();
  fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'dark' }));
  assert.equal(readSettings().theme, 'dark');
  forgetSettings();
  fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'sepia' }));
  assert.equal(readSettings().theme, 'system');
});

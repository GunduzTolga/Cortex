import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { offered } from '../electron/services/chat';
import { chooseChatTool, forgetSettings, onSettingsUnsaved, readSettings, setChatTool, settingsPath, settingsUnreadable, settingsUnsaved, tidyName, updateSettings } from '../electron/services/settings';
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
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
  assert.equal(settingsUnreadable(), null);
  updateSettings((settings) => {
    settings.language = 'en';
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), { theme: 'system', vault: null, language: 'en', allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
  assert.deepEqual(fs.readdirSync(dir()).filter((name) => name.endsWith('.tmp')), [], 'no temporary left');
  forgetSettings();
  assert.equal(readSettings().language, 'en', 'read back from disk');
});

test('a file that will not parse is copied aside before an empty one is saved', () => {
  fresh();
  fs.writeFileSync(settingsPath(), '{"vault": "C:\\\\Notlar", "lang');
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
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
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
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
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
  fs.writeFileSync(settingsPath(), JSON.stringify(['not', 'an', 'object']));
  forgetSettings();
  assert.deepEqual(readSettings(), { theme: 'system', vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, hermesUrl: null, hermesProfile: null, vaultSync: false, chatTools: null, autoUpdate: true, browserLink: null, browserLinkToken: null });
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

test('updates are downloaded unasked unless the person turned that off: only a written no is one (G2)', () => {
  fresh();
  assert.equal(readSettings().autoUpdate, true, 'a first run, and an install from before the switch');
  fs.writeFileSync(settingsPath(), JSON.stringify({ autoUpdate: false }));
  forgetSettings();
  assert.equal(readSettings().autoUpdate, false);
  fs.writeFileSync(settingsPath(), JSON.stringify({ autoUpdate: 'no' }));
  forgetSettings();
  assert.equal(readSettings().autoUpdate, true);
});

test('a write that fails is not only logged: the folder is said, once, until a write goes through again (K10)', () => {
  // 10 November: with the settings folder not writable, `onboarded` was never kept and the first run came back at
  // every start, with nothing on the screen to say why.
  fresh();
  const heard: string[] = [];
  onSettingsUnsaved((folder) => heard.push(folder));
  assert.equal(settingsUnsaved(), null);
  // The temporary's name taken by a folder: the write fails on any system, whoever runs the tests.
  fs.mkdirSync(`${settingsPath()}.tmp`);
  try {
    const kept = updateSettings((settings) => {
      settings.onboarded = true;
    });
    assert.equal(kept.onboarded, true, 'the change holds while the app runs');
    assert.equal(fs.existsSync(settingsPath()), false, 'and is not on disk');
    assert.equal(settingsUnsaved(), dir());
    assert.deepEqual(heard, [dir()]);
    updateSettings((settings) => {
      settings.allFiles = true;
    });
    assert.deepEqual(heard, [dir()], 'said once, not at every change');
  } finally {
    fs.rmSync(`${settingsPath()}.tmp`, { recursive: true, force: true });
  }
  // Writable again: the next change is kept, with everything changed meanwhile, and nothing is left to say.
  updateSettings((settings) => {
    settings.nameIcons = true;
  });
  assert.equal(settingsUnsaved(), null);
  const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { onboarded: boolean; allFiles: boolean; nameIcons: boolean };
  assert.deepEqual([written.onboarded, written.allFiles, written.nameIcons], [true, true, true]);
  onSettingsUnsaved(() => undefined);
});

test('Cortex Browser’s link keeps whether the person opened it, closed it, or never touched it, and the digest of the leave given', () => {
  fresh();
  const digest = 'a'.repeat(64);
  const read = (raw: unknown) => {
    fs.writeFileSync(settingsPath(), JSON.stringify(raw));
    forgetSettings();
    return [readSettings().browserLink, readSettings().browserLinkToken];
  };
  assert.deepEqual(read({ browserLink: 'on', browserLinkToken: digest }), ['on', digest]);
  assert.deepEqual(read({ browserLink: 'off' }), ['off', null], 'closed by the person: kept, so a browser cannot open it');
  assert.deepEqual(read({}), [null, null], 'never touched');
  // As a build before the three states wrote it: `true` was a link opened; `false` was only where every install began,
  // not a choice anybody made - read as never touched, so the browser may still open it the first time.
  assert.deepEqual(read({ browserLink: true, browserLinkToken: digest }), ['on', digest]);
  assert.deepEqual(read({ browserLink: false }), [null, null]);
  // Kept as it is read: written back in the new form at the next change.
  updateSettings((settings) => {
    settings.allFiles = true;
  });
  assert.equal((JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { browserLink: unknown }).browserLink, null);
  // Written by hand, or damaged: nothing but the words themselves, and a digest that is not one is no leave.
  for (const bad of [{ browserLink: 'true', browserLinkToken: 'yes' }, { browserLink: 1, browserLinkToken: true }, { browserLink: 'OFF', browserLinkToken: 'A'.repeat(64) }, { browserLink: null, browserLinkToken: 'a'.repeat(63) }]) {
    assert.deepEqual(read(bad), [null, null], JSON.stringify(bad));
  }
});

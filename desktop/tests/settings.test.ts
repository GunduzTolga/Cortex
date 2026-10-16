import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { forgetSettings, readSettings, settingsPath, settingsUnreadable, tidyName, updateSettings } from '../electron/services/settings';

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
  assert.deepEqual(readSettings(), { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
  assert.equal(settingsUnreadable(), null);
  updateSettings((settings) => {
    settings.language = 'en';
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), { vault: null, language: 'en', allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
  assert.deepEqual(fs.readdirSync(dir()).filter((name) => name.endsWith('.tmp')), [], 'no temporary left');
  forgetSettings();
  assert.equal(readSettings().language, 'en', 'read back from disk');
});

test('a file that will not parse is copied aside before an empty one is saved', () => {
  fresh();
  fs.writeFileSync(settingsPath(), '{"vault": "C:\\\\Notlar", "lang');
  assert.deepEqual(readSettings(), { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
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
  assert.deepEqual(readSettings(), { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
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
  assert.deepEqual(readSettings(), { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(['not', 'an', 'object']));
  forgetSettings();
  assert.deepEqual(readSettings(), { vault: null, language: null, allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true });
  assert.equal(settingsUnreadable(), 'copied');
});

test('a name is kept tidied and cut to a way of addressing somebody; an empty one is none', () => {
  fresh();
  fs.writeFileSync(settingsPath(), JSON.stringify({ userName: '  Tolga \n Bey ', onboarded: true }));
  assert.deepEqual([readSettings().userName, readSettings().onboarded], ['Tolga Bey', true]);
  assert.equal(tidyName('   '), null);
  assert.equal(tidyName('x'.repeat(100))?.length, 40);
});

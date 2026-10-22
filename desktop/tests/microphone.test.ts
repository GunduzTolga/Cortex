import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BEAT_EVERY, type HelperState, type ListenerWord, listenerFile, microphoneFile, microphoneWord, readListener } from '../electron/services/microphone';
import { helperTurn, percentOf, trayItems, trayTooltip } from '../electron/services/tray';
import { percentOfStep } from '../shared/setup';

/**
 * The microphone listens all the time only while Cortex runs and the person
 * allowed it (electron/services/microphone.ts): the app's word, and the
 * engine's reading of it (beyin_v3_ses.wake_allowed), which are one contract.
 */

// The tests run from desktop/, as every other one reads the sources.
const SCRIPTS = path.resolve('..', 'template', '.claude', 'scripts');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PYTHON, ['--version'], { windowsHide: true }).status === 0;

test('the word is kept beside every vault’s state, where the engine looks for it', () => {
  assert.equal(microphoneFile({ LOCALAPPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Local') }), path.join('C:', 'Users', 'x', 'AppData', 'Local', 'beyin-v3', 'masaustu.json'));
  assert.ok(microphoneFile({}).endsWith(path.join('AppData', 'Local', 'beyin-v3', 'masaustu.json')));
  // Said often enough that the engine, which takes 20 seconds of silence as closed, never thinks a running app gone.
  assert.ok(BEAT_EVERY * 3 < 20_000);
});

test('what the app says: running and allowed, running and not, or quit', () => {
  assert.deepEqual(JSON.parse(microphoneWord(true, false, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, dinle: true });
  assert.deepEqual(JSON.parse(microphoneWord(false, false, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, dinle: false });
  assert.deepEqual(JSON.parse(microphoneWord(true, true, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, kapali: true }, 'quit says nothing of leave');
});

test('the engine reads the app’s word as the app means it', { skip: !hasPython }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mikrofon-'));
  const file = path.join(dir, 'masaustu.json');
  const allowed = () => {
    const run = spawnSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import beyin_v3_ses as s; print(s.wake_allowed({"uyandirma": True}, sys.argv[2]))', SCRIPTS, file], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  try {
    fs.writeFileSync(file, microphoneWord(true, false));
    assert.equal(allowed(), 'True', 'running, and allowed');
    fs.writeFileSync(file, microphoneWord(false, false));
    assert.equal(allowed(), 'False', 'running, not allowed');
    fs.writeFileSync(file, microphoneWord(true, true));
    assert.equal(allowed(), 'False', 'quit');
    fs.writeFileSync(file, microphoneWord(true, false, Date.now() - 60_000));
    assert.equal(allowed(), 'False', 'silent for a minute: crashed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the listener’s word on its voice is read only from a listener that runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-dinleyici-'));
  const file = path.join(dir, 'dinleyici.json');
  try {
    assert.equal(readListener(file), null, 'no listener: nothing said');
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false }));
    assert.deepEqual(readListener(file), { ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null });
    // A model being fetched: how much has come, for the settings' bar.
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', mb: 120, toplam: 484 }));
    assert.deepEqual(readListener(file), { ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false, mb: 120, toplam: 484 });
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', mb: 120, toplam: 0 }));
    assert.equal(readListener(file)?.mb, null, 'nothing in all is no progress');
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: 424242, at: 1, ses: 'hazir', model: 'small (işlemci)', uyandirma: true }));
    assert.equal(readListener(file, () => false), null, 'a listener that died without a word is none');
    assert.deepEqual(readListener(file, () => true), { ses: 'hazir', model: 'small (işlemci)', mesaj: '', uyandirma: true, mb: null, toplam: null });
    for (const broken of ['{', '[]', JSON.stringify({ pid: process.pid, ses: 'belki' }), JSON.stringify({ pid: 'x', ses: 'hazir' })]) {
      fs.writeFileSync(file, broken);
      assert.equal(readListener(file), null, broken);
    }
    assert.equal(listenerFile({ LOCALAPPDATA: path.join('C:', 'L') }), path.join('C:', 'L', 'beyin-v3', 'dinleyici.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow load is said, and so is its end; a quick one says nothing; a failure says why', () => {
  const word = (ses: HelperState, more: Partial<ListenerWord> = {}): ListenerWord => ({ ses, model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, ...more });
  const phrase = '“Hey Pyn”';
  assert.equal(helperTurn(word('yukleniyor'), word('hazir'), false, phrase, false), null, 'quick: nothing was said, nothing to end');
  assert.deepEqual(helperTurn(word('yukleniyor'), word('hazir', { uyandirma: true }), false, phrase, true), {
    title: 'Pyn hazır',
    body: '“Hey Pyn” de; not penceresi seni dinleyerek açılır.',
  });
  assert.equal(helperTurn(word('yukleniyor'), word('hazir'), true, phrase, true)?.body, 'You can speak into the note window.');
  assert.equal(helperTurn(word('hata', { mesaj: 'x' }), word('hazir'), false, phrase, false)?.title, 'Pyn hazır', 'back from a failure is said');
  assert.deepEqual(helperTurn(word('yukleniyor'), word('hata', { mesaj: 'İnternet yok.' }), false, phrase, false), {
    title: 'Ses açılamadı',
    body: 'İnternet yok. Birazdan yeniden denenecek.',
  });
  assert.equal(helperTurn(word('hazir'), word('hazir'), false, phrase, true), null, 'no turn, no word');
  assert.equal(helperTurn(word('hazir'), null, false, phrase, true), null);
});

test('the icon’s menu says the voice is getting ready, or could not start, instead of a microphone that seems on', () => {
  const voice = { installed: true, on: true, wake: true, auto: true, engine: 'islemci' as const, model: 'small', commands: null, wakePhrase: 'hey pyn' as const, readsFiles: true };
  assert.equal(trayItems(voice, false, false, true, 'yukleniyor')[0].label, 'Ses hazırlanıyor…');
  assert.equal(trayItems(voice, false, false, true, 'yukleniyor')[0].icon, 'mikrofon-kapali', 'not listening yet');
  assert.equal(trayItems(voice, true, false, true, 'hata')[0].label, 'Voice could not start; trying again');
  assert.equal(trayItems(voice, false, false, true, 'hazir')[0].label, 'Mikrofon dinliyor: “Hey Pyn”');
  assert.equal(trayItems(voice, false, false, true)[0].label, 'Mikrofon dinliyor: “Hey Pyn”', 'an engine that says nothing: as before');
  assert.equal(trayTooltip(voice, false, 'yukleniyor'), 'Cortex · Pyn hazırlanıyor…');
  assert.equal(trayTooltip(voice, false, 'yukleniyor', 40), 'Cortex · Pyn hazırlanıyor… %40', 'how much of the model has come');
  assert.equal(trayTooltip(voice, true, 'yukleniyor', 40), 'Cortex · voice is getting ready… 40%');
});

test('how far a download is: from the listener’s word, and from a setup step’s line, for the bars', () => {
  const word = (more: Partial<ListenerWord>): ListenerWord => ({ ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, ...more });
  assert.equal(percentOf(word({ mb: 121, toplam: 484 })), 25);
  assert.equal(percentOf(word({ mb: 500, toplam: 484 })), 100, 'never past all of it');
  assert.equal(percentOf(word({})), null, 'not downloading');
  assert.equal(percentOf(null), null);
  assert.equal(percentOfStep('  %40 (650 / 1624 MB)'), 40);
  assert.equal(percentOfStep('40% (650 / 1624 MB)'), 40, 'in English');
  assert.equal(percentOfStep('Paketler yükleniyor…'), null);
});

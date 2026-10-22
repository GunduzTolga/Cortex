import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BEAT_EVERY, type HelperState, type ListenerWord, listenerFile, microphoneFile, microphoneWord, ownerFile, readListener, readOwner } from '../electron/services/microphone';
import { helperTurn, isMissing, listenerTurn, MISSING_AFTER, MISSING_AT_START, missingSince, percentOf, trayItems, trayTooltip } from '../electron/services/tray';
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

test('what the app says: running and allowed, running and not, or quit; and its language, for yakala’s window', () => {
  assert.deepEqual(JSON.parse(microphoneWord(true, false, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, dinle: true, dil: 'tr' });
  assert.deepEqual(JSON.parse(microphoneWord(false, false, 1_000_000, 'en')), { surum: 1, pid: process.pid, at: 1000, dinle: false, dil: 'en' });
  assert.deepEqual(JSON.parse(microphoneWord(true, true, 1_000_000, 'en')), { surum: 1, pid: process.pid, at: 1000, kapali: true, dil: 'en' }, 'quit says nothing of leave, and keeps the language');
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
    const quiet = { uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: null };
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false }));
    assert.deepEqual(readListener(file), { ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, ...quiet });
    // A model being fetched: how much has come, for the settings' bar.
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', mb: 120, toplam: 484 }));
    assert.deepEqual(readListener(file), { ses: 'yukleniyor', model: '', mesaj: '', uyandirma: false, mb: 120, toplam: 484, ...quiet });
    // The wake phrase that cannot hear, and why; the key another app holds (beyin_v3_ses.say_listener).
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'hazir', uyandirma: false, uyandirma_sorun: 'sessiz', uyandirma_mesaj: 'mikrofon yalnız sessizlik veriyor', kisayol: 'mesgul' }));
    assert.deepEqual([readListener(file)?.uyandirma_sorun, readListener(file)?.uyandirma_mesaj, readListener(file)?.kisayol], ['sessiz', 'mikrofon yalnız sessizlik veriyor', 'mesgul']);
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'hazir', uyandirma_sorun: 'baska', kisayol: 'belki' }));
    assert.deepEqual([readListener(file)?.uyandirma_sorun, readListener(file)?.kisayol], [null, null], 'only what there is');
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', mb: 120, toplam: 0 }));
    assert.equal(readListener(file)?.mb, null, 'nothing in all is no progress');
    fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: 424242, at: 1, ses: 'hazir', model: 'small (işlemci)', uyandirma: true }));
    assert.equal(readListener(file, () => false), null, 'a listener that died without a word is none');
    assert.deepEqual(readListener(file, () => true), { ses: 'hazir', model: 'small (işlemci)', mesaj: '', uyandirma: true, mb: null, toplam: null, ...quiet });
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
  const word = (ses: HelperState, more: Partial<ListenerWord> = {}): ListenerWord => ({ ses, model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: null, ...more });
  const phrase = '“Hey Pyn”';
  assert.equal(helperTurn(word('yukleniyor'), word('hazir'), false, phrase, false), null, 'quick: nothing was said, nothing to end');
  assert.deepEqual(helperTurn(word('yukleniyor'), word('hazir', { uyandirma: true }), false, phrase, true), {
    title: 'Pyn hazır',
    body: '“Hey Pyn” de; not penceresi seni dinleyerek açılır.',
  });
  assert.equal(helperTurn(word('yukleniyor'), word('hazir'), true, phrase, true)?.body, 'You can speak into the note window.');
  // Ready, the wake phrase not heard yet (or not at all): "say the phrase" is not said (windows-e2e-2).
  assert.equal(helperTurn(word('yukleniyor'), word('hazir', { uyandirma: false, uyandirma_sorun: 'model' }), false, phrase, true)?.body, 'Not penceresinde konuşabilirsin.');
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
  const word = (ses: HelperState, more: Partial<ListenerWord> = {}): ListenerWord => ({ ses, model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: null, ...more });
  assert.equal(trayItems(voice, false, false, true, { word: word('yukleniyor') })[0].label, 'Ses hazırlanıyor…');
  assert.equal(trayItems(voice, false, false, true, { word: word('yukleniyor') })[0].icon, 'mikrofon-kapali', 'not listening yet');
  assert.equal(trayItems(voice, true, false, true, { word: word('hata') })[0].label, 'Voice could not start; trying again');
  assert.deepEqual(
    [trayItems(voice, false, false, true, { word: word('hazir', { uyandirma: true }) })[0].label, trayItems(voice, false, false, true, { word: word('hazir', { uyandirma: true }) })[0].icon],
    ['Mikrofon dinliyor: “Hey Pyn”', 'mikrofon-acik'],
  );
  assert.equal(trayTooltip(voice, false, { word: word('yukleniyor') }), 'Cortex · Pyn hazırlanıyor…');
  assert.equal(trayTooltip(voice, false, { word: word('yukleniyor') }, 40), 'Cortex · Pyn hazırlanıyor… %40', 'how much of the model has come');
  assert.equal(trayTooltip(voice, true, { word: word('yukleniyor') }, 40), 'Cortex · voice is getting ready… 40%');
  assert.equal(trayTooltip(voice, false, { word: word('hazir', { uyandirma: true }) }), 'Cortex · mikrofon “Hey Pyn” için dinliyor');
});

test('the microphone is said to listen only while the listener says it hears: not for a setting, a failed wake phrase, or no listener (voice-4, windows-e2e-2, windows-e2e-5)', () => {
  const voice = { installed: true, on: true, wake: true, auto: true, engine: 'vulkan' as const, model: 'large-v3-turbo', commands: null, wakePhrase: 'pyn not al' as const, readsFiles: true };
  const word = (more: Partial<ListenerWord> = {}): ListenerWord => ({ ses: 'hazir', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: null, ...more });
  const first = (seen: Parameters<typeof trayItems>[4]) => trayItems(voice, false, false, true, seen)[0];
  // No listener yet (within the grace): starting, and the red dot is not shown.
  assert.deepEqual([first({}).label, first({}).icon], ['Dinleyici başlıyor…', 'mikrofon-kapali']);
  // Ready, the wake listener not hearing yet.
  assert.deepEqual([first({ word: word() }).label, first({ word: word() }).icon], ['Uyandırma açılıyor…', 'mikrofon-kapali']);
  // Its microphone silent (Windows' privacy switch), its model gone: said, the dot off.
  assert.deepEqual([first({ word: word({ uyandirma_sorun: 'sessiz' }) }).label, first({ word: word({ uyandirma_sorun: 'sessiz' }) }).icon], ['Uyandırma açılamadı: mikrofon yalnız sessizlik veriyor', 'mikrofon-kapali']);
  assert.equal(trayItems(voice, true, false, true, { word: word({ uyandirma_sorun: 'model' }) })[0].label, 'The wake phrase could not start: its model did not load');
  assert.equal(trayTooltip(voice, false, { word: word({ uyandirma_sorun: 'mikrofon' }) }), 'Cortex · uyandırma açılamadı');
  // No listener for longer than a restart takes: said, with what starts it.
  const gone = trayItems(voice, false, false, true, { word: null, missing: true });
  assert.deepEqual([gone[0].label, gone[0].icon], ['Dinleyici çalışmıyor', 'mikrofon-kapali']);
  assert.deepEqual(gone.filter((one) => one.action === 'listener').map((one) => [one.label, one.enabled ?? true]), [['Dinleyiciyi başlat', true]]);
  assert.equal(trayItems(voice, false, true, true, { missing: true }).find((one) => one.action === 'listener')?.enabled, false, 'not while it is being started');
  assert.equal(trayTooltip(voice, true, { missing: true }), 'Cortex · the listener is not running');
  // Voice typing switched off, or not set up: a listener not running is nothing to say.
  for (const off of [{ ...voice, on: false }, { ...voice, installed: false }]) {
    const items = trayItems(off, false, false, true, { missing: true });
    assert.ok(!items.some((one) => one.action === 'listener') && items[0].label !== 'Dinleyici çalışmıyor');
  }
  // The key another app holds: said, and it opens the settings, where another is chosen.
  const busy = trayItems(voice, false, false, true, { word: word({ uyandirma: true, kisayol: 'mesgul' }), hotkey: 'Ctrl+Alt+C' });
  assert.deepEqual(busy.filter((one) => one.label.includes('Ctrl+Alt+C')).map((one) => [one.label, one.action]), [['Ctrl+Alt+C başka bir uygulamada: kısayolu değiştir…', 'settings']]);
  assert.equal(busy[0].label, 'Mikrofon dinliyor: “Pyn, not al”', 'the phrase still works without the key');
});

test('a listener is said not to run only past a restart’s grace, never while one is being started, and not right at the app’s start', () => {
  const voice = { installed: true, on: true, wake: false, auto: true, engine: 'islemci' as const, model: 'small', commands: null, wakePhrase: 'pyn not al' as const };
  const word: ListenerWord = { ses: 'hazir', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: null };
  const started = 0;
  const late = MISSING_AT_START + 1_000;
  let since = missingSince(null, voice, null, false, late);
  assert.equal(since, late, 'none seen from now');
  assert.equal(isMissing(since, late + MISSING_AFTER - 1, started), false, 'within the grace: a restart takes a moment');
  since = missingSince(since, voice, null, false, late + 4_000);
  assert.equal(since, late, 'the first moment kept');
  assert.equal(isMissing(since, late + MISSING_AFTER, started), true);
  assert.equal(missingSince(since, voice, word, false, late + 20_000), null, 'seen again: nothing missing');
  assert.equal(missingSince(since, voice, null, true, late + 20_000), null, 'being started again (a setting, a setup): not missing meanwhile');
  assert.equal(missingSince(since, { ...voice, on: false }, null, false, late + 20_000), null, 'voice off: no listener is wanted');
  assert.equal(missingSince(since, null, null, false, late + 20_000), null);
  // Started with Windows, the listener starts beside the app, cold: not said in the app's first minute.
  assert.equal(isMissing(0, MISSING_AFTER + 1, started), false);
  assert.equal(isMissing(0, MISSING_AT_START, started), true);
});

test('the wake phrase’s trouble, a key taken and no listener are each said once, when they begin', () => {
  const word = (more: Partial<ListenerWord> = {}): ListenerWord => ({ ses: 'hazir', model: '', mesaj: '', uyandirma: false, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: 'tamam', ...more });
  const seen = (one: ListenerWord | null, missing = false) => ({ word: one, missing, hotkey: 'Ctrl+Alt+C' });
  assert.deepEqual(listenerTurn(seen(word()), seen(word({ uyandirma_sorun: 'mikrofon', uyandirma_mesaj: 'mikrofondan ses gelmiyor; bağlı ve seçili mi?' })), false), {
    title: 'Uyandırma açılamadı',
    body: 'Mikrofondan ses gelmiyor; bağlı ve seçili mi?',
  });
  assert.equal(listenerTurn(seen(word({ uyandirma_sorun: 'mikrofon' })), seen(word({ uyandirma_sorun: 'mikrofon' })), false), null, 'said once');
  assert.equal(listenerTurn(seen(word()), seen(word({ uyandirma_sorun: 'sessiz' })), true)?.body, 'The microphone gives only silence; Settings → Voice typing says what to do.');
  assert.deepEqual(listenerTurn(seen(word()), seen(word({ kisayol: 'mesgul' })), false)?.title, 'Ctrl+Alt+C başka bir uygulamada');
  assert.equal(listenerTurn(seen(null, false), seen(null, true), false)?.title, 'Dinleyici çalışmıyor');
  assert.equal(listenerTurn(seen(null, true), seen(null, true), false), null);
  assert.equal(listenerTurn(seen(word()), seen(word({ uyandirma: true })), false), null, 'nothing wrong, nothing said');
});

test('yakala’s owner record is read beside the app’s word: its vault and its key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sahip-'));
  const file = path.join(dir, 'yakala-sahip.json');
  try {
    assert.equal(ownerFile({ LOCALAPPDATA: path.join('C:', 'L') }), path.join('C:', 'L', 'beyin-v3', 'yakala-sahip.json'));
    assert.equal(readOwner(file), null, 'none written');
    fs.writeFileSync(file, JSON.stringify({ surum: 1, vault: 'C:\\Kasa', state: 'C:\\durum', tus: 'ctrl+alt+c', at: 1 }));
    assert.deepEqual(readOwner(file), { vault: 'C:\\Kasa', tus: 'ctrl+alt+c' });
    fs.writeFileSync(file, JSON.stringify({ surum: 1, vault: 'C:\\Kasa' }));
    assert.deepEqual(readOwner(file), { vault: 'C:\\Kasa', tus: null });
    for (const broken of ['{', '[]', JSON.stringify({ vault: '' }), JSON.stringify({ tus: 'ctrl+alt+c' })]) {
      fs.writeFileSync(file, broken);
      assert.equal(readOwner(file), null, broken);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

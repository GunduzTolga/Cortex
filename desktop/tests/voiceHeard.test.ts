import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENGINE_SENTENCES } from '../shared/engineError';
import type { VoiceStatus } from '../shared/setup';
import { madeAtStart } from '../electron/services/micWindow';
import { type HelperState, type ListenerWordNow, readListener } from '../electron/services/microphone';
import { heardNotice, heardStep, helperTurn, trayTooltip } from '../electron/services/tray';

/**
 * What the person is shown between saying the wake phrase and the note window: on a weak laptop that was a minute of
 * nothing (the review of 1.0.61). The helper says the phrase was heard as soon as it is (`duydu`), the listener writes
 * it into its word (dinleyici.json), and the icon says it; and a model that would not load is said in a sentence, in
 * the window's language, not in the library's own words.
 */

const word = (ses: HelperState, more: Partial<ListenerWordNow> = {}): ListenerWordNow => ({
  ses,
  model: '',
  mesaj: '',
  uyandirma: false,
  mb: null,
  toplam: null,
  uyandirma_sorun: null,
  uyandirma_mesaj: '',
  kisayol: 'tamam',
  ...more,
});

const voice: VoiceStatus = { installed: true, on: true, wake: true, auto: true, engine: 'islemci', model: 'small', commands: null, wakePhrase: 'hey pyn' };

test('the listener’s word carries a phrase just heard and the kind of a failed load, and nothing it does not know', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-duydu-'));
  const file = path.join(dir, 'dinleyici.json');
  const said = (more: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ surum: 1, pid: process.pid, at: 1, ses: 'yukleniyor', ...more }));
  try {
    said({ duydu: 'hazirlaniyor', uyandirma: true });
    assert.deepEqual([readListener(file)?.duydu, readListener(file)?.uyandirma], ['hazirlaniyor', true]);
    said({ duydu: 'bakiyor' });
    assert.equal(readListener(file)?.duydu, 'bakiyor');
    said({ duydu: 'baska', hata_turu: 'x' });
    assert.deepEqual([readListener(file)?.duydu, readListener(file)?.hata_turu], [undefined, undefined], 'only what the app knows');
    said({ duydu: null, hata_turu: null });
    assert.equal('duydu' in (readListener(file) ?? {}), false, 'an engine that says nothing of it reads as before');
    said({ ses: 'hata', mesaj: 'Ses modelinin dosyası eksik ya da bozuk; Ayarlar → Sesle yazma\'dan yeniden kur.', hata_turu: 'bozuk' });
    assert.equal(readListener(file)?.hata_turu, 'bozuk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a phrase heard while the model still loads is said at once; a check alone only if it takes a while; over, it is taken back', () => {
  assert.equal(heardStep(null, 'hazirlaniyor', false), 'say', 'a long wait: said now');
  assert.equal(heardStep(null, 'bakiyor', false), 'later', 'mostly over in a moment: its window answers');
  assert.equal(heardStep('bakiyor', 'bakiyor', false), null, 'nothing new');
  assert.equal(heardStep('bakiyor', null, false), null, 'over before anything was said: nothing to take back');
  assert.equal(heardStep('bakiyor', null, true), 'clear', 'said, and over: taken away without a word');
  assert.equal(heardStep('hazirlaniyor', null, true), 'clear');
  assert.equal(heardStep('hazirlaniyor', 'bakiyor', true), null, 'said once');
  assert.deepEqual(heardNotice('hazirlaniyor', false), {
    title: 'Pyn seni duydu',
    body: 'Ses modeli hâlâ hazırlanıyor; hazır olunca not penceresi kendiliğinden açılacak.',
  });
  assert.deepEqual(heardNotice('bakiyor', false), {
    title: 'Pyn seni duydu',
    body: 'Uyandırma sözünü denetliyorum; söz buysa not penceresi birazdan açılır.',
  });
  assert.deepEqual(heardNotice('hazirlaniyor', true), {
    title: 'Pyn heard you',
    body: 'The voice model is still getting ready; the note window will open by itself once it is.',
  });
  assert.equal(heardNotice('bakiyor', true).body, 'Checking the wake phrase; if that was it, the note window opens in a moment.');
});

test('the icon says the phrase was heard, over "getting ready"', () => {
  assert.equal(trayTooltip(voice, false, { word: word('yukleniyor', { uyandirma: true, duydu: 'hazirlaniyor' }) }), 'Cortex · Pyn seni duydu…');
  assert.equal(trayTooltip(voice, true, { word: word('hazir', { uyandirma: true, duydu: 'bakiyor' }) }), 'Cortex · Pyn heard you…');
  assert.equal(trayTooltip(voice, false, { word: word('yukleniyor') }), 'Cortex · Pyn hazırlanıyor…', 'nothing heard: as before');
  assert.equal(trayTooltip({ ...voice, wake: false }, false, { word: word('hazir', { duydu: 'bakiyor' }) }), 'Cortex · mikrofon kapalı', 'not where the wake phrase is off');
});

test('a model that would not load is said in the window’s language, never in a library’s own words', () => {
  const phrase = '“Hey Pyn”';
  const broken = word('hata', { mesaj: 'Ses modelinin dosyası eksik ya da bozuk; Ayarlar → Sesle yazma\'dan yeniden kur.', hata_turu: 'bozuk' });
  assert.deepEqual(helperTurn(word('yukleniyor'), broken, false, phrase, false), {
    title: 'Ses açılamadı',
    body: 'Ses modelinin dosyası eksik ya da bozuk; Ayarlar → Sesle yazma\'dan yeniden kur. Birazdan yeniden denenecek.',
  });
  assert.deepEqual(helperTurn(word('yukleniyor'), broken, true, phrase, false), {
    title: 'Voice could not start',
    body: 'The voice model’s file is missing or damaged; set voice typing up again in Settings → Voice typing. It will be tried again shortly.',
  });
  for (const kind of ['ag', 'disk', 'bellek', 'bozuk', 'bilinmeyen'] as const) {
    const body = helperTurn(word('yukleniyor'), word('hata', { mesaj: 'Türkçe cümle.', hata_turu: kind }), true, phrase, false)?.body ?? '';
    assert.ok(body.startsWith('The') || body.startsWith('There'), `${kind}: ${body}`);
    assert.equal(body.includes('Türkçe'), false, 'an English window does not show the Turkish sentence');
  }
  // An engine that does not sort its failures: what it says, as before.
  assert.equal(helperTurn(word('yukleniyor'), word('hata', { mesaj: 'İnternet yok.' }), true, phrase, false)?.body, 'İnternet yok. It will be tried again shortly.');
});

test('the recording window is made as the app starts only where the wake listener will ask for sound at once', () => {
  assert.equal(madeAtStart('win32', true), true);
  assert.equal(madeAtStart('win32', false), false, 'the microphone not let listen all the time: made when sound is first asked for, as before');
  assert.equal(madeAtStart('darwin', true), false, 'the listener is on Windows only');
});

test('a voice setup the network stopped names the addresses a company network must allow, in both languages', () => {
  for (const sentence of [ENGINE_SENTENCES.voice_network.tr, ENGINE_SENTENCES.voice_network.en]) {
    for (const host of ['pypi.org', 'files.pythonhosted.org', 'huggingface.co', 'alphacephei.com']) assert.ok(sentence.includes(host), `${host}: ${sentence}`);
    assert.ok(/proxy/.test(sentence) && /sertifika|certificate/.test(sentence), sentence);
    assert.ok(sentence.length <= 400, 'shown whole: the longest sentence the app shows');
  }
});

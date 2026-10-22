import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ENGINE_CODES, ENGINE_SENTENCES, engineFailureText, engineSentence, readEngineError } from '../shared/engineError';

/**
 * What the vault's engine says when a command fails, said to the person
 * (shared/engineError.ts): the JSON line it ends with is read, never shown.
 */

/** As beyin.py and install_v3.py write it: `json.dumps(..., ensure_ascii=True)`, every Turkish letter escaped. */
const asPython = (value: Record<string, unknown>) => JSON.stringify(value).replace(/[\u0080-\uffff]/g, (one) => `\\u${one.charCodeAt(0).toString(16).padStart(4, '0')}`);

test('the engine’s JSON line is read whole: its letters come back, and nothing of the JSON is shown', () => {
  const line = asPython({ error: 'RuntimeError', message: 'Paketler yüklenemedi: ağ yok' });
  assert.match(line, /\\u00fc/, 'escaped, as the engine writes it');
  const text = engineFailureText(`Uyari: bir şey\n${line}\n`, 'tr');
  assert.equal(text, 'Paketler yüklenemedi: ağ yok');
  assert.doesNotMatch(text ?? '', /[{}"\\]/);
});

test('a long message is read before it is cut: an escaped pip error longer than a toast is not shown as broken JSON', () => {
  const long = `Sesle yazma kurulamadı: ${'ş'.repeat(700)}`;
  const line = asPython({ error: 'SetupError', message: long });
  assert.ok(line.length > 4000);
  const text = engineFailureText(line, 'tr') ?? '';
  assert.ok(text.startsWith('Sesle yazma kurulamadı: şşş'));
  assert.ok(text.length <= 400 && text.endsWith('…'));
});

test('a failure that names itself is said in the window’s language: the engine’s own Turkish sentence, or the English one', () => {
  const line = asPython({ error: 'SetupError', message: 'Sesle yazma kurulamadı: indirirken internete bağlanılamadı.', code: 'voice_network' });
  assert.equal(engineFailureText(line, 'tr'), 'Sesle yazma kurulamadı: indirirken internete bağlanılamadı.');
  assert.equal(engineFailureText(line, 'en'), ENGINE_SENTENCES.voice_network.en);
  assert.equal(readEngineError(line)?.code, 'voice_network');
  assert.equal(readEngineError(line)?.named, true);
});

test('an engine from before the codes is known by its English words, and said in either language', () => {
  const busy = asPython({ error: 'ValueError', message: 'runtime/updater busy; retry after active work finishes' });
  assert.equal(readEngineError(busy)?.code, 'updater_busy');
  assert.equal(engineFailureText(busy, 'tr'), ENGINE_SENTENCES.updater_busy.tr);
  assert.equal(engineFailureText(busy, 'en'), ENGINE_SENTENCES.updater_busy.en);
  const legacy = asPython({ error: 'ValueError', message: 'Customized legacy runner requires review .claude/scripts/flush.py' });
  assert.equal(readEngineError(legacy)?.code, 'legacy_review');
  assert.match(engineFailureText(legacy, 'tr') ?? '', /\(\.claude\/scripts\/flush\.py\)/, 'the file it names is said');
  assert.match(engineFailureText(legacy, 'en') ?? '', /\(\.claude\/scripts\/flush\.py\)/);
  assert.equal(readEngineError(asPython({ error: 'ValueError', message: 'unsupported Python runtime' }))?.code, 'python_too_old');
  assert.equal(readEngineError(asPython({ error: 'ValueError', message: 'Pending installation; run installed beyin.py recover or rollback first' }))?.code, 'pending_journal');
  assert.equal(readEngineError(asPython({ error: 'ValueError', message: 'runtime belongs to another vault' }))?.code, 'vault_moved');
  assert.equal(readEngineError(asPython({ error: 'ValueError', message: 'update conflict: managed target changed .claude/settings.local.json' }))?.code, 'update_conflict');
  assert.equal(readEngineError(asPython({ error: 'ValueError', message: 'migration marker changed; rollback conflict' }))?.code, 'rollback_conflict');
  // pip's words, inside the old voice setup's Turkish, and urllib's as a traceback's last line.
  assert.equal(readEngineError(asPython({ error: 'RuntimeError', message: 'Paketler yüklenemedi: ERROR: No matching distribution found for faster-whisper>=1.2' }))?.code, 'network');
  assert.equal(readEngineError('Traceback (most recent call last):\n  ...\nurllib.error.URLError: <urlopen error [Errno 11001] getaddrinfo failed>')?.code, 'network');
  assert.equal(readEngineError(asPython({ error: 'OSError', message: '[Errno 28] No space left on device' }))?.code, 'disk_full');
});

test('anything else is the engine’s sentence with its hint, or the line as it came; a code no one knows is no code', () => {
  assert.equal(engineFailureText(asPython({ error: 'ValueError', message: 'laya_shadow_only', hint: 'Laya yalniz golge modda calisir.' }), 'en'), 'laya_shadow_only Laya yalniz golge modda calisir.');
  assert.equal(engineFailureText('bilinmeyen komut', 'en'), 'bilinmeyen komut');
  assert.equal(engineFailureText(asPython({ error: 'ValueError', message: 'x', code: 'made_up' }), 'tr'), 'x');
  assert.equal(engineFailureText(asPython({ error: 'KeyError' }), 'en'), 'Cortex’s engine failed (KeyError).');
  assert.equal(engineFailureText('', 'tr'), null);
  // A sentence already said is said again as it is: reading twice changes nothing.
  const once = engineFailureText(asPython({ error: 'ValueError', message: 'runtime/updater busy; retry after active work finishes' }), 'en') ?? '';
  assert.equal(engineFailureText(once, 'en'), once);
});

test('every failure the engine names is said in Turkish and in English', () => {
  for (const code of ENGINE_CODES) {
    const said = ENGINE_SENTENCES[code];
    assert.ok(said.tr.trim() && said.en.trim(), code);
    assert.notEqual(said.tr, said.en, code);
    assert.doesNotMatch(said.tr, /[\u00e2\u00c2]/, 'written as the rest of the window writes it');
    assert.equal(engineSentence({ type: 'ValueError', code, message: '', hint: null, named: false, given: null }, 'en'), said.en.replace('{file}', ''));
  }
});

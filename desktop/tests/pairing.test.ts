import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PAIRING_MAX, PAIRING_PREFIX, type PairingRefusal, pairingRefusalText, parsePairing } from '../shared/pairing';

/**
 * The pairing code (shared/pairing.ts): read exactly as the server writes it (template/.claude/scripts/
 * beyin_v3_eslestir.py, `code`), and every other paste refused with a reason the window turns into one sentence.
 * The codes here are made by the same rules as the server's: compact JSON (`separators=(',', ':')`, non-ASCII as it
 * is), base64url with its padding taken off. Nothing in them is a real key.
 */

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const AUTHKEY = 'tskey-auth-kTEST000CNTRL-0123456789abcdefghijklmnop';
const HERMES_KEY = 'hermes-key-ornek-0123456789abcdef';

/** As Python's `code()`: json.dumps(payload, separators=(',', ':'), ensure_ascii=False), urlsafe_b64encode, '=' stripped. */
function codeOf(payload: unknown): string {
  return PAIRING_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const good = (patch: Record<string, unknown> = {}) => ({ v: 1, url: 'https://pyn.tailnet-ornek.ts.net:8642', profile: 'pyn', authkey: AUTHKEY, hermesKey: HERMES_KEY, exp: '2026-11-06T13:00:00Z', ...patch });

const refused = (code: unknown, now = NOW): PairingRefusal => {
  const result = parsePairing(code, now);
  assert.equal(result.ok, false, `taken: ${String(code).slice(0, 40)}`);
  return (result as { refusal: PairingRefusal }).refusal;
};

test('a code as the server writes it is read: the address, the profile, both keys and when it stops', () => {
  const result = parsePairing(codeOf(good()), NOW);
  assert.ok(result.ok);
  assert.deepEqual(result.pairing, { url: 'https://pyn.tailnet-ornek.ts.net:8642', profile: 'pyn', authkey: AUTHKEY, hermesKey: HERMES_KEY, exp: Date.UTC(2026, 10, 6, 13, 0, 0) });
  // No profile (Python's None), an address with a path and its closing slash, the code pasted with spaces and a line break.
  const plain = parsePairing(`  ${codeOf(good({ profile: null, url: 'http://host:8642/gateway/' })).replace(/(.{40})/, '$1\n')}  `, NOW);
  assert.ok(plain.ok);
  assert.equal(plain.pairing.profile, null);
  assert.equal(plain.pairing.url, 'http://host:8642/gateway');
});

test('a code made by the server’s own generator is read (Python, beyin_v3_eslestir.code)', (t) => {
  const script = path.resolve('..', 'template', '.claude', 'scripts');
  let python: string | null = null;
  for (const name of ['python3', 'python']) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' });
      python = name;
      break;
    } catch {
      /* the next */
    }
  }
  if (!python || !fs.existsSync(path.join(script, 'beyin_v3_eslestir.py'))) return t.skip('no Python here');
  const made = execFileSync(python, ['-I', '-c', [
    'import sys; sys.path.insert(0, sys.argv[1])',
    'from datetime import datetime, timezone',
    'import beyin_v3_eslestir as e',
    "print(e.code('https://pyn.tailnet-ornek.ts.net:8642', 'pyn', sys.argv[2], sys.argv[3], 60, now=datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)))",
  ].join('\n'), script, AUTHKEY, `${HERMES_KEY}-ğüşİ`], { encoding: 'utf8' }).trim();
  const result = parsePairing(made, NOW);
  assert.ok(result.ok);
  assert.equal(result.pairing.hermesKey, `${HERMES_KEY}-ğüşİ`, 'non-ASCII as Python writes it (ensure_ascii=False)');
  assert.equal(result.pairing.exp, Date.UTC(2026, 10, 6, 13, 0, 0));
  assert.equal(made, codeOf({ v: 1, url: 'https://pyn.tailnet-ornek.ts.net:8642', profile: 'pyn', authkey: AUTHKEY, hermesKey: `${HERMES_KEY}-ğüşİ`, exp: '2026-11-06T13:00:00Z' }), 'the test’s own rules are the generator’s');
});

test('every paste that is not a code is refused, each for its reason', () => {
  assert.equal(refused(42), 'prefix');
  assert.equal(refused(''), 'prefix');
  assert.equal(refused('https://pyn.tailnet.ts.net:8642'), 'prefix');
  assert.equal(refused(codeOf(good()).replace('cortex-pair-1:', 'cortex-pair-2:')), 'prefix');
  assert.equal(refused(`${PAIRING_PREFIX}bu+base64url/degil`), 'encoding');
  assert.equal(refused(`${PAIRING_PREFIX}A`), 'encoding', 'one character over a whole group is no base64');
  assert.equal(refused(`${PAIRING_PREFIX}${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}`), 'encoding', 'not UTF-8');
  assert.equal(refused(`${PAIRING_PREFIX}${Buffer.from('{"v":1,').toString('base64url')}`), 'json');
  assert.equal(refused(`${PAIRING_PREFIX}${Buffer.from('[1]').toString('base64url')}`), 'json');
  assert.equal(refused(codeOf(good({ v: 2 }))), 'version');
  assert.equal(refused(codeOf(good({ v: '1' }))), 'version');
  for (const field of ['url', 'authkey', 'hermesKey', 'exp']) {
    const { [field]: _gone, ...rest } = good();
    assert.equal(refused(codeOf(rest)), 'field', `without ${field}`);
    assert.equal(refused(codeOf(good({ [field]: 7 }))), 'field', `${field} not a string`);
  }
  assert.equal(refused(codeOf(good({ profile: 3 }))), 'field');
  assert.equal(refused(codeOf(good({ hermesKey: '  ' }))), 'field', 'an empty key');
  assert.equal(refused(codeOf(good({ hermesKey: 'a\nb' }))), 'field', 'a key of two lines');
  assert.equal(refused(codeOf(good({ exp: '2026-11-06 13:00:00' }))), 'field', 'another way of writing the time');
  assert.equal(refused(codeOf(good({ exp: '2026-02-30T13:00:00Z' }))), 'field', 'a day that does not exist');
  for (const url of ['ftp://host:8642', 'https://ad:parola@host:8642', 'https://host:8642/?a=1', 'host:8642', 'https://ho st']) {
    assert.equal(refused(codeOf(good({ url }))), 'url', url);
  }
  assert.equal(refused(codeOf(good({ profile: 'a/b' }))), 'profile');
  assert.equal(refused(codeOf(good({ profile: '' }))), 'profile');
  assert.equal(refused(codeOf(good({ authkey: 'auth-key-without-prefix' }))), 'authkey');
  assert.equal(refused(codeOf(good({ authkey: 'tskey-a b' }))), 'authkey');
});

test('a code past its time is refused, and so is one at its very second', () => {
  assert.equal(refused(codeOf(good()), Date.UTC(2026, 10, 6, 13, 0, 1)), 'expired');
  assert.equal(refused(codeOf(good()), Date.UTC(2026, 10, 6, 13, 0, 0)), 'expired');
  assert.ok(parsePairing(codeOf(good()), Date.UTC(2026, 10, 6, 12, 59, 59)).ok);
});

test('a paste too long to be a code is refused before it is read', () => {
  assert.equal(refused(`${PAIRING_PREFIX}${'A'.repeat(PAIRING_MAX)}`), 'length');
  assert.ok(codeOf(good()).length < 600, 'a real code is far under the limit');
});

test('each refusal is one sentence in the window’s language: an expired code apart, all say “not a code”', () => {
  const reasons: PairingRefusal[] = ['length', 'prefix', 'encoding', 'json', 'version', 'field', 'url', 'profile', 'authkey'];
  for (const reason of reasons) {
    assert.equal(pairingRefusalText(reason, false), "Bu bir Cortex eşleştirme kodu değil. Telefondaki 'Bilgisayar ekle'den yeni kod al.");
    assert.match(pairingRefusalText(reason, true), /^This is not a Cortex pairing code\./);
  }
  assert.equal(pairingRefusalText('expired', false), 'Kodun süresi dolmuş. Yeni kod al.');
  assert.equal(pairingRefusalText('expired', true), 'The code has expired. Get a new code.');
});

test('a refusal carries nothing of the code', () => {
  for (const code of [codeOf(good({ v: 2 })), codeOf(good({ url: 'ftp://x' })), codeOf(good())]) {
    const result = parsePairing(code, Date.UTC(2027, 0, 1));
    assert.equal(result.ok, false);
    const said = JSON.stringify(result) + pairingRefusalText((result as { refusal: PairingRefusal }).refusal, false);
    for (const secret of [AUTHKEY, HERMES_KEY, code.slice(PAIRING_PREFIX.length, PAIRING_PREFIX.length + 20)]) assert.ok(!said.includes(secret));
  }
});

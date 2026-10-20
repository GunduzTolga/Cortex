import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { pythonOf } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';
import {
  connectTelegram,
  disconnectTelegram,
  engineSentence,
  pairTelegramAgain,
  restartDelay,
  stopTelegram,
  telegramOf,
  telegramStatus,
} from '../electron/services/telegram';

/**
 * Notes from the phone through Telegram (electron/services/telegram.ts): the
 * key checked by the vault's engine and kept encrypted, the listener started
 * with it and stopped, the engine's status read for the window. The engine is
 * stood in for by a small beyin.py that answers `telegram` as the real one does.
 */

const KEY = `123456789:${'A'.repeat(35)}`;
const REFUSED = `123456789:${'X'.repeat(35)}`;

const STAND_IN = String.raw`import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
args = [one for one in sys.argv[1:] if one != '--json']
key = os.environ.get('BEYIN_TELEGRAM_TOKEN', '')
with open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8') as log:
    log.write(' '.join(args) + (' +anahtar' if key == '123456789:' + 'A' * 35 else ' -anahtar' if not key else ' ?anahtar') + '\n')
kept = os.path.join(here, 'tg.json')
seen = json.load(open(kept, encoding='utf-8')) if os.path.exists(kept) else {'bot': None, 'eslesti': False}
def keep():
    json.dump(seen, open(kept, 'w', encoding='utf-8'))
def status():
    return {'kurulu': bool(seen['bot']) and bool(key), 'anahtar': bool(key), 'bot': seen['bot'], 'eslesti': seen['eslesti'],
            'kisi': 'Tolga' if seen['eslesti'] else None,
            'baglanti': None if seen['eslesti'] or not seen['bot'] else 'https://t.me/pyn_bot?start=KOD12345',
            'kod': None if seen['eslesti'] or not seen['bot'] else 'KOD12345', 'calisiyor': False, 'son_hata': None,
            'yakalanan': 3, 'sesli_not': True}
if args[:2] == ['telegram', 'durum']:
    print(json.dumps(status()))
elif args[:2] == ['telegram', 'kur']:
    if key != '123456789:' + 'A' * 35:
        print(json.dumps({'error': 'ValueError', 'message': 'Telegram bu anahtarı tanımadı.'}), file=sys.stderr)
        sys.exit(1)
    seen['bot'] = 'pyn_bot'
    if '--yeniden-esle' in args:
        seen['eslesti'] = False
    keep()
    print(json.dumps(dict(status(), status='kuruldu')))
elif args[:2] == ['telegram', 'dinle']:
    open(os.path.join(here, 'dinle.pid'), 'w').write(str(os.getpid()))
    seen['eslesti'] = True
    keep()
    time.sleep(30)
elif args[:2] == ['telegram', 'kaldir']:
    os.remove(kept)
    print(json.dumps({'status': 'kaldirildi'}))
else:
    print('bilinmeyen komut', file=sys.stderr)
    sys.exit(2)
`;

function vaultWithEngine(): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-telegram-'));
  fs.writeFileSync(path.join(vault, 'beyin.py'), STAND_IN);
  fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.26\n');
  updateSettings((settings) => {
    settings.vault = vault;
  });
  return vault;
}

const asked = (vault: string) => fs.readFileSync(path.join(vault, 'istenen.log'), 'utf8').trim().split(/\r?\n/);
const hasPython = pythonOf() !== null;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('the engine’s status as the window holds it; an engine without Telegram is said to be one', () => {
  assert.deepEqual(
    telegramOf({ bot: 'pyn_bot', eslesti: false, baglanti: 'https://t.me/pyn_bot?start=K', kod: 'K', calisiyor: true, son_hata: '', yakalanan: 2, sesli_not: false }, true),
    { key: true, supported: true, bot: 'pyn_bot', paired: false, person: null, link: 'https://t.me/pyn_bot?start=K', code: 'K', listening: true, error: null, captured: 2, voiceNotes: false },
  );
  const none = telegramOf(null, false);
  assert.equal(none.supported, false);
  assert.equal(none.bot, null);
});

test('what the engine refused with is its own sentence, not its JSON', () => {
  assert.equal(engineSentence(new Error('{"error": "ValueError", "message": "Telegram bu anahtarı tanımadı."}')), 'Telegram bu anahtarı tanımadı.');
  assert.equal(engineSentence(new Error('Çıkış kodu 1.')), 'Çıkış kodu 1.');
});

test('a listener that keeps stopping is started again a little later each time, never more than five minutes later', () => {
  assert.deepEqual([0, 1, 2, 3].map(restartDelay), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(restartDelay(20), 5 * 60_000);
});

test('a key that does not look like one is refused before anything runs', async () => {
  const vault = vaultWithEngine();
  await assert.rejects(connectTelegram('merhaba'), /bot anahtarına benzemiyor/);
  await assert.rejects(connectTelegram(42), /bot anahtarına benzemiyor/);
  assert.equal(fs.existsSync(path.join(vault, 'istenen.log')), false);
});

test('the key is checked by the engine, kept encrypted, and the listener runs with it until it is let go', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  const before = await telegramStatus();
  assert.deepEqual([before.supported, before.key, before.bot], [true, false, null]);

  const connected = await connectTelegram(`  ${KEY}  `);
  assert.deepEqual([connected.key, connected.bot, connected.link, connected.listening], [true, 'pyn_bot', 'https://t.me/pyn_bot?start=KOD12345', true]);
  const kept = fs.readFileSync(path.join(app.getPath('userData'), 'telegram.json'), 'utf8');
  assert.ok(!kept.includes(KEY), 'never kept as it was given');
  assert.ok(!fs.readdirSync(vault).some((name) => fs.readFileSync(path.join(vault, name), 'utf8').includes(KEY)), 'nothing in the vault holds the key');

  await until(() => fs.existsSync(path.join(vault, 'dinle.pid')));
  const pid = Number(fs.readFileSync(path.join(vault, 'dinle.pid'), 'utf8'));
  assert.ok(alive(pid));
  assert.ok(asked(vault).includes('telegram dinle +anahtar'), 'the listener is given the key as its environment');
  const paired = await telegramStatus();
  assert.deepEqual([paired.paired, paired.person, paired.captured, paired.voiceNotes], [true, 'Tolga', 3, true]);

  const again = await pairTelegramAgain();
  assert.deepEqual([again.paired, again.link], [false, 'https://t.me/pyn_bot?start=KOD12345']);
  assert.ok(asked(vault).includes('telegram kur --yeniden-esle +anahtar'));

  const gone = await disconnectTelegram();
  await until(() => !alive(pid));
  assert.equal(gone.key, false);
  assert.equal(gone.bot, null);
  assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'telegram.json')), false);
  assert.ok(asked(vault).includes('telegram kaldir +anahtar'));
});

test('a key Telegram does not know is said in the engine’s words and not kept', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  fs.rmSync(path.join(app.getPath('userData'), 'telegram.json'), { force: true });
  await assert.rejects(connectTelegram(REFUSED), (err: Error) => err.message === 'Telegram bu anahtarı tanımadı.');
  assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'telegram.json')), false);
  assert.equal(fs.existsSync(path.join(vault, 'dinle.pid')), false, 'no listener for a refused key');
  await stopTelegram();
});

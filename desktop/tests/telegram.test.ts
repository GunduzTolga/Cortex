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
  restartTelegram,
  stopTelegram,
  telegramFolder,
  telegramListener,
  telegramOf,
  telegramStatus,
} from '../electron/services/telegram';
import { TELEGRAM_ERRORS, TELEGRAM_SENTENCES, telegramErrorOf } from '../shared/telegram';

/**
 * Notes from the phone through Telegram (electron/services/telegram.ts): the
 * key checked by the vault's engine and kept encrypted, the listener started
 * with it and stopped, the engine's status read for the window. The engine is
 * stood in for by a small beyin.py that answers `telegram` as the real one does,
 * keeping what it knows of the bot where the app names (BEYIN_TELEGRAM_DIR).
 */

const KEY = `123456789:${'A'.repeat(35)}`;
const REFUSED = `123456789:${'X'.repeat(35)}`;

const STAND_IN = String.raw`import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
args = [one for one in sys.argv[1:] if one != '--json']
key = os.environ.get('BEYIN_TELEGRAM_TOKEN', '')
folder = os.environ.get('BEYIN_TELEGRAM_DIR') or here
os.makedirs(folder, exist_ok=True)
with open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8') as log:
    log.write(' '.join(args) + (' +anahtar' if key == '123456789:' + 'A' * 35 else ' -anahtar' if not key else ' ?anahtar') + '\n')
with open(os.path.join(here, 'klasor.log'), 'a', encoding='utf-8') as log:
    log.write(os.environ.get('BEYIN_TELEGRAM_DIR', '-') + '\n')
kept = os.path.join(folder, 'tg.json')
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
        open(os.path.join(here, 'kur.zaman'), 'w').write(repr(time.time()))
    keep()
    print(json.dumps(dict(status(), status='kuruldu')))
elif args[:2] == ['telegram', 'dinle']:
    if not seen['bot']:
        # Not set up: an engine from before the status says so on stderr, as Python's error, one from after in its result.
        if os.path.exists(os.path.join(here, 'eski-motor')):
            print(json.dumps({'error': 'ValueError', 'message': 'Telegram kurulmamış. Önce: beyin.py telegram kur'}), file=sys.stderr)
            sys.exit(1)
        print(json.dumps({'status': 'kurulmamis'}))
        sys.exit(3)
    open(os.path.join(here, 'dinle.pid'), 'w').write(str(os.getpid()))
    seen['eslesti'] = True
    keep()
    for beat in range(300):  # a heartbeat while it runs: stopped, it stops
        open(os.path.join(here, 'dinle.nabiz'), 'w').write(str(beat))
        open(os.path.join(here, 'nabiz-%d' % os.getpid()), 'w').write(repr(time.time()))
        time.sleep(0.1)
elif args[:2] == ['telegram', 'kaldir']:
    if os.path.exists(kept):
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

/**
 * Whether the stand-in listener has stopped: its heartbeat unchanged for a second. Its PID cannot
 * say so on Windows, where a number freed is soon another process's (the test files run side by
 * side): a listener that was ended was still "alive" now and then.
 */
async function stopsBeating(vault: string, ms = 10_000): Promise<void> {
  const file = path.join(vault, 'dinle.nabiz');
  const beat = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const end = Date.now() + ms;
  let last = beat();
  let since = Date.now();
  while (Date.now() - since < 1_000) {
    if (Date.now() > end) throw new Error('still beating');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = beat();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}

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
    { key: true, supported: true, bot: 'pyn_bot', paired: false, person: null, link: 'https://t.me/pyn_bot?start=K', code: 'K', listening: true, error: null, errorCode: null, captured: 2, voiceNotes: false },
  );
  const none = telegramOf(null, false);
  assert.equal(none.supported, false);
  assert.equal(none.bot, null);
});

test('what went wrong is said in the window’s language: by the engine’s code, or by an older engine’s words (pyn-telegram-jev-8)', () => {
  const refused = { bot: 'pyn_bot', eslesti: true, son_hata: "Telegram anahtarı geçersiz; Ayarlar → Telegram'dan yeniden gir.", son_hata_kod: 'anahtar_gecersiz' };
  assert.deepEqual([telegramOf(refused, true, 'tr').error, telegramOf(refused, true, 'tr').errorCode], [refused.son_hata, 'anahtar_gecersiz'], 'a Turkish window keeps the engine’s own sentence');
  assert.equal(telegramOf(refused, true, 'en').error, TELEGRAM_SENTENCES.anahtar_gecersiz.en);
  // An engine from before the codes: known by its words.
  const older = { bot: 'pyn_bot', eslesti: true, son_hata: 'Bağlantı yok: timed out' };
  assert.deepEqual([telegramOf(older, true, 'en').errorCode, telegramOf(older, true, 'en').error], ['baglanti', TELEGRAM_SENTENCES.baglanti.en]);
  assert.equal(telegramOf(older, true, 'tr').error, 'Bağlantı yok: timed out');
  assert.equal(telegramErrorOf('Bu bot başka bir yerde de dinleniyor; Cortex için ayrı bir bot kullan.'), 'cakisma');
  assert.equal(telegramErrorOf('Telegram: Too Many Requests'), 'telegram');
  assert.equal(telegramErrorOf('Telegram kurulmamış. Önce: beyin.py telegram kur'), 'kurulmamis');
  assert.equal(telegramErrorOf('anything', 'webhook'), 'webhook', 'the engine’s code first');
  assert.equal(telegramErrorOf('anything', 'not-a-code'), null);
  // Something the window does not know is said as the engine said it, in either language.
  const unknown = { bot: 'pyn_bot', son_hata: 'Beklenmeyen bir şey.' };
  assert.deepEqual([telegramOf(unknown, true, 'en').error, telegramOf(unknown, true, 'en').errorCode], ['Beklenmeyen bir şey.', null]);
  for (const code of TELEGRAM_ERRORS) assert.ok(TELEGRAM_SENTENCES[code].tr && TELEGRAM_SENTENCES[code].en, code);
});

test('what the engine refused with is its own sentence, not its JSON; in an English window, in English', () => {
  assert.equal(engineSentence(new Error('{"error": "ValueError", "message": "Telegram bu anahtarı tanımadı."}')), 'Telegram bu anahtarı tanımadı.');
  assert.equal(engineSentence(new Error('Çıkış kodu 1.')), 'Çıkış kodu 1.');
  updateSettings((settings) => {
    settings.language = 'en';
  });
  try {
    assert.equal(engineSentence(new Error('{"error": "ValueError", "message": "Telegram bu anahtarı tanımadı."}')), TELEGRAM_SENTENCES.anahtar_gecersiz.en);
    assert.equal(engineSentence(new Error('{"error": "ValueError", "message": "Başka bir şey.", "code": "webhook"}')), TELEGRAM_SENTENCES.webhook.en);
  } finally {
    updateSettings((settings) => {
      settings.language = null;
    });
  }
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
  // The listener was stopped before the new link was written, and started again after it (pyn-telegram-jev-2): left
  // running, it wrote the old pairing back over the new one within its round.
  await until(() => fs.existsSync(path.join(vault, 'dinle.pid')) && Number(fs.readFileSync(path.join(vault, 'dinle.pid'), 'utf8')) !== pid);
  const lastBeat = Number(fs.readFileSync(path.join(vault, `nabiz-${pid}`), 'utf8'));
  const written = Number(fs.readFileSync(path.join(vault, 'kur.zaman'), 'utf8'));
  assert.ok(lastBeat < written, 'no listener ran while the pairing was written');
  assert.equal(telegramListener(), 'running');

  const gone = await disconnectTelegram();
  await stopsBeating(vault);
  assert.equal(gone.key, false);
  assert.equal(gone.bot, null);
  assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'telegram.json')), false);
  assert.ok(asked(vault).includes('telegram kaldir +anahtar'));
});

test('a new key while paired keeps the pairing; one refused leaves the listener running with the key kept', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  fs.rmSync(telegramFolder(), { recursive: true, force: true });
  await connectTelegram(KEY);
  await until(() => fs.existsSync(path.join(vault, 'dinle.pid')));
  await until(() => telegramListener() === 'running');
  const paired = await telegramStatus();
  assert.equal(paired.paired, true);
  // The same bot's key again (one renewed at @BotFather): still paired (pyn-telegram-jev-7).
  const renewed = await connectTelegram(KEY);
  assert.deepEqual([renewed.paired, renewed.bot, renewed.listening], [true, 'pyn_bot', true]);
  // A key Telegram refuses: said, and the listener started again with the key that works.
  await assert.rejects(connectTelegram(REFUSED), /tanımadı/);
  assert.equal(telegramListener(), 'running');
  assert.equal((await telegramStatus()).paired, true);
  await disconnectTelegram();
  await stopsBeating(vault);
});

test('Telegram is kept in the app’s folder, not the vault’s: another vault chosen, it is still paired and listening (pyn-telegram-jev-3)', { skip: !hasPython }, async () => {
  const first = vaultWithEngine();
  fs.rmSync(telegramFolder(), { recursive: true, force: true });
  await connectTelegram(KEY);
  await until(() => fs.existsSync(path.join(first, 'dinle.pid')));
  const second = vaultWithEngine();
  await restartTelegram(); // as electron/ipc.ts does once another vault is chosen
  await until(() => fs.existsSync(path.join(second, 'dinle.pid')));
  const status = await telegramStatus();
  assert.deepEqual([status.key, status.bot, status.paired], [true, 'pyn_bot', true]);
  const folders = [first, second].flatMap((vault) => fs.readFileSync(path.join(vault, 'klasor.log'), 'utf8').trim().split(/\r?\n/));
  assert.ok(folders.length >= 4 && folders.every((one) => one === telegramFolder()), 'every command and the listener, in either vault, are given the app’s folder');
  assert.ok(fs.existsSync(path.join(telegramFolder(), 'tg.json')));
  await disconnectTelegram();
  await stopsBeating(second);
});

test('a listener that ends because Telegram is not set up is not started again and again', { skip: !hasPython }, async () => {
  for (const older of [false, true]) {
    const vault = vaultWithEngine();
    fs.rmSync(telegramFolder(), { recursive: true, force: true });
    if (older) fs.writeFileSync(path.join(vault, 'eski-motor'), '');
    // A key kept from before (an engine that kept Telegram in another vault's state): the listener is started with it.
    await connectTelegram(KEY);
    await until(() => telegramListener() === 'running');
    await stopTelegram();
    fs.rmSync(path.join(telegramFolder(), 'tg.json'), { force: true });
    await restartTelegram();
    await until(() => telegramListener() !== 'running');
    assert.equal(telegramListener(), 'off', older ? 'an engine from before the status: known by its words' : 'the engine says so');
    const status = await telegramStatus();
    assert.deepEqual([status.key, status.bot], [true, null], 'the settings ask for the key, which sets it up');
  }
  await disconnectTelegram();
});

test('a key Telegram does not know is said in the engine’s words and not kept', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine();
  fs.rmSync(path.join(app.getPath('userData'), 'telegram.json'), { force: true });
  await assert.rejects(connectTelegram(REFUSED), (err: Error) => err.message === 'Telegram bu anahtarı tanımadı.');
  assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'telegram.json')), false);
  assert.equal(fs.existsSync(path.join(vault, 'dinle.pid')), false, 'no listener for a refused key');
  await stopTelegram();
});

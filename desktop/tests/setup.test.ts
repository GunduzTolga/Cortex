import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SetupPush } from '../shared/setup';
import { pythonOf } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';
import {
  bundledPackage,
  compareVersions,
  engineStep,
  PYTHON_INSTALL_ARGS,
  installEngine,
  installPython,
  installVoice,
  installedVersion,
  onSetupPush,
  onVoiceStatus,
  readLine,
  setVoice,
  commandsPatch,
  setupStatus,
  trailingObject,
  voiceOf,
} from '../electron/services/setup';

/**
 * Cortex set up from the app (electron/services/setup.ts): the engine that
 * came with it installed or updated in the vault, voice typing set up, each
 * step passed on as the engine says it. The vault's engine is stood in for by
 * a small beyin.py that answers its commands as the real one does.
 */

test('versions are compared part by part, 1.0.10 after 1.0.9', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.9', '1.0.9'), 0);
  assert.equal(compareVersions('0.9.12', '1.0.0'), -1);
});

test('the package is the newest one in the first folder that has one; other files are not it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paket-'));
  const [none, first, second] = ['yok', 'bir', 'iki'].map((name) => path.join(root, name));
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  for (const name of ['beyin-v3-1.0.9.zip', 'beyin-v3-1.0.10.zip', 'beyin-v3-1.0.10.zip.sha256', 'beyin-v3-latest.zip']) fs.writeFileSync(path.join(first, name), '');
  fs.writeFileSync(path.join(second, 'beyin-v3-9.9.9.zip'), '');
  assert.deepEqual(bundledPackage([none, first, second]), { file: path.join(first, 'beyin-v3-1.0.10.zip'), version: '1.0.10' });
  assert.equal(bundledPackage([none]), null);
});

test('what a job says is read line by line: steps, then its result, written on one line or several', () => {
  assert.deepEqual(readLine('{"adim": "Motor: işlemci"}'), { step: 'Motor: işlemci' });
  assert.deepEqual(readLine('{"status": "kuruldu"}'), { result: { status: 'kuruldu' } });
  assert.equal(readLine('Cortex güncelleniyor (vault: C:\\Kasa)…'), null);
  assert.equal(readLine('[1, 2]'), null);
  assert.deepEqual(trailingObject('Cortex güncelleniyor…\n{\n  "status": "updated",\n  "version": "1.0.9"\n}\n'), { status: 'updated', version: '1.0.9' });
  assert.equal(trailingObject('bitti'), null);
});

test('the voice status is the engine’s, the model by its name only', () => {
  assert.deepEqual(voiceOf({ kurulu: true, acik: true, uyandirma: false, otomatik_dinle: false, motor: 'vulkan', model: 'large-v3-turbo (ekran kartı, Vulkan)' }), {
    installed: true,
    on: true,
    wake: false,
    auto: false,
    engine: 'vulkan',
    model: 'large-v3-turbo',
    commands: null,
    wakePhrase: 'pyn not al',
    readsFiles: true,
  });
  assert.equal(voiceOf({ kurulu: true, dosya_okur: false })?.readsFiles, false, 'a whisper.cpp setup that cannot open a voice note yet');
  assert.equal(voiceOf({ kurulu: true, uyandirma_sozu: 'hey pyn' })?.wakePhrase, 'hey pyn');
  assert.equal(voiceOf({ kurulu: true, uyandirma_sozu: 'ikisi' })?.wakePhrase, 'ikisi', 'both at once');
  assert.equal(voiceOf({ kurulu: true, uyandirma_sozu: 'merhaba' })?.wakePhrase, 'pyn not al', 'only a phrase there is');
  assert.equal(voiceOf({ kurulu: false, motor: 'bilinmeyen' })?.engine, 'islemci');
  assert.equal(voiceOf({ status: 'tamam' }), null, 'not a voice status');
});

test('the spoken commands are the engine’s, and what a window asks is tidied before the engine checks it', () => {
  const said = { kaydet: ['kaydet'], sil: ['sil', 'hepsini sil'], kelime_sil: ['son kelimeyi sil'], cumle_sil: [], iptal: ['iptal', 3] };
  assert.deepEqual(voiceOf({ kurulu: true, komutlar: said, adla_kaydet: ['gönder'] })?.commands, {
    kaydet: ['kaydet'],
    adla_kaydet: ['gönder'],
    resim_ekle: [],
    kelime_sil: ['son kelimeyi sil'],
    cumle_sil: [],
    sil: ['sil', 'hepsini sil'],
    iptal: ['iptal'],
  });
  assert.deepEqual(commandsPatch({ kaydet: ['  kaydet ', '', 'tamam   dır'], uydurma: ['x'], sil: 'sil' }), { kaydet: ['kaydet', 'tamam dır'] });
  assert.deepEqual(commandsPatch({ iptal: Array.from({ length: 12 }, (_, i) => 'söz ' + i) })?.iptal?.length, 8);
  assert.equal(commandsPatch({}), null);
  assert.equal(commandsPatch(['kaydet']), null);
});

/** The vault's engine stood in for: it keeps what it was asked in a log, and answers as beyin.py does. */
const STAND_IN = String.raw`
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8') as log:
    log.write(' '.join(args) + '\n')
state = os.path.join(here, 'durum.json')
seen = json.load(open(state, encoding='utf-8')) if os.path.exists(state) else {'yakala': False, 'ses': False, 'acik': True, 'uyandirma': False}
def keep():
    json.dump(seen, open(state, 'w', encoding='utf-8'))
def say(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
if args[:2] == ['yakala', 'durum']:
    say({'status': 'tamam', 'kurulu': seen['yakala']})
elif args[:2] == ['yakala', 'kur']:
    seen['yakala'] = True; keep()
    print(json.dumps({'status': 'kuruldu'}, indent=2))
elif args[:2] == ['ses', 'durum']:
    say({'kurulu': seen['ses'], 'acik': seen['acik'], 'uyandirma': seen['uyandirma'], 'motor': 'vulkan', 'model': 'large-v3-turbo (ekran kartı, Vulkan)'})
elif args[:2] == ['ses', 'kur']:
    for step in ('Motor: AMD/Intel ekran kartı (Vulkan, whisper.cpp)', 'whisper.cpp modeli indiriliyor (yaklaşık 1,6 GB)…', '  %50 (812 / 1624 MB)', '  %100 (1624 / 1624 MB)'):
        say({'adim': step})
    seen['ses'] = True; keep()
    say({'status': 'kuruldu', 'motor': 'vulkan'})
elif args[:2] == ['ses', 'ayar']:
    if '--uyandirma' in args: seen['uyandirma'] = args[args.index('--uyandirma') + 1] == 'ac'
    if '--ses' in args: seen['acik'] = args[args.index('--ses') + 1] == 'ac'
    keep()
    say({'status': 'kaydedildi', 'kurulu': seen['ses']})
elif args[:1] == ['update']:
    package = args[args.index('--package') + 1]
    version = os.path.basename(package)[len('beyin-v3-'):-len('.zip')]
    open(os.path.join(here, '.beyin-version'), 'w', encoding='utf-8').write(version + '\n')
    print('Cortex güncelleniyor…')
    print(json.dumps({'status': 'updated', 'version': version}, indent=2))
else:
    print('bilinmeyen komut', file=sys.stderr)
    sys.exit(2)
`;

function vaultWithEngine(version: string): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-kurulum-'));
  fs.writeFileSync(path.join(vault, 'beyin.py'), STAND_IN);
  fs.writeFileSync(path.join(vault, '.beyin-version'), `${version}\n`);
  updateSettings((settings) => {
    settings.vault = vault;
  });
  return vault;
}

const asked = (vault: string) => fs.readFileSync(path.join(vault, 'istenen.log'), 'utf8').trim().split(/\r?\n/);
const hasPython = pythonOf() !== null;

test('voice typing is set up from the app: yakala first if it is not, then the engine’s steps as they come', { skip: !hasPython || process.platform !== 'win32' }, async () => {
  const vault = vaultWithEngine('1.0.9');
  const pushes: SetupPush[] = [];
  onSetupPush((one) => pushes.push(one));
  const before = await setupStatus();
  assert.equal(before.engine.installed, '1.0.9');
  assert.equal(before.voice?.installed, false);
  const after = await installVoice();
  assert.equal(after.voice?.installed, true);
  assert.equal(after.job, null);
  assert.deepEqual(
    pushes.filter((one): one is { job: 'voice'; step: string } => 'step' in one).map((one) => one.step),
    ['Yakala kuruluyor (Ctrl+Alt+C)…', 'Motor: AMD/Intel ekran kartı (Vulkan, whisper.cpp)', 'whisper.cpp modeli indiriliyor (yaklaşık 1,6 GB)…', '%50 (812 / 1624 MB)', '%100 (1624 / 1624 MB)'],
  );
  assert.deepEqual(pushes[pushes.length - 1], { job: 'voice', done: true, ok: true });
  // The status asked before and after aside: what the job itself ran, in order.
  assert.deepEqual(
    asked(vault).filter((one) => one !== 'ses durum'),
    ['yakala durum', 'yakala kur', 'ses kur'],
  );
  // Listening all the time only once the person allowed it in the app (src/ui/MicConsent.tsx): refused before, the engine not asked.
  await assert.rejects(setVoice({ wake: true }), /önce izin ver|first/);
  assert.ok(!asked(vault).includes('ses ayar --uyandirma ac'));
  updateSettings((settings) => {
    settings.wakeConsent = true;
  });
  // The wake phrase on, from the switch: the engine's own setting command; the icon at the bottom right hears of it.
  const heard: Array<boolean | undefined> = [];
  const stop = onVoiceStatus((voice) => heard.push(voice?.wake));
  const woken = await setVoice({ wake: true });
  stop();
  assert.equal(woken.voice?.wake, true);
  assert.deepEqual(heard, [true], 'told once, of the change');
  assert.ok(asked(vault).includes('ses ayar --uyandirma ac'));
  // A command's words, and every command back to its first words.
  await setVoice({ commands: { kaydet: ['kaydet', 'tamam'] } });
  assert.ok(asked(vault).includes('ses ayar --komutlar {"kaydet":["kaydet","tamam"]}'));
  await setVoice({ defaultCommands: true });
  assert.ok(asked(vault).includes('ses ayar --varsayilan-komutlar'));
  await setVoice({ wakePhrase: 'hey pyn' });
  assert.ok(asked(vault).includes('ses ayar --uyandirma-sozu hey pyn'));
});

test('a job that fails says why, and the next one may start', { skip: !hasPython || process.platform !== 'win32' }, async () => {
  const vault = vaultWithEngine('1.0.9');
  fs.writeFileSync(path.join(vault, 'beyin.py'), "import sys\nprint('Paketler yüklenemedi: ağ yok', file=sys.stderr)\nsys.exit(1)\n");
  const pushes: SetupPush[] = [];
  onSetupPush((one) => pushes.push(one));
  await assert.rejects(installVoice(), /ağ yok/);
  assert.deepEqual(pushes[pushes.length - 1], { job: 'voice', done: true, ok: false, error: 'Paketler yüklenemedi: ağ yok' });
  assert.equal((await setupStatus()).job, null, 'nothing is left marked as going on');
});

test('an older engine is updated from the package that came with the app, its result read over several lines', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine('1.0.8');
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), 'paket-'));
  fs.writeFileSync(path.join(packages, 'beyin-v3-1.0.9.zip'), '');
  process.env.CORTEX_ENGINE_PACKAGES = packages;
  try {
    assert.deepEqual((await setupStatus()).engine, { installed: '1.0.8', bundled: '1.0.9' });
    const after = await installEngine();
    assert.equal(after.engine.installed, '1.0.9');
    assert.ok(asked(vault).includes(`update --package ${path.join(packages, 'beyin-v3-1.0.9.zip')}`));
  } finally {
    delete process.env.CORTEX_ENGINE_PACKAGES;
  }
});

test('a vault without an engine gets one by the package’s own installer, taken apart outside the vault', { skip: !hasPython }, async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-bos-'));
  fs.writeFileSync(path.join(vault, 'Not.md'), '# Not\n');
  updateSettings((settings) => {
    settings.vault = vault;
  });
  assert.equal(installedVersion(vault), null);
  // A package whose installer writes the engine and its stamp into --vault, as install_v3.py does.
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), 'paket-'));
  const installer = "import json, sys, pathlib\nvault = pathlib.Path(sys.argv[sys.argv.index('--vault') + 1])\n(vault / 'beyin.py').write_text('', encoding='utf-8')\n(vault / '.beyin-version').write_text('1.0.9\\n', encoding='utf-8')\nprint(json.dumps({'status': 'installed'}))\n";
  const python = pythonOf();
  assert.ok(python);
  const made = spawnSync(python.command, [
    ...python.args,
    '-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("scripts/install_v3.py", sys.argv[2])',
    path.join(packages, 'beyin-v3-1.0.9.zip'),
    installer,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  process.env.CORTEX_ENGINE_PACKAGES = packages;
  try {
    const after = await installEngine();
    assert.equal(after.engine.installed, '1.0.9');
    assert.equal(fs.readFileSync(path.join(vault, 'Not.md'), 'utf8'), '# Not\n', 'the notes are not touched');
    assert.deepEqual(fs.readdirSync(vault).sort(), ['.beyin-version', 'Not.md', 'beyin.py'], 'nothing of the package is left in the vault');
  } finally {
    delete process.env.CORTEX_ENGINE_PACKAGES;
  }
});

test('the Python that came with the app is run only as python.org signed it: a file that is not it is refused unrun', { skip: process.platform !== 'win32' }, async () => {
  const installers = fs.mkdtempSync(path.join(os.tmpdir(), 'python-paket-'));
  // Named as the pinned installer, but not it: a script that would leave a mark if it ever ran.
  const mark = path.join(installers, 'calisti.txt');
  fs.writeFileSync(path.join(installers, 'python-3.12.10-amd64.exe'), `echo ran > "${mark}"`);
  const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, BEYIN_PYTHON: process.env.BEYIN_PYTHON };
  // A machine without Python, as this one is made to look.
  process.env.PATH = installers;
  process.env.LOCALAPPDATA = installers;
  delete process.env.BEYIN_PYTHON;
  process.env.CORTEX_PYTHON_INSTALLERS = installers;
  const pushes: SetupPush[] = [];
  onSetupPush((one) => pushes.push(one));
  try {
    const before = await setupStatus();
    assert.equal(before.python, false);
    assert.equal(before.pythonBundled, '3.12.10');
    await assert.rejects(installPython(), /SHA-256/);
    assert.equal(fs.existsSync(mark), false, 'never run');
    assert.deepEqual(pushes.filter((one) => 'step' in one).length, 1, 'checked, and stopped there');
  } finally {
    Object.assign(process.env, saved);
    if (saved.BEYIN_PYTHON === undefined) delete process.env.BEYIN_PYTHON;
    delete process.env.CORTEX_PYTHON_INSTALLERS;
  }
  assert.ok(PYTHON_INSTALL_ARGS.includes('InstallAllUsers=0') && PYTHON_INSTALL_ARGS.includes('PrependPath=0'), 'for this user only, the PATH left alone');
});

test('the engine’s Turkish steps are said in English in an English window, the numbers kept, and left alone in Turkish', () => {
  assert.equal(engineStep('  %50 (812 / 1624 MB)', 'en'), '50% (812 / 1624 MB)');
  assert.equal(engineStep('Motor: AMD/Intel ekran kartı (Vulkan, whisper.cpp)', 'en'), 'Engine: AMD / Intel graphics card (Vulkan, whisper.cpp)');
  assert.equal(engineStep('whisper.cpp modeli indiriliyor (yaklaşık 1,6 GB)…', 'en'), 'Downloading the whisper.cpp model (about 1.6 GB)…');
  assert.equal(engineStep('  %50 (812 / 1624 MB)', 'tr'), '%50 (812 / 1624 MB)');
  assert.equal(engineStep('Bilinmeyen bir satır', 'en'), 'Bilinmeyen bir satır', 'an unknown line as it was');
});

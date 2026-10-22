import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENGINE_SENTENCES } from '../shared/engineError';
import { engineAction, type SetupPush } from '../shared/setup';
import { pythonOf } from '../electron/services/localChat';
import { updateSettings } from '../electron/services/settings';
import {
  bundledPackage,
  compareVersions,
  EngineFailure,
  engineStep,
  PYTHON_INSTALL_ARGS,
  installEngine,
  installPython,
  installVoice,
  installedNameOf,
  installedVersion,
  isPredecessor,
  onSetupPush,
  onVoiceStatus,
  readLine,
  runPython,
  setBusyWaits,
  setVoice,
  settleVault,
  setupBusy,
  commandsPatch,
  setupStatus,
  staleAgainst,
  trailingObject,
  vaultSettled,
  voiceOf,
  whenSetupIdle,
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
    cpuModel: null,
  });
  assert.equal(voiceOf({ kurulu: true, dosya_okur: false })?.readsFiles, false, 'a whisper.cpp setup that cannot open a voice note yet');
  // On the processor, the model it writes with is a choice: quick, or accurate and slow there.
  assert.equal(voiceOf({ kurulu: true, motor: 'islemci', islemci_modeli: 'small' })?.cpuModel, 'small');
  assert.equal(voiceOf({ kurulu: true, motor: 'islemci', islemci_modeli: 'large-v3-turbo' })?.cpuModel, 'large-v3-turbo');
  assert.equal(voiceOf({ kurulu: true, motor: 'islemci', islemci_modeli: 'medium' })?.cpuModel, null, 'only a choice the app offers');
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
    # Told how to fail by a file beside it: busy the first time, or an engine left half written.
    failing = os.path.join(here, 'guncelleme-hatasi.json')
    if os.path.exists(failing):
        said = json.load(open(failing, encoding='utf-8'))
        if said.pop('bir_kez', False): os.remove(failing)
        print(json.dumps(said), file=sys.stderr)
        sys.exit(1)
    package = args[args.index('--package') + 1]
    version = os.path.basename(package)[len('beyin-v3-'):-len('.zip')]
    open(os.path.join(here, '.beyin-version'), 'w', encoding='utf-8').write(version + '\n')
    print('Cortex güncelleniyor…')
    print(json.dumps({'status': 'updated', 'version': version}, indent=2))
elif args[:1] == ['relocate']:
    failing = os.path.join(here, 'tasima-hatasi.json')
    if os.path.exists(failing):
        print(json.dumps(json.load(open(failing, encoding='utf-8'))), file=sys.stderr)
        sys.exit(1)
    if os.path.exists(os.path.join(here, 'eski-motor')):
        # An engine from before relocate: argparse refuses the command, as beyin_v3_cli does.
        print("usage: beyin.py [-h] {init,sync,doctor} ...", file=sys.stderr)
        print("beyin.py: error: argument command: invalid choice: 'relocate'", file=sys.stderr)
        sys.exit(2)
    say({'status': 'unchanged', 'vault': here, 'state': os.path.join(here, 'durum')})
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
  // As the engine ends a failure: one JSON line on stderr, its Turkish letters escaped (beyin_entry.py).
  fs.writeFileSync(path.join(vault, 'beyin.py'), "import json, sys\nprint(json.dumps({'error': 'RuntimeError', 'message': 'Paketler yüklenemedi: ağ yok'}), file=sys.stderr)\nsys.exit(1)\n");
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
    assert.deepEqual((await setupStatus()).engine, { installed: '1.0.8', bundled: '1.0.9', legacy: false, stale: false });
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
  // What the processor downloads is said as it is: the quick model and its checker, or the large one.
  assert.equal(engineStep('Whisper modeli hazırlanıyor (ilk seferde yaklaşık 0,7 GB iner)…', 'en'), 'Preparing the Whisper model (about 0.7 GB the first time)…');
  assert.equal(engineStep('Whisper modeli hazırlanıyor (ilk seferde yaklaşık 1,6 GB iner)…', 'en'), 'Preparing the Whisper model (about 1.6 GB the first time)…');
  assert.equal(engineStep('  %50 (812 / 1624 MB)', 'tr'), '%50 (812 / 1624 MB)');
  assert.equal(engineStep('Bilinmeyen bir satır', 'en'), 'Bilinmeyen bir satır', 'an unknown line as it was');
});

/* ------------------------------------------------------------------ */
/* What the setup says, and what it does about the engine it finds     */
/* ------------------------------------------------------------------ */

/** A script for the system's Python, in a folder of its own. */
function script(text: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betik-'));
  const file = path.join(dir, 'betik.py');
  fs.writeFileSync(file, text);
  return { dir, file };
}

const language = (value: 'tr' | 'en' | null) =>
  updateSettings((settings) => {
    settings.language = value;
  });

test('a failure is said as the engine’s sentence: its JSON line read whole, its letters back, never the JSON', { skip: !hasPython }, async () => {
  // As beyin.py ends a failure: json.dumps with every Turkish letter escaped; long, as pip's tail makes it.
  const long = script("import json, sys\nprint('Uyari: once bir uyari', file=sys.stderr)\nprint(json.dumps({'error': 'RuntimeError', 'message': 'Paketler yüklenemedi: ' + 'ş' * 600}), file=sys.stderr)\nsys.exit(1)\n");
  await assert.rejects(runPython([long.file], { cwd: long.dir, timeout: 30_000 }), (err: unknown) => {
    assert.ok(err instanceof EngineFailure);
    assert.ok(err.message.startsWith('Paketler yüklenemedi: şşş'), err.message.slice(0, 80));
    assert.ok(err.message.length <= 400);
    assert.doesNotMatch(err.message, /\\u|[{}"]/);
    assert.equal(err.exitCode, 1);
    return true;
  });
  // An engine from before the codes, busy: known by its words, said in the window's language, its code kept for the setup to act on.
  const busy = script("import json, sys\nprint(json.dumps({'error': 'ValueError', 'message': 'runtime/updater busy; retry after active work finishes'}), file=sys.stderr)\nsys.exit(1)\n");
  await assert.rejects(runPython([busy.file], { cwd: busy.dir, timeout: 30_000 }), (err: unknown) => err instanceof EngineFailure && err.code === 'updater_busy' && err.message === ENGINE_SENTENCES.updater_busy.tr);
  language('en');
  try {
    await assert.rejects(runPython([busy.file], { cwd: busy.dir, timeout: 30_000 }), { message: ENGINE_SENTENCES.updater_busy.en });
    // Its own sentences too, in an English window: a run that ended without an answer, and one stopped for taking too long.
    const silent = script('pass\n');
    await assert.rejects(runPython([silent.file], { cwd: silent.dir, timeout: 30_000 }), { message: 'The answer that was expected did not come.' });
    const slow = script('import time\ntime.sleep(30)\n');
    await assert.rejects(runPython([slow.file], { cwd: slow.dir, timeout: 300 }), { message: 'It took too long and was stopped.' });
  } finally {
    language(null);
  }
});

/** A stand-in Python on a PATH of its own: a shell script that says this version. */
function pythonSaying(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-'));
  fs.writeFileSync(path.join(dir, 'python3'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return dir;
}

test('a Python too old for the engine is no Python: the status names it, and no engine job starts on it', { skip: process.platform === 'win32' }, async () => {
  vaultWithEngine('1.0.9');
  const saved = { PATH: process.env.PATH, BEYIN_PYTHON: process.env.BEYIN_PYTHON };
  process.env.PATH = pythonSaying('3.10');
  delete process.env.BEYIN_PYTHON;
  try {
    const status = await setupStatus();
    assert.equal(status.python, false);
    assert.equal(status.pythonWanting, '3.10');
    await assert.rejects(installEngine(), /Python bulunamadı/);
    assert.equal((await setupStatus()).job, null, 'nothing left marked as going on');
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.BEYIN_PYTHON !== undefined) process.env.BEYIN_PYTHON = saved.BEYIN_PYTHON;
  }
  assert.equal((await setupStatus()).pythonWanting, null, 'a fit Python found again: nothing said against it');
});

/**
 * A package as the app carries it: a zip whose installer stands in for install_v3.py - it notes how it was run,
 * finishes a journal left behind (and does only that, as the real one does), else writes the engine's stamp and its
 * record of what it wrote - and, beside it, its list of digests.
 */
const INSTALLER = String.raw`
import json, os, sys, pathlib
args = sys.argv[1:]
vault = pathlib.Path(args[args.index('--vault') + 1])
state = pathlib.Path(args[args.index('--state') + 1]) if '--state' in args else None
with open(vault / 'kurucu.log', 'a', encoding='utf-8') as log:
    log.write(' '.join(args) + '\n')
if state and (state / 'update-journal.json').exists():
    (state / 'update-journal.json').unlink()
    print(json.dumps({'status': 'recovered', 'install_resumed': True}))
    raise SystemExit(0)
if not (vault / 'beyin.py').exists():
    (vault / 'beyin.py').write_text('', encoding='utf-8')
(vault / '.beyin-version').write_text(VERSION + '\n', encoding='utf-8')
if state:
    (state / 'v3-install.json').write_text(json.dumps({'files': {'beyin.py': {'installed_hash': 'a' * 64}, '.claude/scripts/beyin_v3_ses.py': {'installed_hash': 'c' * 64}}}), encoding='utf-8')
print(json.dumps({'status': 'installed'}))
`;

function packageOf(version: string, digests?: Record<string, string>): string {
  const packages = fs.mkdtempSync(path.join(os.tmpdir(), 'paket-'));
  const python = pythonOf();
  assert.ok(python);
  const made = spawnSync(python.command, [
    ...python.args,
    '-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("scripts/install_v3.py", sys.argv[2])',
    path.join(packages, `beyin-v3-${version}.zip`),
    INSTALLER.replace('VERSION + ', `${JSON.stringify(version)} + `),
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  if (digests) fs.writeFileSync(path.join(packages, `beyin-v3-${version}.manifest.json`), JSON.stringify({ version, files: digests }));
  return packages;
}

/** The vault's state where its pin says, with what the installer last wrote. */
function pinState(vault: string, written?: Record<string, string>): string {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'durum-'));
  fs.writeFileSync(path.join(vault, '.beyin-runtime.json'), JSON.stringify({ state, schema: 1 }));
  if (written) {
    const files = Object.fromEntries(Object.entries(written).map(([name, hash]) => [name, { installed_hash: hash, installed_content: '' }]));
    fs.writeFileSync(path.join(state, 'v3-install.json'), JSON.stringify({ files }));
  }
  return state;
}

const installerRuns = (vault: string) => (fs.existsSync(path.join(vault, 'kurucu.log')) ? fs.readFileSync(path.join(vault, 'kurucu.log'), 'utf8').trim().split(/\r?\n/) : []);

async function withPackages<T>(packages: string, work: () => Promise<T>): Promise<T> {
  process.env.CORTEX_ENGINE_PACKAGES = packages;
  try {
    return await work();
  } finally {
    delete process.env.CORTEX_ENGINE_PACKAGES;
  }
}

test('the package’s files are held to what the vault’s installer last wrote, each where it goes in the vault', () => {
  assert.equal(installedNameOf('scripts/beyin_entry.py'), 'beyin.py');
  assert.equal(installedNameOf('scripts/beyin_v3.py'), '.claude/scripts/beyin_v3_cli.py');
  assert.equal(installedNameOf('template/.claude/scripts/beyin_v3_ses.py'), '.claude/scripts/beyin_v3_ses.py');
  assert.equal(installedNameOf('scripts/install_v3.py'), null, 'the installer stays in the package');
  const written = { 'beyin.py': { installed_hash: 'a' }, '.claude/scripts/beyin_v3_ses.py': { installed_hash: 'b' } };
  assert.equal(staleAgainst({ 'scripts/beyin_entry.py': 'a', 'template/.claude/scripts/beyin_v3_ses.py': 'b', 'scripts/install_v3.py': 'z' }, written), false);
  assert.equal(staleAgainst({ 'scripts/beyin_entry.py': 'a', 'template/.claude/scripts/beyin_v3_ses.py': 'B' }, written), true);
  // An adapter left out by the person was never written: it is no reason to install again.
  assert.equal(staleAgainst({ 'scripts/beyin_entry.py': 'a', 'template/.claude/scripts/beyin_v3_kiro.py': 'k' }, written), false);
});

test('an engine of the same version with other files is refreshed by the package’s own installer, the state it is pinned to kept', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine('1.0.9');
  const state = pinState(vault, { 'beyin.py': 'a'.repeat(64), '.claude/scripts/beyin_v3_ses.py': 'b'.repeat(64) });
  // The package of the same number, built later: its voice code is not the one the vault was given.
  const packages = packageOf('1.0.9', { 'scripts/beyin_entry.py': 'a'.repeat(64), 'template/.claude/scripts/beyin_v3_ses.py': 'c'.repeat(64) });
  await withPackages(packages, async () => {
    const before = await setupStatus();
    assert.deepEqual(before.engine, { installed: '1.0.9', bundled: '1.0.9', legacy: false, stale: true });
    assert.equal(engineAction(before.engine), 'refresh', 'offered, where a version alone said there was nothing to do');
    const after = await installEngine();
    assert.equal(after.engine.stale, false, 'what the installer wrote is now the package’s');
    assert.equal(engineAction(after.engine), null);
    assert.deepEqual(installerRuns(vault), [`--vault ${vault} --state ${state}`], 'the vault’s own state given, not a default one');
    assert.ok(!asked(vault).some((one) => one.startsWith('update')), 'not the updater, which takes the same version for nothing to do');
  });
});

test('the predecessor’s 3.x is moved to Cortex by the package’s installer, not taken for a newer Cortex', { skip: !hasPython }, async () => {
  assert.equal(isPredecessor('3.9.0', '1.0.32'), true);
  assert.equal(isPredecessor('2.3.0', '1.0.32'), true);
  assert.equal(isPredecessor('1.0.40', '1.0.32'), false, 'a newer Cortex is a newer Cortex');
  const vault = vaultWithEngine('3.9.0');
  const packages = packageOf('1.0.9');
  await withPackages(packages, async () => {
    const before = await setupStatus();
    assert.deepEqual(before.engine, { installed: '3.9.0', bundled: '1.0.9', legacy: true, stale: false });
    assert.equal(engineAction(before.engine), 'migrate');
    assert.equal(before.voice, null, 'its engine is not asked what it does not know');
    const after = await installEngine();
    assert.equal(after.engine.installed, '1.0.9');
    assert.equal(after.engine.legacy, false);
    assert.equal(installerRuns(vault).length, 1);
    assert.ok(!asked(vault).some((one) => one.startsWith('update')), 'its updater refuses Cortex: never asked');
  });
});

test('an engine busy with other work is asked again a little later, as it asks', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine('1.0.8');
  fs.writeFileSync(path.join(vault, 'guncelleme-hatasi.json'), JSON.stringify({ error: 'ValueError', message: 'runtime/updater busy; retry after active work finishes', bir_kez: true }));
  const packages = packageOf('1.0.9');
  const pushes: SetupPush[] = [];
  onSetupPush((one) => pushes.push(one));
  setBusyWaits([10, 10, 10]);
  try {
    const after = await withPackages(packages, () => installEngine());
    assert.equal(after.engine.installed, '1.0.9');
    assert.equal(asked(vault).filter((one) => one.startsWith('update')).length, 2);
    assert.ok(pushes.some((one) => 'step' in one && one.step === 'Cortex başka bir işi bitiriyor; birazdan yeniden deneniyor…'));
    assert.deepEqual(pushes[pushes.length - 1], { job: 'engine', done: true, ok: true });
  } finally {
    setBusyWaits([3_000, 6_000, 12_000]);
  }
});

test('an update left half done is finished by the package’s own installer, then installed, when every beyin.py fails on the half-written engine', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine('1.0.8');
  const state = pinState(vault);
  fs.writeFileSync(path.join(state, 'update-journal.json'), '{}');
  // The new entry against the old CLI: every command, update among them, fails the same way (install-update-5).
  fs.writeFileSync(path.join(vault, 'guncelleme-hatasi.json'), JSON.stringify({ error: 'AttributeError', message: "module 'beyin_installed_cli' has no attribute 'resolve_state'" }));
  const packages = packageOf('1.0.9');
  const after = await withPackages(packages, () => installEngine());
  assert.equal(after.engine.installed, '1.0.9');
  assert.equal(fs.existsSync(path.join(state, 'update-journal.json')), false, 'the journal finished');
  assert.deepEqual(installerRuns(vault), [`--vault ${vault} --state ${state}`, `--vault ${vault} --state ${state}`], 'the journal finished first, then the install');
});

test('a vault opened is bound to where it is now, once; a failure is said, and tried again at the next opening', { skip: !hasPython }, async () => {
  const bound = vaultWithEngine('1.0.9');
  assert.equal(await settleVault(), null);
  assert.equal(await settleVault(), null, 'opened again: the same answer');
  await vaultSettled();
  assert.equal(asked(bound).filter((one) => one === 'relocate').length, 1, 'bound once');
  // Moved, and the engine could not mend it: its own sentence is said (in a Turkish window, the engine's Turkish).
  const moved = vaultWithEngine('1.0.9');
  const sentence = 'Kasa taşınmış ama eski yerindeki durum klasörü okunamadı.';
  fs.writeFileSync(path.join(moved, 'tasima-hatasi.json'), JSON.stringify({ error: 'ValueError', message: sentence, code: 'vault_moved' }));
  assert.equal(await settleVault(), sentence);
  assert.equal(await settleVault(), sentence, 'tried again, not kept as the answer');
  assert.equal(asked(moved).filter((one) => one === 'relocate').length, 2);
  language('en');
  try {
    fs.rmSync(path.join(moved, 'tasima-hatasi.json'));
    fs.writeFileSync(path.join(moved, 'tasima-hatasi.json'), JSON.stringify({ error: 'ValueError', message: sentence, code: 'vault_moved' }));
    assert.equal(await settleVault(), ENGINE_SENTENCES.vault_moved.en);
  } finally {
    language(null);
  }
  // An engine from before relocate does not know it: left as it is, nothing said.
  const old = vaultWithEngine('1.0.9');
  fs.writeFileSync(path.join(old, 'eski-motor'), '');
  assert.equal(await settleVault(), null);
  // A vault without an engine, or a predecessor's: nothing to bind.
  const predecessor = vaultWithEngine('3.9.0');
  assert.equal(await settleVault(), null);
  assert.ok(!fs.existsSync(path.join(predecessor, 'istenen.log')), 'its engine not asked');
});

test('a job going on is known, and its end can be waited for: the app asked to quit when it is done quits then', { skip: !hasPython }, async () => {
  const vault = vaultWithEngine('1.0.8');
  const packages = packageOf('1.0.9');
  assert.equal(setupBusy(), null);
  await whenSetupIdle();
  process.env.CORTEX_ENGINE_PACKAGES = packages;
  try {
    const running = installEngine();
    assert.equal(setupBusy(), 'engine', 'from the moment it starts');
    let ended = false;
    const waited = whenSetupIdle().then(() => {
      ended = true;
      assert.equal(setupBusy(), null);
    });
    await running;
    await waited;
    assert.ok(ended);
    assert.equal(installedVersion(vault), '1.0.9');
  } finally {
    delete process.env.CORTEX_ENGINE_PACKAGES;
  }
});

"""Optional voice typing for yakala (beyin_v3_ses): words, install plan, helper protocol.

Offline and silent: nothing is installed, downloaded or recorded. The helper process is stood
in for by a small script that speaks the same protocol, and the installer's commands are
recorded instead of run.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_ses as ses  # noqa: E402
import beyin_v3_yakala as yakala  # noqa: E402


class WordsTest(unittest.TestCase):
    def test_the_wake_phrase_is_heard_however_the_name_is_spelled(self):
        for said in ('Pyn, not al', 'pyn not al.', 'pin not al', 'Pın not al', 'hey pen not al lütfen', 'PİN NOT AL'):
            self.assertTrue(ses.wake_heard(said), said)
        for said in ('not al', 'pyn not', 'bunu not alma', 'pyn notları aç', 'pin kodunu al'):
            self.assertFalse(ses.wake_heard(said), said)

    def test_kaydet_counts_at_the_end_sil_and_iptal_only_alone(self):
        self.assertEqual(ses.command_of('Toplantı notu, kaydet.'), ('kaydet', 'Toplantı notu'))
        self.assertEqual(ses.command_of('Kaydet'), ('kaydet', ''))
        self.assertEqual(ses.command_of('sil'), ('sil', ''))
        self.assertEqual(ses.command_of('Vazgeç.'), ('iptal', ''))
        self.assertEqual(ses.command_of('notu kaydettim'), (None, 'notu kaydettim'), 'a word that starts like a command is a word')
        self.assertEqual(ses.command_of('bu satırı sil'), (None, 'bu satırı sil'), 'sil inside a sentence is written')
        self.assertEqual(ses.command_of('   '), (None, ''))
        self.assertEqual(ses.command_of('Haftalık plan kaydı kaydet'), ('kaydet', 'Haftalık plan kaydı'))

    def test_what_is_said_goes_after_what_was_typed(self):
        self.assertEqual(yakala.with_spoken('', 'merhaba dünya'), 'merhaba dünya')
        self.assertEqual(yakala.with_spoken('Toplantı:', 'yarın onda'), 'Toplantı: yarın onda')
        self.assertEqual(yakala.with_spoken('aynı ', ''), 'aynı')


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-')
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'

    def test_settings_are_their_defaults_until_changed_and_unknown_keys_are_dropped(self):
        config = ses.load_config(self.state)
        self.assertFalse(config['uyandirma'], 'the wake word starts off')
        self.assertEqual(config['uyandirma_sozu'], 'pyn not al')
        (ses.ses_dir(self.state)).mkdir(parents=True)
        (ses.ses_dir(self.state) / ses.CONFIG).write_text(json.dumps({'uyandirma': True, 'yabanci': 1, 'komutlar': {'kaydet': ['tamam', 'kaydet']}}), encoding='utf-8')
        config = ses.load_config(self.state)
        self.assertTrue(config['uyandirma'])
        self.assertNotIn('yabanci', config)
        self.assertEqual(config['komutlar']['kaydet'], ['tamam', 'kaydet'])
        self.assertEqual(config['komutlar']['sil'], ['sil', 'temizle'], 'the other commands keep their words')
        self.assertFalse(ses.installed(self.state))
        self.assertFalse(ses.usable(self.state))

    def test_the_plan_picks_a_python_with_wheels_and_adds_cuda_only_with_an_nvidia_card(self):
        calls = []

        def run(command, **_options):
            calls.append(command)
            if command[:2] == ['py', '-3.12']:
                return subprocess.CompletedProcess(command, 1, '', 'not installed')
            if command[:2] == ['py', '-3.13']:
                return subprocess.CompletedProcess(command, 0, 'C:\\Python313\\python.exe\n', '')
            if command[0] == 'nvidia-smi':
                return subprocess.CompletedProcess(command, 0, 'GPU 0: RTX', '')
            return subprocess.CompletedProcess(command, 1, '', '')

        found = {'py': 'C:\\Windows\\py.exe', 'nvidia-smi': 'C:\\nvidia-smi.exe'}
        plan = ses.install_plan(self.state, which=found.get, run=run)
        if os.name == 'nt':
            self.assertEqual(plan['python'], 'C:\\Python313\\python.exe', '3.12 missing, 3.13 next')
        self.assertTrue(plan['ekran_karti'])
        self.assertIn('nvidia-cublas-cu12', plan['paketler'])
        self.assertTrue(plan['klasor'].endswith(ses.SES_DIR), 'everything under state/ses, outside the vault')
        self.assertEqual(plan['motor'], 'cuda')
        plan = ses.install_plan(self.state, which={'py': None}.get, run=run, system=self.tmp.name)
        self.assertFalse(plan['ekran_karti'])
        self.assertEqual(plan['motor'], 'islemci')
        self.assertNotIn('nvidia-cublas-cu12', plan['paketler'])
        self.assertIn('faster-whisper>=1.2', plan['paketler'])

    @unittest.skipUnless(os.name == 'nt', 'graphics cards are looked up the Windows way')
    def test_an_amd_or_intel_arc_card_with_vulkan_writes_with_whisper_cpp_and_integrated_intel_does_not(self):
        system = Path(self.tmp.name) / 'Windows'
        cards = []

        def run(command, **_options):
            if command[0] == 'powershell':
                return subprocess.CompletedProcess(command, 0, '\n'.join(cards) + '\n', '')
            return subprocess.CompletedProcess(command, 1, '', '')

        cards[:] = ['AMD Radeon(TM) Graphics', 'AMD Radeon RX 7800 XT']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'islemci', 'no Vulkan loader, no Vulkan')
        (system / 'System32').mkdir(parents=True)
        (system / 'System32' / 'vulkan-1.dll').write_bytes(b'')
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'vulkan')
        plan = ses.install_plan(self.state, which={}.get, run=run, system=system)
        self.assertEqual(plan['paketler'], list(ses.BASE_PACKAGES), 'whisper.cpp writes: no faster-whisper, no CUDA')
        cards[:] = ['Intel(R) Arc(TM) A770 Graphics']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'vulkan')
        cards[:] = ['Intel(R) UHD Graphics 770', 'Intel(R) Iris(R) Xe Graphics']
        self.assertEqual(ses.engine_for(which={}.get, run=run, system=system), 'islemci')
        nvidia = {'nvidia-smi': 'C:\\nvidia-smi.exe'}.get
        found = lambda command, **_options: subprocess.CompletedProcess(command, 0, 'GPU 0: RTX', '')
        self.assertEqual(ses.engine_for(which=nvidia, run=found, system=system), 'cuda', 'an NVIDIA card goes first')
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='islemci'))
        self.assertEqual(ses.install_plan(self.state, which={}.get, run=run, system=system)['motor'], 'islemci', 'a chosen engine wins')

    def test_the_engine_in_use_is_the_chosen_one_else_the_installed_one_and_a_1_0_8_install_keeps_cuda(self):
        folder = ses.ses_dir(self.state)
        folder.mkdir(parents=True)
        self.assertEqual(ses.engine_in_use(self.state), 'islemci', 'nothing installed: the processor')
        (folder / ses.MARKER).write_text(json.dumps({'schema': 1, 'ekran_karti': True}), encoding='utf-8')
        self.assertEqual(ses.engine_in_use(self.state), 'cuda', 'before engines, the NVIDIA flag said CUDA')
        (folder / ses.MARKER).write_text(json.dumps({'schema': 1, 'motor': 'vulkan', 'ekran_karti': True}), encoding='utf-8')
        self.assertEqual(ses.engine_in_use(self.state), 'vulkan')
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='islemci'))
        self.assertEqual(ses.engine_in_use(self.state), 'islemci')

    def test_install_builds_the_environment_fetches_both_models_and_says_each_step(self):
        archive = Path(self.tmp.name) / 'vosk.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('vosk-model-small-tr-0.3/am/final.mdl', b'model')
        commands, said = [], []

        def run(command, **_options):
            commands.append(command)
            if '-m' in command and 'venv' in command:
                python = ses.venv_python(self.state)
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text('')
            if '--indir' in command:
                return subprocess.CompletedProcess(command, 0, 'large-v3-turbo (işlemci)\n', '')
            return subprocess.CompletedProcess(command, 0, '', '')

        def download(url, target):
            self.assertTrue(url.startswith('https://'))
            copy = target.with_name('indirilen.zip')
            copy.write_bytes(archive.read_bytes())
            return copy

        result = ses.install(self.state, say=said.append, run=run, download=download, which={}.get)
        self.assertEqual(result['model'], 'large-v3-turbo (işlemci)')
        self.assertTrue(ses.installed(self.state))
        self.assertTrue((ses.ses_dir(self.state) / ses.VOSK_DIR / 'am/final.mdl').is_file(), 'the archive’s top folder is the model folder')
        pip = next(c for c in commands if 'pip' in c)
        self.assertIn('faster-whisper>=1.2', pip)
        self.assertIn('vosk>=0.3.45', pip)
        fetch = next(c for c in commands if '--indir' in c)
        self.assertIn('--scripts', fetch, 'the Whisper model is fetched by the install, not by the first word')
        self.assertTrue(any('Whisper' in line for line in said))
        self.assertFalse((ses.ses_dir(self.state) / 'indirilen.zip').exists(), 'the archive is removed')
        self.assertEqual(ses.uninstall(self.state)['status'], 'kaldirildi')
        self.assertFalse(ses.ses_dir(self.state).exists())

    def vulkan_install(self, fetched, build=None):
        """An install with the Vulkan engine chosen; downloads and commands recorded, not run."""
        ses.save_config(self.state, dict(ses.load_config(self.state), motor='vulkan'))
        (ses.ses_dir(self.state) / ses.VOSK_DIR).mkdir(parents=True, exist_ok=True)  # the wake model is not this test's
        commands, said = [], []

        def run(command, **_options):
            commands.append(command)
            if '-m' in command and 'venv' in command:
                python = ses.venv_python(self.state)
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text('')
            if '--indir' in command:
                engine = json.loads((ses.ses_dir(self.state) / ses.MARKER).read_text(encoding='utf-8'))['motor']
                return subprocess.CompletedProcess(command, 0, 'large-v3-turbo (%s)\n' % engine, '')
            return subprocess.CompletedProcess(command, 0, '', '')

        def download_checked(url, target, sha256, say=print):
            fetched.append((url, sha256))
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            Path(target).write_bytes(build.read_bytes() if url == ses.VULKAN_BUILD['url'] else b'ggml')
            return target

        result = ses.install(self.state, say=said.append, run=run, download=None, which={}.get, download_checked=download_checked)
        return result, next(c for c in commands if 'pip' in c), said

    def test_with_whisper_cpp_in_place_the_vulkan_install_fetches_its_model_by_digest_and_no_faster_whisper(self):
        exe = ses.server_exe(self.state)
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b'MZ')  # a build put there by hand, as before the pre-release is published
        fetched = []
        result, pip, _said = self.vulkan_install(fetched)
        self.assertEqual((result['motor'], result['model']), ('vulkan', 'large-v3-turbo (vulkan)'), 'the trial load ran on Vulkan')
        self.assertEqual(fetched, [(ses.GGML_MODEL['url'], ses.GGML_MODEL['sha256'])])
        self.assertNotIn('faster-whisper>=1.2', pip)
        self.assertIn('vosk>=0.3.45', pip)
        self.assertEqual(ses.engine_in_use(self.state), 'vulkan')

    def test_whisper_cpp_comes_from_its_pre_release_and_without_one_the_processor_writes(self):
        fetched = []
        with mock.patch.dict(ses.VULKAN_BUILD, sha256=None):
            result, pip, said = self.vulkan_install(fetched)
        self.assertEqual(result['motor'], 'islemci')
        self.assertIn('faster-whisper>=1.2', pip, 'the processor writes with faster-whisper')
        self.assertTrue(any('İşlemciye' in line for line in said))
        self.assertEqual(fetched, [], 'nothing fetched for an engine that is not used')
        build = Path(self.tmp.name) / 'whisper-vulkan-win-x64.zip'
        with zipfile.ZipFile(build, 'w') as zipped:  # as the workflow packs it: the files at the top
            zipped.writestr(ses.SERVER_EXE, b'MZ')
            zipped.writestr('LICENSE-whisper.cpp.txt', b'MIT')
        fetched.clear()
        with mock.patch.dict(ses.VULKAN_BUILD, sha256='ab' * 32):
            result, _pip, _said = self.vulkan_install(fetched, build)
        self.assertEqual(result['motor'], 'vulkan')
        self.assertEqual(fetched[0], (ses.VULKAN_BUILD['url'], 'ab' * 32), 'the build is checked by its digest')
        self.assertTrue(ses.server_exe(self.state).is_file())
        self.assertFalse((ses.ses_dir(self.state) / 'whisper-vulkan.zip').exists(), 'the archive is removed')

    def test_a_failed_reinstall_leaves_the_working_install_as_it_was(self):
        folder = ses.ses_dir(self.state)
        (folder / ses.VOSK_DIR).mkdir(parents=True)
        before = json.dumps({'schema': 1, 'motor': 'islemci', 'ekran_karti': False, 'model': 'small (işlemci)'})
        (folder / ses.MARKER).write_text(before, encoding='utf-8')
        python = ses.venv_python(self.state)
        python.parent.mkdir(parents=True)
        python.write_text('')

        def run(command, **_options):
            failed = '--indir' in command
            return subprocess.CompletedProcess(command, 1 if failed else 0, '', 'CUDA failed' if failed else '')

        with self.assertRaises(RuntimeError):
            ses.install(self.state, say=lambda _text: None, run=run, which={}.get, system=self.tmp.name)
        self.assertEqual((folder / ses.MARKER).read_text(encoding='utf-8'), before)

    def test_a_download_whose_digest_does_not_match_never_takes_the_name(self):
        folder = Path(self.tmp.name) / 'indirme'
        target = folder / 'model.bin'

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        with mock.patch('urllib.request.urlopen', lambda url, timeout: Response(b'not the model')):
            with self.assertRaises(ValueError):
                ses._download_checked('https://example.invalid/model.bin', target, '0' * 64)
        self.assertEqual(list(folder.iterdir()), [], 'neither the name nor a partial file is left')
        with self.assertRaises(ValueError):
            ses._download_checked('http://example.invalid/model.bin', target, None)

    def test_an_archive_that_reaches_outside_its_folder_is_refused(self):
        archive = Path(self.tmp.name) / 'kotu.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('../../disari.txt', b'x')
        with self.assertRaises(ValueError):
            ses._unpack(archive, Path(self.tmp.name) / 'model')
        self.assertFalse((Path(self.tmp.name).parent / 'disari.txt').exists())

    def test_the_command_line_says_when_it_is_not_installed(self):
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out):
            ses.main(['durum', '--human'], state=self.state)
        self.assertIn('kurulu değil', out.getvalue())
        out = io.StringIO()
        with redirect_stdout(out):
            ses.main(['durum'], state=self.state)
        self.assertFalse(json.loads(out.getvalue())['kurulu'], 'read by a program, not a terminal: JSON')
        out = io.StringIO()
        with redirect_stdout(out):
            ses.main(['durum', '--json'], state=self.state)
        self.assertFalse(json.loads(out.getvalue())['kurulu'])


FAKE_HELPER = r'''
import json, sys
print(json.dumps({"olay": "yukleniyor"}), flush=True)
print(json.dumps({"olay": "hazir", "aciklama": "sahte (islemci)"}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    name = command["komut"]
    if name == "dinle":
        print(json.dumps({"olay": "dinliyor"}), flush=True)
    elif name == "bitir":
        print(json.dumps({"olay": "ceviriyor"}), flush=True)
        print(json.dumps({"olay": "metin", "metin": "Toplantı notu", "komut": "kaydet"}, ensure_ascii=False), flush=True)
    elif name == "kapat":
        break
'''


class WorkerTest(unittest.TestCase):
    def test_commands_go_in_and_events_come_out_one_line_each(self):
        with tempfile.TemporaryDirectory(prefix='v3-ses-isci-') as tmp:
            script = Path(tmp) / 'sahte.py'
            script.write_text(FAKE_HELPER, encoding='utf-8')
            worker = ses.Worker(Path(tmp) / 'state', command=[sys.executable, '-u', str(script)])
            try:
                events = self.until(worker, 'hazir')
                self.assertEqual([e['olay'] for e in events], ['yukleniyor', 'hazir'])
                self.assertTrue(worker.send('dinle'))
                self.assertEqual(self.until(worker, 'dinliyor')[-1]['olay'], 'dinliyor')
                worker.send('bitir')
                spoken = self.until(worker, 'metin')[-1]
                self.assertEqual((spoken['metin'], spoken['komut']), ('Toplantı notu', 'kaydet'))
            finally:
                worker.close()
            self.assertFalse(worker.alive)
            self.assertEqual(self.until(worker, 'bitti')[-1]['olay'], 'bitti', 'a helper that ends says so')
            self.assertFalse(worker.send('dinle'), 'nothing is sent to a helper that is gone')

    def until(self, worker, kind, wait=10.0):
        seen, deadline = [], time.monotonic() + wait
        while time.monotonic() < deadline:
            seen.extend(worker.take())
            if any(e.get('olay') == kind for e in seen):
                return seen
            time.sleep(0.02)
        self.fail('no %s event; saw %s' % (kind, seen))


class FakeWorker:
    def __init__(self):
        self.sent = []

    def send(self, command, **values):
        self.sent.append(command)
        return True


class PopupVoiceTest(unittest.TestCase):
    """The Beyne at window with a microphone, built on a hidden Tk root and never shown."""

    def setUp(self):
        try:
            import tkinter as tk
            self.root = tk.Tk()
        except Exception as exc:  # no Tk, or no display
            self.skipTest('Tk yok: %s' % exc)
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        from unittest.mock import patch
        # Nothing appears on the screen and nothing is read from the person's clipboard.
        for target in ('tkinter.Toplevel.deiconify', 'tkinter.Toplevel.lift', 'tkinter.Toplevel.focus_force'):
            patcher = patch(target, lambda *_a, **_k: None)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (('_clipboard', lambda _root: ''), ('clipboard_image', lambda *_a: None), ('_bring_to_front', lambda *_a: False)):
            patcher = patch.object(yakala, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-pencere-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Kasa'
        self.vault.mkdir()
        self.link = yakala.VoiceLink(FakeWorker())

    def window(self, **options):
        win = yakala.popup(self.vault, {}, master=self.root, state=Path(self.tmp.name) / 'state', voice=self.link, **options)
        self.root.update_idletasks()
        return win

    def test_what_is_said_is_written_into_the_field_and_kaydet_at_the_end_saves_it(self):
        self.link.ready = True
        win = self.window()
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['dinle'])
        for event in ({'olay': 'dinliyor'}, {'olay': 'seviye', 'deger': 0.6}, {'olay': 'ceviriyor'}):
            win.voice_event(event)
        win.voice_toggle()  # writing: a press does nothing more
        self.assertEqual(self.link.worker.sent, ['dinle'])
        win.voice_event({'olay': 'metin', 'metin': 'Yarın onda toplantı', 'komut': 'kaydet'})
        cards = list((self.vault / yakala.INBOX).glob('*.md'))
        self.assertEqual(len(cards), 1, 'saved as a card in the inbox')
        self.assertIn('Yarın onda toplantı', cards[0].read_text(encoding='utf-8'))

    def test_opened_by_the_wake_phrase_it_is_already_listening_and_closing_lets_the_microphone_go(self):
        win = self.window(listening=True)
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['bitir'], 'a press ends what the wake phrase began')
        win.voice_event({'olay': 'dinliyor'})
        win.leave()  # Esc
        self.assertEqual(self.link.worker.sent, ['bitir', 'iptal'])

    def test_until_the_model_is_loaded_the_microphone_waits_and_a_failure_is_said(self):
        win = self.window()
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, [], 'not ready: nothing is recorded')
        self.link.ready = True
        win.voice_event({'olay': 'hazir', 'aciklama': 'large-v3-turbo (işlemci)'})
        win.voice_event({'olay': 'hata', 'neden': 'mikrofon', 'mesaj': 'Mikrofon açılamadı'})
        win.voice_toggle()
        self.assertEqual(self.link.worker.sent, ['dinle'], 'ready again after the failure')
        win.voice_event({'olay': 'metin', 'metin': 'sil bunu', 'komut': None})
        win.voice_event({'olay': 'metin', 'metin': '', 'komut': 'sil'})
        win.voice_event({'olay': 'bitti'})


# whisper.cpp's server stood in for: the same flags, GET / when ready, POST /inference with a WAV.
FAKE_SERVER = r'''
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
record, args = sys.argv[1], sys.argv[2:]
with open(record, 'a', encoding='utf-8') as log:
    log.write(json.dumps({'argv': args}) + '\n')
if 'kart-yok' in args and '-dev' in args:
    print('ggml_vulkan: no devices found', file=sys.stderr, flush=True)
    sys.exit(3)
port = int(args[args.index('--port') + 1])


class Answer(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        silent = body.count(b'\x00' * 64) > 100
        with open(record, 'a', encoding='utf-8') as log:
            log.write(json.dumps({'yol': self.path, 'wav': b'RIFF' in body and b'WAVEfmt' in body,
                                  'json': b'name="response_format"\r\n\r\njson' in body, 'sessiz': silent}) + '\n')
        text = ' [BLANK_AUDIO]\n' if silent else ' Merhaba\n dünya\n'
        payload = json.dumps({'text': text}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


HTTPServer(('127.0.0.1', port), Answer).serve_forever()
'''


class VulkanServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-ses-sunucu-')
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        (self.folder / 'sunucu.py').write_text(FAKE_SERVER, encoding='utf-8')
        self.record = self.folder / 'kayit.jsonl'
        # The helper as it runs: written into a voice folder and loaded from there.
        spec = importlib.util.spec_from_file_location('isci_sunucu_testi', ses.write_worker(self.folder / 'state'))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.helper.ses = ses

    def stand_in(self, *extra):
        return [sys.executable, str(self.folder / 'sunucu.py'), str(self.record), *extra]

    def seen(self):
        return [json.loads(line) for line in self.record.read_text(encoding='utf-8').splitlines()]

    def test_whisper_cpp_starts_on_a_local_port_is_warmed_up_and_is_asked_with_a_wav(self):
        import threading
        config = dict(ses.DEFAULTS, ipucu='Pyn, Cortex')
        server = self.helper.Server(self.stand_in(), self.folder / 'model.bin', config, self.folder / 'sunucu.log')
        try:
            text = self.helper.transcribe(server, b'\x10\x00\xf0\xff' * 8000, config, threading.Lock())
        finally:
            self.helper.release(server)
        self.assertEqual(text, 'Merhaba dünya', 'its lines joined, its spaces trimmed')
        self.assertIsNotNone(server.process.poll(), 'released with the helper')
        launch, warm, asked = self.seen()
        argv = launch['argv']
        self.assertEqual(argv[argv.index('--host') + 1], '127.0.0.1', 'only this machine can reach it')
        self.assertEqual(argv[argv.index('-l') + 1], 'tr')
        self.assertEqual(argv[argv.index('--prompt') + 1], 'Pyn, Cortex')
        self.assertEqual(argv[argv.index('-dev') + 1], '0')
        self.assertIn('-nt', argv)
        self.assertEqual((warm['yol'], warm['sessiz']), ('/inference', True), 'warmed up on silence before the first sentence')
        self.assertEqual((asked['wav'], asked['json'], asked['sessiz']), (True, True, False))

    def test_a_card_that_fails_is_said_and_whisper_cpp_writes_on_the_processor(self):
        from contextlib import redirect_stderr
        stand_in = self.stand_in('kart-yok')
        self.helper.ses = types.SimpleNamespace(
            engine_in_use=lambda _state, _config: 'vulkan', server_exe=lambda _state: stand_in,
            ggml_model=lambda _state: self.folder / 'ggml-large-v3-turbo.bin', ses_dir=lambda _state: self.folder,
            GGML_MODEL=ses.GGML_MODEL)
        errors = io.StringIO()
        with redirect_stderr(errors):
            model, what = self.helper.load_model(self.folder, dict(ses.DEFAULTS))
        self.helper.release(model)
        self.assertEqual(what, 'large-v3-turbo (işlemci, whisper.cpp)')
        self.assertIn('Vulkan açılamadı', errors.getvalue())
        self.assertIn('no devices found', errors.getvalue(), 'why, from whisper.cpp itself (isci.log)')
        first, second = [entry['argv'] for entry in self.seen() if 'argv' in entry]
        self.assertIn('-dev', first)
        self.assertIn('-ng', second)


class HelperModuleTest(unittest.TestCase):
    def test_the_helper_is_written_into_the_voice_folder_and_loads_its_packages_only_when_it_runs(self):
        with tempfile.TemporaryDirectory(prefix='v3-ses-kaynak-') as tmp:
            state = Path(tmp) / 'state'
            path = ses.write_worker(state)
            self.assertEqual(path, ses.ses_dir(state) / 'isci.py', 'beside its environment, outside the vault and the engine')
            self.assertEqual(path.read_text(encoding='utf-8'), ses.WORKER_SOURCE)
            stamp = path.stat().st_mtime_ns
            ses.write_worker(state)
            self.assertEqual(path.stat().st_mtime_ns, stamp, 'written again only when it changed')
            command = ses.worker_command(state, '--indir')
            self.assertEqual(command[2:4], [str(path), '--scripts'])
            # Imported by the engine's own Python (no faster-whisper, no vosk), it must not fail.
            done = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import isci', str(path.parent)],
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Optional voice typing for yakala ("ses"): speak into the Beyne at window, or say "Pyn, not al".

Speech never leaves this machine. Whisper (faster-whisper) writes what is said: on an NVIDIA
card when there is one, else on the processor. A small Turkish Vosk model listens only for the
wake phrase, so the processor is not kept busy by Whisper while nobody is talking to Pyn.

The engine stays standard-library only: the voice runs in its own virtual environment, as a
helper process that yakala's resident listener talks to one JSON line at a time. The helper's
source is WORKER_SOURCE below, a string: written out into state/ses with the environment it
runs in, so its packages are never imported by the engine. Nothing is installed unless the user runs `ses kur`; everything it installs (the
environment, the Whisper model, the Vosk model) lives under state/ses, outside the vault, so a
synced vault never carries gigabytes of models or one machine's packages to another.
"""
import argparse
import difflib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True

SES_DIR = 'ses'
CONFIG = 'ayar.json'
MARKER = 'kurulum.json'
LOG = 'isci.log'
VOSK_DIR = 'vosk-tr'
VOSK_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-tr-0.3.zip'
WORKER = 'isci.py'
PACKAGES = ('faster-whisper>=1.2', 'sounddevice>=0.5', 'numpy', 'vosk>=0.3.45')
# Only with an NVIDIA card: CUDA's own libraries, from pip, so no CUDA install is needed.
NVIDIA_PACKAGES = ('nvidia-cublas-cu12', 'nvidia-cudnn-cu12>=9,<10')
# The voice packages publish wheels for these first; a newer Python may have none yet.
PYTHON_VERSIONS = ('3.12', '3.13', '3.11', '3.10')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

DEFAULTS = {
    'acik': True,
    'dil': 'tr',
    'model': 'large-v3-turbo',      # on an NVIDIA card
    'cpu_model': 'large-v3-turbo',  # on the processor; 'small' is faster and less accurate
    'uyandirma': False,             # "Pyn, not al" opens the window: the microphone stays open
    'uyandirma_sozu': 'pyn not al',
    'sessizlik_sn': 1.4,            # after speech, this much silence ends the recording
    'en_uzun_sn': 120,
    'mikrofon': None,
    'ipucu': 'Cortex, Pyn, yakala, kasa, not, makbuz, Claude, Codex.',
    'komutlar': {
        'kaydet': ['kaydet'],
        'sil': ['sil', 'temizle'],
        'iptal': ['iptal', 'vazgeç'],
    },
}


def ses_dir(state):
    return Path(state) / SES_DIR


def venv_python(state):
    venv = ses_dir(state) / 'venv'
    return venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def worker_script(state):
    """The helper's script, in the voice environment's own folder (its source: WORKER_SOURCE)."""
    return ses_dir(state) / WORKER


def write_worker(state):
    """The helper written out where it runs, again whenever this engine's copy changed it."""
    path = worker_script(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_text(encoding='utf-8') == WORKER_SOURCE:
            return path
    except OSError:
        pass
    path.write_text(WORKER_SOURCE, encoding='utf-8', newline='\n')
    return path


def worker_command(state, *extra):
    return [str(venv_python(state)), '-u', str(write_worker(state)), '--scripts', str(Path(__file__).resolve().parent),
            '--state', str(state), *extra]


def load_config(state):
    config = json.loads(json.dumps(DEFAULTS))
    try:
        saved = json.loads((ses_dir(state) / CONFIG).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return config
    if isinstance(saved, dict):
        for key, value in saved.items():
            if key == 'komutlar' and isinstance(value, dict):
                config['komutlar'].update({k: list(v) for k, v in value.items() if isinstance(v, list)})
            elif key in DEFAULTS:
                config[key] = value
    return config


def save_config(state, config):
    path = ses_dir(state) / CONFIG
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def installed(state):
    """The environment and the wake model are there, as `kur` left them."""
    return venv_python(state).is_file() and (ses_dir(state) / MARKER).is_file()


def usable(state):
    """Installed and switched on."""
    return installed(state) and bool(load_config(state).get('acik'))


# --------------------------------------------------------------- words --
_FOLD = str.maketrans('ışğüöç', 'isguoc')
# How recognizers spell the name they hear as "pin".
NAME_SPELLINGS = {'pyn', 'pin', 'pinn', 'pen', 'pine', 'bin', 'fin'}


def tr_lower(text):
    return text.replace('İ', 'i').replace('I', 'ı').lower()


def words(text):
    """The words of a text, lowercased the Turkish way and folded to ASCII: a model that writes
    "kaydi" for "kaydı" still matches."""
    return [w.translate(_FOLD) for w in re.findall(r'\w+', tr_lower(text))]


def wake_heard(text, phrase=DEFAULTS['uyandirma_sozu']):
    """Whether the wake phrase is in what was heard. The rest of the phrase must be there as
    said ("not al"); the name before it is matched loosely, since nobody spells "Pyn" alike."""
    want, got = words(phrase), words(text)
    if not want:
        return False
    head, tail = want[0], want[1:]
    for at in range(len(got) - len(want) + 1):
        window = got[at:at + len(want)]
        if window[1:] != tail:
            continue
        if window[0] == head or window[0] in NAME_SPELLINGS or difflib.SequenceMatcher(None, window[0], head).ratio() >= 0.6:
            return True
    return False


def _without_last_words(text, count):
    """The text with its last `count` words taken off, its punctuation tidied."""
    spans = [m.start() for m in re.finditer(r'\w+', tr_lower(text))]
    if count > len(spans):
        return ''
    return text[:spans[-count]].rstrip(' ,.;:!?…') if count else text.strip()


def command_of(text, commands=None):
    """(command, text to write) for what was said.

    "kaydet" counts only at the very end ("Toplantı notu, kaydet" writes and saves); "sil" and
    "iptal" only when said alone. Anywhere else a command word is just a word: "notu kaydettim"
    and "bu satırı sil" are written as they are.
    """
    commands = commands or DEFAULTS['komutlar']
    said = words(text)
    if not said:
        return None, ''
    whole = ' '.join(said)
    for name in ('sil', 'iptal', 'kaydet'):
        if whole in {' '.join(words(p)) for p in commands.get(name, ())}:
            return name, ''
    for phrase in sorted(commands.get('kaydet', ()), key=len, reverse=True):
        wanted = words(phrase)
        if wanted and said[-len(wanted):] == wanted:
            return 'kaydet', _without_last_words(text, len(wanted))
    return None, text.strip()


# ------------------------------------------------------------- install --
def _run(command, timeout=None, run=subprocess.run):
    return run(command, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)


def python_for_env(which=shutil.which, run=subprocess.run):
    """The Python the voice environment is built with: a 3.10-3.13 the system knows, for which
    the voice packages have wheels, else the one running this."""
    if os.name == 'nt' and which('py'):
        for version in PYTHON_VERSIONS:
            try:
                done = _run(['py', '-' + version, '-c', 'import sys; print(sys.executable)'], timeout=30, run=run)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if done.returncode == 0 and done.stdout.strip():
                return done.stdout.strip().splitlines()[-1]
    for version in PYTHON_VERSIONS:
        found = which('python' + version)
        if found:
            return found
    return sys.executable


def has_nvidia(which=shutil.which, run=subprocess.run):
    if not which('nvidia-smi'):
        return False
    try:
        return _run(['nvidia-smi', '-L'], timeout=20, run=run).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def install_plan(state, which=shutil.which, run=subprocess.run):
    gpu = has_nvidia(which, run)
    return {
        'klasor': str(ses_dir(state)),
        'python': python_for_env(which, run),
        'paketler': list(PACKAGES) + (list(NVIDIA_PACKAGES) if gpu else []),
        'ekran_karti': gpu,
        'vosk_modeli': VOSK_MODEL_URL,
    }


def _download(url, target):
    """A model archive, over HTTPS only, into a temporary file beside its target."""
    from urllib.request import urlopen
    if not url.startswith('https://'):
        raise ValueError('Yalnız HTTPS adresinden indirilir: ' + url)
    target.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(url, timeout=60) as response, tempfile.NamedTemporaryFile(dir=target.parent, delete=False, suffix='.zip') as out:
        shutil.copyfileobj(response, out)
        return Path(out.name)


def _unpack_vosk(archive, folder):
    """The Vosk archive's one top folder becomes `folder`; nothing is written outside it."""
    import zipfile
    folder = Path(folder)
    staging = folder.with_name(folder.name + '.acilan')
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(archive) as zipped:
        for member in zipped.namelist():
            resolved = (staging / member).resolve()
            if staging.resolve() not in resolved.parents and resolved != staging.resolve():
                raise ValueError('Arşivde klasör dışına çıkan bir yol var: ' + member)
        zipped.extractall(staging)
    inner = [p for p in staging.iterdir() if p.is_dir()]
    source = inner[0] if len(inner) == 1 else staging
    shutil.rmtree(folder, ignore_errors=True)
    shutil.move(str(source), str(folder))
    shutil.rmtree(staging, ignore_errors=True)


def worker_env(state):
    """The helper's environment: Hugging Face's cache under state/ses, UTF-8 pipes."""
    env = dict(os.environ)
    env.update(HF_HOME=str(ses_dir(state) / 'hf'), PYTHONIOENCODING='utf-8', PYTHONUTF8='1',
               HF_HUB_DISABLE_TELEMETRY='1', PYTHONDONTWRITEBYTECODE='1')
    return env


def install(state, say=print, run=subprocess.run, download=_download, which=shutil.which):
    """Build the environment, install the packages, fetch both models. Each step says what it does."""
    plan = install_plan(state, which, run)
    folder = ses_dir(state)
    folder.mkdir(parents=True, exist_ok=True)
    say('Python: ' + plan['python'])
    if not venv_python(state).is_file():
        say('Sanal ortam kuruluyor…')
        done = _run([plan['python'], '-m', 'venv', str(folder / 'venv')], timeout=600, run=run)
        if done.returncode:
            raise RuntimeError('Sanal ortam kurulamadı: ' + (done.stderr or done.stdout).strip()[-400:])
    say('Paketler yükleniyor (ilk kurulumda birkaç dakika sürer): ' + ', '.join(plan['paketler']))
    done = _run([str(venv_python(state)), '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', *plan['paketler']],
                timeout=3600, run=run)
    if done.returncode:
        raise RuntimeError('Paketler yüklenemedi: ' + (done.stderr or done.stdout).strip()[-600:])
    if not (folder / VOSK_DIR).is_dir():
        say('Uyandırma modeli indiriliyor (yaklaşık 40 MB)…')
        archive = download(VOSK_MODEL_URL, folder / 'vosk.zip')
        try:
            _unpack_vosk(archive, folder / VOSK_DIR)
        finally:
            Path(archive).unlink(missing_ok=True)
    say('Whisper modeli hazırlanıyor (ilk seferde yaklaşık 1,6 GB iner)…')
    done = run(worker_command(state, '--indir'), capture_output=True, text=True, encoding='utf-8', errors='replace',
               timeout=7200, env=worker_env(state), creationflags=NO_WINDOW)
    if done.returncode:
        raise RuntimeError('Whisper modeli hazırlanamadı: ' + (done.stderr or done.stdout).strip()[-600:])
    model = (done.stdout or '').strip().splitlines()[-1:] or ['']
    if not (folder / CONFIG).is_file():
        save_config(state, load_config(state))
    (folder / MARKER).write_text(json.dumps({'schema': 1, 'python': plan['python'], 'ekran_karti': plan['ekran_karti'],
                                             'model': model[0]}, ensure_ascii=False) + '\n', encoding='utf-8')
    return {'status': 'kuruldu', 'klasor': str(folder), 'ekran_karti': plan['ekran_karti'], 'model': model[0]}


def status(state):
    marker = {}
    try:
        marker = json.loads((ses_dir(state) / MARKER).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        pass
    config = load_config(state)
    return {'kurulu': installed(state), 'acik': bool(config['acik']), 'uyandirma': bool(config['uyandirma']),
            'uyandirma_sozu': config['uyandirma_sozu'], 'model': marker.get('model'), 'ekran_karti': marker.get('ekran_karti'),
            'klasor': str(ses_dir(state))}


def uninstall(state):
    """The environment and both models, all under state/ses, go; the vault is not touched."""
    folder = ses_dir(state)
    existed = folder.exists()
    shutil.rmtree(folder, ignore_errors=True)
    return {'status': 'kaldirildi' if existed else 'zaten-yok', 'klasor': str(folder)}


def restart_listener(state):
    """Yakala's resident listener started again, so it takes up the voice now (Windows)."""
    if os.name != 'nt' or os.environ.get('BEYIN_V3_NO_SPAWN') == '1':
        return False
    import beyin_v3_yakala as yakala
    programs, _sendto = yakala._windows_dirs()
    startup = programs / 'Startup' / yakala.STARTUP_NAME
    if not startup.is_file():
        return False
    yakala.stop_windows_listener()
    subprocess.Popen(['explorer.exe', str(startup)], close_fds=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


# --------------------------------------------------------------- helper --
class Worker:
    """The voice helper, started in its environment; commands in, events out, one JSON line each.

    Events are read on a thread into a queue, so a Tk loop takes them when it polls and never
    waits on the pipe. A helper that ends says so with a last event, `bitti`.
    """

    def __init__(self, state, popen=subprocess.Popen, command=None):
        folder = ses_dir(state)
        folder.mkdir(parents=True, exist_ok=True)
        self.events = queue.Queue()
        self._log = open(folder / LOG, 'a', encoding='utf-8')
        args = command or worker_command(state)
        self.proc = popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._log, text=True,
                          encoding='utf-8', errors='replace', env=worker_env(state), cwd=str(folder),
                          creationflags=NO_WINDOW)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and isinstance(event.get('olay'), str):
                self.events.put(event)
        self.events.put({'olay': 'bitti'})

    @property
    def alive(self):
        return self.proc.poll() is None

    def send(self, command, **values):
        if not self.alive:
            return False
        try:
            self.proc.stdin.write(json.dumps(dict(values, komut=command), ensure_ascii=False) + '\n')
            self.proc.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def take(self):
        """Every event that arrived since the last call."""
        out = []
        while True:
            try:
                out.append(self.events.get_nowait())
            except queue.Empty:
                return out

    def close(self, wait=3.0):
        self.send('kapat')
        try:
            self.proc.wait(wait)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(wait)
        for pipe in (self.proc.stdin, self._log):
            try:
                pipe.close()
            except (OSError, ValueError):
                pass


# ------------------------------------------------------------------ cli --
def human(result, command):
    if command == 'kur':
        return ('Sesle yazma kuruldu (' + (result.get('model') or 'Whisper') + ').\n'
                'Ctrl+Alt+B ile yakala\'yı aç, mikrofona tıkla ya da Ctrl+Alt+B\'ye yeniden basıp konuş.\n'
                '"Pyn, not al" ile açmak için: beyin.py ses ayar --uyandirma ac')
    if command == 'durum':
        if not result['kurulu']:
            return 'Sesle yazma kurulu değil. Kurmak için: beyin.py ses kur'
        return ('Sesle yazma kurulu · ' + ('açık' if result['acik'] else 'kapalı') + ' · model ' + str(result.get('model')) +
                (' · ekran kartı' if result.get('ekran_karti') else ' · işlemci') +
                ' · uyandırma ' + ('açık ("' + result['uyandirma_sozu'] + '")' if result['uyandirma'] else 'kapalı'))
    if command == 'kaldir':
        return 'Sesle yazma kaldırıldı.' if result['status'] == 'kaldirildi' else 'Sesle yazma zaten kurulu değil.'
    if command == 'ayar':
        return 'Ayar kaydedildi.' + (' Yakala dinleyicisi yeniden başlatıldı.' if result.get('dinleyici') else '')
    if command == 'dene':
        return result.get('metin') or '(bir şey duyulmadı)'
    return json.dumps(result, ensure_ascii=False)


def main(argv=None, vault=None, state=None):
    parser = argparse.ArgumentParser(prog='beyin.py ses', description='Yakala\'da sesle yazma (yerel Whisper).')
    parser.add_argument('--json', action='store_true')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('kur', help='Sanal ortamı, paketleri ve modelleri kur (yaklaşık 2 GB indirir)')
    sub.add_parser('durum', help='Kurulu mu, hangi model, uyandırma açık mı')
    sub.add_parser('kaldir', help='Sanal ortamı ve modelleri sil')
    setting = sub.add_parser('ayar', help='Ayarları değiştir')
    setting.add_argument('--uyandirma', choices=('ac', 'kapat'), help='"Pyn, not al" ile açılsın mı (mikrofon sürekli açık kalır)')
    setting.add_argument('--ses', choices=('ac', 'kapat'), help='Sesle yazmayı aç ya da kapat')
    setting.add_argument('--model', help='Whisper modeli, örnek: large-v3-turbo, small')
    trial = sub.add_parser('dene', help='Birkaç saniye kaydedip yazıya çevir')
    trial.add_argument('--sn', type=float, default=5.0)
    argv = list(sys.argv[1:] if argv is None else argv)
    # As beyin.py and yakala decide: text for a terminal, JSON for anything reading the output;
    # --json and --human say it outright, before or after the command.
    as_json = '--json' in argv or ('--human' not in argv and not (sys.stdout and sys.stdout.isatty()))
    args = parser.parse_args([one for one in argv if one not in ('--json', '--human')])
    args.json = as_json
    if not as_json and hasattr(sys.stdout, 'reconfigure'):
        # A piped Windows console is cp1252, which has no dotless i: such a letter prints as '?'.
        sys.stdout.reconfigure(errors='replace')
    if state is None:
        raise SystemExit('Durum klasörü bilinmiyor; beyin.py ses ile çalıştırın.')
    state = Path(state)
    if args.command == 'kur':
        result = install(state, say=(lambda _text: None) if args.json else (lambda text: print(text, flush=True)))
        result['dinleyici'] = restart_listener(state)
    elif args.command == 'durum':
        result = status(state)
    elif args.command == 'kaldir':
        result = uninstall(state)
        result['dinleyici'] = restart_listener(state)
    elif args.command == 'ayar':
        config = load_config(state)
        if args.uyandirma:
            config['uyandirma'] = args.uyandirma == 'ac'
        if args.ses:
            config['acik'] = args.ses == 'ac'
        if args.model:
            config['model'] = config['cpu_model'] = args.model
        save_config(state, config)
        result = {'status': 'kaydedildi', **status(state), 'dinleyici': restart_listener(state) if args.ses or args.model else False}
    else:
        if not installed(state):
            raise SystemExit('Sesle yazma kurulu değil. Kurmak için: beyin.py ses kur')
        done = subprocess.run(worker_command(state, '--dene', str(args.sn)), capture_output=True, text=True, encoding='utf-8',
                              env=worker_env(state), timeout=600)
        if done.returncode:
            raise SystemExit((done.stderr or done.stdout).strip()[-600:])
        result = json.loads(done.stdout.strip().splitlines()[-1])
    if args.json:
        # Literal letters only where the stream writes UTF-8; ASCII escapes elsewhere (as yakala does).
        utf8 = (getattr(sys.stdout, 'encoding', '') or '').lower().replace('-', '') in ('utf8', 'utf8sig')
        print(json.dumps(result, ensure_ascii=not utf8))
    else:
        print(human(result, args.command))
    return 0


# The voice helper, run by state/ses/venv's Python (see worker_command). Kept here as text so
# that the packaged engine imports nothing outside the standard library.
WORKER_SOURCE = r'''"""Voice helper for yakala: runs in state/ses/venv, never in the engine's own Python.

Commands arrive on stdin and events leave on stdout, one JSON object a line (see
beyin_v3_ses.Worker). It loads Whisper (an NVIDIA card first, else the processor), records the
microphone on `dinle`, ends on silence, on "kaydet" at the end or on `bitir`, writes what was
said, and, when the wake word is on and nothing is being recorded, listens with a small Vosk
model for "Pyn, not al" and starts recording by itself. No audio is kept or sent anywhere.

Modes for the command line: `--indir` loads the model once (the install fetches it) and exits;
`--dene N` records N seconds, writes them and exits.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

sys.dont_write_bytecode = True
ses = None  # beyin_v3_ses, imported from the engine's scripts folder named by --scripts

RATE = 16000


def out(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _cuda_dirs():
    """The DLLs of pip's nvidia-* packages made findable (Windows)."""
    import site
    for root in site.getsitepackages():
        nvidia = Path(root) / 'nvidia'
        if not nvidia.is_dir():
            continue
        for package in nvidia.iterdir():
            binary = package / 'bin'
            if binary.is_dir():
                if hasattr(os, 'add_dll_directory'):
                    os.add_dll_directory(str(binary))
                os.environ['PATH'] = str(binary) + os.pathsep + os.environ.get('PATH', '')


def _open(name, device, compute):
    """From disk without the network when it is there; else fetched once."""
    from faster_whisper import WhisperModel
    threads = max(1, min(8, (os.cpu_count() or 4) // 2))
    try:
        return WhisperModel(name, device=device, compute_type=compute, cpu_threads=threads, local_files_only=True)
    except Exception:
        return WhisperModel(name, device=device, compute_type=compute, cpu_threads=threads)


def load_model(config):
    """(model, what it is): the NVIDIA card first, then the processor."""
    import numpy as np
    try:
        _cuda_dirs()
        model = _open(config['model'], 'cuda', 'float16')
        list(model.transcribe(np.zeros(RATE, dtype='float32'), language=config['dil'])[0])  # CUDA loads on first use
        return model, config['model'] + ' (ekran kartı)'
    except Exception:
        pass
    return _open(config['cpu_model'], 'cpu', 'int8'), config['cpu_model'] + ' (işlemci)'


def transcribe(model, audio, config, lock):
    with lock:
        segments, _info = model.transcribe(audio, language=config['dil'] or None, vad_filter=True, beam_size=5,
                                           initial_prompt=config.get('ipucu') or None, condition_on_previous_text=False)
        return ' '.join(s.text.strip() for s in segments).strip()


def _device(config):
    """The configured microphone by a part of its name; else the system's default."""
    import sounddevice as sd
    want = config.get('mikrofon')
    if not isinstance(want, str) or not want:
        return None
    for index, device in enumerate(sd.query_devices()):
        if device['max_input_channels'] > 0 and want.lower() in device['name'].lower():
            return index
    return None


class Recorder:
    """The microphone into memory, with its level and whether someone has spoken."""

    def __init__(self, config):
        self.config = config
        self.stream = None
        self.chunks = []
        self.level = 0.0

    def start(self, on_chunk=None):
        import sounddevice as sd
        self.chunks, self.level, self.floor, self.loud = [], 0.0, 1.0, 0
        self.spoke, self.started = False, time.time()
        self.last_voice = self.started
        self.on_chunk = on_chunk

        def take(data, _frames, _time, _status):
            if self.on_chunk is not None:
                self.on_chunk(data.copy())
                return
            self.chunks.append(data.copy())
            self.level = float(abs(data).max())
            rms = float((data ** 2).mean() ** 0.5)
            self.floor = min(rms, self.floor * 1.02 + 1e-6)
            if rms > max(0.006, self.floor * 4):  # clearly above the room's noise: speech
                self.loud += 1
                if self.loud >= 3:
                    self.spoke = True
                self.last_voice = time.time()
            else:
                self.loud = 0

        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype='float32', device=_device(self.config), callback=take)
        self.stream.start()

    def stop(self):
        import numpy as np
        if self.stream is not None:
            self.stream.stop()
            self.stream.close()
            self.stream = None
        if not self.chunks:
            return np.zeros(0, dtype='float32')
        return np.concatenate(self.chunks)[:, 0]


class Wake:
    """"Pyn, not al" heard with a small Vosk model: cheap enough to run while nobody speaks to Pyn."""

    def __init__(self, state, config):
        from vosk import KaldiRecognizer, Model, SetLogLevel
        SetLogLevel(-1)
        self.phrase = config['uyandirma_sozu']
        self.model = Model(str(ses.ses_dir(state) / ses.VOSK_DIR))
        self.recognizer = KaldiRecognizer(self.model, RATE)
        self.audio = queue.Queue()
        self.recorder = Recorder(config)

    def start(self):
        self.recognizer.Reset()
        self.recorder.start(on_chunk=self.audio.put)

    def stop(self):
        self.recorder.stop()
        while not self.audio.empty():
            self.audio.get_nowait()

    @property
    def running(self):
        return self.recorder.stream is not None

    def heard(self):
        """Whether the phrase was said in what arrived since the last call."""
        import numpy as np
        while True:
            try:
                chunk = self.audio.get_nowait()
            except queue.Empty:
                return False
            pcm = (np.clip(chunk[:, 0], -1, 1) * 32767).astype('<i2').tobytes()
            if self.recognizer.AcceptWaveform(pcm):
                text = json.loads(self.recognizer.Result()).get('text', '')
            else:
                text = json.loads(self.recognizer.PartialResult()).get('partial', '')
            if text and ses.wake_heard(text, self.phrase):
                self.recognizer.Reset()
                return True


def serve(state, config):
    commands = queue.Queue()

    def read():
        for line in sys.stdin:
            try:
                commands.put(json.loads(line))
            except ValueError:
                continue
        commands.put({'komut': 'kapat'})

    threading.Thread(target=read, daemon=True).start()
    out(olay='yukleniyor')
    loaded, lock = {}, threading.Lock()

    def load():
        try:
            loaded['model'], what = load_model(config)
            out(olay='hazir', aciklama=what)
        except Exception as exc:
            out(olay='hata', neden='model', mesaj=str(exc)[:300])

    threading.Thread(target=load, daemon=True).start()
    recorder, wake, wake_on = Recorder(config), None, bool(config.get('uyandirma'))
    mode, last_level = 'bos', 0.0

    def begin():
        nonlocal mode
        if wake is not None and wake.running:
            wake.stop()
        try:
            recorder.start()
        except Exception as exc:
            out(olay='hata', neden='mikrofon', mesaj=str(exc)[:300])
            return False
        mode = 'kayit'
        out(olay='dinliyor')
        return True

    def finish(keep=True):
        nonlocal mode
        audio = recorder.stop()
        # Nothing said (no speech above the room's noise): Whisper given silence makes words up.
        if not keep or not recorder.spoke or len(audio) < RATE * 0.3 or 'model' not in loaded:
            mode = 'bos'
            out(olay='metin', metin='', komut=None)
            return
        mode = 'ceviri'
        out(olay='ceviriyor')

        def work():
            nonlocal mode
            try:
                text = transcribe(loaded['model'], audio, config, lock)
                command, text = ses.command_of(text, config['komutlar'])
                out(olay='metin', metin=text, komut=command)
            except Exception as exc:
                out(olay='hata', neden='ceviri', mesaj=str(exc)[:300])
            mode = 'bos'

        threading.Thread(target=work, daemon=True).start()

    while True:
        try:
            command = commands.get(timeout=0.05)
        except queue.Empty:
            command = None
        if command:
            name = command.get('komut')
            if name == 'kapat':
                if recorder.stream is not None:
                    recorder.stop()
                if wake is not None and wake.running:
                    wake.stop()
                return 0
            if name == 'dinle' and mode == 'bos':
                begin()
            elif name == 'bitir' and mode == 'kayit':
                finish()
            elif name == 'iptal' and mode == 'kayit':
                finish(keep=False)
            elif name == 'uyandirma':
                wake_on = bool(command.get('acik'))
        now = time.time()
        if mode == 'kayit':
            if now - last_level >= 0.1:
                last_level = now
                out(olay='seviye', deger=round(min(1.0, recorder.level * 4), 2))
            spoke_then_quiet = recorder.spoke and now - recorder.last_voice > float(config['sessizlik_sn'])
            if spoke_then_quiet or now - recorder.started > float(config['en_uzun_sn']):
                finish()
            elif not recorder.spoke and now - recorder.started > 12:
                finish(keep=False)  # nothing said: let the microphone go
        elif mode == 'bos' and wake_on and 'model' in loaded:
            try:
                if wake is None:
                    wake = Wake(state, config)
                if not wake.running:
                    wake.start()
                elif wake.heard():
                    wake.stop()
                    if begin():
                        out(olay='uyandi')
            except Exception as exc:
                out(olay='hata', neden='uyandirma', mesaj=str(exc)[:300])
                wake_on = False
        elif wake is not None and wake.running and not wake_on:
            wake.stop()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--scripts', required=True)
    parser.add_argument('--indir', action='store_true')
    parser.add_argument('--dene', type=float)
    args = parser.parse_args(argv)
    global ses
    sys.path.insert(0, args.scripts)
    import beyin_v3_ses as engine_ses  # standard library only
    ses = engine_ses
    state = Path(args.state)
    config = ses.load_config(state)
    if args.indir:
        _model, what = load_model(config)
        print(what, flush=True)
        return 0
    if args.dene:
        model, what = load_model(config)
        recorder = Recorder(config)
        recorder.start()
        time.sleep(args.dene)
        audio = recorder.stop()
        started = time.time()
        text = transcribe(model, audio, config, threading.Lock())
        print(json.dumps({'metin': text, 'model': what, 'sure_sn': round(time.time() - started, 2)}, ensure_ascii=False), flush=True)
        return 0
    return serve(state, config)


if __name__ == '__main__':
    sys.exit(main())
'''


if __name__ == '__main__':
    sys.exit(main())

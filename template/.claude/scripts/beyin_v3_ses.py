#!/usr/bin/env python3
"""Optional voice typing for yakala ("ses"): speak into the Beyne at window, or say "Pyn, not al".

Speech never leaves this machine. Whisper writes what is said, on the best engine the machine
has (`engine_for`):

- an NVIDIA card: faster-whisper on CUDA, its libraries from pip, no CUDA install needed;
- an AMD or Intel card: whisper.cpp's own server, built for Vulkan by Cortex's whisper-vulkan
  workflow (whisper.cpp ships no Vulkan build for Windows), the model held warm on the card;
- neither: faster-whisper on the processor, a few seconds a sentence.

A small Turkish Vosk model listens only for the wake phrase, so the processor is not kept busy by
Whisper while nobody is talking to Pyn.

The engine stays standard-library only: the voice runs in its own virtual environment, as a
helper process that yakala's resident listener talks to one JSON line at a time. The helper's
source is WORKER_SOURCE below, a string: written out into state/ses with the environment it
runs in, so its packages are never imported by the engine. Nothing is installed unless the
user runs `ses kur`; everything it installs (the environment, whisper.cpp, the models) lives
under state/ses, outside the vault, so a synced vault never carries gigabytes of models or one
machine's packages to another.
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
ENGINES = ('cuda', 'vulkan', 'islemci')
# Recording and the wake word, for every engine.
BASE_PACKAGES = ('sounddevice>=0.5', 'numpy', 'vosk>=0.3.45')
# Writing on CUDA or on the processor; the Vulkan engine is whisper.cpp and needs neither.
FASTER_PACKAGES = ('faster-whisper>=1.2',)
# Only with an NVIDIA card: CUDA's own libraries, from pip, so no CUDA install is needed.
NVIDIA_PACKAGES = ('nvidia-cublas-cu12', 'nvidia-cudnn-cu12>=9,<10')
PACKAGES = FASTER_PACKAGES + BASE_PACKAGES  # the processor's set
VULKAN_DIR = 'whisper-vulkan'
SERVER_EXE = 'whisper-server.exe'
GGML_DIR = 'ggml'
# whisper.cpp's own model file for the Vulkan engine, pinned by its digest.
GGML_MODEL = {
    'ad': 'ggml-large-v3-turbo.bin',
    'url': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    'sha256': '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    'boyut': 1624555275,
}
# whisper.cpp built for Vulkan by .github/workflows/whisper-vulkan.yml, a pre-release of its own
# (published 2026-10-15). A build already in state/ses/whisper-vulkan is used as it is.
VULKAN_BUILD = {
    'surum': '1.9.5',
    'url': 'https://github.com/GunduzTolga/Cortex/releases/download/whisper-vulkan-1.9.5/whisper-vulkan-win-x64.zip',
    'sha256': '720c36dcce8f2bc007af973aa065ab9f06a1575ba18ae84756afea0ff2f5506e',
}
# The voice packages publish wheels for these first; a newer Python may have none yet.
PYTHON_VERSIONS = ('3.12', '3.13', '3.11', '3.10')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

DEFAULTS = {
    'acik': True,
    'motor': 'otomatik',            # or 'cuda', 'vulkan', 'islemci'; otomatik: what `kur` found
    'gpu': 0,                       # the Vulkan device whisper.cpp writes on
    'dil': 'tr',
    'model': 'large-v3-turbo',      # on an NVIDIA card
    'cpu_model': 'large-v3-turbo',  # on the processor; 'small' is faster and less accurate
    'uyandirma': False,             # "Pyn, not al" opens the window: the microphone stays open
    'otomatik_dinle': True,         # the window listens as it opens; typing lets the microphone go
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
NAME_SPELLINGS = {'pyn', 'pin', 'pinn', 'pen', 'pine', 'bin', 'fin', 'pay', 'bayan'}
# Words of the small Turkish model's own vocabulary that sound like "Pyn" said as "payn" or "pin".
# The model can only write words it knows, and "pyn", "payn", "pin" are not among them: listening
# freely, it wrote "payn not al" as "aynen" or "pan am". Given the phrase as a grammar it hears
# one of these instead (tried on synthesized "payn not al": "pay not al", every time).
WAKE_NAMES = ('pay', 'bin', 'bayan')


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


def wake_grammar(phrase=DEFAULTS['uyandirma_sozu']):
    """What the wake listener may hear, as a Vosk grammar (JSON): the wake phrase with Pyn's name
    and the sound-alikes the model knows, everything else "[unk]". A grammar also keeps other
    speech from looking like the phrase: "bunu not al" and "not al" alone are not it."""
    said = words(phrase)
    if not said:
        return json.dumps(['[unk]'])
    head, tail = said[0], ' '.join(said[1:])
    names = [head] + [name for name in WAKE_NAMES if name != head]
    return json.dumps([(name + ' ' + tail).strip() for name in names] + ['[unk]'], ensure_ascii=False)


def _without_last_words(text, count):
    """The text with its last `count` words taken off, its punctuation tidied."""
    spans = [m.start() for m in re.finditer(r'\w+', tr_lower(text))]
    if count > len(spans):
        return ''
    return text[:spans[-count]].rstrip(' ,.;:!?…') if count else text.strip()


def _named(word):
    """Whether a word is Pyn's name however the model wrote it (Pyn, pin, pın, pen...)."""
    return word in NAME_SPELLINGS or word == 'pyn'


def command_of(text, commands=None):
    """(command, text to write) for what was said.

    "kaydet" counts only at the very end ("Toplantı notu, kaydet" writes and saves); "sil" and
    "iptal" only when said alone. Anywhere else a command word is just a word: "notu kaydettim"
    and "bu satırı sil" are written as they are. Pyn's name may come before the command, as
    the wake phrase is said: "…, Pyn kaydet" saves and the name is not written.
    """
    commands = commands or DEFAULTS['komutlar']
    said = words(text)
    if not said:
        return None, ''
    whole = ' '.join(said)
    for name in ('sil', 'iptal', 'kaydet'):
        spoken = {' '.join(words(p)) for p in commands.get(name, ())}
        if whole in spoken or (len(said) > 1 and _named(said[0]) and ' '.join(said[1:]) in spoken):
            return name, ''
    for phrase in sorted(commands.get('kaydet', ()), key=len, reverse=True):
        wanted = words(phrase)
        if wanted and said[-len(wanted):] == wanted:
            cut = len(wanted) + (1 if len(said) > len(wanted) and _named(said[-len(wanted) - 1]) else 0)
            return 'kaydet', _without_last_words(text, cut)
    return None, text.strip()


# What Whisper writes for silence or noise, learnt from its subtitle training: never a note.
HALLUCINATIONS = {
    'altyazi m k', 'altyazilar m k', 'altyazi mk', 'izlediginiz icin tesekkurler', 'izlediginiz icin tesekkur ederim',
    'abone olmayi unutmayin', 'begenmeyi ve abone olmayi unutmayin', 'blank audio', 'blank_audio', 'muzik', 'alkis',
    'thank you for watching', 'thanks for watching', 'subtitles by the amara org community',
}


def clean_spoken(text):
    """What was written from speech, without what Whisper makes up for silence."""
    return '' if ' '.join(words(text)) in HALLUCINATIONS else (text or '').strip()


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


def video_cards(run=subprocess.run):
    """The names of the machine's graphics adapters (Windows), as the system knows them."""
    if os.name != 'nt':
        return []
    try:
        done = _run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                     '(Get-CimInstance Win32_VideoController).Name'], timeout=30, run=run)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line.strip() for line in (done.stdout or '').splitlines() if line.strip()] if done.returncode == 0 else []


def has_vulkan_card(run=subprocess.run, system=None):
    """An AMD or Intel card with the system's Vulkan loader: whisper.cpp's Vulkan build runs on it."""
    if os.name != 'nt':
        return False
    root = Path(system or os.environ.get('SystemRoot', r'C:\Windows'))
    if not (root / 'System32' / 'vulkan-1.dll').is_file():
        return False
    # whisper.cpp writes on a discrete card when there is one (an APU's Radeon only without one);
    # Intel's integrated graphics stay on the processor, which is not slower there.
    return any(re.search(r'\b(radeon|amd|intel\(r\) arc|arc)\b', name.lower()) for name in video_cards(run))


def engine_for(which=shutil.which, run=subprocess.run, system=None):
    """The fastest engine this machine has: NVIDIA's CUDA, then Vulkan, then the processor."""
    if has_nvidia(which, run):
        return 'cuda'
    if has_vulkan_card(run, system):
        return 'vulkan'
    return 'islemci'


def installed_engine(state):
    """The engine `kur` set up, as its marker says; the processor when it says none."""
    try:
        marker = json.loads((ses_dir(state) / MARKER).read_text(encoding='utf-8'))
        engine = marker.get('motor') or ('cuda' if marker.get('ekran_karti') else None)
    except (OSError, ValueError, AttributeError):
        engine = None
    return engine if engine in ENGINES else 'islemci'


def engine_in_use(state, config=None):
    """The engine the helper writes with: the one chosen in the settings, else the installed one."""
    chosen = (config or load_config(state)).get('motor')
    return chosen if chosen in ENGINES else installed_engine(state)


def server_exe(state):
    return ses_dir(state) / VULKAN_DIR / SERVER_EXE


def ggml_model(state):
    return ses_dir(state) / GGML_DIR / GGML_MODEL['ad']


def packages_for(engine):
    if engine == 'vulkan':
        return list(BASE_PACKAGES)
    return list(FASTER_PACKAGES) + list(BASE_PACKAGES) + (list(NVIDIA_PACKAGES) if engine == 'cuda' else [])


def install_plan(state, which=shutil.which, run=subprocess.run, system=None):
    chosen = load_config(state).get('motor')
    engine = chosen if chosen in ENGINES else engine_for(which, run, system)
    return {
        'klasor': str(ses_dir(state)),
        'python': python_for_env(which, run),
        'motor': engine,
        'paketler': packages_for(engine),
        'ekran_karti': engine in ('cuda', 'vulkan'),
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


def _download_checked(url, target, sha256, say=print):
    """A file over HTTPS, its digest checked before it takes its name; a wrong one is removed."""
    import hashlib
    from urllib.request import urlopen
    if not url.startswith('https://'):
        raise ValueError('Yalnız HTTPS adresinden indirilir: ' + url)
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + '.part')
    digest, done, told = hashlib.sha256(), 0, 0
    with urlopen(url, timeout=60) as response, open(part, 'wb') as out:
        total = int(response.headers.get('Content-Length') or 0) if getattr(response, 'headers', None) else 0
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
            done += len(chunk)
            if total and done * 10 // total > told:  # every tenth: a big model is not silence for minutes
                told = done * 10 // total
                say('  %%%d (%d / %d MB)' % (told * 10, done >> 20, total >> 20))
    if sha256 and digest.hexdigest() != sha256:
        part.unlink(missing_ok=True)
        raise ValueError('İndirilen dosya beklenen dosya değil (SHA-256 tutmadı): ' + target.name)
    os.replace(part, target)
    return target


def _sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _unpack(archive, folder):
    """The archive's one top folder (Vosk's) or its files (whisper-vulkan's) become `folder`;
    nothing is written outside it."""
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


def _vulkan_ready(state, say, download_checked):
    """whisper.cpp's Vulkan server and its model in place; False when the build cannot be had."""
    exe = server_exe(state)
    if not exe.is_file():
        if not VULKAN_BUILD['sha256']:
            say('Vulkan derlemesi bu sürümde henüz yayımlanmadı.')
            return False
        say('whisper.cpp (Vulkan) indiriliyor…')
        archive = ses_dir(state) / 'whisper-vulkan.zip'
        try:
            download_checked(VULKAN_BUILD['url'], archive, VULKAN_BUILD['sha256'], say)
            _unpack(archive, exe.parent)  # the same guarded unpack: nothing outside the folder
        except Exception as exc:
            say('whisper.cpp (Vulkan) indirilemedi: ' + str(exc)[:200])
            return False
        finally:
            archive.unlink(missing_ok=True)
        if not exe.is_file():
            return False
    model = ggml_model(state)
    if not (model.is_file() and model.stat().st_size == GGML_MODEL['boyut']):
        say('whisper.cpp modeli indiriliyor (yaklaşık 1,6 GB)…')
        download_checked(GGML_MODEL['url'], model, GGML_MODEL['sha256'], say)
    return True


def install(state, say=print, run=subprocess.run, download=_download, which=shutil.which, download_checked=_download_checked, system=None):
    """Build the environment, install the packages, fetch the models. Each step says what it does."""
    plan = install_plan(state, which, run, system)
    folder = ses_dir(state)
    folder.mkdir(parents=True, exist_ok=True)
    say('Python: ' + plan['python'])
    say('Motor: ' + {'cuda': 'NVIDIA ekran kartı (CUDA)', 'vulkan': 'AMD/Intel ekran kartı (Vulkan, whisper.cpp)',
                     'islemci': 'işlemci'}[plan['motor']])
    if plan['motor'] == 'vulkan' and not _vulkan_ready(state, say, download_checked):
        say('İşlemciye geçiliyor.')
        plan.update(motor='islemci', paketler=packages_for('islemci'), ekran_karti=False)
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
            _unpack(archive, folder / VOSK_DIR)
        finally:
            Path(archive).unlink(missing_ok=True)
    # The marker first, so the helper's trial load below writes with the engine just set up.
    if not (folder / CONFIG).is_file():
        save_config(state, load_config(state))
    marker = {'schema': 1, 'python': plan['python'], 'motor': plan['motor'], 'ekran_karti': plan['ekran_karti']}
    try:
        previous = (folder / MARKER).read_text(encoding='utf-8')  # a working install stays working if this one fails
    except OSError:
        previous = None
    (folder / MARKER).write_text(json.dumps(marker, ensure_ascii=False) + '\n', encoding='utf-8')
    say('Whisper modeli hazırlanıyor' + (' (ilk seferde yaklaşık 1,6 GB iner)…' if plan['motor'] != 'vulkan' else '…'))
    done = run(worker_command(state, '--indir'), capture_output=True, text=True, encoding='utf-8', errors='replace',
               timeout=7200, env=worker_env(state), creationflags=NO_WINDOW)
    if done.returncode:
        if previous is None:
            (folder / MARKER).unlink(missing_ok=True)
        else:
            (folder / MARKER).write_text(previous, encoding='utf-8')
        raise RuntimeError('Whisper modeli hazırlanamadı: ' + (done.stderr or done.stdout).strip()[-600:])
    model = (done.stdout or '').strip().splitlines()[-1:] or ['']
    marker['model'] = model[0]
    (folder / MARKER).write_text(json.dumps(marker, ensure_ascii=False) + '\n', encoding='utf-8')
    return {'status': 'kuruldu', 'klasor': str(folder), 'motor': plan['motor'], 'ekran_karti': plan['ekran_karti'], 'model': model[0]}


def status(state):
    marker = {}
    try:
        marker = json.loads((ses_dir(state) / MARKER).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        pass
    config = load_config(state)
    return {'kurulu': installed(state), 'acik': bool(config['acik']), 'uyandirma': bool(config['uyandirma']),
            'uyandirma_sozu': config['uyandirma_sozu'], 'otomatik_dinle': bool(config['otomatik_dinle']),
            'model': marker.get('model'), 'ekran_karti': marker.get('ekran_karti'),
            'motor': engine_in_use(state, config), 'klasor': str(ses_dir(state))}


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
                'Ctrl+Alt+C ile Not al\'ı aç: dinler halde açılır; konuş, bitince "Pyn, kaydet" de.\n'
                '"Pyn, not al" ile açmak için: beyin.py ses ayar --uyandirma ac')
    if command == 'durum':
        if not result['kurulu']:
            return 'Sesle yazma kurulu değil. Kurmak için: beyin.py ses kur'
        return ('Sesle yazma kurulu · ' + ('açık' if result['acik'] else 'kapalı') + ' · model ' + str(result.get('model')) +
                ' · motor ' + {'cuda': 'NVIDIA (CUDA)', 'vulkan': 'Vulkan (whisper.cpp)', 'islemci': 'işlemci'}.get(result.get('motor'), '?') +
                ' · uyandırma ' + ('açık ("' + result['uyandirma_sozu'] + '")' if result['uyandirma'] else 'kapalı'))
    if command == 'kaldir':
        return 'Sesle yazma kaldırıldı.' if result['status'] == 'kaldirildi' else 'Sesle yazma zaten kurulu değil.'
    if command == 'ayar':
        return ('Ayar kaydedildi.' + (' Yakala dinleyicisi yeniden başlatıldı.' if result.get('dinleyici') else '') +
                (' Bu motor kurulu değil; kurmak için: beyin.py ses kur' if result.get('kur_gerekli') else ''))
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
    setting.add_argument('--otomatik', choices=('ac', 'kapat'), help='Pencere açılınca kendiliğinden dinlesin mi')
    setting.add_argument('--ses', choices=('ac', 'kapat'), help='Sesle yazmayı aç ya da kapat')
    setting.add_argument('--model', help='Whisper modeli, örnek: large-v3-turbo, small')
    setting.add_argument('--motor', choices=('otomatik',) + ENGINES, help='Yazan motor: otomatik, cuda, vulkan ya da islemci')
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
        if args.json:
            # Each step its own line ({"adim": ...}), the result the last: the desktop app shows them as they come.
            utf8 = (getattr(sys.stdout, 'encoding', '') or '').lower().replace('-', '') in ('utf8', 'utf8sig')
            say = lambda text: print(json.dumps({'adim': text.strip()}, ensure_ascii=not utf8), flush=True)
        else:
            say = lambda text: print(text, flush=True)
        result = install(state, say=say)
        result['dinleyici'] = restart_listener(state)
    elif args.command == 'durum':
        result = status(state)
    elif args.command == 'kaldir':
        result = uninstall(state)
        result['dinleyici'] = restart_listener(state)
    elif args.command == 'ayar':
        config = load_config(state)
        if args.otomatik:
            config['otomatik_dinle'] = args.otomatik == 'ac'
        if args.uyandirma:
            config['uyandirma'] = args.uyandirma == 'ac'
        if args.ses:
            config['acik'] = args.ses == 'ac'
        if args.model:
            config['model'] = config['cpu_model'] = args.model
        if args.motor:
            config['motor'] = args.motor
        save_config(state, config)
        result = {'status': 'kaydedildi', **status(state),
                  'dinleyici': restart_listener(state) if args.ses or args.model or args.motor else False}
        if args.motor in ENGINES and installed(state) and args.motor != installed_engine(state):
            result['kur_gerekli'] = True  # another engine's packages or whisper.cpp: `kur` sets them up
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
beyin_v3_ses.Worker). It loads Whisper on the engine `ses kur` set up (whisper.cpp's server on a
Vulkan card, faster-whisper on CUDA, else on the processor), records the microphone on `dinle`, ends on silence, on "kaydet" at the end or on `bitir`, writes what was
said, and, when the wake word is on and nothing is being recorded, listens with a small Vosk
model for "Pyn, not al" and starts recording by itself. No audio is kept or sent anywhere.

Modes for the command line: `--indir` loads the model once (the install fetches it) and exits;
`--dene N` records N seconds, writes them and exits.
"""
import argparse
import io
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


def _tie(process):
    """The process dies with this helper, even when the helper itself is killed (a Windows job)."""
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', ctypes.c_ulonglong * 6),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    limits = Extended()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
    kernel32.AssignProcessToJobObject(job, int(process._handle))
    return job  # kept by the caller: when the last handle closes, the process goes with it


class Server:
    """whisper.cpp's own server, the model held warm on the card, on a free port of this machine only.

    It is asked like faster-whisper's model (`write`), so recording does not care which engine writes.
    """

    def __init__(self, exe, model, config, log, gpu=True):
        # exe: whisper-server.exe, or a command that starts a stand-in (the tests)
        import socket
        import subprocess
        from urllib.request import ProxyHandler, build_opener
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.url = 'http://127.0.0.1:%d' % self.port
        self.opener = build_opener(ProxyHandler({}))  # a system proxy never sees speech
        threads = max(1, min(8, (os.cpu_count() or 4) // 2))
        start = list(exe) if isinstance(exe, (list, tuple)) else [str(exe)]
        command = start + ['-m', str(model), '--host', '127.0.0.1', '--port', str(self.port),
                           '-l', config.get('dil') or 'auto', '-t', str(threads), '-nt']
        if config.get('ipucu'):
            command += ['--prompt', config['ipucu']]
        command += ['-dev', str(int(config.get('gpu') or 0))] if gpu else ['-ng']
        self.log = Path(log)
        with open(self.log, 'wb') as sink:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sink, stderr=sink,
                                            creationflags=0x08000000 if os.name == 'nt' else 0)
        self.job = _tie(self.process)
        try:
            self._wait()
            self.write(bytes(2 * RATE), config)  # the first answer builds the card's pipelines: not on the user's sentence
        except Exception:
            self.close()
            raise

    def _wait(self, limit=180):
        deadline = time.time() + limit
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError('whisper.cpp kapandı: ' + self._tail())
            try:
                with self.opener.open(self.url + '/', timeout=2):
                    return
            except OSError:
                time.sleep(0.25)
        raise RuntimeError('whisper.cpp hazır olmadı: ' + self._tail())

    def _tail(self):
        try:
            return self.log.read_text(encoding='utf-8', errors='replace').strip()[-400:]
        except OSError:
            return ''

    def write(self, audio, config):
        import uuid
        import wave
        from urllib.request import Request
        if isinstance(audio, bytes):
            pcm = audio  # already 16-bit samples
        else:
            import numpy as np
            pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
        sound = io.BytesIO()
        with wave.open(sound, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(pcm)
        boundary = uuid.uuid4().hex
        body = b''
        for name, value in (('response_format', 'json'), ('temperature', '0.0')):
            body += ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, name, value)).encode()
        body += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="ses.wav"\r\n'
                 'Content-Type: audio/wav\r\n\r\n' % boundary).encode() + sound.getvalue() + ('\r\n--%s--\r\n' % boundary).encode()
        request = Request(self.url + '/inference', data=body,
                          headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
        with self.opener.open(request, timeout=300) as response:
            answer = json.loads(response.read().decode('utf-8'))
        if 'error' in answer:
            raise RuntimeError('whisper.cpp: ' + str(answer['error'])[:300])
        return ' '.join(line.strip() for line in str(answer.get('text', '')).splitlines() if line.strip())

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except Exception:
                self.process.kill()


def _silence():
    import numpy as np
    return np.zeros(RATE, dtype='float32')


def load_model(state, config):
    """(model, what it is), on the engine `ses kur` set up; a failed card says why on stderr (isci.log)."""
    engine = ses.engine_in_use(state, config)
    if engine == 'vulkan':
        exe, model, log = ses.server_exe(state), ses.ggml_model(state), ses.ses_dir(state) / 'whisper-server.log'
        name = ses.GGML_MODEL['ad'][len('ggml-'):-len('.bin')]
        try:
            return Server(exe, model, config, log), name + ' (ekran kartı, Vulkan)'
        except Exception as exc:
            print('Vulkan açılamadı, işlemciye geçiliyor: ' + str(exc)[:400], file=sys.stderr, flush=True)
        # This environment has no faster-whisper: whisper.cpp itself writes on the processor.
        return Server(exe, model, config, log, gpu=False), name + ' (işlemci, whisper.cpp)'
    if engine == 'cuda':
        try:
            _cuda_dirs()
            model = _open(config['model'], 'cuda', 'float16')
            list(model.transcribe(_silence(), language=config['dil'])[0])  # CUDA loads on first use
            return model, config['model'] + ' (ekran kartı, CUDA)'
        except Exception as exc:
            print('CUDA açılamadı, işlemciye geçiliyor: ' + str(exc)[:400], file=sys.stderr, flush=True)
    return _open(config['cpu_model'], 'cpu', 'int8'), config['cpu_model'] + ' (işlemci)'


def release(model):
    """whisper.cpp's server stops with the helper; faster-whisper's model needs nothing."""
    if isinstance(model, Server):
        model.close()


def transcribe(model, audio, config, lock):
    with lock:
        if isinstance(model, Server):
            return model.write(audio, config)
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


def _device_name(config):
    """The microphone listened to, by the name the system gives it; empty when it cannot say."""
    try:
        import sounddevice as sd
        index = _device(config)
        return str(sd.query_devices(index if index is not None else sd.default.device[0])['name'])
    except Exception:
        return ''


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
            # Clearly above the room's noise: speech. Low enough for a headset mic with little gain.
            if rms > max(0.0025, self.floor * 5):
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
        # A grammar, not free listening: the model knows no "Pyn" and would never write it.
        self.recognizer = KaldiRecognizer(self.model, RATE, ses.wake_grammar(self.phrase))
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
            loaded['model'], what = load_model(state, config)
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
        out(olay='dinliyor', mikrofon=_device_name(config))
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
                text = ses.clean_spoken(transcribe(loaded['model'], audio, config, lock))
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
                release(loaded.get('model'))
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
        model, what = load_model(state, config)
        release(model)
        print(what, flush=True)
        return 0
    if args.dene:
        model, what = load_model(state, config)
        try:
            recorder = Recorder(config)
            recorder.start()
            time.sleep(args.dene)
            audio = recorder.stop()
            started = time.time()
            text = transcribe(model, audio, config, threading.Lock())
        finally:
            release(model)
        print(json.dumps({'metin': text, 'model': what, 'sure_sn': round(time.time() - started, 2)}, ensure_ascii=False), flush=True)
        return 0
    return serve(state, config)


if __name__ == '__main__':
    sys.exit(main())
'''


if __name__ == '__main__':
    sys.exit(main())

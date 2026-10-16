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
    # Said alone, with or without Pyn's name before: "sil" empties the field, "iptal" closes it.
    # "kaydet" and taking the last word or sentence back count at a sentence's end too.
    'komutlar': {
        'kaydet': ['kaydet'],
        'sil': ['sil', 'temizle', 'hepsini sil'],
        'kelime_sil': ['son kelimeyi sil'],
        'cumle_sil': ['son cümleyi sil'],
        'iptal': ['iptal', 'vazgeç'],
    },
    # These save only right after Pyn's name ("…, Pyn gönder"); anywhere else they are the note's words.
    'adla_kaydet': ['gönder', 'tamam', 'bitti', 'bitir'],
    'surekli_bekle_sn': 24,         # a dictation nobody speaks into for this long ends by itself
}
# A heard "not al" after a word the small model does not know is checked by Whisper on the last
# few seconds of sound, the rest of the phrase included: it waits this long after it for that.
WAKE_CLIP_SN = 4.0
WAKE_AFTER_SN = 0.6


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


COMMANDS = tuple(DEFAULTS['komutlar'])
# Commands that count at the end of a sentence too ("…, kaydet"); the others only said alone.
AT_END = ('kaydet', 'kelime_sil', 'cumle_sil')
# A command's words as earlier versions wrote them into every settings file: the new default.
OLD_COMMANDS = {'sil': (['sil', 'temizle'],)}
# What a person may set a command's words to.
MOST_PHRASES, LONGEST_PHRASE = 8, 40
# What a running helper takes up when the settings file changes (`ayar`); the rest needs a restart.
LIVE_SETTINGS = ('komutlar', 'adla_kaydet', 'sessizlik_sn', 'en_uzun_sn', 'surekli_bekle_sn', 'ipucu')


def load_config(state):
    config = json.loads(json.dumps(DEFAULTS))
    try:
        saved = json.loads((ses_dir(state) / CONFIG).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return config
    if isinstance(saved, dict):
        for key, value in saved.items():
            if key == 'komutlar' and isinstance(value, dict):
                config['komutlar'].update({k: list(v) for k, v in value.items()
                                           if isinstance(v, list) and list(v) not in OLD_COMMANDS.get(k, ())})
            elif key in DEFAULTS:
                config[key] = value
    return config


def commands_from(text, config):
    """(komutlar, adla_kaydet) from `ses ayar --komutlar` JSON: {command: [words], ...} and
    'adla_kaydet', each given replacing that list, the rest kept. Each phrase tidied; a phrase
    said for two things, one too long, or one without a word is refused, so the setting is
    always one the helper can tell apart."""
    try:
        asked = json.loads(text)
    except ValueError:
        asked = None
    if not isinstance(asked, dict):
        raise SystemExit('Komutlar JSON olarak verilmeli: {"kaydet": ["kaydet", "tamam"]}')
    commands = {name: list(config['komutlar'].get(name, DEFAULTS['komutlar'][name])) for name in COMMANDS}
    after_name = list(config.get('adla_kaydet') or [])
    for name, phrases in asked.items():
        if name not in COMMANDS + ('adla_kaydet',):
            raise SystemExit('Bilinmeyen komut: %s (%s)' % (name, ', '.join(COMMANDS + ('adla_kaydet',))))
        if not isinstance(phrases, list) or not all(isinstance(one, str) for one in phrases):
            raise SystemExit('%s: sözler bir liste olmalı' % name)
        kept = []
        for phrase in phrases:
            phrase = ' '.join(phrase.split())
            if not phrase:
                continue
            if len(phrase) > LONGEST_PHRASE:
                raise SystemExit('“%s…” çok uzun; bir komut en fazla %d harf' % (phrase[:20], LONGEST_PHRASE))
            if not words(phrase):
                raise SystemExit('“%s” bir kelime değil' % phrase)
            if ' '.join(words(phrase)) not in {' '.join(words(one)) for one in kept}:
                kept.append(phrase)
        if len(kept) > MOST_PHRASES:
            raise SystemExit('%s: en fazla %d söz' % (name, MOST_PHRASES))
        if name == 'adla_kaydet':
            after_name = kept
        else:
            commands[name] = kept
    owner = {}
    for name, phrases in list(commands.items()) + [('adla_kaydet', after_name)]:
        for phrase in phrases:
            said = ' '.join(words(phrase))
            if owner.get(said, name) != name and {owner[said], name} != {'kaydet', 'adla_kaydet'}:
                raise SystemExit('“%s” iki komutta birden var; hangisi olduğunu ayırt edemem' % phrase)
            owner.setdefault(said, name)
    return commands, after_name


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
# How recognizers spell the name they hear as "pin" or "payn" (Whisper: "Payn", "Pain", "Payın").
NAME_SPELLINGS = {'pyn', 'pin', 'pinn', 'pen', 'pine', 'bin', 'fin', 'pay', 'bayan', 'payn', 'pain', 'payin', 'bayin', 'pyne'}
# How the name is said: a heard word close to it is the name, as one close to how it is written is.
NAME_SAID = 'payn'
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


def _name_like(word, head):
    """Whether a heard word is the phrase's name: one of its spellings, or close to how it is
    written or, for Pyn, said."""
    if word == head or word in NAME_SPELLINGS:
        return True
    forms = (head, NAME_SAID) if head == 'pyn' else (head,)
    return any(difflib.SequenceMatcher(None, word, form).ratio() >= 0.6 for form in forms)


def _apart(got, said, ends=None):
    """Heard words with the phrase's own words written as one taken apart: Whisper writes
    "not al" as "notal" too. With `ends` (where each word ends in the text), theirs alongside."""
    joined = {''.join(said[i:j]): said[i:j] for i in range(len(said)) for j in range(i + 2, len(said) + 1)}
    words_out, ends_out = [], []
    for at, word in enumerate(got):
        parts = joined.get(word, [word])
        words_out.extend(parts)
        if ends is not None:
            ends_out.extend([ends[at]] * len(parts))
    return (words_out, ends_out) if ends is not None else words_out


def wake_heard(text, phrase=DEFAULTS['uyandirma_sozu']):
    """Whether the wake phrase is in what was heard. The rest of the phrase must be there as
    said ("not al", or "notal" as one word); the name before it is matched loosely, since nobody
    spells "Pyn" alike."""
    want = words(phrase)
    got = _apart(words(text), want)
    if not want:
        return False
    head, tail = want[0], want[1:]
    for at in range(len(got) - len(want) + 1):
        window = got[at:at + len(want)]
        if window[1:] == tail and _name_like(window[0], head):
            return True
    return False


def wake_verdict(text, phrase=DEFAULTS['uyandirma_sozu']):
    """What the wake listener's words say: 'soz' when the phrase is there, name and all; 'aday'
    when only the rest of it is ("not al"), after a word the small model does not know or after
    nothing. Said by a real voice, the name is mostly such a word: whether it was Pyn's name,
    Whisper decides from the sound (wake_heard on what it writes). None otherwise."""
    if wake_heard(text, phrase):
        return 'soz'
    tail = words(phrase)[1:]
    got = _apart(words(text), words(phrase))
    if tail and any(got[at:at + len(tail)] == tail for at in range(len(got) - len(tail) + 1)):
        return 'aday'
    return None


def wake_grammar(phrase=DEFAULTS['uyandirma_sozu']):
    """What the wake listener may hear, as a Vosk grammar (JSON): the wake phrase with Pyn's name
    and the sound-alikes the model knows, the rest of the phrase alone, everything else "[unk]".
    The model knows no "pyn": it leaves the word out, so "not al" was in the grammar already, and
    a real voice saying "payn" is mostly heard as "[unk] not al". "bunu not al" is heard so too:
    "not al" is never the phrase by itself, only a candidate Whisper checks (wake_verdict)."""
    said = words(phrase)
    if not said:
        return json.dumps(['[unk]'])
    head, tail = said[0], ' '.join(said[1:])
    names = [head] + [name for name in WAKE_NAMES if name != head]
    phrases = [(name + ' ' + tail).strip() for name in names] + ([tail] if tail else [])
    return json.dumps(phrases + ['[unk]'], ensure_ascii=False)


def without_wake(text, phrase=DEFAULTS['uyandirma_sozu']):
    """Dictation begun by the wake phrase, without what of the phrase its recording caught at the
    start ("al.", "not al,", "Pyn, not al"): the note begins after it."""
    said = words(phrase)
    got, ends = _apart(words(text), said, [m.end() for m in re.finditer(r'\w+', tr_lower(text))])
    for size in range(len(said), 0, -1):
        if len(got) < size or got[1:size] != said[len(said) - size + 1:]:
            continue
        first = said[len(said) - size]
        if got[0] == first or (size == len(said) and _name_like(got[0], first)):
            return text[ends[size - 1]:].lstrip(' ,.;:!?…-').strip()
    return text.strip()


def mic_label(name, names=()):
    """A microphone's name for a person: whole where Windows' oldest sound API cut it at 31
    letters (another API lists it whole), and its own name without "Microphone (…)" around it."""
    name = (name or '').strip()
    if len(name) >= 31:
        longer = [one for one in names if isinstance(one, str) and one.startswith(name) and len(one) > len(name)]
        if longer:
            name = min(longer, key=len)
    inner = re.match(r'^(?:microphone|mikrofon|mic)\s*\((.+?)\)?$', name, re.IGNORECASE)
    return inner.group(1).strip() if inner else name


def _without_last_words(text, count):
    """The text with its last `count` words taken off, its punctuation tidied."""
    spans = [m.start() for m in re.finditer(r'\w+', tr_lower(text))]
    if count > len(spans):
        return ''
    return text[:spans[-count]].rstrip(' ,.;:!?…') if count else text.strip()


def _named(word):
    """Whether a word is Pyn's name however Whisper wrote it (Pyn, pin, Payn, pen...). Not the
    small model's sound-alikes (WAKE_NAMES): those are Turkish words, and in a note "on bin
    kaydet" or "Ali'ye beş bin gönder" is about a thousand."""
    return (word in NAME_SPELLINGS or word == 'pyn') and word not in WAKE_NAMES


def command_of(text, commands=None, after_name=None):
    """(command, text to write) for what was said.

    "kaydet" counts only at the very end ("Toplantı notu, kaydet" writes and saves), as do
    "son kelimeyi sil" and "son cümleyi sil" (the window writes, then takes the word or the
    sentence back); "sil" ("hepsini sil") and "iptal" only when said alone. Anywhere else a command word is just a word: "notu kaydettim"
    and "bu satırı sil" are written as they are. Pyn's name may come before the command, as
    the wake phrase is said: "…, Pyn kaydet" saves and the name is not written. `after_name`
    ("gönder", "tamam"…) save too, but only right after the name: "Ali'ye gönder" is a note.
    """
    commands = commands or DEFAULTS['komutlar']
    after_name = DEFAULTS['adla_kaydet'] if after_name is None else after_name
    said = words(text)
    if not said:
        return None, ''
    whole = ' '.join(said)
    named_saves = {' '.join(words(p)) for p in after_name}
    for name in COMMANDS:
        spoken = {' '.join(words(p)) for p in commands.get(name, ())}
        named = spoken | named_saves if name == 'kaydet' else spoken
        if whole in spoken or (len(said) > 1 and _named(said[0]) and ' '.join(said[1:]) in named):
            return name, ''
    at_end = [(name, words(p)) for name in AT_END for p in commands.get(name, ())]
    for name, wanted in sorted(at_end, key=lambda one: len(one[1]), reverse=True):
        if wanted and len(said) >= len(wanted) and said[-len(wanted):] == wanted:
            cut = len(wanted) + (1 if len(said) > len(wanted) and _named(said[-len(wanted) - 1]) else 0)
            return name, _without_last_words(text, cut)
    for wanted in sorted((words(p) for p in after_name), key=len, reverse=True):
        if wanted and len(said) > len(wanted) and said[-len(wanted):] == wanted and _named(said[-len(wanted) - 1]):
            return 'kaydet', _without_last_words(text, len(wanted) + 1)
    return None, text.strip()


# What Whisper writes for silence or noise, learnt from its subtitle training: never a note.
HALLUCINATIONS = {
    'altyazi m k', 'altyazilar m k', 'altyazi mk', 'izlediginiz icin tesekkurler', 'izlediginiz icin tesekkur ederim',
    'abone olmayi unutmayin', 'begenmeyi ve abone olmayi unutmayin', 'blank audio', 'blank_audio', 'muzik', 'alkis',
    'thank you for watching', 'thanks for watching', 'subtitles by the amara org community',
}


def clean_spoken(text, prompt=None):
    """What was written from speech, without what Whisper makes up for silence: a bracketed
    sound ("[Müzik]"), a subtitle line or the prompt it was given said back. Whole, or at the
    end, after the words: "…, Pyn kaydet. Altyazı M.K." still ends with the command."""
    text = ' '.join(re.sub(r'\[[^\]]*\]', ' ', text or '').split())
    if ' '.join(words(text)) in HALLUCINATIONS:
        return ''
    made_up = [line.split() for line in HALLUCINATIONS if ' ' in line] + ([words(prompt)] if prompt and words(prompt) else [])
    trimmed = True
    while trimmed and text:
        trimmed, said = False, words(text)
        for line in sorted(made_up, key=len, reverse=True):
            if len(said) >= len(line) and said[-len(line):] == line:
                text, trimmed = _without_last_words(text, len(line)), True
                break
    return text.strip()


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
            'motor': engine_in_use(state, config), 'klasor': str(ses_dir(state)),
            'komutlar': config['komutlar'], 'adla_kaydet': list(config.get('adla_kaydet') or [])}


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


def trial_line(event):
    """A line of `ses dene --uyandirma` for a person, from one of the helper's events; None for
    one that says nothing to them."""
    kind = event.get('olay')
    if kind == 'dinliyor':
        return ('%g saniye dinliyorum · %s · Whisper: %s\n"%s" de; birkaç kez, farklı tonlarda dene.'
                % (event.get('sn') or 0, event.get('mikrofon') or 'varsayılan mikrofon', event.get('model') or '?',
                   'Pyn, ' + ' '.join(words(event.get('soz') or '')[1:]) if event.get('soz') else 'Pyn, not al'))
    if kind == 'duyulan':
        return '  küçük model: ' + str(event.get('metin') or '')
    if kind == 'karar' and event.get('karar') == 'soz':
        return '  → sözü tam duydu: pencere açılırdı ✓'
    if kind == 'karar':
        return '  → Whisper: “%s” · %s' % (event.get('whisper') or '', 'pencere açılırdı ✓' if event.get('uyanir')
                                          else 'Pyn\'in adını duymadı, pencere açılmazdı ✗')
    return None


def trial_wake(state, seconds, as_json, popen=subprocess.Popen, say=print):
    """`ses dene --uyandirma`: the helper's wake trial, each thing it hears said as it comes."""
    process = popen(worker_command(state, '--dene-uyandirma', str(seconds)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding='utf-8', errors='replace', env=worker_env(state), creationflags=NO_WINDOW)
    utf8 = (getattr(sys.stdout, 'encoding', '') or '').lower().replace('-', '') in ('utf8', 'utf8sig')
    decided, other = 0, []
    for line in process.stdout:
        line = line.strip()
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        if not isinstance(event, dict):
            if line:
                other.append(line)
            continue
        decided += event.get('olay') == 'karar'
        text = json.dumps(event, ensure_ascii=not utf8) if as_json else trial_line(event)
        if text:
            say(text)
    if process.wait():
        raise SystemExit('\n'.join(other)[-600:] or 'Ses yardımcısı bir hatayla kapandı.')
    if not as_json and not decided:
        say('"not al" hiç duyulmadı. Doğru mikrofon mu dinleniyor? `beyin.py ses dene` söylediğini yazıya çevirip gösterir.')
    return 0


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
    setting.add_argument('--komutlar', help='Sesli komutların sözleri, JSON: {"kaydet": ["kaydet", "tamam"], "adla_kaydet": ["gönder"]}')
    setting.add_argument('--varsayilan-komutlar', action='store_true', help='Sesli komutları ilk hallerine döndür')
    trial = sub.add_parser('dene', help='Birkaç saniye kaydedip yazıya çevir')
    trial.add_argument('--sn', type=float, help='Kaç saniye (5; --uyandirma ile 20)')
    trial.add_argument('--uyandirma', action='store_true', help='"Pyn, not al"ı dinle: ne duyduğunu ve pencerenin açılıp açılmayacağını söyler')
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
        if args.varsayilan_komutlar:
            config['komutlar'] = json.loads(json.dumps(DEFAULTS['komutlar']))
            config['adla_kaydet'] = list(DEFAULTS['adla_kaydet'])
        if args.komutlar is not None:
            config['komutlar'], config['adla_kaydet'] = commands_from(args.komutlar, config)
        save_config(state, config)
        result = {'status': 'kaydedildi', **status(state),
                  'dinleyici': restart_listener(state) if args.ses or args.model or args.motor else False}
        if args.motor in ENGINES and installed(state) and args.motor != installed_engine(state):
            result['kur_gerekli'] = True  # another engine's packages or whisper.cpp: `kur` sets them up
    else:
        if not installed(state):
            raise SystemExit('Sesle yazma kurulu değil. Kurmak için: beyin.py ses kur')
        if args.uyandirma:
            return trial_wake(state, args.sn or 20.0, args.json)
        done = subprocess.run(worker_command(state, '--dene', str(args.sn or 5.0)), capture_output=True, text=True, encoding='utf-8',
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
Vulkan card, faster-whisper on CUDA, else on the processor), records the microphone on `dinle`,
writes what was said, and, when the wake word is on and nothing is being recorded, listens with a
small Vosk model for "Pyn, not al" and starts recording by itself. No audio is kept or sent anywhere.

A dictation (`dinle` with `surekli`, and every one the wake phrase begins) is one recording: each
pause hands the sentence to Whisper and the microphone stays open, so nothing said while a
sentence is written is lost. Its sentences come back in order as `metin` events with `son`
false; the last one, `son` true, ends it: "kaydet" said, `bitir`, `iptal`, or a long silence.

Modes for the command line: `--indir` loads the model once (the install fetches it) and exits;
`--dene N` records N seconds, writes them and exits; `--dene-uyandirma N` listens for the wake
phrase N seconds and says what it hears and what it would do.
"""
import argparse
import collections
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
# A sentence is kept from a little before its speech to a little after: Whisper given a long
# silence makes words up ("Altyazı M.K."), and quiet word endings are below the speech level.
LEAD_SN, TAIL_SN = 0.3, 0.4
now = time.time
_writing = threading.Lock()


def out(**event):
    # One write a line, under a lock: the loader's thread speaks too, and half a line is no event.
    line = json.dumps(event, ensure_ascii=False) + '\n'
    with _writing:
        sys.stdout.write(line)
        sys.stdout.flush()


def log(text):
    """A line for isci.log (the helper's stderr): what the wake listener decided, never what was said."""
    print(time.strftime('%Y-%m-%d %H:%M:%S ') + text, file=sys.stderr, flush=True)


def join_audio(*parts):
    import numpy as np
    parts = [part for part in parts if part is not None and len(part)]
    return np.concatenate(parts) if parts else np.zeros(0, dtype='float32')


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
        devices = sd.query_devices()
        name = devices[index if index is not None else sd.default.device[0]]['name']
        return ses.mic_label(str(name), [str(device['name']) for device in devices])
    except Exception:
        return ''


class Recorder:
    """The microphone into memory, with its level and whether someone has spoken.

    A dictation is one stream: `cut` takes the sentence said so far and the recording goes on,
    so nothing is lost while a sentence is written. A sentence is kept from a little before its
    speech to a little after it (LEAD_SN, TAIL_SN).
    """

    def __init__(self, config):
        self.config = config
        self.stream = None
        self.level = 0.0
        self.guard = threading.Lock()  # the stream's thread appends while the loop cuts
        self._sentence(now())

    def _sentence(self, at):
        # Positions are samples into the sentence: where its speech starts and where it last was.
        self.chunks, self.count, self.run_from = [], 0, 0
        self.spoke, self.started, self.last_voice = False, at, at
        self.voice_from = self.voice_to = None

    def start(self, on_chunk=None):
        import sounddevice as sd
        self.level, self.floor, self.loud = 0.0, 1.0, 0
        self._sentence(now())
        self.on_chunk = on_chunk

        def take(data, _frames, _time, _status):
            if self.on_chunk is not None:
                self.on_chunk(data.copy())
                return
            rms = float((data ** 2).mean() ** 0.5)
            with self.guard:
                at = self.count
                self.chunks.append(data.copy())
                self.count += len(data)
                self.level = float(abs(data).max())
                self.floor = min(rms, self.floor * 1.02 + 1e-6)
                # Clearly above the room's noise: speech. Low enough for a headset mic with little gain.
                if rms > max(0.0025, self.floor * 5):
                    self.loud += 1
                    if self.loud == 1:
                        self.run_from = at
                    if self.loud >= 3:
                        self.spoke = True
                        if self.voice_from is None:
                            self.voice_from = self.run_from
                    self.voice_to = self.count
                    self.last_voice = now()
                else:
                    self.loud = 0

        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype='float32', device=_device(self.config), callback=take)
        self.stream.start()

    def _speech(self, chunks, start, end):
        """The sentence's sound; only its speech, a little either side, when someone spoke."""
        import numpy as np
        if not chunks:
            return np.zeros(0, dtype='float32')
        audio = np.concatenate(chunks)[:, 0]
        if start is None or end is None:
            return audio
        return audio[max(0, start - int(LEAD_SN * RATE)):end + int(TAIL_SN * RATE)]

    def cut(self):
        """The sentence said so far; the stream goes on into the next one."""
        with self.guard:
            chunks, start, end = self.chunks, self.voice_from, self.voice_to
            self._sentence(now())
        return self._speech(chunks, start, end)

    def peek(self):
        """What it recorded since the last cut, all of it, without taking it."""
        with self.guard:
            chunks = list(self.chunks)
        return self._speech(chunks, None, None)

    def stop(self):
        """The microphone let go; what was said since the last cut. `spoke` still says whether
        anyone did."""
        if self.stream is not None:
            self.stream.stop()
            self.stream.close()
            self.stream = None
        with self.guard:
            chunks, start, end = self.chunks, self.voice_from, self.voice_to
            self.chunks = []
        return self._speech(chunks, start, end)


class Wake:
    """"Pyn, not al" heard with a small Vosk model: cheap enough to run while nobody speaks to Pyn.

    It keeps the last few seconds it heard (WAKE_CLIP_SN), so a heard "not al" can be checked by
    Whisper on the sound itself.
    """

    def __init__(self, state, config):
        from vosk import KaldiRecognizer, Model, SetLogLevel
        SetLogLevel(-1)
        self.phrase = config['uyandirma_sozu']
        self.model = Model(str(ses.ses_dir(state) / ses.VOSK_DIR))
        # A grammar, not free listening: the model knows no "Pyn" and would never write it.
        self.recognizer = KaldiRecognizer(self.model, RATE, ses.wake_grammar(self.phrase))
        self.audio = queue.Queue()
        self.recent, self.kept = collections.deque(), 0
        self.text, self.last_seen = '', ''
        self.recorder = Recorder(config)

    def start(self):
        self.recognizer.Reset()
        self.recent.clear()
        self.kept = 0
        self.recorder.start(on_chunk=self.audio.put)

    def stop(self):
        self.recorder.stop()
        self._drain()  # what arrived and was not listened to yet is the clip's end

    @property
    def running(self):
        return self.recorder.stream is not None

    def _keep(self, chunk):
        self.recent.append(chunk)
        self.kept += len(chunk)
        while self.recent and self.kept - len(self.recent[0]) >= ses.WAKE_CLIP_SN * RATE:
            self.kept -= len(self.recent.popleft())

    def _drain(self):
        while True:
            try:
                self._keep(self.audio.get_nowait())
            except queue.Empty:
                return

    def clip(self):
        """The last few seconds it heard."""
        self._drain()
        return join_audio(*[chunk[:, 0] for chunk in self.recent])

    def forget(self):
        """A candidate dealt with: the next one is judged on its own sound."""
        self.recognizer.Reset()
        self.recent.clear()
        self.kept = 0

    def heard(self, seen=None):
        """What the small model made of what arrived since the last call: 'soz', 'aday' or None
        (ses.wake_verdict); `text` is what it heard then. `seen` is given each new thing it heard."""
        import numpy as np
        while True:
            try:
                chunk = self.audio.get_nowait()
            except queue.Empty:
                return None
            self._keep(chunk)
            pcm = (np.clip(chunk[:, 0], -1, 1) * 32767).astype('<i2').tobytes()
            if self.recognizer.AcceptWaveform(pcm):
                text = json.loads(self.recognizer.Result()).get('text', '')
            else:
                text = json.loads(self.recognizer.PartialResult()).get('partial', '')
            if seen is not None and text and text != self.last_seen:
                seen(text)
            if text:
                self.last_seen = text
            verdict = ses.wake_verdict(text, self.phrase) if text else None
            if verdict:
                self.text, self.last_seen = text, ''
                self.recognizer.Reset()
                return verdict


def serve(state, config, lines=None):
    """The helper's loop: commands from `lines` (stdin), events out. Whisper writes on a thread of
    its own, one piece at a time and in the order said; everything else happens on this one."""
    commands = queue.Queue()

    def read():
        for line in (sys.stdin if lines is None else lines):
            try:
                commands.put(json.loads(line))
            except ValueError:
                continue
        commands.put({'komut': 'kapat'})

    threading.Thread(target=read, daemon=True).start()
    out(olay='yukleniyor')
    loaded, lock = {}, threading.Lock()
    jobs, written = queue.Queue(), queue.Queue()

    def load():
        try:
            loaded['model'], what = load_model(state, config)
            out(olay='hazir', aciklama=what)
        except Exception as exc:
            out(olay='hata', neden='model', mesaj=str(exc)[:300])

    def write():
        while True:
            job = jobs.get()
            if job is None:
                return
            if job['audio'] is None or 'model' not in loaded:  # a dictation's end with nothing more to write: in its turn
                written.put(dict(job, metin=''))
                continue
            try:
                text = transcribe(loaded['model'], job['audio'], config, lock)
                written.put(dict(job, metin=ses.clean_spoken(text, config.get('ipucu'))))
            except Exception as exc:
                written.put(dict(job, hata=str(exc)[:300]))

    threading.Thread(target=load, daemon=True).start()
    threading.Thread(target=write, daemon=True).start()
    recorder, wake, wake_on = Recorder(config), None, bool(config.get('uyandirma'))
    mode, last_level = 'bos', 0.0
    # Each recording is a turn. What Whisper writes back names its turn: a turn ended by what
    # was said in it ("kaydet") is gone from `turns`, and nothing it still writes is news.
    turn, turns = 0, {}

    def begin(continuous=False, woke=False, checking=None):
        """Recording. `checking`: begun on a heard "not al" Whisper has yet to confirm; nobody is
        told until it does, and the sound since is already the dictation's start."""
        nonlocal mode, turn
        if wake is not None and wake.running:
            wake.stop()
        try:
            recorder.start()
        except Exception as exc:
            out(olay='hata', neden='mikrofon', mesaj=str(exc)[:300])
            return False
        mode, turn = 'kayit', turn + 1
        turns[turn] = {'continuous': continuous, 'woke': woke, 'first': True, 'checking': checking}
        if checking is None:
            out(olay='dinliyor', mikrofon=_device_name(config))
        return True

    def confirmed():
        turns[turn]['checking'] = None
        out(olay='dinliyor', mikrofon=_device_name(config))
        out(olay='uyandi', mikrofon=_device_name(config))

    def piece(audio, last):
        jobs.put({'is': 'parca', 'turn': turn, 'audio': audio, 'son': last})

    def end(keep=True):
        """The microphone let go: what was said since the last sentence is written, if anything
        was, and the dictation ends with it once what came before is written."""
        nonlocal mode
        audio = recorder.stop()
        # Nothing said (no speech above the room's noise): Whisper given silence makes words up.
        if keep and recorder.spoke and len(audio) >= RATE * 0.3 and 'model' in loaded:
            out(olay='ceviriyor')
            piece(audio, True)
        else:
            piece(None, True)
        mode = 'ceviri'

    def drop():
        """A recording nobody was told of, let go: it says nothing."""
        nonlocal mode
        recorder.stop()
        turns.pop(turn, None)
        mode = 'bos'

    def back(result):
        """What Whisper wrote, said, in the order it was said."""
        nonlocal mode
        info, own = turns.get(result['turn']), result['turn'] == turn
        if info is None:
            return
        if result['is'] == 'dogrula':
            if own and mode == 'kayit' and info['checking'] is not None:
                if 'hata' not in result and ses.wake_heard(result['metin'], config['uyandirma_sozu']):
                    log('uyandırma: küçük model "%s" duydu, Whisper doğruladı' % wake.text)
                    confirmed()
                else:
                    log('uyandırma: küçük model "%s" duydu, Whisper doğrulamadı' % wake.text)
                    drop()
            return
        if 'hata' in result:
            turns.pop(result['turn'], None)
            if own:
                if mode == 'kayit':
                    recorder.stop()
                mode = 'bos'
            out(olay='hata', neden='ceviri', mesaj=result['hata'])
            return
        text = result['metin']
        if info['woke'] and info['first']:
            text = ses.without_wake(text, config['uyandirma_sozu'])
        info['first'] = False
        command, text = ses.command_of(text, config['komutlar'], config.get('adla_kaydet'))
        last = result['son'] or command in ('kaydet', 'iptal')
        if last:
            turns.pop(result['turn'], None)
            if own:
                if mode == 'kayit':
                    recorder.stop()  # what was said after "kaydet" is not the note
                mode = 'bos'
            elif command not in ('kaydet', 'iptal'):
                # Ended while another recording began: its words go in, its end is not news.
                if text or command:
                    out(olay='metin', metin=text, komut=command, son=False)
                return
        elif not (text or command):
            return
        out(olay='metin', metin=text, komut=command, son=last)

    while True:
        try:
            command = commands.get(timeout=0.05)
        except queue.Empty:
            command = None
        while True:
            try:
                back(written.get_nowait())
            except queue.Empty:
                break
        checking = turns[turn]['checking'] if mode == 'kayit' and turn in turns else None
        if command:
            name = command.get('komut')
            if name == 'kapat':
                if recorder.stream is not None:
                    recorder.stop()
                if wake is not None and wake.running:
                    wake.stop()
                jobs.put(None)
                release(loaded.get('model'))
                return 0
            if name == 'dinle' and mode in ('bos', 'ceviri'):
                begin(continuous=bool(command.get('surekli')))
            elif name == 'dinle' and mode == 'kayit':
                # Asked to listen while it already does (a "not al" still being checked, too).
                turns[turn]['continuous'] = turns[turn]['continuous'] or bool(command.get('surekli'))
                if checking is not None:
                    turns[turn]['checking'] = checking = None
                out(olay='dinliyor', mikrofon=_device_name(config))
            elif name in ('bitir', 'iptal') and mode == 'kayit':
                if checking is not None:
                    drop()
                else:
                    end(keep=name == 'bitir')
            elif name == 'uyandirma':
                wake_on = bool(command.get('acik'))
            elif name == 'ayar':
                # The settings file changed: the commands and pauses count from the next sentence.
                try:
                    fresh = ses.load_config(state)
                except Exception:
                    fresh = {}
                config.update({key: fresh[key] for key in ses.LIVE_SETTINGS if key in fresh})
        moment = now()
        if mode == 'kayit' and checking is not None:
            if not checking['sent'] and moment - recorder.started >= ses.WAKE_AFTER_SN:
                checking['sent'] = True
                jobs.put({'is': 'dogrula', 'turn': turn, 'audio': join_audio(checking['clip'], recorder.peek()), 'son': False})
        elif mode == 'kayit':
            if moment - last_level >= 0.1:
                last_level = moment
                out(olay='seviye', deger=round(min(1.0, recorder.level * 4), 2))
            spoke_then_quiet = recorder.spoke and moment - recorder.last_voice > float(config['sessizlik_sn'])
            too_long = moment - recorder.started > float(config['en_uzun_sn'])
            if turns[turn]['continuous']:
                if recorder.spoke and (spoke_then_quiet or too_long):
                    piece(recorder.cut(), False)  # the sentence is written, the microphone stays open
                elif not recorder.spoke and moment - recorder.started > float(config['surekli_bekle_sn']):
                    end()  # nobody spoke for a long while: no microphone stays open by itself
            elif spoke_then_quiet or too_long:
                end()
            elif not recorder.spoke and moment - recorder.started > 12:
                end(keep=False)  # nothing said: let the microphone go
        elif mode == 'bos' and wake_on and 'model' in loaded:
            try:
                if wake is None:
                    wake = Wake(state, config)
                if not wake.running:
                    wake.start()
                else:
                    # Whatever the small model heard, the phrase whole or only "not al", Whisper
                    # checks it before a window opens: held to a grammar, the small model takes
                    # talk for the phrase (seen during a game), and a window must not open over it.
                    if wake.heard():
                        clip = wake.clip()
                        wake.stop()
                        begin(continuous=True, woke=True, checking={'clip': clip, 'sent': False})
            except Exception as exc:
                out(olay='hata', neden='uyandirma', mesaj=str(exc)[:300])
                wake_on = False
        elif wake is not None and wake.running and not wake_on:
            wake.stop()


def trial_wake(state, config, seconds):
    """`--dene-uyandirma N`: the wake listener for N seconds, saying what the small model hears
    and, for a heard "not al", what Whisper writes and whether the window would open."""
    model, what = load_model(state, config)
    try:
        wake = Wake(state, config)
        out(olay='dinliyor', model=what, soz=config['uyandirma_sozu'], sn=seconds, mikrofon=_device_name(config))
        wake.start()
        deadline = now() + seconds
        while now() < deadline:
            verdict = wake.heard(lambda text: out(olay='duyulan', metin=text))
            if verdict == 'soz':
                out(olay='karar', karar='soz', duyulan=wake.text, uyanir=True)
                wake.forget()
            elif verdict == 'aday':
                time.sleep(ses.WAKE_AFTER_SN)  # the rest of the phrase, as the listener waits for it
                text = ses.clean_spoken(transcribe(model, wake.clip(), config, threading.Lock()), config.get('ipucu'))
                out(olay='karar', karar='aday', duyulan=wake.text, whisper=text,
                    uyanir=ses.wake_heard(text, config['uyandirma_sozu']))
                wake.forget()
            time.sleep(0.05)
        wake.stop()
    finally:
        release(model)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--scripts', required=True)
    parser.add_argument('--indir', action='store_true')
    parser.add_argument('--dene', type=float)
    parser.add_argument('--dene-uyandirma', type=float)
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
    if args.dene_uyandirma:
        return trial_wake(state, config, args.dene_uyandirma)
    return serve(state, config)


if __name__ == '__main__':
    sys.exit(main())
'''


if __name__ == '__main__':
    sys.exit(main())

"""Yakala pieces taken from the predecessor's 3.10/3.11 (Cortex 1.0.25): transcripts in the spoken
language and Whisper (#277), link identity, helper process trees on Windows, a card that cannot be
written, the browser's address bar, clipboard freshness, the popup's monitor, decoded image bounds.

Offline: every helper is a stand-in, nothing reaches the network, no window is shown.
"""
import ctypes
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from v3_package_helpers import clean_environ

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
WINDOWS = os.name == 'nt'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_yakala as yakala  # noqa: E402


def wait_until(check, seconds=30.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return bool(check())


def windows_os():
    return types.SimpleNamespace(**{**vars(os), 'name': 'nt'})


def png(width=2, height=2):
    import zlib
    head = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    body = zlib.compress((b'\0' + b'\x11\x22\x33' * width) * height)
    return yakala.PNG_MAGIC + yakala._png_chunk(b'IHDR', head) + yakala._png_chunk(b'IDAT', body) + yakala._png_chunk(b'IEND', b'')


def public_dns_fixture(test):
    # Helpers below are real offline subprocess stand-ins, so DNS must also stay deterministic.
    patcher = patch.object(socket, 'getaddrinfo', return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))])
    patcher.start()
    test.addCleanup(patcher.stop)


# Stands in for `npx defuddle`, `yt-dlp` and `whisper` as a real child process. It answers from
# scenario.json next to it, logs every command line to calls.jsonl and never opens a socket. A subtitle
# request behaves like yt-dlp: --sub-langs is a comma list of regexes, a manual track wins over an
# automatic one of the same name, and each matching track becomes sub.<track>.vtt.
FAKE_TOOL = r'''
import json, re, sys
from pathlib import Path

here = Path(__file__).resolve().parent
name, args = sys.argv[1], sys.argv[2:]
scenario = json.loads((here / 'scenario.json').read_text(encoding='utf-8'))
with open(here / 'calls.jsonl', 'a', encoding='utf-8') as log:
    log.write(json.dumps([name] + args) + '\n')


def value(flag):
    return args[args.index(flag) + 1] if flag in args else None


def too_many():
    sys.stderr.write('ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests\n')
    raise SystemExit(1)


if name == 'npx':
    answers = scenario.get('defuddle') or {}
    answer = answers.get(value('--lang') or '', answers.get(''))
    if not answer:
        raise SystemExit(1)
    sys.stdout.write(json.dumps(answer))
elif name.startswith('whisper'):
    if scenario.get('whisper_error') and value('--device') != scenario.get('whisper_works_on'):
        sys.stderr.write('Detecting language...\n' + scenario['whisper_error'] + '\n')
        if scenario.get('whisper_empty_output'):
            Path(value('--output_dir'), 'ses.txt').write_text(' \n', encoding='utf-8')
        raise SystemExit(scenario.get('whisper_exit', 0))
    Path(value('--output_dir'), 'ses.txt').write_text(scenario['audio'], encoding='utf-8')
elif '-J' in args:
    if not scenario.get('video'):
        too_many()
    sys.stdout.write(json.dumps(scenario['video']))
elif '--sub-langs' in args:
    if '--load-info-json' in args:
        json.loads(Path(value('--load-info-json')).read_text(encoding='utf-8'))
    video, offered = scenario.get('video') or {}, {}
    if '--write-subs' in args:
        offered.update({track: 'manual' for track in video.get('subtitles') or {}})
    if '--write-auto-subs' in args:
        for track in video.get('automatic_captions') or {}:
            offered.setdefault(track, 'auto')
    earlier = sum('--sub-langs' in json.loads(line) for line in (here / 'calls.jsonl').read_text(encoding='utf-8').splitlines()) - 1
    if earlier < scenario.get('fail_first', 0):
        too_many()
    for track, kind in offered.items():
        if any(re.fullmatch(pattern, track) for pattern in value('--sub-langs').split(',')):
            words = scenario.get('speech', {}).get(kind + ':' + track) or (kind + ' track ' + track + ' ') * 8
            Path(value('-o').replace('%(ext)s', track + '.vtt')).write_text(
                'WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:09.000\n' + words + '\n', encoding='utf-8')
elif '-f' in args and scenario.get('audio'):
    Path(value('-o').replace('%(ext)s', 'webm')).write_bytes(b'ses')
else:
    raise SystemExit(1)
'''

VIDEO = 'https://www.youtube.com/watch?v=Wqq0mwYmhcQ'
DUBS = ('ar', 'bn', 'de-DE', 'es-US', 'fr-FR', 'hi', 'id', 'it', 'iw', 'ja', 'ko', 'ml', 'nl-NL', 'pa', 'pl', 'pt-BR',
        'ru', 'ta', 'te', 'uk')
ENGLISH = 'So, I gave the same prompt to both models across four different builds and wrote down what every run cost.'
ARABIC = 'لذا، قمتُ بتطبيق نفس التعليمات على النموذجين في أربع تجارب مختلفة، ثم سجّلتُ تكلفة كل تجربة منها بالتفصيل.'
TURKISH = 'Aynı istemi iki modele de verdim; ölçtüğüm maliyeti şöyle yazdım: İstanbul, Iğdır, Çorum, Şırnak, Ödemiş, Ünye.'


def caption(source, target=None):
    """One automatic caption entry as yt-dlp lists it; `tlang` marks a machine translation of `source`."""
    url = 'https://www.youtube.com/api/timedtext?v=Wqq0mwYmhcQ&kind=asr&lang=' + source + ('&tlang=' + target if target else '')
    return [{'ext': ext, 'url': url + '&fmt=' + ext} for ext in ('json3', 'vtt')]


def video(language=None, audio=(), manual=(), recognised=(), translated=()):
    """The part of a `yt-dlp -J` answer the capture reads. `audio` is (language, language_preference) pairs."""
    automatic = {track: caption(track.removesuffix('-orig')) for track in recognised}
    for track in translated:  # the untranslated entry, if any, comes first; yt-dlp takes the last one
        automatic[track] = automatic.get(track, []) + caption('uk', track)
    return {'id': 'Wqq0mwYmhcQ', 'title': 'I Tested Two Models', 'language': language,
            'formats': [{'format_id': '251-' + str(index), 'acodec': 'opus', 'language': code, 'language_preference': mark}
                        for index, (code, mark) in enumerate(audio)],
            'subtitles': {track: [{'ext': 'vtt', 'url': 'https://www.youtube.com/api/timedtext?lang=' + track}] for track in manual},
            'automatic_captions': automatic}


def dubbed():
    """Like the video in #277: spoken English, 20 automatic dubs, one `-orig` track per audio track."""
    return video('en-US', audio=[('en-US', 10)] + [(code, -1) for code in DUBS],
                 recognised=['en', 'en-orig'] + [code + '-orig' for code in DUBS],
                 translated=['en', 'tr'] + [code for code in DUBS])


def defuddle(language, words=None):
    """A `defuddle parse --json` answer; without words the video has no transcript, only its description."""
    body = '## Transcript\n\n### Intro\n\n**0:00** · ' + words if words else 'Video description without a transcript. ' * 4
    return {'title': 'I Tested Two Models', 'author': 'Kanal', 'published': '2026-09-16T05:37:48-07:00', 'site': 'YouTube',
            'language': language, 'content': '![](' + VIDEO + ')\n\n' + body}




class YakalaVideoLanguageTest(unittest.TestCase):
    """#277: the transcript is in the language spoken in the video; the card names the language it stored
    and warns only on evidence of a wrong one (a known mismatch, or a dubbed video of unknown language)."""

    def setUp(self):
        public_dns_fixture(self)
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-yakala-dil-')
        self.addCleanup(self.tmp.cleanup)
        self.vault, self.bin = Path(self.tmp.name) / 'Örnek Beyin', Path(self.tmp.name) / 'bin'
        self.vault.mkdir()
        self.bin.mkdir()
        (self.bin / 'fake_tool.py').write_text(FAKE_TOOL, encoding='utf-8')
        environ = clean_environ()
        environ.start()
        self.addCleanup(environ.stop)
        real_run = yakala._run

        def run(command, timeout, cwd=None):  # the real subprocess call, aimed at the stand-in
            self.assertGreater(timeout, 0)
            return real_run([sys.executable, str(self.bin / 'fake_tool.py'), Path(command[0]).name, *command[1:]], timeout, cwd)
        patcher = patch.object(yakala, '_run', run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def isle(self, scenario, npx=True, yt_dlp=True, whisper=False, url=VIDEO, **options):
        """Capture `url` once, process the queue against `scenario`; returns (result entry, card meta, raw text)."""
        (self.bin / 'scenario.json').write_text(json.dumps(scenario), encoding='utf-8')
        (self.bin / 'calls.jsonl').write_text('', encoding='utf-8')
        found = {'npx': 'npx' if npx else None, 'yt_dlp': 'yt-dlp' if yt_dlp else None,
                 'whisper': (whisper if isinstance(whisper, str) else 'whisper') if whisper else None,
                 'pdftotext': None, 'ffmpeg': None}
        card = next((card['id'] for card in yakala.cards(self.vault) if card['meta'].get('url') == url), None) \
            or yakala.capture(self.vault, url=url)['id']
        with patch.object(yakala, 'tools', return_value=found):
            entry = yakala.process(self.vault, [card], **options)['kartlar'][0]
        raw = (self.vault / entry['ham']).read_text(encoding='utf-8') if entry.get('ham') else ''
        return entry, yakala.find_card(self.vault, card)['meta'], raw

    def calls(self, tool=None):
        lines = (self.bin / 'calls.jsonl').read_text(encoding='utf-8').splitlines()
        return [call for call in map(json.loads, lines) if tool in (None, call[0])]

    def track_requests(self):
        """What each yt-dlp subtitle request asked for: (--sub-langs value, automatic?)."""
        return [(call[call.index('--sub-langs') + 1], '--write-auto-subs' in call) for call in self.calls('yt-dlp')
                if '--sub-langs' in call]

    def test_dubbed_video_asks_defuddle_for_the_spoken_language(self):
        answers = {'': defuddle('ar', ARABIC), 'en-US': defuddle('en', ENGLISH)}
        entry, meta, raw = self.isle({'video': dubbed(), 'defuddle': answers})
        self.assertIn(ENGLISH, raw)
        self.assertNotIn(ARABIC, raw)
        self.assertEqual((entry['durum'], entry['yontem'], entry['dil']), ('cikarildi', 'defuddle', 'en'))
        self.assertEqual(meta['dil'], 'en')
        self.assertNotIn('uyari', meta)
        self.assertNotIn('not', entry)
        self.assertEqual(self.track_requests(), [])  # the language matched: no subtitle download at all
        self.assertEqual(len(self.calls('yt-dlp')), 1)
        # An article never costs a yt-dlp request and its card gains no language field.
        page = {'title': 'Yazı', 'language': 'tr', 'content': 'Uzun makale metni. ' * 20}
        entry, meta, _raw = self.isle({'video': dubbed(), 'defuddle': {'': page}}, url='https://ornek.com/yazi')
        self.assertEqual(entry['yontem'], 'defuddle')
        self.assertEqual(self.calls('yt-dlp'), [])
        self.assertNotIn('--lang', self.calls('npx')[0])
        self.assertFalse({'dil', 'altyazi', 'uyari'} & set(meta))

    def test_wrong_defuddle_language_gives_way_to_the_spoken_track(self):
        # Defuddle keeps answering with the Arabic dub even when asked for en-US.
        entry, meta, raw = self.isle({'video': dubbed(), 'defuddle': {'': defuddle('ar', ARABIC)}, 'speech': {'auto:en-orig': ENGLISH}})
        self.assertIn(ENGLISH, raw)
        self.assertNotIn(ARABIC, raw)
        self.assertEqual((entry['yontem'], entry['dil'], entry['altyazi']), ('yt-dlp-altyazi', 'en', 'en-orig (otomatik)'))
        self.assertIn('![](' + VIDEO + ')\n\n## Transcript\n\n**0:01** So, I gave', raw)
        self.assertEqual((meta['dil'], meta['altyazi']), ('en', 'en-orig (otomatik)'))
        self.assertNotIn('uyari', meta)
        self.assertEqual(self.track_requests(), [('en-orig', True)])
        self.assertIn('--lang', self.calls('npx')[0])

    def test_dubbed_video_without_defuddle_requests_one_track_not_every_orig(self):
        entry, meta, raw = self.isle({'video': dubbed(), 'speech': {'auto:en-orig': ENGLISH}}, npx=False)
        self.assertEqual((entry['durum'], entry.get('yontem')), ('cikarildi', 'yt-dlp-altyazi'))
        self.assertIn(ENGLISH, raw)  # not `ar-orig`, the first `-orig` track in the alphabet
        self.assertEqual(self.track_requests(), [('en-orig', True)])  # asking for all 21 is what drew HTTP 429
        self.assertEqual((meta.get('dil'), meta.get('altyazi')), ('en', 'en-orig (otomatik)'))

    def test_http_429_on_the_first_track_request_moves_to_the_next_track(self):
        scenario = {'video': video('tr', audio=[('tr', -1)], manual=['tr'], recognised=['tr-orig', 'tr'], translated=['en']),
                    'speech': {'auto:tr-orig': TURKISH}, 'fail_first': 1}
        entry, meta, raw = self.isle(scenario, npx=False)
        self.assertEqual((entry['durum'], entry.get('altyazi')), ('cikarildi', 'tr-orig (otomatik)'))
        self.assertIn(TURKISH, raw)
        self.assertEqual(self.track_requests(), [('tr', False), ('tr-orig', True)])
        self.assertEqual(meta['dil'], 'tr')
        self.assertNotIn('uyari', meta)

    def test_wrong_language_is_kept_only_with_a_warning(self):
        # Every track request is refused: the dub transcript is all there is.
        scenario = {'video': dubbed(), 'defuddle': {'': defuddle('ar', ARABIC)}, 'fail_first': 9}
        entry, meta, raw = self.isle(scenario, whisper=True)
        self.assertEqual((entry['durum'], entry['yontem'], meta.get('dil')), ('cikarildi', 'defuddle', 'ar'))
        self.assertIn(ARABIC, raw)
        for part in ('konusma dilinde olmayabilir', 'video en-US', 'transkript ar'):
            self.assertIn(part, meta.get('uyari', ''))
        self.assertEqual(entry['not'], meta['uyari'])
        self.assertEqual(self.track_requests(), [('en-orig', True)])
        # Audio stays the last resort for a video with no transcript at all; nothing was downloaded here.
        self.assertEqual([call for call in self.calls('yt-dlp') if '-f' in call], [])
        # A later run that gets the track replaces the warning it wrote.
        entry, meta, raw = self.isle(dict(scenario, fail_first=0, speech={'auto:en-orig': ENGLISH}))
        self.assertEqual((meta['dil'], meta['altyazi']), ('en', 'en-orig (otomatik)'))
        self.assertNotIn('uyari', meta)
        self.assertNotIn(ARABIC, raw)

    def test_unknown_language_of_a_single_language_video_is_recorded_without_a_warning(self):
        # Like jNQXAC9IVRw: manual tracks only, no speech recognition, so yt-dlp names no language.
        # Nothing points at a dub, so the stored language on the card is enough.
        scenario = {'video': video(None, audio=[(None, -1)], manual=['de', 'en']), 'defuddle': {'': defuddle('en', ENGLISH)},
                    'speech': {'manual:en': ENGLISH}}
        entry, meta, raw = self.isle(scenario)
        self.assertEqual((entry['yontem'], meta.get('dil')), ('defuddle', 'en'))
        self.assertNotIn('uyari', meta)
        self.assertNotIn('not', entry)
        self.assertNotIn('--lang', self.calls('npx')[0])
        self.assertEqual(self.track_requests(), [])
        # Without Defuddle a track is still taken, and the card names it.
        entry, meta, raw = self.isle(scenario, npx=False)
        self.assertEqual((entry['yontem'], meta.get('dil'), meta.get('altyazi')), ('yt-dlp-altyazi', 'en', 'en (elle)'))
        self.assertNotIn('uyari', meta)
        self.assertNotIn('not', entry)
        self.assertEqual(self.track_requests(), [('en', False)])

    def test_unknown_language_of_a_dubbed_video_warns(self):
        # Two audio languages and neither marked original: whatever is stored may be a dub.
        scenario = {'video': video('tr', audio=[('tr', 5), ('en', -1)], recognised=['en-orig', 'tr-orig'], translated=['de']),
                    'defuddle': {'': defuddle('en', ENGLISH)}}
        entry, meta, raw = self.isle(scenario)
        self.assertEqual((entry['yontem'], meta.get('dil')), ('defuddle', 'en'))
        for part in ('dublajli', 'konusulan dil belirlenemedi', 'transkript dili: en'):
            self.assertIn(part, meta.get('uyari', ''))
        self.assertEqual(entry['not'], meta['uyari'])
        self.assertNotIn('--lang', self.calls('npx')[0])
        # No audio language at all, but speech recognised in two languages: the track taken is named.
        scenario = {'video': video(None, recognised=['en-orig', 'tr-orig']), 'speech': {'auto:tr-orig': TURKISH}}
        entry, meta, raw = self.isle(scenario, npx=False)
        self.assertEqual((entry['yontem'], meta.get('dil'), meta.get('altyazi')), ('yt-dlp-altyazi', 'tr', 'tr-orig (otomatik)'))
        for part in ('dublajli', 'kullanilan altyazi izi: tr-orig (otomatik)'):
            self.assertIn(part, meta.get('uyari', ''))
        self.assertEqual(self.track_requests(), [('tr-orig', True)])

    def test_audio_fallback_warns_only_for_a_dubbed_video_of_unknown_language(self):
        # No captions of any kind: the audio is transcribed. With two audio languages and no original it may be a dub.
        scenario = {'video': video(None, audio=[('tr', 5), ('en', -1)]), 'audio': TURKISH}
        entry, meta, raw = self.isle(scenario, npx=False, whisper=True)
        self.assertEqual((entry['durum'], entry.get('yontem')), ('cikarildi', 'ses-whisper'))
        self.assertIn(TURKISH, raw)
        for part in ('dublajli', 'ses asil dilde olmayabilir'):
            self.assertIn(part, meta.get('uyari', ''))
        self.assertNotIn('dil', meta)
        # One audio language: its transcript is the spoken language, nothing to warn about.
        entry, meta, raw = self.isle(dict(scenario, video=video('tr', audio=[('tr', -1)])), npx=False, whisper=True)
        self.assertEqual((entry['yontem'], meta.get('dil'), meta.get('uyari')), ('ses-whisper', 'tr', None))
        self.assertNotIn('not', entry)

    def whisper_call(self):
        return next(call for call in self.calls() if call[0].startswith('whisper'))

    def test_audio_fallback_names_the_spoken_language_and_the_chosen_model(self):
        # yt-dlp named the spoken language: Whisper is told it instead of guessing from the intro.
        scenario = {'video': video('tr', audio=[('tr', -1)]), 'audio': TURKISH}
        with patch.dict(os.environ, {'BEYIN_WHISPER_MODEL': ''}):
            entry, meta, raw = self.isle(scenario, npx=False, whisper=True)
        call = self.whisper_call()
        self.assertEqual((entry['yontem'], call[call.index('--language') + 1]), ('ses-whisper', 'tr'))
        self.assertNotIn('--model', call)  # the tool's own default unless the user picks one
        with patch.dict(os.environ, {'BEYIN_WHISPER_MODEL': 'large-v3-turbo'}):
            self.isle(scenario, npx=False, whisper=True)
        call = self.whisper_call()
        self.assertEqual(call[call.index('--model') + 1], 'large-v3-turbo')
        # Unknown or dubbed: no language flag, Whisper detects it as before.
        with patch.dict(os.environ, {'BEYIN_WHISPER_MODEL': ''}):
            self.isle(dict(scenario, video=video(None, audio=[('tr', 5), ('en', -1)])), npx=False, whisper=True)
        self.assertNotIn('--language', self.whisper_call())

    def test_cuda_failure_in_whisper_ctranslate2_is_retried_on_the_cpu(self):
        # ctranslate2 picks CUDA itself; without cuBLAS it fails yet exits 0. The CPU run is kept and the card says why.
        cublas = 'RuntimeError: Library cublas64_12.dll is not found or cannot be loaded'
        scenario = {'video': video('tr', audio=[('tr', -1)]), 'audio': TURKISH, 'whisper_error': cublas,
                    'whisper_works_on': 'cpu'}
        entry, meta, raw = self.isle(scenario, npx=False, whisper='whisper-ctranslate2')
        self.assertEqual((entry['yontem'], meta.get('dil')), ('ses-whisper', 'tr'))
        self.assertIn(TURKISH, raw)
        runs = self.calls('whisper-ctranslate2')
        self.assertEqual([call[call.index('--device') + 1] if '--device' in call else None for call in runs], [None, 'cpu'])
        self.assertIn('--language', runs[1])  # the retry keeps the language and model it was given
        for part in ('CPU ile', 'cublas64_12.dll'):
            self.assertIn(part, meta.get('uyari', ''))

    def test_empty_whisper_output_also_retries_cuda_and_reports_failure(self):
        scenario = {'video': video('tr', audio=[('tr', -1)]), 'audio': TURKISH,
                    'whisper_error': 'RuntimeError: Library cublas64_12.dll is not found',
                    'whisper_works_on': 'cpu', 'whisper_empty_output': True}
        entry, meta, raw = self.isle(scenario, npx=False, whisper='whisper-ctranslate2')
        self.assertEqual(entry['yontem'], 'ses-whisper')
        self.assertIn(TURKISH, raw)
        self.assertEqual(len(self.calls('whisper-ctranslate2')), 2)
        entry, meta, _raw = self.isle(dict(scenario, whisper_works_on='never'),
                                    npx=False, whisper='whisper-ctranslate2')
        self.assertEqual(entry['durum'], 'hata')
        self.assertIn('Whisper metin uretmedi', entry.get('not', ''))

    def test_whisper_failure_names_whisper_error_instead_of_a_missing_tool(self):
        # Both runs fail (or the tool is not ctranslate2): the card carries Whisper's own last error line.
        scenario = {'video': video('tr', audio=[('tr', -1)]), 'audio': TURKISH,
                    'whisper_error': 'RuntimeError: CUDA failed with error out of memory', 'whisper_works_on': 'never'}
        entry, meta, raw = self.isle(scenario, npx=False, whisper='whisper-ctranslate2')
        self.assertEqual(len(self.calls('whisper-ctranslate2')), 2)
        self.assertIn('Whisper metin uretmedi: RuntimeError: CUDA failed', entry.get('not', '') + meta.get('uyari', ''))
        self.assertNotIn('bulunamadi', entry.get('not', ''))
        # openai-whisper falls back to the CPU on its own: no retry, only the error is named.
        entry, meta, raw = self.isle(dict(scenario, whisper_error='Killed', whisper_exit=1), npx=False, whisper=True)
        self.assertEqual(len(self.calls('whisper')), 1)
        self.assertIn('Whisper metin uretmedi: Killed', entry.get('not', '') + meta.get('uyari', ''))

    def test_whisper_language_flag_takes_only_a_plain_language_code(self):
        self.assertEqual(yakala._whisper_options('pt-BR')[1], ['--language', 'pt'])
        for odd in (None, '', 'und&calc', 'x' * 9):
            self.assertEqual(yakala._whisper_options(odd)[1], [])

    def test_refused_metadata_request_keeps_defuddle_and_asks_for_no_track(self):
        entry, meta, raw = self.isle({'video': None, 'defuddle': {'': defuddle('ar', ARABIC)}})
        self.assertEqual((entry['yontem'], meta.get('dil')), ('defuddle', 'ar'))
        self.assertNotIn('uyari', meta)  # an unanswered request is no evidence of a dub
        self.assertNotIn('not', entry)
        self.assertEqual(self.track_requests(), [])  # no blind request for tracks it could not list
        self.assertEqual(len(self.calls('yt-dlp')), 1)

    def test_turkish_video_manual_track_beats_automatic(self):
        tracks = {'recognised': ['tr-orig', 'tr'], 'translated': ['en', 'ar']}
        scenario = {'video': video('tr', audio=[('tr', -1)], manual=['en', 'tr'], **tracks),
                    'speech': {'manual:tr': TURKISH, 'auto:tr-orig': 'otomatik ' * 20}}
        entry, meta, raw = self.isle(scenario, npx=False)
        self.assertIn(TURKISH, raw)  # the manual track, with Ş, ğ, ü, ç, ö, İ and ı intact
        self.assertEqual((meta.get('dil'), meta.get('altyazi')), ('tr', 'tr (elle)'))
        self.assertEqual(self.track_requests(), [('tr', False)])
        # No manual Turkish track: the recognised one, never the English translation or the manual `en`.
        scenario = {'video': video('tr', audio=[('tr', -1)], manual=['en'], **tracks), 'speech': {'auto:tr-orig': TURKISH}}
        entry, meta, raw = self.isle(scenario, npx=False)
        self.assertEqual((meta['dil'], meta['altyazi']), ('tr', 'tr-orig (otomatik)'))
        self.assertIn(TURKISH, raw)
        self.assertNotIn('uyari', meta)
        # With Defuddle the Turkish transcript is verified and no track is downloaded.
        entry, meta, raw = self.isle(dict(scenario, defuddle={'tr': defuddle('tr', TURKISH)}))
        self.assertEqual((entry['yontem'], meta['dil'], meta.get('altyazi'), meta.get('uyari')), ('defuddle', 'tr', None, None))
        self.assertEqual(self.track_requests(), [])

    def test_without_ytdlp_defuddle_stands_and_its_language_is_recorded(self):
        entry, meta, raw = self.isle({'defuddle': {'': defuddle('ar', ARABIC)}}, yt_dlp=False)
        self.assertEqual((entry['durum'], entry['yontem']), ('cikarildi', 'defuddle'))
        self.assertIn(ARABIC, raw)  # as before: there is nothing to check it against
        self.assertEqual((meta.get('dil'), entry.get('dil')), ('ar', 'ar'))  # visible on the card, which is enough
        self.assertNotIn('uyari', meta)
        self.assertNotIn('not', entry)
        self.assertEqual(self.calls('yt-dlp'), [])
        self.assertNotIn('--lang', self.calls('npx')[0])
        # No transcript and no yt-dlp: the old note, no language claim.
        entry, meta, raw = self.isle({'defuddle': {'': defuddle('en')}}, yt_dlp=False)
        self.assertIn('Altyazi bulunamadi', entry['not'])
        self.assertFalse({'dil', 'altyazi', 'uyari'} & set(meta))

    def test_spoken_language_and_track_order_from_metadata(self):
        def tracks(data):
            with tempfile.TemporaryDirectory() as work, patch.object(yakala, '_run', return_value=(0, json.dumps(data), '')):
                return yakala.youtube_tracks(VIDEO, {'yt_dlp': 'yt-dlp'}, work)
        self.assertEqual(tracks(dubbed()), {'dil': 'en-US', 'dublaj': True, 'adaylar': [('en-orig', True)]})
        # Region codes: the exact track, then the bare language, then another region; a manual one first.
        german = video('de-DE', audio=[('de-DE', -1)], manual=['de', 'en'], recognised=['de-DE-orig', 'de-DE', 'de-orig'], translated=['de'])
        self.assertEqual(tracks(german), {'dil': 'de-DE', 'dublaj': False,
                                          'adaylar': [('de', False), ('de-DE-orig', True), ('de-orig', True)]})
        # No `language`, one recognised track: that is what is spoken.
        self.assertEqual(tracks(video(None, recognised=['ja-orig', 'ja'], translated=['en', 'tr'])),
                         {'dil': 'ja', 'dublaj': False, 'adaylar': [('ja-orig', True), ('ja', True)]})
        # Several audio languages and none marked original: nothing to go on, Turkish and English first.
        unmarked = video('tr', audio=[('tr', 5), ('en', -1), ('en-desc', -10)], recognised=['en-orig', 'tr-orig', 'ar-orig'], translated=['de'])
        self.assertEqual(tracks(unmarked), {'dil': None, 'dublaj': True,
                                            'adaylar': [('tr-orig', True), ('en-orig', True), ('ar-orig', True)]})
        # Evidence of a dub, each kind alone: two audio languages, or speech recognised in two languages.
        self.assertEqual(tracks(video(None, audio=[('tr', 5), ('en', -1)])), {'dil': None, 'dublaj': True, 'adaylar': []})
        self.assertEqual(tracks(video(None, recognised=['en-orig', 'tr-orig'])),
                         {'dil': None, 'dublaj': True, 'adaylar': [('tr-orig', True), ('en-orig', True)]})
        # No evidence: one language throughout. An audio description (`en-desc`) and a second recognised
        # track of the same language are not dubs, and neither is a video that names no language at all.
        described = video(None, audio=[('en', -1), ('en-desc', -10)], recognised=['en-orig', 'en-US-orig'])
        self.assertEqual(tracks(described), {'dil': None, 'dublaj': False, 'adaylar': [('en-US-orig', True), ('en-orig', True)]})
        self.assertEqual(tracks(video(None, audio=[(None, -1)], manual=['de', 'en'])),
                         {'dil': None, 'dublaj': False, 'adaylar': [('en', False), ('de', False)]})
        # A language that is not a language code is not passed on to a command line.
        self.assertIsNone(tracks(video('--evil', recognised=['en-orig', 'tr-orig']))['dil'])
        odd = video('en', manual=['live_chat', 'all', '-en', 'en.*', 'en'], recognised=['en-orig'])
        self.assertEqual(tracks(odd)['adaylar'], [('en', False), ('en-orig', True)])
        # A playlist address answers with its videos; the first one stands for it.
        self.assertEqual(tracks({'_type': 'playlist', 'entries': [dubbed(), german]})['dil'], 'en-US')
        for unusable in (['not', 'a', 'video'], {'_type': 'playlist', 'entries': []}):
            self.assertIsNone(tracks(unusable))
        self.assertIsNone(yakala.youtube_tracks(VIDEO, {'yt_dlp': None}, self.tmp.name))



class BrowserUrlTest(unittest.TestCase):
    """The active tab's link comes from the browser's own address bar; anything else is not a link."""

    def test_address_bar_values(self):
        self.assertEqual(yakala.tab_url('youtube.com/watch?v=abc\r\n'), 'https://youtube.com/watch?v=abc')
        self.assertIsNone(yakala.tab_url('http://127.0.0.1:8080/x'))
        self.assertEqual(yakala.tab_url('https://github.com/GunduzTolga'), 'https://github.com/GunduzTolga')
        for value in ('yarim kalmis arama', 'brave://settings', 'localhost', 'http://10.0.0.1/', 'https://user:pass@example.com/', 'https://[broken/', 'https://example.com:bad/', '', None):
            self.assertIsNone(yakala.tab_url(value), value)

    def test_a_private_browser_tab_does_not_override_clipboard_capture(self):
        with patch.object(yakala, '_windows_read', return_value={'value': 'http://127.0.0.1:8080/panel'}):
            self.assertIsNone(yakala.windows_browser_url(42, 'chrome'))

    def test_each_browser_is_asked_for_its_own_address_bar_class(self):
        with patch.object(yakala, '_windows_read', return_value={'value': 'https://github.com/GunduzTolga'}) as read:
            self.assertEqual(yakala.windows_browser_url(42, 'Brave'), 'https://github.com/GunduzTolga')
            self.assertEqual(yakala.windows_browser_url(42, 'msedge'), 'https://github.com/GunduzTolga')
            self.assertIsNone(yakala.windows_browser_url(42, 'firefox'))
        self.assertEqual([c.args[1]['class'] for c in read.call_args_list], ['BraveOmniboxViewViews', 'OmniboxViewViews'])

    def test_reader_failure_falls_back_to_the_clipboard(self):
        for returned in ({'error': 'timeout'}, {'value': None}, {'value': 'chrome://settings'}):
            with patch.object(yakala, '_windows_read', return_value=returned):
                self.assertIsNone(yakala.windows_browser_url(42, 'chrome'))

    def test_timeout_is_passed_to_an_independent_reader_each_time(self):
        with patch.object(yakala, '_windows_read', side_effect=[{'error': 'timeout'}, {'value': 'https://example.com/'}]) as read:
            self.assertIsNone(yakala.windows_browser_url(42, 'chrome', timeout=0.1))
            self.assertEqual(yakala.windows_browser_url(42, 'chrome', timeout=0.1), 'https://example.com/')
        self.assertEqual(read.call_count, 2)
        self.assertEqual([c.args[2] for c in read.call_args_list], [0.1, 0.1])

    @unittest.skipUnless(WINDOWS, 'IsHungAppWindow is Windows only')
    def test_a_hung_window_is_not_asked_at_all(self):
        with patch.object(ctypes.windll.user32, 'IsHungAppWindow', return_value=1), \
                patch.object(yakala, '_windows_read') as read:
            self.assertIsNone(yakala.windows_browser_url(42, 'chrome'))
        read.assert_not_called()  # the isolated reader process is never started

    @unittest.skipUnless(WINDOWS, 'UI Automation is Windows only')
    def test_real_ui_automation_with_a_dead_window_gives_nothing_and_releases_com(self):
        # The real COM path end to end: ElementFromHandle fails on a closed handle and nothing escapes.
        self.assertIsNone(yakala.windows_browser_url(0, 'chrome'))
        seen = {}

        def run():
            with self.assertRaises(OSError):
                yakala._uia_address_bar(0, 'OmniboxViewViews')
            # Balanced: COM is not left initialised on the thread, so this is a fresh S_OK, not S_FALSE.
            seen['again'] = ctypes.windll.ole32.CoInitializeEx(None, 2)
            ctypes.windll.ole32.CoUninitialize()
        worker = threading.Thread(target=run)
        worker.start()
        worker.join(10)
        self.assertEqual(seen.get('again'), 0)


class PopupPlacementTest(unittest.TestCase):
    def test_popup_position_uses_negative_monitor_work_area(self):
        self.assertEqual(yakala._popup_position((-1920, 0, 0, 1040), 640, 400), (-1280, 228))
        self.assertEqual(yakala._popup_position((0, -1080, 1920, -40), 640, 400), (640, -852))

    def test_monitor_uses_source_window_and_work_area(self):
        user = Mock()
        user.MonitorFromWindow.return_value = 55

        def info(_handle, pointer):
            work = pointer._obj.work
            work.left, work.top, work.right, work.bottom = -1920, 0, 0, 1040
            return 1
        user.GetMonitorInfoW.side_effect = info
        with patch.object(ctypes, 'WinDLL', return_value=user, create=True):
            self.assertEqual(yakala._win_monitor(42), (-1920, 0, 0, 1040))
        user.MonitorFromWindow.assert_called_once_with(42, 2)



class WindowsHelperRunTest(unittest.TestCase):
    def test_job_assignment_precedes_resume_and_timeout_closes_job(self):
        kernel, process = Mock(), Mock()
        process._handle, process.pid = 12, 123
        process.wait.side_effect = [subprocess.TimeoutExpired('helper', 1), None]
        process.poll.return_value = None
        events = []
        kernel.AssignProcessToJobObject.side_effect = lambda *_: events.append('assign') or True
        kernel.CloseHandle.side_effect = lambda *_: events.append('close')
        with patch.object(yakala, '_windows_job', return_value=(kernel, 42)), \
                patch.object(yakala, '_windows_resume', side_effect=lambda _pid: events.append('resume')), \
                patch.object(yakala.subprocess, 'Popen', return_value=process) as popen:
            with self.assertRaises(subprocess.TimeoutExpired):
                yakala._windows_run(['helper'], 1, None, {})
        self.assertEqual(events, ['assign', 'resume', 'close'])
        self.assertTrue(popen.call_args.kwargs['creationflags'] & 4)
        process.kill.assert_called_once()

    def test_job_creation_failure_does_not_start_a_helper(self):
        with patch.object(yakala, '_windows_job', side_effect=OSError('job refused')), \
                patch.object(yakala.subprocess, 'Popen') as popen:
            with self.assertRaises(OSError):
                yakala._windows_run(['helper'], 1, None, {})
        popen.assert_not_called()


@unittest.skipUnless(WINDOWS, 'Windows Job Objects; no desktop or clipboard access')
class WindowsJobTest(unittest.TestCase):
    def test_timeout_terminates_helper_and_grandchild(self):
        # The killed processes release their working folder a moment after they report exit.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            pid_file = Path(directory) / 'child.pid'
            script = ('import subprocess, sys, time; from pathlib import Path; '
                      'p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], '
                      'creationflags=subprocess.CREATE_NO_WINDOW); '
                      'Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)')
            with self.assertRaises(subprocess.TimeoutExpired):
                yakala._windows_run([sys.executable, '-c', script, str(pid_file)], 3, directory, dict(os.environ))
            self.assertTrue(pid_file.exists(), 'helper must start before the timeout')
            kernel = ctypes.WinDLL('kernel32')
            kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32], ctypes.c_void_p
            kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel.OpenProcess(0x1000, False, int(pid_file.read_text()))
            if handle:
                try:
                    code = ctypes.c_uint32()
                    def stopped():
                        return kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value != 259
                    self.assertTrue(wait_until(stopped, 3), 'grandchild survived the closed job')
                finally:
                    kernel.CloseHandle(handle)


class YakalaCardWriteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='yakala-security-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        self.no_tools = {key: None for key in ('npx', 'yt_dlp', 'whisper', 'pdftotext', 'ffmpeg')}

    def windows(self):
        return patch.object(yakala, 'os', types.SimpleNamespace(**{**vars(os), 'name': 'nt'}))

    def test_windows_url_selection_is_private_on_new_and_existing_cards(self):
        with self.windows():
            first = yakala.capture(self.vault, url='https://example.com/a', text='musteri adresi')
            self.assertEqual(yakala.find_card(self.vault, first['id'])['meta']['visibility'], 'private')
            second = yakala.capture(self.vault, url='https://example.com/b')
            yakala.capture(self.vault, url='https://example.com/b', text='ozel secim')
            card = yakala.find_card(self.vault, second['id'])
            self.assertEqual(card['meta']['visibility'], 'private')
            self.assertIn('ozel secim', card['body'])

    def test_windows_recapture_copies_and_links_attachments(self):
        source = self.root / 'belge.txt'
        source.write_text('dosya icerigi', encoding='utf-8')
        with self.windows():
            first = yakala.capture(self.vault, url='https://example.com/a')
            result = yakala.capture(self.vault, url='https://example.com/a', files=[source])
            card = yakala.find_card(self.vault, first['id'])
            self.assertEqual(result['status'], 'mevcut_karta_eklendi')
            self.assertIn('/dosyalar/belge.txt]]', card['body'])
            self.assertEqual(card['meta']['visibility'], 'private')
            target = card['path'].parent / 'dosyalar/belge.txt'
            self.assertEqual(target.read_text(encoding='utf-8'), 'dosya icerigi')

    def test_windows_one_locked_card_does_not_stop_the_queue(self):
        with self.windows():
            first = yakala.capture(self.vault, text='first')
            second = yakala.capture(self.vault, text='second')
            original = yakala.write_card

            def write(path, *args):
                if path.stem == first['id']:
                    raise PermissionError('locked card')
                return original(path, *args)
            with patch.object(yakala, 'tools', return_value=self.no_tools), \
                    patch.object(yakala, 'write_card', side_effect=write):
                result = yakala.process(self.vault, [first['id'], second['id']])
            self.assertEqual([row['durum'] for row in result['kartlar']], ['hata', 'cikarildi'])
            self.assertIn('locked card', result['kartlar'][0]['not'])

    def test_windows_locked_raw_file_does_not_stop_the_queue(self):
        with self.windows():
            first = yakala.capture(self.vault, text='first')
            second = yakala.capture(self.vault, text='second')
            original = yakala.os.replace

            def write(temporary, path, *args, **kwargs):
                path = Path(path)
                if path.parent.name == '.ham' and path.stem == first['id']:
                    raise PermissionError('locked raw')
                return original(temporary, path, *args, **kwargs)
            with patch.object(yakala, 'tools', return_value=self.no_tools), patch.object(yakala.os, 'replace', write):
                result = yakala.process(self.vault, [first['id'], second['id']])
            self.assertEqual([row['durum'] for row in result['kartlar']], ['hata', 'cikarildi'])


class ImageBoundTest(unittest.TestCase):
    def test_oversized_png_never_reaches_tk(self):
        header = struct.pack('>IIBBBBB', 100000, 100000, 8, 2, 0, 0, 0)
        data = yakala.PNG_MAGIC + yakala._png_chunk(b'IHDR', header) + yakala._png_chunk(b'IDAT', b'x') + yakala._png_chunk(b'IEND', b'')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'image.png'
            path.write_bytes(data)
            fake = types.SimpleNamespace(PhotoImage=Mock(), TclError=RuntimeError)
            with patch.dict(sys.modules, tkinter=fake):
                self.assertIsNone(yakala._image_thumb(None, dict(path=path, width=100000, height=100000)))
            fake.PhotoImage.assert_not_called()

    def test_duplicate_png_header_and_excess_pixels_are_rejected(self):
        first = png()
        duplicate = first[:33] + first[8:33] + first[33:]
        self.assertIsNone(yakala.png_info(duplicate))
        with patch.object(yakala, 'IMAGE_PIXEL_LIMIT', 3):
            self.assertIsNone(yakala.png_info(first))
            dib = struct.pack('<IiiHHIIiiII', 40, 2, 2, 1, 32, 0, 16, 0, 0, 0, 0) + b'\0' * 16
            self.assertIsNone(yakala.dib_to_png(dib))

    def test_thumbnail_opens_only_a_validated_picture(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'image.png'
            path.write_bytes(png())
            photo = Mock()
            photo.width.return_value, photo.height.return_value = 2, 2
            fake = types.SimpleNamespace(PhotoImage=Mock(return_value=photo), TclError=RuntimeError)
            with patch.dict(sys.modules, tkinter=fake), patch.object(yakala, 'os', windows_os()):
                self.assertIs(yakala._image_thumb(None, dict(path=path, width=2, height=2)), photo)
                self.assertEqual(fake.PhotoImage.call_args.kwargs['file'], path)
                fake.PhotoImage.reset_mock()
                self.assertIsNone(yakala._image_thumb(None, dict(path=path, width=3, height=2)))  # size must match
                fake.PhotoImage.assert_not_called()



class LinkIdentityTest(unittest.TestCase):
    def test_forms_of_one_video_or_post_share_a_card_and_different_pages_never_do(self):
        canonical = yakala.canonical
        self.assertEqual(canonical('https://youtu.be/abc123?t=40'), canonical('https://www.youtube.com/watch?v=abc123&list=x'))
        for form in ('https://www.youtube.com/shorts/abc123', 'https://youtube.com/live/abc123', 'https://www.youtube.com/embed/abc123',
                     'https://music.youtube.com/watch?v=abc123', 'https://m.youtube.com/watch?v=abc123'):
            self.assertEqual(canonical(form), 'youtube:abc123', form)
        self.assertEqual(canonical('https://twitter.com/a/status/42'), canonical('https://x.com/b/status/42?s=20'))
        self.assertNotEqual(canonical('https://notyoutube.com/watch?v=abc123'), 'youtube:abc123')
        self.assertNotEqual(canonical('https://www.youtube.com/@a/videos'), canonical('https://www.youtube.com/@b/videos'))
        self.assertNotEqual(canonical('https://example.com:8080/x'), canonical('https://example.com/x'))
        self.assertNotEqual(canonical('https://example.com/#/one'), canonical('https://example.com/#/two'))
        self.assertEqual(canonical('https://example.com/a#section'), canonical('https://example.com/a'))
        self.assertEqual(canonical('http://[::1]:8080/x'), '[::1]:8080/x')

    def test_canonical_is_the_same_on_every_system(self):
        for name in ('nt', 'posix'):
            with patch.object(yakala, 'os', types.SimpleNamespace(**{**vars(os), 'name': name})):
                self.assertEqual(yakala.canonical('https://www.example.org/x/'), 'example.org/x')
                self.assertEqual(yakala.canonical('https://x.com/b/status/42?s=20'), 'x:42')

    def test_windows_link_with_an_attached_picture_stays_a_private_link_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault, picture = Path(tmp) / 'vault', Path(tmp) / 'shot.png'
            vault.mkdir()
            picture.write_bytes(png())
            with patch.object(yakala, 'os', windows_os()):
                saved = yakala.capture(vault, url='https://www.youtube.com/watch?v=abcdefghijk', files=[picture])
            card = yakala.find_card(vault, saved['id'])
            self.assertEqual((card['meta']['kaynak_turu'], card['meta']['visibility']), ('youtube', 'private'))


class ClipboardFreshnessTest(unittest.TestCase):
    """Clipboard text starts switched on only when it was copied after the last save from the window,
    or, before any save, after the listener started; text of unknown age waits for Tab."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-yakala-pano-')
        self.addCleanup(self.tmp.cleanup)
        self.vault, self.state = Path(self.tmp.name) / 'vault', Path(self.tmp.name) / 'state'
        self.vault.mkdir()

    def fresh(self, number, baseline=None, generation=None):
        return yakala.clipboard_fresh(self.vault, number, self.state, baseline, generation)

    def test_nothing_known_is_never_fresh(self):
        self.assertFalse(self.fresh(7))  # a window opened on its own, before any save: unknown age
        self.assertFalse(self.fresh(None, 5, 'run'))
        self.assertFalse(self.fresh(0, 5, 'run'))

    def test_a_copy_after_the_listener_started_is_fresh(self):
        self.assertFalse(self.fresh(5, 5, 'run'), 'on the clipboard before the listener started')
        self.assertTrue(self.fresh(6, 5, 'run'))

    def test_a_saved_copy_is_consumed_and_the_next_one_is_fresh(self):
        yakala._clipboard_saved(self.vault, 6, self.state, 'run')
        self.assertFalse(self.fresh(6, 5, 'run'))
        self.assertTrue(self.fresh(7, 5, 'run'))
        self.assertFalse(list((self.state / 'yakala').glob('.pano-*')), 'no staging file left behind')

    def test_a_new_listener_run_starts_from_its_own_baseline(self):
        yakala._clipboard_saved(self.vault, 6, self.state, 'old run')
        self.assertFalse(self.fresh(9, 9, 'new run'))
        self.assertTrue(self.fresh(10, 9, 'new run'))

    def test_a_window_without_a_listener_compares_with_the_last_save(self):
        yakala._clipboard_saved(self.vault, 6, self.state)
        self.assertFalse(self.fresh(6))
        self.assertTrue(self.fresh(8))

    @unittest.skipUnless(WINDOWS, 'GetClipboardSequenceNumber is Windows only')
    def test_the_real_sequence_number_is_read_without_opening_the_clipboard(self):
        number = yakala._clipboard_sequence()
        self.assertTrue(number is None or isinstance(number, int))


class ListenerStatusTest(unittest.TestCase):
    @unittest.skipUnless(WINDOWS, 'named mutexes are Windows only')
    def test_a_held_mutex_is_a_running_listener(self):
        name = 'Local\\CortexPynYakalaTest' + str(os.getpid())
        self.assertFalse(yakala.windows_listener_running(name))
        kernel = ctypes.WinDLL('kernel32')
        kernel.CreateMutexW.restype = ctypes.c_void_p
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.CreateMutexW(None, True, name)
        try:
            self.assertTrue(yakala.windows_listener_running(name))
        finally:
            kernel.CloseHandle(handle)
        self.assertFalse(yakala.windows_listener_running(name))

    def test_elsewhere_it_is_not_known(self):
        with patch.object(yakala, 'os', types.SimpleNamespace(**{**vars(os), 'name': 'posix'})):
            self.assertIsNone(yakala.windows_listener_running())


class AddressReaderTest(unittest.TestCase):
    """The address bar is read in a short-lived child: its answer format, and a hung reader."""

    def test_packet_round_trip_and_garbage(self):
        packet = yakala._read_packet({'value': 'https://example.com/'})
        self.assertEqual(yakala._parse_read_packet(packet), {'value': 'https://example.com/'})
        for raw in (b'', b'\x00\x00\x00\x00', b'xxxx{}', packet + b'extra', None):
            self.assertEqual(yakala._parse_read_packet(raw), {}, raw)

    def test_a_reader_that_never_answers_is_killed_at_the_deadline(self):
        started = time.monotonic()
        result = yakala._process_packet([sys.executable, '-c', 'import time; time.sleep(30)'], {'hwnd': 1}, 0.5)
        self.assertEqual(result, {'error': 'timeout'})
        self.assertLess(time.monotonic() - started, 10)

    def test_the_private_entry_refuses_anything_but_an_address_read(self):
        command = [sys.executable, str(SCRIPTS / 'beyin_v3_yakala.py'), '_win-read', 'clipboard']
        result = yakala._process_packet(command, {'snapshot': True}, 20)
        self.assertIn('error', result)
        self.assertNotIn('text', result)

    def test_windows_context_keeps_the_page_only_from_a_chromium_address_bar(self):
        with patch.object(yakala, 'windows_browser_url', return_value='https://example.com/sayfa') as read:
            context = yakala.windows_context(read_url=False)
        read.assert_not_called()  # the wake phrase's window opens at once, without a reader
        self.assertNotIn('url', context)


if __name__ == '__main__':
    unittest.main()

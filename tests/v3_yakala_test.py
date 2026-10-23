"""Optional capture tool (yakala): exercised through a real install, the installed entry and hook.

Offline: `isle` runs with every helper tool hidden, so nothing reaches the network and the
popup/hotkey paths are never started.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from v3_package_helpers import inherited_env

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
INBOX = '📥 000-Inbox/Yakala'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_yakala as yakala  # noqa: E402


class YakalaUnitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-yakala-unit-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Örnek Beyin'
        self.vault.mkdir()

    def test_canonical_merges_url_forms(self):
        self.assertEqual(yakala.canonical('https://youtu.be/abc123?t=40'), yakala.canonical('https://www.youtube.com/watch?v=abc123&list=x'))
        self.assertEqual(yakala.canonical('https://twitter.com/a/status/42'), yakala.canonical('https://x.com/b/status/42?s=20'))
        self.assertNotEqual(yakala.canonical('https://a.com/x'), yakala.canonical('https://a.com/y'))

    def test_kind_and_slug(self):
        self.assertEqual(yakala.kind_of('https://m.youtube.com/watch?v=1'), 'youtube')
        self.assertEqual(yakala.kind_of('https://x.com/a/status/1'), 'x')
        self.assertEqual(yakala.kind_of('https://mail.google.com/mail/u/0/#inbox/1'), 'mail')
        self.assertEqual(yakala.kind_of(None, app='Mail'), 'mail')
        self.assertEqual(yakala.kind_of(None), 'metin')
        self.assertEqual(yakala.slug('Kısa tut, İyi düşün: ağ'), 'kisa-tut-iyi-dusun-ag')
        self.assertEqual(yakala.url_slug('https://www.youtube.com/watch?v=AbC'), 'youtube-abc')
        self.assertEqual(yakala.url_slug('https://x.com/karpathy/status/99'), 'x-karpathy-99')

    def test_capture_writes_one_card_and_dedupes(self):
        first = yakala.capture(self.vault, url='https://www.youtube.com/watch?v=abc', why='limit gözlemi')
        again = yakala.capture(self.vault, url='https://youtu.be/abc', why='ikinci bakış')
        self.assertEqual(first['status'], 'yakalandi')
        self.assertEqual(again['status'], 'mevcut_karta_eklendi')
        self.assertEqual(again['id'], first['id'])
        cards = yakala.cards(self.vault)
        self.assertEqual(len(cards), 1)
        meta, body = cards[0]['meta'], cards[0]['body']
        self.assertEqual((meta['durum'], meta['kaynak_turu'], meta['visibility']), ('bekliyor', 'youtube', 'internal'))
        self.assertIn('limit gözlemi', body)
        self.assertIn('ikinci bakış', body)
        self.assertEqual(yakala.pending(self.vault), 1)

    def test_capture_requires_something(self):
        with self.assertRaises(ValueError):
            yakala.capture(self.vault, why='yalniz neden')

    def test_private_kinds_and_files(self):
        source = Path(self.tmp.name) / 'not.txt'
        source.write_text('dosyadaki ders', encoding='utf-8')
        result = yakala.capture(self.vault, files=[source], why='belge')
        card = yakala.find_card(self.vault, result['id'])
        self.assertEqual(card['meta']['visibility'], 'private')
        self.assertTrue((self.vault / INBOX / 'dosyalar/not.txt').is_file())
        text = yakala.capture(self.vault, text='pano metni')
        self.assertEqual(yakala.find_card(self.vault, text['id'])['meta']['visibility'], 'private')

    def test_process_offline_and_finish(self):
        none = {name: None for name in ('npx', 'yt_dlp', 'whisper', 'pdftotext', 'ffmpeg')}
        note = yakala.capture(self.vault, text='Bağlam kaybı en pahalı kalem.', why='ders')
        clipped = self.vault / INBOX / 'clip.md'
        clipped.write_text('---\ntur: yakala\ndurum: bekliyor\nkaynak_turu: makale\nurl: "https://ornek.com/yazi"\n---\n\n'
                           '# Yazı\n\n## Neden\n\n\n\n## Icerik\n\n' + ('Uzun makale metni. ' * 30) + '\n', encoding='utf-8')
        video = yakala.capture(self.vault, url='https://www.youtube.com/watch?v=zzz')
        with patch.object(yakala, 'tools', return_value=none):
            result = yakala.process(self.vault)
        by_id = {entry['id']: entry for entry in result['kartlar']}
        self.assertEqual(by_id[note['id']]['yontem'], 'metin')
        self.assertEqual(by_id['clip']['yontem'], 'web-clipper')
        self.assertEqual(by_id[video['id']]['durum'], 'hata')
        raw = (self.vault / by_id['clip']['ham']).read_text(encoding='utf-8')
        self.assertIn('Uzun makale metni.', raw)
        self.assertIn('visibility: private', raw)
        # The clipped page body moves out of the indexed card into the dot folder.
        self.assertNotIn('Uzun makale metni.', (self.vault / INBOX / 'clip.md').read_text(encoding='utf-8'))
        self.assertEqual(yakala.pending(self.vault), 0)
        concept = self.vault / 'knowledge/concepts/baglam.md'
        concept.parent.mkdir(parents=True)
        concept.write_text('# Bağlam\n', encoding='utf-8')
        done = yakala.finish(self.vault, note['id'], ['knowledge/concepts/baglam.md'], 'tek ders')
        self.assertEqual(done['status'], 'islendi')
        card = yakala.find_card(self.vault, note['id'])
        self.assertEqual(card['meta']['durum'], 'islendi')
        self.assertIn('[[knowledge/concepts/baglam]]', card['body'])
        with self.assertRaises(ValueError):
            yakala.finish(self.vault, note['id'], ['knowledge/concepts/yok.md'])

    def test_extract_reads_only_inside_the_vault_and_only_web_addresses(self):
        none = {name: None for name in ('npx', 'yt_dlp', 'whisper', 'pdftotext', 'ffmpeg')}
        outside = Path(self.tmp.name) / 'disari.txt'
        outside.write_text('vault disindaki gizli metin', encoding='utf-8')
        inside = yakala.capture(self.vault, files=[outside], why='kopya')
        card = yakala.find_card(self.vault, inside['id'])
        text, method, _ = yakala.extract(self.vault, card, none)
        self.assertEqual(method, 'dosya')
        self.assertIn('vault disindaki gizli metin', text)  # the copy inside the vault is read
        # A link that leaves the vault (traversal, a drive path, UNC, a device name) is refused before
        # anything is resolved or read; `isle` records it as the card's error.
        for link in ('../disari.txt', str(outside), '\\\\sunucu\\pay\\x.txt', 'CON', 'nul.txt'):
            with self.subTest(link=link):
                forged = {'meta': {'kaynak_turu': 'dosya'}, 'body': '# x\n\n## Dosyalar\n\n- [[' + link + ']]\n'}
                with self.assertRaisesRegex(ValueError, 'vault disinda'):
                    yakala.extract(self.vault, forged, none)
        local = {'meta': {'kaynak_turu': 'makale', 'url': outside.as_uri()}, 'body': '# x\n'}
        with patch.object(yakala, 'via_stdlib', side_effect=AssertionError('fetched')), \
                patch.object(yakala, 'via_defuddle', side_effect=AssertionError('fetched')):
            with self.assertRaisesRegex(ValueError, 'HTTP\\(S\\)'):
                yakala.extract(self.vault, local, none)

    def test_windows_virtual_keys(self):
        self.assertEqual(yakala.windows_virtual_key('ctrl+alt+b'), (0x3, ord('B')))
        self.assertEqual(yakala.windows_virtual_key('ctrl+shift+f12'), (0x6, 0x7B))
        with self.assertRaises(ValueError):
            yakala.windows_virtual_key('win+b')

    @unittest.skipUnless(sys.platform == 'win32', 'Windows resident listener')
    def test_windows_listener_opens_warm_window_and_stops_on_request(self):
        import ctypes
        import time
        try:
            import tkinter
            tkinter.Tk().destroy()
        except Exception as exc:
            self.skipTest('no Tk display: ' + type(exc).__name__)
        state = Path(self.tmp.name) / 'state'
        names = tuple('Local\\CortexTest%s-%d' % (kind, os.getpid()) for kind in ('Kilit', 'Dur', 'Ac'))
        code = ('import sys; sys.path.insert(0, %r); import beyin_v3_yakala as y; '
                'sys.exit(y.listen_windows(%r, %r, spec="ctrl+alt+shift+f11", mutex_name=%r, stop_name=%r, open_name=%r))'
                % (str(SCRIPTS), str(self.vault), str(state), *names))
        # Its windows are built and never shown: nothing appears on the screen of whoever runs the tests.
        # Its record of whose key it is and its word to the desktop app stay in the test's folder.
        hidden = dict(os.environ, BEYIN_YAKALA_GIZLI='1', LOCALAPPDATA=str(Path(self.tmp.name) / 'local'))
        listener = subprocess.Popen([sys.executable, '-c', code], env=hidden)
        self.addCleanup(lambda: listener.poll() is None and listener.kill())

        def info():
            try:
                return json.loads((state / yakala.LISTENER_STATE).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return {}
        deadline = time.monotonic() + 20
        while 'kisayol_calisiyor' not in info() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not info().get('kisayol_calisiyor'):
            self.skipTest('the test hotkey is held elsewhere on this machine')
        twin = subprocess.run([sys.executable, '-c', code], timeout=60, env=hidden)
        self.assertEqual(twin.returncode, 0)  # one listener per user: the second steps aside
        user32 = ctypes.windll.user32
        user32.PostThreadMessageW.argtypes = [ctypes.c_ulong, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
        pressed = time.time()
        user32.PostThreadMessageW(info()['tid'], 0x0312, 1, 0)  # WM_HOTKEY, exactly what the key sends
        deadline = time.monotonic() + 10
        while info().get('son_pencere', 0) < pressed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(info().get('son_pencere', 0), pressed)
        # `yakala pencere` (the desktop app's "Not al") asks the running listener for its window:
        # it takes the request (the auto-reset event is down again a moment later).
        self.assertTrue(yakala.open_windows_listener(open_name=names[2]))
        time.sleep(1.0)
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenEventW.restype = ctypes.c_void_p
        kernel32.OpenEventW.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_wchar_p]
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        event = kernel32.OpenEventW(0x00100000, False, names[2])  # SYNCHRONIZE
        self.assertTrue(event)
        self.assertEqual(kernel32.WaitForSingleObject(event, 0), 258, 'the listener took the request')  # WAIT_TIMEOUT
        kernel32.CloseHandle(event)
        self.assertTrue(yakala.stop_windows_listener(stop_name=names[1], mutex_name=names[0], wait=10))
        self.assertFalse(yakala.open_windows_listener(open_name=names[2]), 'no listener: the window opens by itself')
        self.assertEqual(listener.wait(timeout=10), 0)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows resident listener')
    def test_windows_listener_survives_a_window_that_fails_to_open(self):
        # A malformed link on the clipboard raised while the window was built, and the listener's
        # loop never ran again: no window, no stop for `kur`, the microphone left open.
        import time
        try:
            import tkinter
            tkinter.Tk().destroy()
        except Exception as exc:
            self.skipTest('no Tk display: ' + type(exc).__name__)
        state = Path(self.tmp.name) / 'state'
        names = tuple('Local\\CortexTestHata%s-%d' % (kind, os.getpid()) for kind in ('Kilit', 'Dur', 'Ac'))
        code = ('import sys; sys.path.insert(0, %r); import beyin_v3_yakala as y; real, calls = y.popup, []\n'
                'def popup(*args, **options):\n'
                '    calls.append(1)\n'
                '    if len(calls) == 1:\n'
                '        raise ValueError("Invalid IPv6 URL")\n'
                '    return real(*args, **options)\n'
                'y.popup = popup\n'
                'sys.exit(y.listen_windows(%r, %r, spec="ctrl+alt+shift+f10", mutex_name=%r, stop_name=%r, open_name=%r))'
                % (str(SCRIPTS), str(self.vault), str(state), *names))
        hidden = dict(os.environ, BEYIN_YAKALA_GIZLI='1', LOCALAPPDATA=str(Path(self.tmp.name) / 'local'))
        listener = subprocess.Popen([sys.executable, '-c', code], env=hidden)
        self.addCleanup(lambda: listener.poll() is None and listener.kill())
        log = state / 'yakala' / yakala.LISTENER_LOG

        def info():
            try:
                return json.loads((state / yakala.LISTENER_STATE).read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return {}

        def wait_for(condition, seconds=20):
            deadline = time.monotonic() + seconds
            while not condition() and time.monotonic() < deadline:
                time.sleep(0.05)
            return condition()
        self.assertTrue(wait_for(lambda: 'kisayol_calisiyor' in info()), 'the listener came up')
        self.assertTrue(yakala.open_windows_listener(open_name=names[2]))
        self.assertTrue(wait_for(lambda: log.is_file() and 'Invalid IPv6 URL' in log.read_text(encoding='utf-8')))
        asked = time.time()
        self.assertTrue(yakala.open_windows_listener(open_name=names[2]))
        self.assertTrue(wait_for(lambda: info().get('son_pencere', 0) >= asked), 'the next request still opens a window')
        self.assertTrue(yakala.stop_windows_listener(stop_name=names[1], mutex_name=names[0], wait=10))
        self.assertEqual(listener.wait(timeout=10), 0)

    def test_vtt_text(self):
        raw = ('WEBVTT\nKind: captions\n\n00:00:00.000 --> 00:00:02.000\nmerhaba <c>dunya</c>\n\n'
               '00:00:02.000 --> 00:00:04.000\nmerhaba dunya\nikinci satir\n\n00:00:40.000 --> 00:00:42.000\nyeni paragraf\n'
               '\n01:00:05.000 --> 01:00:06.000\nsaat\n')
        text = yakala.vtt_text(raw)
        self.assertEqual(text.count('merhaba dunya'), 1)
        self.assertIn('**0:00** merhaba dunya ikinci satir', text)
        self.assertIn('**0:40** yeni paragraf', text)
        self.assertIn('**1:00:05** saat', text)

    def test_repair_mojibake(self):
        good = 'Agent loop’ta en pahalı şey bağlam kaybı'
        self.assertEqual(yakala.repair_mojibake(good.encode('utf-8').decode('mac_roman')), good)
        self.assertEqual(yakala.repair_mojibake('pahalÄ± ÅŸey'), 'pahalı şey')  # cp1252 variant
        for text in ('Müşteri Şifre Arşiv', 'café', 'plain'):
            self.assertEqual(yakala.repair_mojibake(text), text)

    def test_clipper_template_is_importable(self):
        template = yakala.clipper_template()
        for field in ('name', 'behavior', 'properties', 'noteContentFormat', 'noteNameFormat', 'path'):
            self.assertIn(field, template)
        self.assertEqual(template['path'], INBOX)
        names = {prop['name']: prop['value'] for prop in template['properties']}
        self.assertEqual((names['tur'], names['durum']), ('yakala', 'bekliyor'))
        self.assertTrue(all(prop['type'] in ('text', 'multitext', 'number', 'checkbox', 'date', 'datetime')
                            for prop in template['properties']))

    def test_hotkey_specs(self):
        self.assertEqual(yakala.parse_hotkey('ctrl+alt+b'), (['ctrl', 'alt'], 'b'))
        self.assertEqual(yakala.parse_hotkey('Option+Command+K'), (['alt', 'cmd'], 'K'))
        self.assertEqual(yakala.parse_hotkey('⌘⇧space'), (['shift', 'cmd'], 'space'))
        self.assertEqual(yakala.parse_hotkey('cmd++'), (['cmd'], '+'))
        self.assertEqual(yakala.parse_hotkey('cmd+"'), (['cmd'], '"'))
        self.assertEqual(yakala.parse_hotkey('f9'), ([], 'f9'))
        for bad in ('', 'b', 'hyper+b', 'cmd+', 'cmd+pageup'):
            with self.assertRaises(ValueError):
                yakala.parse_hotkey(bad)
        self.assertEqual(yakala.windows_hotkey('ctrl+alt+b'), ('CTRL+ALT+B', 'Ctrl+Alt+B'))
        self.assertEqual(yakala.windows_hotkey('alt+shift+f2')[0], 'ALT+SHIFT+F2')
        for bad in ('cmd+b', 'shift+b', 'ctrl+"'):
            with self.assertRaises(ValueError):
                yakala.windows_hotkey(bad)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS key codes')
    def test_mac_hotkey_codes(self):
        self.assertEqual(yakala.mac_hotkey('ctrl+alt+b')[:2], (11, 0x1800))
        self.assertEqual(yakala.mac_hotkey('cmd+shift+space'), (49, 0x300, '⇧⌘Space'))
        self.assertEqual(yakala.mac_hotkey('alt+f5')[:2], (96, 0x800))

    def test_vault_before_or_after_command(self):
        yakala.capture(self.vault, url='https://ornek.com/a')
        for argv in (['--vault', str(self.vault), '--json', 'liste'], ['liste', '--vault', str(self.vault), '--json']):
            with patch('sys.stdout', new_callable=__import__('io').StringIO) as out:
                yakala.main(argv)
            self.assertEqual(json.loads(out.getvalue())['bekleyen'], 1)

    def test_bad_hotkey_writes_nothing(self):
        state = Path(self.tmp.name) / 'state'
        # The spec is parsed before any platform call, so the macOS branch rejects it on every OS.
        with patch.object(yakala.sys, 'platform', 'darwin'):
            with self.assertRaises(ValueError):
                yakala.install(self.vault, state, spec='hyper+b')
        self.assertFalse((self.vault / INBOX).exists())
        self.assertFalse(state.exists())

    def test_uninstall_leaves_another_vaults_listener(self):
        import plistlib
        agent = Path(self.tmp.name) / 'agent.plist'
        agent.write_bytes(plistlib.dumps({'ProgramArguments': ['python3', 'x.py', 'dinle', '--vault', '/baska/vault']}))
        state = Path(self.tmp.name) / 'state'
        # On Windows os.name still takes the Windows branch: keep it off the real Start menu,
        # Startup and Send To folders and away from a real listener.
        dirs = (Path(self.tmp.name) / 'programs', Path(self.tmp.name) / 'sendto')
        with patch.object(yakala, '_launch_agent', return_value=agent), patch.object(yakala.sys, 'platform', 'darwin'), \
                patch.object(yakala, '_windows_dirs', return_value=dirs), \
                patch.object(yakala, 'stop_windows_listener') as stop, \
                patch.object(yakala.subprocess, 'run') as run:
            result = yakala.uninstall(self.vault, state)
        stop.assert_not_called()
        run.assert_not_called()
        self.assertTrue(agent.exists())
        self.assertNotIn('LaunchAgent', result['kaldirilan'])

    @unittest.skipUnless(os.name == 'nt', 'Windows listener')
    def test_a_test_install_never_stops_the_users_listener(self):
        # Named events are shared by the whole Windows session, unlike APPDATA: a suite run
        # once ended the developer's own Ctrl+Alt+B listener.
        state = Path(self.tmp.name) / 'state'
        with patch.dict(os.environ, {'BEYIN_V3_NO_SPAWN': '1', 'APPDATA': str(Path(self.tmp.name) / 'appdata'),
                                     'LOCALAPPDATA': str(Path(self.tmp.name) / 'local')}), \
                patch.object(yakala, 'stop_windows_listener') as stop:
            yakala.install(self.vault, state)
            self.assertTrue(yakala._owns(self.vault), 'the key is this vault\'s now')
            yakala.uninstall(self.vault, state)
            self.assertIsNone(yakala._owner())
        stop.assert_not_called()

    def test_rewriting_a_card_keeps_what_the_person_added_by_hand(self):
        # Obsidian's Properties panel writes tags as a block list: the next `isle`, `bitti` or
        # recapture dropped them and turned the rest into strings.
        added = ('tags:\n  - okunacak\n  - yapay-zeka\naliases: [Yazi, Makale]\nokundu: true\nsayi: 3\n'
                 'ozet: |\n  birinci satir\n  ikinci satir\n# kendi notum\n')
        result = yakala.capture(self.vault, text='Bağlam kaybı en pahalı kalem.', why='ders')
        path = self.vault / result['path']
        path.write_text(path.read_text(encoding='utf-8').replace('\n---\n', '\n' + added + '---\n', 1), encoding='utf-8')
        none = {name: None for name in ('npx', 'yt_dlp', 'whisper', 'pdftotext', 'ffmpeg')}
        with patch.object(yakala, 'tools', return_value=none):
            yakala.process(self.vault)
        concept = self.vault / 'knowledge/concepts/baglam.md'
        concept.parent.mkdir(parents=True)
        concept.write_text('# Bağlam\n', encoding='utf-8')
        yakala.finish(self.vault, result['id'], ['knowledge/concepts/baglam.md'], 'tek ders')
        text = path.read_text(encoding='utf-8')
        self.assertIn(added, text, 'byte for byte, in its place')
        meta = yakala.find_card(self.vault, result['id'])['meta']
        self.assertEqual((meta['durum'], meta['yontem']), ('islendi', 'metin'), 'the engine\'s own fields still change')
        # A field the engine changes is written anew; one it removes is gone with its lines.
        card = yakala.find_card(self.vault, result['id'])
        yakala.write_card(card['path'], {key: value for key, value in card['meta'].items() if key != 'ozet'}, card['body'])
        text = path.read_text(encoding='utf-8')
        self.assertNotIn('ozet:', text)
        self.assertNotIn('birinci satir', text)
        self.assertIn('tags:\n  - okunacak\n  - yapay-zeka\n', text)

    def test_a_source_captured_again_after_it_was_handled_is_queued_again_without_fetching(self):
        first = yakala.capture(self.vault, url='https://www.youtube.com/watch?v=abc', why='ilk bakış')
        card = yakala.find_card(self.vault, first['id'])
        raw = self.vault / INBOX / '.ham' / (first['id'] + '.md')
        raw.parent.mkdir(parents=True)
        raw.write_text('transkript', encoding='utf-8')
        yakala.write_card(card['path'], dict(card['meta'], durum='islendi', ham=raw.relative_to(self.vault).as_posix()),
                          card['body'] + '\n\n## Islendi\n\nders')
        self.assertEqual(yakala.pending(self.vault), 0)
        again = yakala.capture(self.vault, url='https://youtu.be/abc', why="12:30'daki kısmı bilgi notuna ekle")
        self.assertEqual((again['status'], again['id']), ('mevcut_karta_eklendi', first['id']))
        meta = yakala.find_card(self.vault, first['id'])['meta']
        self.assertEqual(meta['durum'], 'bekliyor')
        self.assertTrue(meta['yeniden_yakalandi'])
        self.assertEqual(yakala.pending(self.vault), 1, 'the session notice counts it')
        with patch.object(yakala, 'via_youtube', side_effect=AssertionError('fetched')), \
                patch.object(yakala, 'via_defuddle', side_effect=AssertionError('fetched')), \
                patch.object(yakala, 'tools', return_value={}):
            result = yakala.process(self.vault)
        entry = result['kartlar'][0]
        self.assertEqual((entry['durum'], entry['yontem'], entry['ham']), ('cikarildi', 'onceki', raw.relative_to(self.vault).as_posix()))
        self.assertIn('Yeniden yakalandi', entry['not'])
        self.assertEqual(raw.read_text(encoding='utf-8'), 'transkript')
        # A source that failed before is retried for the new reason; one still waiting stays as it is.
        failed = yakala.capture(self.vault, url='https://ornek.com/yazi')
        card = yakala.find_card(self.vault, failed['id'])
        yakala.write_card(card['path'], dict(card['meta'], durum='hata', hata='giris'), card['body'])
        yakala.capture(self.vault, url='https://ornek.com/yazi/', why='yeniden dene')
        self.assertEqual(yakala.find_card(self.vault, failed['id'])['meta']['durum'], 'bekliyor')

    def test_a_repeated_link_is_found_from_the_cards_heads(self):
        # Every card in the inbox was read whole on the listener's window thread for each page captured.
        folder = self.vault / INBOX
        folder.mkdir(parents=True)
        for number in range(300):
            (folder / ('kart-%03d.md' % number)).write_text(
                '---\ntur: "yakala"\ndurum: "islendi"\nurl: "https://ornek.com/%d"\n---\n\n# Kart\n\n%s\n'
                % (number, 'uzun metin ' * 2000), encoding='utf-8')
        real, reads = yakala.read_card, []
        with patch.object(yakala, 'read_card', lambda path: reads.append(path) or real(path)):
            result = yakala.capture(self.vault, url='https://www.ornek.com/150/', why='yeniden')
        self.assertEqual((result['status'], result['id']), ('mevcut_karta_eklendi', 'kart-150'))
        self.assertEqual([path.name for path in reads], ['kart-150.md'], 'only the matching card is read whole')
        self.assertIn('yeniden', (folder / 'kart-150.md').read_text(encoding='utf-8'))

    def test_a_vault_that_is_gone_is_not_made_again(self):
        gone = Path(self.tmp.name) / 'Tasinan Kasa'
        with self.assertRaisesRegex(ValueError, 'Kasa bulunamadi'):
            yakala.capture(gone, text='not')
        self.assertFalse(gone.exists())

    def owner_record(self, vault):
        path = yakala.owner_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'surum': 1, 'vault': str(vault), 'state': 'x', 'tus': 'ctrl+alt+c', 'at': 1}), encoding='utf-8')

    def test_the_key_is_one_vaults_at_a_time(self):
        other = Path(self.tmp.name) / 'Baska'
        with patch.dict(os.environ, {'LOCALAPPDATA': str(Path(self.tmp.name) / 'local')}):
            self.assertIsNone(yakala._owner())
            self.assertFalse(yakala._owns(self.vault), 'no record: not known to be this vault\'s')
            yakala._write_owner(self.vault.resolve(), Path(self.tmp.name) / 'state', 'ctrl+alt+x')
            said = yakala._owner()
            self.assertEqual((said['surum'], said['tus']), (1, 'ctrl+alt+x'))
            self.assertIsInstance(said['at'], float)
            self.assertTrue(yakala._owns(self.vault))
            self.owner_record(other)
            self.assertFalse(yakala._owns(self.vault))
            yakala.owner_file().write_text('{yarim', encoding='utf-8')
            self.assertIsNone(yakala._owner(), 'a half-written record says nothing')
        self.assertTrue(yakala._same_vault('/a/b/', '/a/b'))
        self.assertFalse(yakala._same_vault('/a/b', '/a/c'))
        if os.name == 'nt':
            self.assertTrue(yakala._same_vault('C:\\Users\\Ali\\Kasa', 'c:/users/ali/kasa'))

    def test_kaldir_in_a_vault_used_before_leaves_the_current_vaults_listener_and_shortcuts(self):
        state = Path(self.tmp.name) / 'state'
        state.mkdir()
        (state / yakala.STATE_FILE).write_text('{"kisayol": "Ctrl+Alt+C"}', encoding='utf-8')
        (state / yakala.LISTENER_STATE).write_text('{"pid": 4242}', encoding='utf-8')  # it ran a listener once
        programs, sendto = Path(self.tmp.name) / 'programs', Path(self.tmp.name) / 'sendto'
        links = [programs / 'Startup' / yakala.STARTUP_NAME, programs / 'Beyne At.lnk', sendto / 'Beyne At.lnk']
        environment = {key: value for key, value in os.environ.items() if key != 'BEYIN_V3_NO_SPAWN'}
        environment['LOCALAPPDATA'] = str(Path(self.tmp.name) / 'local')
        for owner, mine in ((Path(self.tmp.name) / 'Yeni Kasa', False), (self.vault.resolve(), True)):
            for link in links:
                link.parent.mkdir(parents=True, exist_ok=True)
                link.write_text('lnk', encoding='utf-8')
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(yakala, '_windows_dirs', return_value=(programs, sendto)), \
                    patch.object(yakala, 'stop_windows_listener') as stop, \
                    patch.object(yakala, 'windows_listener_running', return_value=True):
                self.owner_record(owner)
                running, elsewhere = yakala._windows_listener_for(self.vault)
                removed, other = yakala._uninstall_windows(self.vault, state)
                record = yakala._owner()
            self.assertEqual(stop.called, mine, owner)
            self.assertEqual([link.exists() for link in links], [not mine] * 3, owner)
            self.assertEqual(record is None, mine, 'the record goes only with its own vault')
            self.assertEqual((running, elsewhere), (True, None) if mine else (False, str(owner)))
            self.assertEqual(other, None if mine else str(owner))
            self.assertFalse((state / yakala.LISTENER_STATE).exists(), 'this vault\'s own note goes either way')
        self.assertIn('baska bir kasanin', yakala.human({'status': 'kaldirildi', 'sahip_kasa': 'D:\\Yeni'}, 'kaldir'))

    def test_pencere_goes_to_the_running_listener_only_when_it_is_this_vaults(self):
        opened = []
        with patch.dict(os.environ, {'LOCALAPPDATA': str(Path(self.tmp.name) / 'local')}), \
                patch.object(yakala, 'open_windows_listener', return_value=True), \
                patch.object(yakala, 'gather_context', return_value={}), \
                patch.object(yakala, 'popup', lambda vault, context, state=None: opened.append(vault) or {'status': 'vazgecildi'}), \
                patch('sys.stdout', new_callable=__import__('io').StringIO) as out:
            self.owner_record(Path(self.tmp.name) / 'Baska')
            yakala.main(['--vault', str(self.vault), '--json', 'pencere'])
            self.assertEqual(opened, [self.vault.resolve()], 'its own window, on this vault')
            self.owner_record(self.vault.resolve())
            yakala.main(['--vault', str(self.vault), '--json', 'pencere'])
            self.assertEqual(len(opened), 1)
            self.assertIn('"dinleyici"', out.getvalue())

    def test_send_to_says_what_happened(self):
        source = Path(self.tmp.name) / 'rapor.pdf'
        source.write_bytes(b'%PDF-1.4')
        told = []
        arguments = ['--vault', str(self.vault), 'ekle', '--arac', 'gonder-menusu']
        with patch.object(yakala, '_sent_note', lambda ok, text: told.append((ok, text))), patch('sys.stdout', None):
            self.assertEqual(yakala.main(arguments + [str(source)]), 0)
            with patch.object(yakala.shutil, 'copy2', side_effect=PermissionError('Outlook dosyayi kullaniyor')):
                self.assertEqual(yakala.main(arguments + [str(source)]), 1)
            self.assertEqual(yakala.main(arguments + [str(Path(self.tmp.name))]), 1)
        self.assertEqual(told[0], (True, 'rapor.pdf'))
        self.assertEqual(told[1], (False, 'Outlook dosyayi kullaniyor'))
        self.assertFalse(told[2][0])
        self.assertIn('Klasor gonderilemez', told[2][1])
        self.assertEqual(len(list((self.vault / INBOX).glob('*.md'))), 1, 'a folder is not saved as a card of its path')
        # From a terminal it is as before: the error is raised, nothing is shown on the screen.
        with patch.object(yakala, '_sent_note', side_effect=AssertionError('shown')):
            with self.assertRaises(ValueError):
                yakala.main(['--vault', str(self.vault), '--json', 'ekle', '--arac', 'gonder-menusu', str(Path(self.tmp.name))])

    def test_inbox_report_skips_processed_cards(self):
        import beyin_v3_hygiene as hygiene
        waiting = yakala.capture(self.vault, url='https://ornek.com/a')
        done = yakala.capture(self.vault, text='bitti')
        card = yakala.find_card(self.vault, done['id'])
        yakala.write_card(card['path'], dict(card['meta'], durum='islendi'), card['body'])
        rows = hygiene.inbox_report(self.vault)['folders']
        self.assertEqual([row['notes'] for row in rows if row['folder'] == '📥 000-Inbox'], [1])
        self.assertTrue(waiting['id'])

    def test_clipper_card_with_quoted_yaml_is_pending(self):
        folder = self.vault / INBOX
        folder.mkdir(parents=True)
        (folder / 'a.md').write_text('---\ntur: yakala\ndurum: "bekliyor"\nurl: "https://a.com"\n---\n\n# A\n', encoding='utf-8')
        (folder / 'b.md').write_text('---\ntur: not\ndurum: bekliyor\n---\n', encoding='utf-8')
        self.assertEqual(yakala.pending(self.vault), 1)


class YakalaInstalledTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-yakala-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.vault, self.state = root / 'Örnek Beyin', root / 'state'
        self.vault.mkdir()
        self.env = inherited_env(BEYIN_V3_NO_SPAWN='1', PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8',
                                 HOME=str(root / 'home'), APPDATA=str(root / 'appdata'), LOCALAPPDATA=str(root / 'local'))
        self.env.pop('BEYIN_V3_FILTER_HARNESS_TURNS', None)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/install_v3.py'), '--vault', str(self.vault),
                                 '--state', str(self.state)], capture_output=True, text=True, encoding='utf-8',
                                env=self.env, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)

    def entry(self, *args):
        result = subprocess.run([sys.executable, str(self.vault / 'beyin.py'), 'yakala', *args], capture_output=True,
                                text=True, encoding='utf-8', env=self.env, cwd=self.vault, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def session_start(self):
        payload = {'hook_event_name': 'SessionStart', 'session_id': 's1', 'event_id': 's1-1', 'cwd': str(self.vault)}
        result = subprocess.run([sys.executable, str(self.vault / '.claude/scripts/beyin_v3_hook.py'), '--vault',
                                 str(self.vault), '--state', str(self.state), '--harness', 'claude'],
                                input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8',
                                env=self.env, cwd=self.vault, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_installed_module_and_entry(self):
        self.assertTrue((self.vault / '.claude/scripts/beyin_v3_yakala.py').is_file())
        added = self.entry('ekle', 'https://x.com/a/status/7', '--neden', 'okunacak')
        self.assertEqual(added['kaynak_turu'], 'x')
        listed = self.entry('liste')
        self.assertEqual(listed['bekleyen'], 1)

    def test_session_notice_is_opt_in(self):
        self.entry('ekle', 'https://ornek.com/yazi')
        self.assertNotIn('Yakalanan', self.session_start())
        installed = self.entry('kur', '--kisayol-yok')
        self.assertIsNone(installed['kisayol'])
        self.assertTrue((self.state / 'yakala.json').is_file())
        skill = self.vault / '.agents/skills/beyin-yakala/SKILL.md'
        self.assertIn('python3 beyin.py yakala isle', skill.read_text(encoding='utf-8'))
        self.assertTrue((self.vault / installed['web_clipper_sablonu']).is_file())
        self.assertIn('Yakalanan 1 kaynak bekliyor', self.session_start())
        removed = self.entry('kaldir')
        self.assertTrue(removed['notlar_korundu'])
        self.assertFalse(skill.exists())
        self.assertFalse((self.state / 'yakala.json').exists())
        self.assertEqual(len(list((self.vault / INBOX).glob('*.md'))), 1)
        self.assertNotIn('Yakalanan', self.session_start())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows Start menu and Send To shortcuts')
    def test_windows_shortcuts(self):
        appdata = Path(self.env['APPDATA'])
        installed = self.entry('kur')
        self.assertEqual(installed['kisayol'], 'Ctrl+Alt+C')
        owner = json.loads((Path(self.env['LOCALAPPDATA']) / 'beyin-v3' / yakala.OWNER_FILE).read_text(encoding='utf-8'))
        self.assertEqual((owner['surum'], owner['tus']), (1, 'ctrl+alt+c'))
        self.assertTrue(yakala._same_vault(owner['vault'], self.vault.resolve()))
        start = appdata / 'Microsoft/Windows/Start Menu/Programs/Beyne At.lnk'
        sendto = appdata / 'Microsoft/Windows/SendTo/Beyne At.lnk'
        self.assertTrue(start.is_file() and sendto.is_file())
        icon = self.state / yakala.ICON_NAME
        self.assertEqual(icon.read_bytes()[:4], b'\x00\x00\x01\x00')  # Pyn's icon for both shortcuts
        self.assertIsInstance(yakala.windows_context(), dict)
        self.entry('kaldir')
        self.assertFalse(start.exists() or sendto.exists() or icon.exists())
        self.assertFalse((Path(self.env['LOCALAPPDATA']) / 'beyin-v3' / yakala.OWNER_FILE).exists())

    def test_user_skill_with_same_name_is_kept(self):
        own = self.vault / '.agents/skills/beyin-yakala/SKILL.md'
        own.parent.mkdir(parents=True)
        own.write_text('kendi skill\'im\n', encoding='utf-8')
        self.entry('kur', '--kisayol-yok')
        self.entry('kaldir')
        self.assertEqual(own.read_text(encoding='utf-8'), 'kendi skill\'im\n')


class ListenerRestartTest(unittest.TestCase):
    def test_an_update_that_changes_only_a_module_it_loaded_restarts_the_listener(self):
        import types
        with tempfile.TemporaryDirectory(prefix='v3-dinleyici-') as tmp:
            folder = Path(tmp).resolve()
            script, voice, other = folder / 'beyin_v3_yakala.py', folder / 'beyin_v3_ses.py', Path(tmp).resolve().parent / 'baska.py'
            for path in (script, voice):
                path.write_text('', encoding='utf-8')
            module = types.ModuleType('beyin_v3_ses_dinleyici_testi')
            module.__file__ = str(voice)
            with patch.dict(sys.modules, {module.__name__: module}):
                stamps = yakala._own_modules(script)
            self.assertEqual(set(stamps), {script, voice}, 'its own script and what it loaded from the engine, nothing else')
            self.assertNotIn(other, stamps)
            self.assertEqual(yakala._own_modules(script, list(stamps)), stamps)
            os.utime(voice, (stamps[voice] + 5, stamps[voice] + 5))
            self.assertNotEqual(yakala._own_modules(script, list(stamps)), stamps, 'the voice module changed: restart')

    def start_listener(self, reports):
        """_start_windows_listener with the listener's reports (its state file, a report a look) and
        a clock that moves a second a look: (what it returned, what it did to the shortcut and the
        listener)."""
        import threading
        import time
        done = {'stopped': 0}
        clock = iter(range(10 ** 6))
        me, real = threading.get_ident(), time.monotonic

        def tick():  # this thread's clock only
            return float(next(clock)) if threading.get_ident() == me else real()
        with tempfile.TemporaryDirectory(prefix='v3-dinleyici-baslat-') as tmp:
            programs = Path(tmp)
            (programs / 'Startup').mkdir()

            def stop(*_args, **_kwargs):
                done['stopped'] += 1
                return True
            env = {key: value for key, value in os.environ.items() if key != 'BEYIN_V3_NO_SPAWN'}
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(yakala, '_windows_shortcut', lambda path, *_a, **_k: Path(path).write_text('lnk')), \
                    patch.object(yakala.subprocess, 'Popen', lambda *_a, **_k: None), \
                    patch.object(yakala, 'stop_windows_listener', stop), patch.object(yakala, 'time_now', lambda: 100.0), \
                    patch.object(yakala, '_listener_state', lambda _state: next(reports, {})), \
                    patch('time.monotonic', tick), patch('time.sleep', lambda _s: None):
                result = yakala._start_windows_listener(Path('pythonw.exe'), Path('yakala.py'), Path(tmp), Path(tmp), programs, None)
            done['startup_kept'] = (programs / 'Startup' / yakala.STARTUP_NAME).exists()
        return result, done

    def test_a_listener_slow_to_start_or_without_its_key_is_left_running(self):
        # A fresh laptop with the virus scanner reading every file took longer than the wait: the
        # listener was stopped and its Startup shortcut removed, and nothing listened, ever.
        result, done = self.start_listener(iter([]))
        self.assertEqual(result, (None, None), 'not known yet: not called failed')
        self.assertEqual((done['startup_kept'], done['stopped']), (True, 0), 'left to come up, and to start with Windows')
        result, done = self.start_listener(iter([{}, {'at': 101.0, 'kisayol_calisiyor': True}]))
        self.assertEqual((result, done['startup_kept'], done['stopped']), ((True, True), True, 0))
        # Another app holds the key: the listener was stopped and its Startup shortcut removed, and
        # the voice and the wake phrase, which only it runs, went with it. Now it stays without
        # the key (and asks for it again); only the key is reported as taken.
        result, done = self.start_listener(iter([{'at': 101.0, 'kisayol_calisiyor': False}]))
        self.assertEqual((result, done['startup_kept'], done['stopped']), ((True, False), True, 0), 'another app holds the key')
        self.assertIn('Dinleyici aciliyor', yakala.human({'status': 'kuruldu', 'dinleyici': None, 'web_clipper_sablonu': 'x'}, 'kur'))
        said = yakala.human({'status': 'kuruldu', 'dinleyici': True, 'kisayol': 'Ctrl+Alt+C', 'kisayol_calisiyor': False,
                             'web_clipper_sablonu': 'x'}, 'kur')
        self.assertIn('Ctrl+Alt+C baska bir uygulamada kayitli. Dinleyici yine calisiyor', said)
        self.assertNotIn('Pencere aninda acilir', said)


class HotkeyMoveTest(unittest.TestCase):
    def test_the_old_default_moves_to_ctrl_alt_c_once_and_a_chosen_key_stays(self):
        with tempfile.TemporaryDirectory(prefix='v3-tus-') as tmp:
            state = Path(tmp)
            path = state / yakala.STATE_FILE
            path.write_text(json.dumps({'schema': 1, 'kisayol': 'Ctrl+Alt+B', 'tus': 'ctrl+alt+b'}), encoding='utf-8')
            self.assertEqual(yakala.saved_hotkey(state), 'ctrl+alt+c')
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['tus'], 'ctrl+alt+c', 'kept, so the listener and the hints agree')
            if os.name == 'nt':
                self.assertEqual(saved['kisayol'], 'Ctrl+Alt+C')
            path.write_text(json.dumps({'schema': 1, 'kisayol': 'Ctrl+Alt+B', 'tus': 'ctrl+alt+b', 'tus_secildi': True}), encoding='utf-8')
            self.assertEqual(yakala.saved_hotkey(state), 'ctrl+alt+b', 'chosen by the person: never moved')
            path.write_text(json.dumps({'schema': 1, 'tus': 'ctrl+shift+space'}), encoding='utf-8')
            self.assertEqual(yakala.saved_hotkey(state), 'ctrl+shift+space')


if __name__ == '__main__':
    unittest.main()

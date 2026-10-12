"""`pyn`: pick an AI client, open it in the vault, and the one-word shell command."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from v3_package_helpers import inherited_env

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_pyn as pyn  # noqa: E402


def fake_which(installed):
    return lambda name: ('/bin/' + name) if name in installed else None


class PynChoiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-pyn-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Örnek Beyin'
        self.vault.mkdir()
        self.state = Path(self.tmp.name) / 'state'

    def test_only_installed_clients_are_offered_with_honest_memory_labels(self):
        found, hints = pyn.options(local=(), which=fake_which({'claude', 'gemini', 'cursor-agent'}))
        self.assertEqual([o['id'] for o in found], ['claude', 'gemini', 'cursor'])
        self.assertEqual([o['hafiza'] for o in found], ['tam', 'talimat', 'talimat'])
        self.assertTrue(any('OpenCode' in hint and 'npm i -g opencode-ai' in hint for hint in hints))
        menu = pyn.menu_text(found, found[0], hints)
        self.assertIn('tam hafıza', menu)
        self.assertIn('AGENTS.md', menu)

    def test_gemini_and_qwen_show_full_memory_once_their_hooks_are_installed(self):
        settings = self.vault / '.gemini/settings.json'
        settings.parent.mkdir()
        settings.write_text(json.dumps({'hooks': {'BeforeAgent': [{'hooks': [
            {'name': 'cortex-pyn', 'type': 'command', 'command': 'py beyin_v3_hook.py --harness gemini'}]}]}}),
            encoding='utf-8')
        found, _ = pyn.options(local=(), which=fake_which({'gemini', 'qwen'}), vault=self.vault)
        self.assertEqual({o['id']: o['hafiza'] for o in found}, {'gemini': 'tam', 'qwen': 'talimat'})

    def test_answers_number_id_name_and_default(self):
        found, _ = pyn.options(local=(), which=fake_which({'claude', 'codex', 'gemini'}))
        self.assertEqual(pyn.pick(found, '', found[1])['id'], 'codex')  # Enter keeps the default
        self.assertEqual(pyn.pick(found, '3', None)['id'], 'gemini')
        self.assertEqual(pyn.pick(found, 'codex', None)['id'], 'codex')
        self.assertEqual(pyn.pick(found, 'Gem', None)['id'], 'gemini')
        self.assertIsNone(pyn.pick(found, '9', None))
        self.assertIsNone(pyn.pick(found, 'c', None))  # Claude and Codex: ambiguous, ask again

    def serve(self, routes):
        class Local(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path not in routes:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps(routes[self.path]).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Local)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)  # cleanups run last-in first-out: shutdown, then close
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:%d' % server.server_port

    def test_local_models_only_from_a_running_server_and_only_through_codex(self):
        ollama = self.serve({
            '/api/tags': {'models': [{'name': 'qwen3:8b'}, {'name': 'gemma3:4b'},
                                     {'name': 'bge-m3:latest', 'details': {'family': 'bert'}},
                                     {'name': 'nomic-embed-text:latest'}]},
            '/api/ps': {'models': [{'name': 'gemma3:4b'}]}})
        local = (('ollama', 'Ollama', lambda: pyn.ollama_models(base=ollama)),
                 ('lmstudio', 'LM Studio', lambda: pyn.lmstudio_models(base='http://127.0.0.1:9')))
        found, hints = pyn.options(local=local, which=fake_which({'codex', 'lms'}))
        offline = [o for o in found if o['id'] == 'codex-ollama']
        self.assertEqual(len(offline), 1)
        self.assertEqual(offline[0]['args'], ['--oss', '--local-provider', 'ollama'])
        self.assertEqual(offline[0]['modeller'], ['qwen3:8b', 'gemma3:4b'])  # embedding models left out
        self.assertEqual(offline[0]['yuklu'], ['gemma3:4b'])
        self.assertEqual(offline[0]['hafiza'], 'tam')  # Codex hooks: full memory on a local model
        off = [o for o in found if o.get('kapali')]
        self.assertEqual([(o['id'], o['ad']) for o in off], [('lmstudio', 'LM Studio')], 'Installed, server off: red row')
        self.assertNotIn(off[0], pyn.usable(found))
        menu = pyn.menu_text(found, found[0], hints)
        self.assertIn('○ LM Studio', menu)
        self.assertIn('kapalı · açıp bir model yükle', menu)
        self.assertIn('● Codex', menu)
        found, _ = pyn.options(local=local, which=fake_which({'claude'}))
        self.assertEqual([o['id'] for o in found], ['claude'])  # no Codex, no local entry

    def test_lm_studio_reports_its_loaded_model_and_hides_embeddings(self):
        studio = self.serve({'/api/v0/models': {'data': [
            {'id': 'qwen2.5-coder-14b', 'type': 'llm', 'state': 'not-loaded'},
            {'id': 'gpt-oss-20b', 'type': 'llm', 'state': 'loaded'},
            {'id': 'text-embedding-nomic', 'type': 'embeddings', 'state': 'loaded'}]}})
        self.assertEqual(pyn.lmstudio_models(base=studio), (['qwen2.5-coder-14b', 'gpt-oss-20b'], ['gpt-oss-20b'], {}))
        older = self.serve({'/v1/models': {'data': [{'id': 'mistral-7b'}, {'id': 'text-embedding-bge-m3'}]}})
        self.assertEqual(pyn.lmstudio_models(base=older), (['mistral-7b'], [], {}))  # no load state there
        sized = self.serve({'/api/v0/models': {'data': [
            {'id': 'qwen3-coder-30b', 'type': 'llm', 'state': 'loaded', 'loaded_context_length': 4096,
             'max_context_length': 262144}]}})
        self.assertEqual(pyn.lmstudio_models(base=sized)[2], {'qwen3-coder-30b': 4096})  # loaded, not the maximum

    def test_local_models_open_in_opencode_when_it_is_installed(self):
        local = (('lmstudio', 'LM Studio', lambda: (['a', 'qwen3-coder-30b'], ['qwen3-coder-30b'],
                                                    {'qwen3-coder-30b': 65536})),)
        found, _ = pyn.options(local=local, which=fake_which({'codex', 'opencode'}))
        self.assertEqual([o['id'] for o in found], ['codex', 'opencode', 'opencode-lmstudio'])  # not twice
        studio = found[2]
        self.assertEqual((studio['istemci'], studio['args'], studio['hafiza']), ('OpenCode', [], 'tam'))
        args, env, warning = pyn.local_launch(studio, 'qwen3-coder-30b', environ={'PATH': 'x'})
        self.assertEqual(args, ['-m', 'lmstudio/qwen3-coder-30b'])
        self.assertIsNone(warning)
        self.assertEqual(env['PATH'], 'x')
        declared = json.loads(env['OPENCODE_CONFIG_CONTENT'])  # this launch only: no file is written
        self.assertEqual(declared['provider']['lmstudio']['models']['qwen3-coder-30b']['limit'],
                         {'context': 65536, 'output': 16384})
        self.assertNotIn('options', declared['provider']['lmstudio'])  # OpenCode's own LM Studio provider

    def test_ollama_in_opencode_is_declared_and_a_short_context_warns(self):
        option = {'id': 'opencode-ollama', 'saglayici': 'ollama', 'yerel': 'Ollama', 'istemci': 'OpenCode',
                  'args': [], 'baglam': {'qwen3:8b': 4096}}
        own = json.dumps({'provider': {'ollama': {'options': {'headers': {'X': '1'}}}}, 'theme': 'mine'})
        args, env, warning = pyn.local_launch(option, 'qwen3:8b', environ={'OPENCODE_CONFIG_CONTENT': own})
        self.assertEqual(args, ['-m', 'ollama/qwen3:8b'])
        declared = json.loads(env['OPENCODE_CONFIG_CONTENT'])
        self.assertEqual(declared['theme'], 'mine')  # the user's own inline config is kept
        self.assertEqual(declared['provider']['ollama']['options'],
                         {'headers': {'X': '1'}, 'baseURL': 'http://127.0.0.1:11434/v1'})
        self.assertIn('qwen3:8b', declared['provider']['ollama']['models'])
        self.assertIn('4096', warning)
        codex = dict(option, id='codex-ollama', istemci='Codex', args=['--oss', '--local-provider', 'ollama'])
        args, env, warning = pyn.local_launch(codex, 'qwen3:8b')
        self.assertEqual((args, env), (['--oss', '--local-provider', 'ollama', '-m', 'qwen3:8b'], None))
        self.assertIn('Codex', warning)

    def test_the_machine_decides_the_model_not_a_question(self):
        option = {'saglayici': 'ollama', 'modeller': ['a', 'b', 'c'], 'yuklu': []}
        self.assertIsNone(pyn.local_model(option, {}))  # several, none loaded, nothing remembered: ask once
        self.assertEqual(pyn.local_model(dict(option, yuklu=['c']), {}), 'c')  # loaded right now wins
        remembered = {'modeller': {'ollama': 'b', 'lmstudio': 'z'}}
        self.assertEqual(pyn.local_model(option, remembered), 'b')  # this machine's last one
        self.assertEqual(pyn.local_model(dict(option, yuklu=['c']), remembered), 'c')  # but loaded beats it
        self.assertEqual(pyn.local_model(dict(option, yuklu=['b', 'c']), remembered), 'b')
        self.assertEqual(pyn.local_model({'saglayici': 'ollama', 'modeller': ['tek'], 'yuklu': []}, {}), 'tek')
        found, _ = pyn.options(local=(('ollama', 'Ollama', lambda: (['a', 'b'], [])),), which=fake_which({'codex'}))
        pyn._remember(self.state, found[1], 'b')
        pyn._remember(self.state, found[0], None)  # another client later keeps the remembered model
        self.assertEqual(pyn._last(self.state), {'secim': 'codex', 'modeller': {'ollama': 'b'}})

    def test_instruction_clients_read_agents_md_without_losing_settings(self):
        gemini = dict(pyn.CLIENTS[4])
        settings = self.vault / '.gemini/settings.json'
        settings.parent.mkdir()
        settings.write_text(json.dumps({'theme': 'Ananas', 'context': {'fileName': 'NOTLAR.md'}}), encoding='utf-8')
        self.assertEqual(pyn.ensure_context(self.vault, gemini), 'yazildi')
        self.assertEqual(json.loads(settings.read_text(encoding='utf-8')),
                         {'theme': 'Ananas', 'context': {'fileName': ['AGENTS.md', 'NOTLAR.md']}})
        self.assertEqual(pyn.ensure_context(self.vault, gemini), 'hazir')
        qwen = dict(pyn.CLIENTS[5])
        self.assertEqual(pyn.ensure_context(self.vault, qwen), 'yazildi')
        self.assertEqual(json.loads((self.vault / '.qwen/settings.json').read_text(encoding='utf-8')),
                         {'context': {'fileName': ['AGENTS.md', 'QWEN.md']}})
        settings.write_text('{bozuk', encoding='utf-8')
        self.assertEqual(pyn.ensure_context(self.vault, gemini), 'okunamadı')
        self.assertEqual(settings.read_text(encoding='utf-8'), '{bozuk')  # never rewritten
        self.assertIsNone(pyn.ensure_context(self.vault, dict(pyn.CLIENTS[0])))  # hook clients need nothing

    def test_launch_runs_in_the_vault_and_passes_arguments(self):
        calls = []
        option = dict(pyn.CLIENTS[1], yol='/bin/codex', args=['--oss'])
        code = pyn.launch(self.vault, option, ['--continue'], run=lambda cmd, cwd: calls.append((cmd, cwd)) or 7)
        self.assertEqual(code, 7)
        self.assertEqual(calls, [(['/bin/codex', '--oss', '--continue'], str(self.vault))])
        calls = []
        option = dict(pyn.CLIENTS[2], yol='/bin/opencode', args=['-m', 'lmstudio/x'], env={'OPENCODE_CONFIG_CONTENT': '{}'})
        pyn.launch(self.vault, option, [], run=lambda cmd, cwd, env: calls.append(env) or 0)
        self.assertEqual(calls, [{'OPENCODE_CONFIG_CONTENT': '{}'}])

    def test_a_red_row_explains_instead_of_launching(self):
        from unittest import mock
        found = [dict(pyn.CLIENTS[0], yol='/bin/claude', args=[]), {'id': 'ollama', 'ad': 'Ollama', 'hafiza': 'tam',
                                                                   'kapali': True}]
        pyn._remember(self.state, found[1], None)  # even a remembered red row is never the default
        launched = []
        with mock.patch.object(pyn, 'options', return_value=(found, [])), \
                mock.patch.object(pyn, 'launch', side_effect=lambda v, o, e: launched.append(o['id']) or 0), \
                mock.patch.object(pyn, 'ensure_context', return_value=None):
            self.assertEqual(pyn.main(['ollama'], self.vault, self.state, interactive=False), 1)
            self.assertEqual(launched, [])
            self.assertEqual(pyn.main([], self.vault, self.state, interactive=False), 0)
        self.assertEqual(launched, ['claude'])

    def test_old_local_choice_finds_the_same_server_under_opencode(self):
        local = (('lmstudio', 'LM Studio', lambda: (['qwen3-8b'], ['qwen3-8b'], {})),)
        found, _ = pyn.options(local=local, which=fake_which({'claude', 'codex', 'opencode'}))
        self.assertIn('opencode-lmstudio', [o['id'] for o in found])
        # Saved by 1.0.3/1.0.4, or typed in an old shortcut: `pyn codex-lmstudio`.
        self.assertEqual(pyn.by_id(found, 'codex-lmstudio')['id'], 'opencode-lmstudio')
        self.assertEqual(pyn.pick(found, 'codex-lmstudio', None)['id'], 'opencode-lmstudio')
        self.assertIsNone(pyn.by_id(found, 'codex-ollama'))
        self.assertIsNone(pyn.by_id(found, 'gemini'))

    def test_last_choice_is_remembered(self):
        found, _ = pyn.options(local=(), which=fake_which({'claude', 'codex'}))
        pyn._remember(self.state, found[1], None)
        self.assertEqual(pyn._last(self.state)['secim'], 'codex')
        self.assertEqual(pyn.choose_model(['a', 'b'], 'b', read=lambda _p: '', write=lambda *_: None), 'b')
        self.assertEqual(pyn.choose_model(['a', 'b'], None, read=lambda _p: '2', write=lambda *_: None), 'b')

    def test_welcome_box_is_the_same_for_everyone_and_leaves_room_for_the_seal(self):
        import re
        companion = self.vault / '🔮 850-Companion'
        companion.mkdir()
        (companion / 'Core.md').write_text('- Kullanıcının adı: Tolga. (Kaynak: beyan)\n', encoding='utf-8')
        (companion / 'Last-Session.md').write_text('# Son oturum\n\n## 2026-10-12 21:05 · Logo · 92ee3e48\n',
                                                   encoding='utf-8')
        (self.vault / '.beyin-version').write_text('1.0.5\n', encoding='utf-8')
        for columns in (40, 90, 300):
            for logo in (True, False):
                lines, place = pyn.welcome_box(self.vault, columns, logo=logo)
                plain = [re.sub(r'\x1b\[[0-9;]*m', '', line) for line in lines]
                self.assertEqual(len({len(line) for line in plain}), 1, 'Every line of the box is equally wide')
                self.assertIn('Pyn · Cortex 1.0.5', plain[0])
                self.assertTrue(any(pyn.GREETING in line for line in plain))
                self.assertFalse(any('Tolga' in line for line in plain), 'No one\'s name: a vault can be shared')
                self.assertTrue(any('2026-10-12 21:05 · Logo' in line and '92ee3e48' not in line for line in plain))
                self.assertEqual(place is not None, logo)
                if logo:  # the seal's rows of the left column are empty
                    row, column = place
                    for line in plain[row:row + pyn.LOGO_ROWS]:
                        self.assertEqual(line[column:column + pyn.LOGO_COLUMNS].strip(), '')

    def test_a_newer_cortex_is_announced_in_the_box_and_the_menu(self):
        import re
        from unittest import mock
        import beyin_v3_releases as releases
        newer = {'status': 'available', 'version': '1.0.7', 'current_version': '1.0.6', 'release_url': 'x'}
        with mock.patch.object(releases, 'status', return_value=newer):
            update = pyn.available_update(self.vault, self.state)
        self.assertEqual(update, {'version': '1.0.7', 'current': '1.0.6'})
        self.assertEqual(pyn.update_hint(update), 'Cortex: 1.0.7 çıktı (sende 1.0.6); güncelle: pyn guncelle')
        lines, _ = pyn.welcome_box(self.vault, 90, update=update)
        plain = [re.sub(r'\x1b\[[0-9;]*m', '', line) for line in lines]
        self.assertTrue(any('Yeni sürüm: Cortex 1.0.7 hazır' in line for line in plain))
        self.assertEqual(len({len(line) for line in plain}), 1)
        for status in ({'status': 'up_to_date'}, {'status': 'unavailable', 'reason': 'http_404'}, {'status': 'disabled'}):
            with mock.patch.object(releases, 'status', return_value=status):
                self.assertIsNone(pyn.available_update(self.vault, self.state), status)
        lines, _ = pyn.welcome_box(self.vault, 90)
        self.assertFalse(any('Yeni sürüm' in line for line in lines), 'Nothing newer: no line')

    def test_pyn_guncelle_runs_the_vaults_own_updater(self):
        from unittest import mock
        with mock.patch.object(pyn.subprocess, 'call', return_value=0) as call:
            self.assertEqual(pyn.main(['guncelle', '--check'], self.vault, self.state), 0)
        self.assertEqual(call.call_args.args[0][1:], [str(self.vault / 'beyin.py'), 'update', '--check'])

    def test_seal_is_drawn_only_where_the_terminal_shows_images(self):
        windows_terminal = lambda: '\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c'  # noqa: E731
        conhost = lambda: '\x1b[?1;0c'  # noqa: E731
        silent = lambda: ''  # noqa: E731
        # The terminal's own answer decides, even without WT_SESSION (cmd from the Start menu).
        self.assertTrue(pyn.sixel_terminal({}, ask=windows_terminal))
        self.assertFalse(pyn.sixel_terminal({'WT_SESSION': 'x'}, ask=conhost))
        self.assertFalse(pyn.sixel_terminal({'WT_SESSION': 'x', 'PYN_LOGO': '0'}, ask=windows_terminal))
        self.assertTrue(pyn.sixel_terminal({'PYN_LOGO': '1'}, ask=silent))
        # No answer: the environment is the fallback.
        self.assertTrue(pyn.sixel_terminal({'WT_SESSION': 'x'}, ask=silent))
        self.assertFalse(pyn.sixel_terminal({}, ask=silent))
        self.assertTrue(pyn._sixel_seal().startswith('\x1bP'))


class PynShellTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-pyn-shell-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_profile_block_is_added_once_and_removed_cleanly(self):
        profile = self.root / 'WindowsPowerShell/Microsoft.PowerShell_profile.ps1'
        profile.parent.mkdir()
        profile.write_text('Set-Alias ll Get-ChildItem\n', encoding='utf-8')
        vault = self.root / 'Pyn Kasası'
        pyn.install_shell(vault, [profile], python='C:/Python/python.exe', windows=True)
        pyn.install_shell(vault, [profile], python='C:/Python/python.exe', windows=True)
        text = profile.read_text(encoding='utf-8-sig')
        self.assertEqual(text.count(pyn.BEGIN), 1)
        self.assertTrue(text.startswith('Set-Alias ll Get-ChildItem'))
        self.assertIn('function pyn { & "C:/Python/python.exe" "' + str(vault / 'beyin.py') + '" pyn @args }', text)
        self.assertEqual(profile.read_bytes()[:3], b'\xef\xbb\xbf')  # BOM: PowerShell 5.1 reads UTF-8
        self.assertEqual(pyn.uninstall_shell([profile])['status'], 'kaldirildi')
        self.assertEqual(profile.read_text(encoding='utf-8-sig'), 'Set-Alias ll Get-ChildItem\n')
        self.assertEqual(pyn.uninstall_shell([profile])['status'], 'kurulu_degil')

    def test_cmd_gets_a_pyn_cmd_on_path_and_loses_it_on_uninstall(self):
        bin_dir = self.root / 'WindowsApps'
        bin_dir.mkdir()
        vault = self.root / 'Pyn Kasası'
        pyn.install_shell(vault, [], python='C:/Python/python.exe', windows=True, cmd=bin_dir)
        data = (bin_dir / 'pyn.cmd').read_bytes()
        self.assertTrue(data.startswith(b'@echo off\r\n'))
        self.assertIn(pyn.BEGIN.encode('ascii'), data)
        self.assertTrue(data.rstrip().endswith(b'pyn %*'))
        # The console's code page when it holds the path, else UTF-8 after `chcp 65001`.
        text = data.decode('utf-8' if b'chcp 65001' in data or os.name != 'nt' else 'oem')
        self.assertIn('"C:/Python/python.exe" "' + str(vault / 'beyin.py') + '" pyn %*', text)
        self.assertEqual(pyn.uninstall_shell([], cmd=bin_dir)['status'], 'kaldirildi')
        self.assertFalse((bin_dir / 'pyn.cmd').exists())
        # Someone else's pyn.cmd is neither replaced nor deleted.
        (bin_dir / 'pyn.cmd').write_bytes(b'@echo off\r\necho baska\r\n')
        pyn.install_shell(vault, [], python='C:/Python/python.exe', windows=True, cmd=bin_dir)
        pyn.uninstall_shell([], cmd=bin_dir)
        self.assertEqual((bin_dir / 'pyn.cmd').read_bytes(), b'@echo off\r\necho baska\r\n')

    def test_pyn_cmd_goes_only_to_windowsapps_already_on_path(self):
        apps = self.root / 'Microsoft' / 'WindowsApps'
        apps.mkdir(parents=True)
        self.assertEqual(pyn.cmd_dir({'LOCALAPPDATA': str(self.root), 'PATH': 'C:\\x;' + str(apps) + '\\'}), apps)
        self.assertIsNone(pyn.cmd_dir({'LOCALAPPDATA': str(self.root), 'PATH': 'C:\\x'}))
        self.assertIsNone(pyn.cmd_dir({'PATH': str(apps)}))

    def test_posix_function_quotes_paths_and_passes_all_arguments(self):
        rc = self.root / '.zshrc'
        pyn.install_shell(self.root / 'My Vault', [rc], python='/usr/bin/python3', windows=False)
        self.assertIn('pyn() { "/usr/bin/python3" "' + str(self.root / 'My Vault' / 'beyin.py') + '" pyn "$@"; }',
                      rc.read_text(encoding='utf-8'))


class PynLookTest(unittest.TestCase):
    """`pyn kur` also gives Claude Code a Pyn status line and Windows Terminal a Pyn profile."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-pyn-look-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.vault, self.state = self.root / 'Örnek Beyin', self.root / 'state'
        (self.vault / '.claude').mkdir(parents=True)
        self.settings = self.vault / '.claude' / 'settings.local.json'
        self.settings.write_text(json.dumps({'hooks': {'Stop': []}}), encoding='utf-8')

    def test_status_line_is_added_kept_beside_hooks_and_removed(self):
        self.assertEqual(pyn.install_statusline(self.vault, self.state, python='C:/Py/python.exe', windows=True),
                         'kuruldu')
        data = json.loads(self.settings.read_text(encoding='utf-8'))
        self.assertEqual(data['hooks'], {'Stop': []}, 'Cortex hooks stay untouched')
        command = data['statusLine']['command']
        self.assertIn('-EncodedCommand', command, 'Same Windows-safe form as the hooks')
        self.assertNotIn('Örnek', command, 'The Unicode path stays inside the encoded script')
        # Again: updated in place, not refused as someone else's.
        self.assertEqual(pyn.install_statusline(self.vault, self.state, python='C:/Py/python.exe', windows=True),
                         'kuruldu')
        self.assertEqual(pyn.uninstall_statusline(self.vault, self.state), 'kaldirildi')
        self.assertNotIn('statusLine', json.loads(self.settings.read_text(encoding='utf-8')))

    def test_someone_elses_status_line_is_left_alone(self):
        self.settings.write_text(json.dumps({'statusLine': {'type': 'command', 'command': 'benim.sh'}}),
                                 encoding='utf-8')
        self.assertEqual(pyn.install_statusline(self.vault, self.state, windows=False), 'başkasının')
        self.assertEqual(pyn.uninstall_statusline(self.vault, self.state), 'kurulu_degil')
        self.assertEqual(json.loads(self.settings.read_text(encoding='utf-8'))['statusLine']['command'], 'benim.sh')

    def test_status_line_script_shows_pyn_model_and_last_session(self):
        import io
        import re
        sys.path.insert(0, str(SCRIPTS))
        import beyin_v3_statusline as statusline
        companion = self.vault / '🔮 850-Companion'
        companion.mkdir()
        (companion / 'Last-Session.md').write_text('# Son oturum\n\n## 2026-10-12 21:05 · Logo işi · 92ee3e48\n',
                                                   encoding='utf-8')
        out = io.BytesIO()
        statusline.main(['--vault', str(self.vault)], io.BytesIO(b'{"model": {"display_name": "Sonnet 5.5"}}'), out)
        plain = re.sub(r'\x1b\[[0-9;]*m', '', out.getvalue().decode('utf-8'))
        self.assertEqual(plain, 'Pyn · ikinci beyin · Sonnet 5.5 · son: Logo işi')
        out = io.BytesIO()
        statusline.main(['--vault', str(self.root / 'yok')], io.BytesIO(b'not json'), out)
        self.assertTrue(out.getvalue().decode('utf-8').endswith('ikinci beyin\x1b[0m'), 'Bad input still prints')

    def test_windows_terminal_profile_is_added_once_and_removed(self):
        local = self.root / 'local'
        folder = local / 'Packages' / 'Microsoft.WindowsTerminal_8wekyb3d8bbwe' / 'LocalState'
        folder.mkdir(parents=True)
        original = {'defaultProfile': '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}',
                    'profiles': {'defaults': {}, 'list': [{'guid': '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}',
                                                           'name': 'Windows PowerShell'}]}}
        (folder / 'settings.json').write_text(json.dumps(original), encoding='utf-8')
        environ = {'LOCALAPPDATA': str(local)}
        for _ in range(2):
            self.assertEqual(pyn.install_terminal_profile(environ), [(str(folder / 'settings.json'), 'kuruldu')])
        data = json.loads((folder / 'settings.json').read_text(encoding='utf-8'))
        names = [p['name'] for p in data['profiles']['list']]
        self.assertEqual(names, ['Pyn', 'Windows PowerShell'], 'One Pyn profile, first in the menu')
        profile = data['profiles']['list'][0]
        self.assertEqual(profile['icon'], 'ms-appdata:///local/pyn-ikon.png', 'Store build reads its own folder')
        self.assertTrue((folder / 'pyn-ikon.png').read_bytes().startswith(b'\x89PNG'))
        self.assertTrue((folder / 'pyn-muhur-200.png').read_bytes().startswith(b'\x89PNG'))
        self.assertEqual(data['defaultProfile'], original['defaultProfile'], 'The default profile is not changed')
        self.assertEqual(json.loads((folder / 'settings.pyn-yedek.json').read_text(encoding='utf-8')), original)
        self.assertEqual(pyn.uninstall_terminal_profile(environ), [str(folder / 'settings.json')])
        data = json.loads((folder / 'settings.json').read_text(encoding='utf-8'))
        self.assertEqual([p['name'] for p in data['profiles']['list']], ['Windows PowerShell'])
        self.assertFalse((folder / 'pyn-ikon.png').exists())

    def test_terminal_settings_with_comments_are_not_rewritten(self):
        folder = self.root / 'local' / 'Microsoft' / 'Windows Terminal'
        folder.mkdir(parents=True)
        text = '// benim ayarım\n{"profiles": {"list": []}}\n'
        (folder / 'settings.json').write_text(text, encoding='utf-8')
        result = pyn.install_terminal_profile({'LOCALAPPDATA': str(self.root / 'local')})
        self.assertEqual(result, [(str(folder / 'settings.json'), 'okunamadı')])
        self.assertEqual((folder / 'settings.json').read_text(encoding='utf-8'), text)

    def test_outdated_clients_show_in_the_menu_until_checked_again(self):
        found, _ = pyn.options(local=(), which=fake_which({'claude', 'codex', 'cursor-agent'}))
        answers = {('/bin/claude', '--version'): '2.1.296 (Claude Code)', ('/bin/codex', '--version'): 'codex-cli 0.122.0',
                   ('/bin/npm', 'view', '@anthropic-ai/claude-code', 'version'): '2.1.296\n',
                   ('/bin/npm', 'view', '@openai/codex', 'version'): '0.162.1\n',
                   ('/bin/cursor-agent', '--version'): '2026.05.01'}
        results = pyn.check_clients(found, run=lambda argv, timeout: answers.get(tuple(argv), ''),
                                    which=fake_which({'npm'}))
        self.assertEqual(results['codex'], {'ad': 'Codex', 'kurulu': '0.122.0', 'son': '0.162.1', 'paket': '@openai/codex'})
        self.assertIsNone(results['cursor']['son'], 'Not an npm client: no latest version')
        pyn.save_health(self.state, results, now=1000.0)
        hints = pyn.health_hints(self.state, now=1000.0)
        self.assertEqual(hints, ['Codex: 0.122.0 kurulu, 0.162.1 çıktı; güncelle: npm i -g @openai/codex@latest'])
        self.assertIn('pyn kontrol', pyn.health_hints(self.state, now=1000.0 + 15 * 86400)[-1])
        self.assertIn('0.122.0 → 0.162.1', pyn.health_report(results))
        self.assertEqual(pyn.health_hints(self.root / 'hic-yok'), [], 'Never checked: no note, no network')


class PynInstalledEntryTest(unittest.TestCase):
    def test_installed_entry_lists_and_passes_arguments_untouched(self):
        with tempfile.TemporaryDirectory(prefix='v3-pyn-installed-') as tmp:
            root = Path(tmp)
            vault, state = root / 'Örnek Beyin', root / 'state'
            vault.mkdir()
            env = inherited_env(BEYIN_V3_NO_SPAWN='1', PYTHONIOENCODING='utf-8',
                                HOME=str(root / 'home'), APPDATA=str(root / 'appdata'))
            installed = subprocess.run([sys.executable, str(ROOT / 'scripts/install_v3.py'), '--vault', str(vault),
                                        '--state', str(state)], capture_output=True, text=True, encoding='utf-8',
                                       env=env, timeout=120)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            # A fake client on PATH records where it ran and what it received.
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            record = root / 'cagri.json'
            fake = bin_dir / 'fakecli.py'
            fake.write_text('import json, os, sys\njson.dump({"cwd": os.getcwd(), "args": sys.argv[1:]}, '
                            'open(%r, "w"))\n' % str(record), encoding='utf-8')
            if os.name == 'nt':
                (bin_dir / 'claude.cmd').write_text('@"%s" "%s" %%*\r\n' % (sys.executable, fake), encoding='utf-8')
            else:
                launcher = bin_dir / 'claude'
                launcher.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, fake), encoding='utf-8')
                launcher.chmod(0o755)
            env['PATH'] = str(bin_dir) + os.pathsep + env.get('PATH', '')

            listed = subprocess.run([sys.executable, str(vault / 'beyin.py'), 'pyn', 'liste'], capture_output=True,
                                    text=True, encoding='utf-8', env=env, cwd=root, timeout=60)
            self.assertEqual(listed.returncode, 0, listed.stderr)
            self.assertIn('claude', [o['id'] for o in json.loads(listed.stdout)['secenekler']])
            ran = subprocess.run([sys.executable, str(vault / 'beyin.py'), 'pyn', 'claude', '--continue', '--json'],
                                 capture_output=True, text=True, encoding='utf-8', env=env, cwd=root, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)
            call = json.loads(record.read_text(encoding='utf-8'))
            self.assertEqual(Path(call['cwd']).resolve(), vault.resolve())  # started inside the vault
            self.assertEqual(call['args'], ['--continue', '--json'])  # --json reached the client


if __name__ == '__main__':
    unittest.main()

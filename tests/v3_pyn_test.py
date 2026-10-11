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
        self.assertTrue(any(hint.startswith('LM Studio kurulu ama') for hint in hints))
        found, _ = pyn.options(local=local, which=fake_which({'claude'}))
        self.assertEqual([o['id'] for o in found], ['claude'])  # no Codex, no local entry

    def test_lm_studio_reports_its_loaded_model_and_hides_embeddings(self):
        studio = self.serve({'/api/v0/models': {'data': [
            {'id': 'qwen2.5-coder-14b', 'type': 'llm', 'state': 'not-loaded'},
            {'id': 'gpt-oss-20b', 'type': 'llm', 'state': 'loaded'},
            {'id': 'text-embedding-nomic', 'type': 'embeddings', 'state': 'loaded'}]}})
        self.assertEqual(pyn.lmstudio_models(base=studio), (['qwen2.5-coder-14b', 'gpt-oss-20b'], ['gpt-oss-20b']))
        older = self.serve({'/v1/models': {'data': [{'id': 'mistral-7b'}, {'id': 'text-embedding-bge-m3'}]}})
        self.assertEqual(pyn.lmstudio_models(base=older), (['mistral-7b'], []))  # no load state there

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

    def test_last_choice_is_remembered(self):
        found, _ = pyn.options(local=(), which=fake_which({'claude', 'codex'}))
        pyn._remember(self.state, found[1], None)
        self.assertEqual(pyn._last(self.state)['secim'], 'codex')
        self.assertEqual(pyn.choose_model(['a', 'b'], 'b', read=lambda _p: '', write=lambda *_: None), 'b')
        self.assertEqual(pyn.choose_model(['a', 'b'], None, read=lambda _p: '2', write=lambda *_: None), 'b')


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

    def test_posix_function_quotes_paths_and_passes_all_arguments(self):
        rc = self.root / '.zshrc'
        pyn.install_shell(self.root / 'My Vault', [rc], python='/usr/bin/python3', windows=False)
        self.assertIn('pyn() { "/usr/bin/python3" "' + str(self.root / 'My Vault' / 'beyin.py') + '" pyn "$@"; }',
                      rc.read_text(encoding='utf-8'))


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

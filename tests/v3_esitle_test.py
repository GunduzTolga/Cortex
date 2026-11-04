"""`beyin.py esitle`: the vault kept in step with its git remote, with real git and throwaway repositories.

Each case builds a bare remote and one or two clones in a temporary folder; no network is touched (an unreachable
remote is a path that does not exist). The states are the ones the desktop app shows (shared/vaultSync.ts).
"""
from __future__ import annotations

import json
import re
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_esitle as esitle  # noqa: E402

GIT = shutil.which('git')
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 'Test',
       'GIT_COMMITTER_EMAIL': 't@example.com', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
TOKEN_LINE = 'anahtar ghp_' + 'A1b2C3d4E5' * 4  # a GitHub token's shape, made up


def git(cwd, *args):
    # UTF-8 açıkça: Windows'ta text=True yerel kod sayfasıyla okur ve 'tarafı' 'tarafÄ±' olur (CI, 2026-11-03).
    return subprocess.run([GIT, *args], cwd=cwd, env=ENV, capture_output=True, encoding='utf-8', errors='replace', check=True).stdout


@unittest.skipUnless(GIT, 'git yok')
class EsitleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='esitle-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.environ.update({k: v for k, v in ENV.items() if k.startswith('GIT_')})
        self.remote = self.tmp / 'uzak.git'
        git(self.tmp, 'init', '-q', '--bare', '-b', 'main', str(self.remote))
        self.a = self.clone('a')
        (self.a / 'ilk.md').write_text('# İlk\n', encoding='utf-8')
        git(self.a, 'add', '-A')
        git(self.a, 'commit', '-q', '-m', 'ilk')
        git(self.a, 'push', '-q', '-u', 'origin', 'main')
        self.state = self.tmp / 'state'

    def clone(self, name):
        target = self.tmp / name
        git(self.tmp, 'clone', '-q', str(self.remote), str(target))
        git(target, 'config', 'user.name', 'Test')
        git(target, 'config', 'user.email', 't@example.com')
        return target

    def sync(self, vault):
        return esitle.sync(vault, self.state)

    def test_a_new_note_goes_and_comes_to_the_other_clone(self):
        b = self.clone('b')
        (self.a / '🔮 Notlar' ).mkdir()
        (self.a / '🔮 Notlar' / 'Çay ocağı.md').write_text('çay\n', encoding='utf-8')
        sent = self.sync(self.a)
        self.assertEqual((sent['state'], sent['pushed'], sent['detail']), ('synced', 1, []))
        self.assertEqual(sent['remote'], str(self.remote))
        got = self.sync(b)
        self.assertEqual((got['state'], got['pulled']), ('synced', 1))
        self.assertEqual((b / '🔮 Notlar' / 'Çay ocağı.md').read_text(encoding='utf-8'), 'çay\n')
        self.assertEqual(self.sync(b)['state'], 'nothing', 'a second round has nothing to do')
        message = git(self.remote, 'log', '-1', '--format=%s')
        self.assertTrue(message.startswith('senkron: '), message)

    def test_a_remote_that_turns_the_credentials_down_is_denied_not_a_conflict(self):
        # A server that asks for a name and password, as GitHub does for a private repository without a token:
        # git, never prompting, says "could not read Username" (seen with GitHub, 4 November; it was called a conflict).
        import http.server
        import threading

        class Asks(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401)
                self.send_header('WWW-Authenticate', 'Basic realm="GitHub"')
                self.send_header('Content-Length', '0')
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Asks)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        git(self.a, 'remote', 'set-url', 'origin', f'http://127.0.0.1:{server.server_port}/kasa.git')
        (self.a / 'yeni.md').write_text('yeni\n', encoding='utf-8')
        result = self.sync(self.a)
        self.assertEqual(result['state'], 'denied', result)
        self.assertNotIn('conflict', json.dumps(result))
        self.assertTrue((self.a / 'yeni.md').exists(), 'nothing lost')
        self.assertIn('bağlantıyı yenile', esitle.sentence(result))
        for said, state in (("fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'denied'),
                            ('remote: Repository not found.', 'denied'),
                            ("remote: Permission to a/b.git denied to x.", 'denied'),
                            ("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", 'offline'),
                            ('error: failed to push some refs', 'error')):
            self.assertEqual(esitle._remote_state(said), state, said)

    def test_a_secret_in_a_new_line_stops_before_the_commit_and_says_where_never_what(self):
        note = self.a / 'not.md'
        note.write_text('merhaba\n' + TOKEN_LINE + '\n', encoding='utf-8')
        result = self.sync(self.a)
        self.assertEqual(result['state'], 'secret')
        self.assertEqual(result['detail'], ['not.md:2 GitHub token'])
        self.assertNotIn('ghp_', json.dumps(result))
        self.assertEqual(git(self.a, 'rev-list', '--count', 'HEAD').strip(), '1', 'nothing committed')
        self.assertEqual(git(self.a, 'diff', '--cached', '--name-only'), '', 'nothing left staged')
        self.assertTrue(note.exists(), 'the file stays as it is')

    def test_a_line_marked_as_an_example_goes(self):
        (self.a / 'ornek.md').write_text(TOKEN_LINE + '  <!-- sir-tarama:izin -->\n', encoding='utf-8')
        self.assertEqual(self.sync(self.a)['state'], 'synced')

    def test_the_persons_own_values_are_found_too(self):
        self.state.mkdir()
        (self.state / 'secret-patterns.txt').write_text('cok-gizli-deger-42\n', encoding='utf-8')
        (self.a / 'n.md').write_text('sunucu cok-gizli-deger-42 burada\n', encoding='utf-8')
        result = self.sync(self.a)
        self.assertEqual((result['state'], result['detail']), ('secret', ['n.md:1 known secret']))

    def test_a_placeholder_and_a_plain_word_are_no_secret(self):
        self.assertIsNone(esitle.secret_in('parola: <buraya-yazin-ornek-deger>'))
        self.assertIsNone(esitle.secret_in('token = aaaaaaaaaaaaaaaaaaaa'))
        self.assertEqual(esitle.secret_in('api_key = Zq8vR2kLm9Xp4Tn7Wc'), 'password or key')

    def test_a_conflict_is_backed_out_of_and_both_sides_stay(self):
        b = self.clone('b')
        (self.a / 'ilk.md').write_text('# A tarafı\n', encoding='utf-8')
        self.assertEqual(self.sync(self.a)['state'], 'synced')
        (b / 'ilk.md').write_text('# B tarafı\n', encoding='utf-8')
        result = self.sync(b)
        self.assertEqual((result['state'], result['detail']), ('conflict', ['ilk.md']))
        self.assertEqual((b / 'ilk.md').read_text(encoding='utf-8'), '# B tarafı\n', 'this side untouched')
        self.assertFalse((b / '.git' / 'rebase-merge').exists(), 'the rebase was backed out of')
        self.assertIn('A tarafı', git(self.remote, 'show', 'main:ilk.md'), 'the remote untouched')

    def test_a_rebase_left_standing_is_the_persons(self):
        (self.a / '.git' / 'rebase-merge').mkdir()
        self.assertEqual(self.sync(self.a)['detail'], ['git: rebase'])

    def test_an_unreachable_remote_is_offline_and_the_note_waits(self):
        git(self.a, 'remote', 'set-url', 'origin', str(self.tmp / 'yok.git'))
        (self.a / 'bekle.md').write_text('bekliyor\n', encoding='utf-8')
        result = self.sync(self.a)
        self.assertEqual(result['state'], 'offline', result)
        self.assertTrue((self.a / 'bekle.md').exists())

    def test_what_is_missing_is_said(self):
        plain = self.tmp / 'duz'
        plain.mkdir()
        self.assertEqual(self.sync(plain)['missing'], 'repo')
        git(self.a, 'branch', '--unset-upstream')
        self.assertEqual((self.sync(self.a)['state'], self.sync(self.a)['missing']), ('missing', 'remote'))

    def test_one_at_a_time(self):
        # Another process holds the lock (the lock is per open file, so a child process stands in for it).
        self.state.mkdir()
        holder = subprocess.Popen([sys.executable, '-c', (
            'import sys,time;sys.path.insert(0,sys.argv[1]);import beyin_v3_esitle as e;'
            'h=open(sys.argv[2],"a+b");assert e._lock(h);print("tutuyor",flush=True);time.sleep(30)'),
            str(SCRIPTS), str(self.state / 'esitle.lock')], stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.kill)
        self.assertEqual(holder.stdout.readline().strip(), 'tutuyor')
        self.assertEqual(self.sync(self.a)['state'], 'busy')
        holder.kill()
        holder.wait()
        self.assertEqual(self.sync(self.a)['state'], 'nothing', 'free again once the other is gone')

    def test_the_remote_is_said_without_a_name_or_token(self):
        self.assertEqual(esitle.remote_label('https://kisi:ghp_x@github.com/sahip/kasa.git'), 'github.com/sahip/kasa')
        self.assertEqual(esitle.remote_label('git@github.com:sahip/kasa.git'), 'github.com/sahip/kasa')

    def test_the_command_line_says_one_json_line_and_never_exits_2(self):
        (self.a / 'k.md').write_text('k\n', encoding='utf-8')
        out = subprocess.run([sys.executable, str(SCRIPTS / 'beyin_v3_esitle.py'), '--json'], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 2)  # no vault given: a message, not argparse's 2
        # On its own with --vault (the desktop app's tests run it so): one JSON line, exit 0.
        alone = subprocess.run([sys.executable, str(SCRIPTS / 'beyin_v3_esitle.py'), '--vault', str(self.a),
                                '--state', str(self.state), '--json'], capture_output=True, text=True, env=ENV)
        self.assertEqual((alone.returncode, json.loads(alone.stdout)['state']), (0, 'synced'), alone.stderr)
        import io
        from contextlib import redirect_stdout
        (self.a / 'k2.md').write_text('k2\n', encoding='utf-8')
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = esitle.main(['--json'], vault=self.a, state=self.state)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buffer.getvalue())['state'], 'synced')
        # A state that is no success is said in the JSON, and the line still exits 0 (the app's runner needs that);
        # said as a sentence, it exits 1.
        (self.a / 's.md').write_text(TOKEN_LINE + '\n', encoding='utf-8')
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(esitle.main(['--json'], vault=self.a, state=self.state), 0)
        self.assertEqual(json.loads(buffer.getvalue())['state'], 'secret')
        with redirect_stdout(io.StringIO()):
            self.assertEqual(esitle.main([], vault=self.a, state=self.state), 1)


@unittest.skipUnless(GIT, 'git yok')
class IlkKezTest(unittest.TestCase):
    """`--baslat` (a new backup to an empty remote) and `--baglan` (a second computer joins it)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='esitle-ilk-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.environ.update({k: v for k, v in ENV.items() if k.startswith('GIT_')})
        self.remote = self.tmp / 'uzak.git'
        git(self.tmp, 'init', '-q', '--bare', '-b', 'main', str(self.remote))
        self.state = self.tmp / 'state'

    def vault(self, name, notes):
        folder = self.tmp / name
        for path, text in notes.items():
            (folder / path).parent.mkdir(parents=True, exist_ok=True)
            (folder / path).write_text(text, encoding='utf-8')
        folder.mkdir(exist_ok=True)
        return folder

    def remote_files(self):
        out = git(self.tmp, '--git-dir', str(self.remote), 'ls-tree', '-r', '--name-only', '-z', 'main')
        return sorted(p for p in out.split('\0') if p)

    def remote_text(self, path):
        return git(self.tmp, '--git-dir', str(self.remote), 'show', f'main:{path}')

    def test_a_new_backup_sends_the_vault_and_writes_the_ignore_list(self):
        a = self.vault('a', {'ilk.md': '# İlk\n', '🔮 Notlar/bir.md': 'bir\n', 'beyin.py': '# motor\n'})
        result = esitle.sync(a, self.state, start_url=str(self.remote))
        self.assertEqual(result['state'], 'synced', result)
        self.assertEqual(result['mode'], 'baslat')
        files = self.remote_files()
        self.assertIn('ilk.md', files)
        self.assertIn('🔮 Notlar/bir.md', files)
        self.assertIn('.gitignore', files)
        self.assertNotIn('beyin.py', files)  # every machine installs its own
        self.assertIn('**/Journal.md merge=union', self.remote_text('.gitattributes'))
        # From now on the ordinary sync: it follows the remote.
        self.assertEqual(esitle.sync(a, self.state)['state'], 'nothing')

    def test_the_ignore_lines_already_there_are_kept_and_not_doubled(self):
        a = self.vault('a', {'.gitignore': 'kendi-dosyam.txt\nbeyin.py\n', 'ilk.md': 'x\n'})
        esitle.sync(a, self.state, start_url=str(self.remote))
        text = (a / '.gitignore').read_text(encoding='utf-8')
        self.assertTrue(text.startswith('kendi-dosyam.txt\nbeyin.py\n'))
        self.assertEqual(text.count('beyin.py'), 1)
        self.assertFalse(esitle.add_lines(a / '.gitignore', esitle.IGNORE))  # a second time: nothing to add

    def test_a_new_backup_to_a_remote_that_holds_a_vault_is_refused(self):
        esitle.sync(self.vault('a', {'ilk.md': 'a\n'}), self.state, start_url=str(self.remote))
        result = esitle.sync(self.vault('b', {'b.md': 'b\n'}), self.state, start_url=str(self.remote))
        self.assertEqual(result['state'], 'not_empty')
        self.assertEqual(self.remote_files(), ['.gitattributes', '.gitignore', 'ilk.md'])

    def test_a_vault_already_syncing_is_said(self):
        a = self.vault('a', {'ilk.md': 'a\n'})
        esitle.sync(a, self.state, start_url=str(self.remote))
        other = self.tmp / 'baska.git'
        git(self.tmp, 'init', '-q', '--bare', '-b', 'main', str(other))
        for url in ({'start_url': str(other)}, {'join_url': str(other)}):
            self.assertEqual(esitle.sync(a, self.state, **url)['state'], 'already')

    def test_a_secret_stops_the_first_backup_and_nothing_goes(self):
        a = self.vault('a', {'ilk.md': 'a\n', 'gizli.md': TOKEN_LINE + '\n'})
        result = esitle.sync(a, self.state, start_url=str(self.remote))
        self.assertEqual(result['state'], 'secret')
        self.assertEqual(result['detail'], ['gizli.md:1 GitHub token'])
        self.assertEqual(git(self.tmp, '--git-dir', str(self.remote), 'branch'), '')  # the remote still empty
        (a / 'gizli.md').unlink()
        self.assertEqual(esitle.sync(a, self.state, start_url=str(self.remote))['state'], 'synced')  # again, once fixed

    def test_joining_keeps_both_sides_and_deletes_nothing(self):
        esitle.sync(self.vault('a', {'ilk.md': '# İlk\n', 'ortak.md': 'aynı\n', 'klasor/not.md': 'uzak\n'}),
                    self.state, start_url=str(self.remote))
        b = self.vault('b', {'ortak.md': 'aynı\n', 'ilk.md': '# Buradaki ilk\n', 'yalniz-burada.md': 'b\n'})
        result = esitle.sync(b, self.state, join_url=str(self.remote))
        self.assertEqual(result['state'], 'synced', result)
        self.assertEqual(result['kept'], [{'file': 'ilk.md', 'as': 'ilk (bu bilgisayar).md'}])
        self.assertIn("'(bu bilgisayar)' adıyla kaldı", esitle.sentence(result))
        self.assertEqual((b / 'ilk.md').read_text(encoding='utf-8'), '# İlk\n')
        self.assertEqual((b / 'ilk (bu bilgisayar).md').read_text(encoding='utf-8'), '# Buradaki ilk\n')
        self.assertEqual((b / 'klasor/not.md').read_text(encoding='utf-8'), 'uzak\n')
        files = self.remote_files()
        for path in ('ilk.md', 'ilk (bu bilgisayar).md', 'ortak.md', 'klasor/not.md', 'yalniz-burada.md'):
            self.assertIn(path, files)
        self.assertEqual(esitle.sync(b, self.state)['state'], 'nothing')

    def test_a_local_file_where_the_remote_has_a_folder_is_set_aside(self):
        esitle.sync(self.vault('a', {'klasor/not.md': 'uzak\n'}), self.state, start_url=str(self.remote))
        b = self.vault('b', {'klasor': 'bir dosya\n'})
        result = esitle.sync(b, self.state, join_url=str(self.remote))
        self.assertEqual(result['state'], 'synced', result)
        self.assertEqual(result['kept'], [{'file': 'klasor', 'as': 'klasor (bu bilgisayar)'}])
        self.assertEqual((b / 'klasor/not.md').read_text(encoding='utf-8'), 'uzak\n')

    def test_a_taken_kept_name_is_numbered(self):
        esitle.sync(self.vault('a', {'n.md': 'uzak\n', 'n (bu bilgisayar).md': 'eski\n'}), self.state,
                    start_url=str(self.remote))
        b = self.vault('b', {'n.md': 'burada\n'})
        result = esitle.sync(b, self.state, join_url=str(self.remote))
        self.assertEqual(result['kept'], [{'file': 'n.md', 'as': 'n (bu bilgisayar 2).md'}])

    def test_joining_an_empty_remote_says_so(self):
        result = esitle.sync(self.vault('b', {'b.md': 'b\n'}), self.state, join_url=str(self.remote))
        self.assertEqual(result['state'], 'empty')

    def test_a_url_that_is_not_https_or_a_folder_is_refused(self):
        b = self.vault('b', {'b.md': 'b\n'})
        for url in ('http://example.com/x.git', '--upload-pack=x', 'git@github.com:a/b.git', 'https://a/b\nc'):
            self.assertEqual(esitle.sync(b, self.state, start_url=url)['detail'], ['url'], url)
        self.assertFalse((b / '.git').exists())

    def test_the_command_line_takes_the_first_time_too(self):
        a = self.vault('a', {'ilk.md': 'a\n'})
        out = subprocess.run([sys.executable, str(SCRIPTS / 'beyin_v3_esitle.py'), '--vault', str(a), '--state',
                              str(self.state), '--json', '--baslat', str(self.remote)],
                             capture_output=True, encoding='utf-8', env={**os.environ, **ENV})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)['state'], 'synced')


class TokenTest(unittest.TestCase):
    def test_the_token_becomes_a_header_for_github_alone(self):
        conf = esitle.token_config('ghu_abc123')
        key = [k for k in conf if k.startswith('GIT_CONFIG_KEY_')][0]
        self.assertEqual(conf[key], 'http.https://github.com/.extraheader')
        value = conf[key.replace('KEY', 'VALUE')]
        import base64
        self.assertEqual(base64.b64decode(value.split()[-1]).decode(), 'x-access-token:ghu_abc123')
        self.assertEqual(esitle.token_config(''), {})
        self.assertEqual(esitle.token_config('a b'), {})

    @unittest.skipIf(os.name == 'nt', 'sahte git bir kabuk betiği')
    def test_the_token_reaches_git_in_its_environment_never_its_arguments(self):
        tmp = Path(tempfile.mkdtemp(prefix='esitle-jeton-'))
        self.addCleanup(shutil.rmtree, tmp, True)
        seen = tmp / 'gordu.txt'
        fake = tmp / 'git'
        fake.write_text('#!/bin/sh\n{ echo "ARGS $*"; env; } > "%s"\n' % seen, encoding='utf-8')
        fake.chmod(0o755)
        vault = tmp / 'kasa'
        vault.mkdir()
        old = {k: os.environ.get(k) for k in (esitle.GIT_ENV, esitle.TOKEN_ENV)}
        os.environ.update({esitle.GIT_ENV: str(fake), esitle.TOKEN_ENV: 'ghu_gizli123'})
        try:
            esitle.Git(vault)('--version')
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        text = seen.read_text(encoding='utf-8')
        args = [line for line in text.splitlines() if line.startswith('ARGS ')][0]
        self.assertNotIn('ghu_gizli123', args)
        self.assertNotIn(esitle.TOKEN_ENV + '=', text)
        self.assertIn('http.https://github.com/.extraheader', text)

    def test_a_brought_git_inside_the_vault_is_not_run(self):
        tmp = Path(tempfile.mkdtemp(prefix='esitle-git-'))
        self.addCleanup(shutil.rmtree, tmp, True)
        inside = tmp / 'git'
        inside.write_text('', encoding='utf-8')
        old = os.environ.get(esitle.GIT_ENV)
        os.environ[esitle.GIT_ENV] = str(inside)
        try:
            self.assertNotEqual(esitle.git_program(tmp), str(inside.resolve()))
        finally:
            os.environ.pop(esitle.GIT_ENV) if old is None else os.environ.__setitem__(esitle.GIT_ENV, old)


class ListeTest(unittest.TestCase):
    def test_the_ignore_list_is_the_one_the_guide_shows(self):
        guide = (ROOT / 'docs/v3/MULTI-MACHINE.md').read_text(encoding='utf-8')
        blocks = re.findall(r'```gitignore\n(.*?)```', guide, re.S)
        self.assertEqual(blocks[0], esitle.render(esitle.IGNORE))
        blocks = re.findall(r'```gitattributes\n(.*?)```', guide, re.S)
        self.assertEqual(blocks[0], esitle.render(esitle.ATTRIBUTES))


if __name__ == '__main__':
    unittest.main()

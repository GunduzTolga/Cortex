"""`beyin.py esitle`: the vault kept in step with its git remote, with real git and throwaway repositories.

Each case builds a bare remote and one or two clones in a temporary folder; no network is touched (an unreachable
remote is a path that does not exist). The states are the ones the desktop app shows (shared/vaultSync.ts).
"""
from __future__ import annotations

import json
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
    return subprocess.run([GIT, *args], cwd=cwd, env=ENV, capture_output=True, text=True, check=True).stdout


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


if __name__ == '__main__':
    unittest.main()

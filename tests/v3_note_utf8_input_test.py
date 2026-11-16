"""Note and task input that is not standard UTF-8 is refused by name, before anything is written.

A lone surrogate, a CESU-8 pair or undecodable bytes are never repaired or replaced:
the call fails with Utf8InputError, the source, the journal and the lock folder stay
untouched. A JSON \\ud83d\\ude00 escape pair is one valid character and is written.
"""
import hashlib
import importlib.util
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
sys.path.insert(0, str(ROOT / 'template/.claude/scripts'))
from beyin_v3_sync import SyncEngine
from beyin_v3_notes import LOCAL_DIRECTORY, Utf8InputError

SPEC = importlib.util.spec_from_file_location('note_utf8_cli', ROOT / 'scripts/beyin_v3.py')
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)

# 😀 (U+1F600) as CESU-8: each UTF-16 half encoded on its own.
CESU = b'\xed\xa0\xbd\xed\xb8\x80'
# The same bytes as POSIX argv/streams carry them (surrogateescape).
ESCAPED = '\udced\udca0\udcbd\udced\udcb8\udc80'


class NoteUtf8InputTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name) / 'vault'
        self.vault.mkdir()
        self.state = Path(self.temp.name) / 'state'
        self.engine = SyncEngine(self.vault, self.state)
        self.addCleanup(self.engine.store.close)
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop('CLAUDE_CODE_SESSION_ID', None)

    def nothing_written(self):
        self.assertEqual(list(self.vault.iterdir()), [])
        self.assertEqual(list(self.state.glob('markdown-journal/*')), [])

    def command(self, *args):
        return [sys.executable, str(ROOT / 'scripts/beyin_v3.py'), '--vault', str(self.vault),
                '--state', str(self.state), *args]

    def run_raw(self, *args, data=None):
        return subprocess.run(self.command(*args), input=data, capture_output=True,
                              timeout=30, env=inherited_env())

    def test_stored_invalid_utf8_is_named_and_left_unchanged(self):
        cases = ((CESU + b'\n', r'CESU-8 encoded U\+1F600 \(surrogate pair U\+D83D U\+DE00\) at byte 0'),
                 (b'ok \xed\xa0\x80\n', r'encoded lone surrogate U\+D800 at byte 3'),
                 (b'\xff\n', r'invalid UTF-8 sequence starting with byte 0xFF at byte 0'))
        for raw, message in cases:
            with self.subTest(raw=raw):
                path = self.vault / 'surrogate.md'
                path.write_bytes(raw)
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.note_read('surrogate.md')
                request = {'source': 'surrogate.md', 'expected_sha256': hashlib.sha256(raw).hexdigest(),
                           'edits': [{'old': '\n', 'new': ' appended\n'}]}
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.note_edit(request)
                self.assertEqual(path.read_bytes(), raw)
                done = self.run_raw('note-read', 'surrogate.md')
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                output = json.loads(done.stdout)
                self.assertEqual((output['status'], output['error']), ('error', 'Utf8InputError'))
                self.assertRegex(output['message'], message)
                self.assertNotIn(b'Traceback', done.stderr)
                self.assertEqual(path.read_bytes(), raw)
        self.assertFalse((self.vault / LOCAL_DIRECTORY / 'backups').exists())

    def test_surrogate_content_cannot_create_a_note(self):
        # Two separate code points, as surrogatepass decodes CESU-8; JSON would join them.
        split = CESU.decode('utf-8', 'surrogatepass')
        cases = (('new lone surrogate \ud800',
                  r'content is not valid UTF-8: unpaired surrogate U\+D800 at character 19'),
                 ('x ' + split, r'surrogate pair U\+D83D U\+DE00 instead of U\+1F600 at character 2'),
                 ('\ude00\ud83d', r'unpaired surrogate U\+DE00 at character 0'))
        for content, message in cases:
            with self.subTest(content=ascii(content)):
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.note_edit({'source': 'broken.md', 'expected_sha256': None, 'content': content})
        # Refused before the note lock: not even the local lock folder exists.
        self.nothing_written()

    def test_surrogate_edits_leave_source_and_backups_untouched(self):
        path = self.vault / 'Threads.md'
        path.write_bytes(b'alpha\nbeta\n')
        request = {'source': 'Threads.md', 'expected_sha256': self.engine.note_read('Threads.md')['sha256']}
        cases = (({'old': 'alpha', 'new': 'x\ud800'},
                  r'edits\[1\]\.new is not valid UTF-8: unpaired surrogate U\+D800'),
                 ({'old': 'alpha\udcff', 'new': 'x'}, r'edits\[1\]\.old .* \(undecodable input byte 0xFF\)'),
                 ({'old': 'alpha', 'new': ESCAPED},
                  r'CESU-8 encoded U\+1F600 .* at character 0 \(undecodable input bytes\)'))
        for edit, message in cases:
            with self.subTest(edit=ascii(edit)):
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.note_edit(dict(request, edits=[{'old': 'beta', 'new': 'BETA'}, edit]))
                self.assertEqual(path.read_bytes(), b'alpha\nbeta\n')
        self.assertFalse((self.vault / LOCAL_DIRECTORY / 'backups').exists())
        emoji = json.loads('"\\ud83d\\ude00 Şifre"')
        result = self.engine.note_edit(dict(request, edits=[{'old': 'alpha', 'new': emoji}]))
        self.assertEqual(result['status'], 'written')
        self.assertEqual(path.read_bytes(), '\U0001F600 Şifre\nbeta\n'.encode('utf-8'))

    def test_surrogate_sources_never_reach_the_filesystem(self):
        # On POSIX such a source becomes a raw CESU-8 byte file name; on Windows an
        # unpaired UTF-16 name. Either way no other client could read it back.
        sources = ('\ud800.md', 'notes/' + ESCAPED + '.md', 'a\udcff.md',
                   ('notes/'.encode() + CESU + b'.md').decode('utf-8', 'surrogatepass'))
        for source in sources:
            with self.subTest(source=ascii(source)):
                with self.assertRaisesRegex(Utf8InputError, 'source is not valid UTF-8'):
                    self.engine.note_read(source)
                with self.assertRaisesRegex(Utf8InputError, 'source is not valid UTF-8'):
                    self.engine.note_edit({'source': source, 'expected_sha256': None, 'content': 'x\n'})
                name = source.rsplit('/', 1)[-1]
                with self.assertRaisesRegex(Utf8InputError, 'source is not valid UTF-8'):
                    self.engine.note_create('notes/' + name, 'x')
                with self.assertRaisesRegex(Utf8InputError, 'source is not valid UTF-8'):
                    self.engine.task_create('tasks/' + name, 'x', {'id': 'utf8-task', 'owner': 'Synthetic',
                                                                   'status': 'active'})
        self.nothing_written()

    def test_note_create_refuses_surrogate_text_and_metadata_before_journal(self):
        cases = ((('notes/a.md', 'body \ud800'), r'text is not valid UTF-8: unpaired surrogate U\+D800'),
                 (('notes/a.md', 'body', {'title': 'T\udced\udca0\udc80'}),
                  r'metadata\.title .* encoded lone surrogate U\+D800'),
                 (('notes/a.md', 'body', {'facts': {'k\ud800': 'v'}}), r'metadata\.facts key'),
                 (('notes/a.md', 'body', {'facts': {'k': ['ok', '\ude00']}}), r'metadata\.facts\.k\[1\]'))
        for args, message in cases:
            with self.subTest(args=ascii(args)):
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.note_create(*args)
        self.nothing_written()
        self.assertEqual(self.engine.note_create('notes/a.md', 'Müşteri \U0001F600')['status'], 'succeeded')

    def test_task_create_refuses_surrogate_text_and_metadata_before_journal(self):
        base = {'id': 'utf8-task', 'owner': 'Synthetic', 'status': 'active'}
        cases = ((('tasks/t.md', 'body \ud800', base), r'text is not valid UTF-8: unpaired surrogate U\+D800'),
                 (('tasks/t.md', 'body', dict(base, owner='Ay\udcfe')),
                  r'metadata\.owner .* \(undecodable input byte 0xFE\)'),
                 (('tasks/t.md', 'body', dict(base, title='x ' + CESU.decode('utf-8', 'surrogatepass'))),
                  r'metadata\.title .* surrogate pair U\+D83D U\+DE00 instead of U\+1F600'),
                 (('tasks/t.md', 'body', dict(base, facts={'k': ['ok', '\ude00']})), r'metadata\.facts\.k\[1\]'))
        for args, message in cases:
            with self.subTest(args=ascii(args)):
                with self.assertRaisesRegex(Utf8InputError, message):
                    self.engine.task_create(*args)
        self.nothing_written()
        created = self.engine.task_create('tasks/t.md', 'Görev \U0001F600', base)
        self.assertEqual(created['id'], 'utf8-task')
        self.assertIn('Görev \U0001F600', (self.vault / 'tasks/t.md').read_text(encoding='utf-8'))

    def test_cli_refuses_cesu8_and_surrogates_from_args_stdin_and_files(self):
        raw_json = b'{"source": "new.md", "expected_sha256": null, "content": "x ' + CESU + b'"}'
        request_file = Path(self.temp.name) / 'request.json'
        request_file.write_bytes(b'\xef\xbb\xbf' + raw_json)
        lone = json.dumps({'source': 'new.md', 'expected_sha256': None, 'content': 'x \ud800'})
        escaped_source = json.dumps({'source': ESCAPED + '.md', 'expected_sha256': None, 'content': 'x'})
        created = json.dumps({'source': 'notes/a.md', 'text': 'body', 'metadata': {'facts': {'k': '\udfff'}}})
        task = json.dumps({'source': 'tasks/t.md', 'text': 'body \ud800',
                           'metadata': {'id': 't1', 'owner': 'Synthetic', 'status': 'active'}})
        cesu_message = r'JSON input is not valid UTF-8: CESU-8 encoded U\+1F600 \(surrogate pair U\+D83D U\+DE00\)'
        cases = ((('note-edit',), raw_json, cesu_message),
                 (('note-edit', '--file', str(request_file)), None, cesu_message),
                 (('note-edit',), lone.encode('ascii'), r'content is not valid UTF-8: unpaired surrogate U\+D800'),
                 (('note-edit',), escaped_source.encode('ascii'),
                  r'source is not valid UTF-8: CESU-8 encoded U\+1F600 .*\(undecodable input bytes\)'),
                 (('note-create',), created.encode('ascii'), r'metadata\.facts\.k is not valid UTF-8'),
                 (('note-create',), b'{"source": "notes/a.md", "text": "x \xed\xb0\x80"}',
                  r'JSON input is not valid UTF-8: encoded lone surrogate U\+DC00'),
                 (('task-create',), task.encode('ascii'), r'text is not valid UTF-8: unpaired surrogate U\+D800'))
        for args, data, message in cases:
            with self.subTest(args=args, data=data):
                done = self.run_raw(*args, data=data)
                self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
                # note-edit answers on stdout; note-create and task-create report errors on stderr.
                output = json.loads(done.stdout if args[0] == 'note-edit' else done.stderr)
                self.assertEqual(output['error'], 'Utf8InputError')
                self.assertRegex(output['message'], message)
                self.assertNotIn(b'Traceback', done.stderr)
        # A source argument: Windows passes unpaired UTF-16 as is, POSIX undecodable bytes as U+DC80..U+DCFF.
        for source in ('\ud800.md', ESCAPED + '.md'):
            with self.subTest(source=ascii(source)):
                result, code = cli.main(self.command('note-read', source)[2:], return_result=True)
                self.assertEqual((code, result['status'], result['error']), (1, 'error', 'Utf8InputError'))
        if os.name != 'nt':
            done = self.run_raw('note-read', CESU + b'.md')
            self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
            output = json.loads(done.stdout)
            self.assertEqual(output['error'], 'Utf8InputError')
            self.assertRegex(output['message'], r'source is not valid UTF-8: CESU-8 encoded U\+1F600')
        self.nothing_written()


if __name__ == '__main__':
    unittest.main()

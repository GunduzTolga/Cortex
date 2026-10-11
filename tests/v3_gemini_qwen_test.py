"""Gemini CLI and Qwen Code get full memory: managed hooks in their project settings, merged with
the user's own keys, and hook output in each client's own shape, run the way each client runs it."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from v3_package_helpers import install, isolated_env, run_python

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import install_v3  # noqa: E402

NOTE = ('# Quartz gözlemevi\n\nQuartz gözlemevi kalibrasyon ayarı teleskop odak düzeltmesi '
        'QUARTZ_ISARET ile yapılır.\n')
PROMPT = 'Quartz gözlemevi kalibrasyon teleskop odak düzeltmesi nasıldı?'


class GeminiQwenInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-gemini-qwen-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.vault, self.state = root / 'Örnek Beyin', root / 'state'
        self.vault.mkdir()
        self.env = isolated_env(root / 'home')
        self.gemini = self.vault / '.gemini/settings.json'
        self.qwen = self.vault / '.qwen/settings.json'

    def install(self):
        result = install(self.vault, self.state, self.env)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))

    def read(self, path):
        return json.loads(path.read_text(encoding='utf-8'))

    def test_hooks_merge_into_the_users_settings_and_never_duplicate(self):
        self.gemini.parent.mkdir()
        user_hook = {'matcher': 'run_shell_command', 'hooks': [{'type': 'command', 'command': 'echo mine'}]}
        self.gemini.write_text(json.dumps({'theme': 'Ananas', 'context': {'fileName': 'NOTLAR.md'},
                                           'hooks': {'BeforeTool': [user_hook]}}), encoding='utf-8')
        self.qwen.parent.mkdir()
        self.qwen.write_text(json.dumps({'model': {'name': 'qwen3-coder'}}), encoding='utf-8')
        for _ in range(2):  # a reinstall replaces our entries instead of adding more
            self.install()
        gemini, qwen = self.read(self.gemini), self.read(self.qwen)
        self.assertEqual(gemini['theme'], 'Ananas')
        self.assertEqual(gemini['context']['fileName'], ['AGENTS.md', 'NOTLAR.md'])
        self.assertEqual(gemini['hooks']['BeforeTool'], [user_hook])
        for event in install_v3.GEMINI_HOOK_EVENTS:
            groups = gemini['hooks'][event]
            self.assertEqual(len(groups), 1, event)
            handler = groups[0]['hooks'][0]
            self.assertEqual((handler['name'], handler['type']), ('cortex-pyn', 'command'))
            self.assertIn('beyin_v3_hook.py', handler['command'])  # plain text, also on Windows
            self.assertIn('gemini', handler['command'])
            self.assertGreaterEqual(handler['timeout'], 1000)  # milliseconds
        self.assertEqual(gemini['hooks']['AfterTool'][0]['matcher'], 'write_file|replace')
        self.assertEqual(qwen['model'], {'name': 'qwen3-coder'})
        self.assertIs(qwen['hooksConfig']['enabled'], True)
        self.assertEqual(qwen['context']['fileName'], ['AGENTS.md', 'QWEN.md'])
        self.assertEqual(sorted(qwen['hooks']), sorted(install_v3.QWEN_HOOK_EVENTS))
        self.assertEqual(qwen['hooks']['PostToolUse'][0]['matcher'], 'write_file|edit')

    def test_a_setting_changed_later_by_the_user_survives_an_update(self):
        self.install()
        gemini = self.read(self.gemini)
        gemini['theme'] = 'Kendi temam'
        gemini['model'] = {'name': 'gemini-2.5-flash'}
        self.gemini.write_text(json.dumps(gemini), encoding='utf-8')
        self.install()  # no "managed file changed" conflict: only our hooks are ours
        after = self.read(self.gemini)
        self.assertEqual((after['theme'], after['model']), ('Kendi temam', {'name': 'gemini-2.5-flash'}))
        self.assertEqual(len(after['hooks']['BeforeAgent']), 1)

    def test_uninstall_gives_back_what_was_there(self):
        self.qwen.parent.mkdir()
        original = json.dumps({'model': {'name': 'qwen3-coder'}})
        self.qwen.write_text(original, encoding='utf-8')
        self.install()
        result = run_python(ROOT / 'scripts/install_v3.py', ['--vault', self.vault, '--state', self.state,
                                                             '--uninstall'], ROOT, self.env)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(self.qwen.read_text(encoding='utf-8'), original)
        self.assertFalse(self.gemini.exists())


class HarnessListTest(unittest.TestCase):
    def test_every_place_that_names_the_clients_agrees(self):
        # A client missing from one list fails quietly: the hook runs, then its receipt is refused.
        sys.path.insert(0, str(ROOT / 'template/.claude/scripts'))
        import beyin_v3
        import beyin_v3_hook
        self.assertEqual(set(beyin_v3_hook.HARNESSES), set(beyin_v3.HARNESSES))
        import re
        cli = (ROOT / 'scripts/beyin_v3.py').read_text(encoding='utf-8')
        lists = re.findall(r'"--harness", choices=\(([^)]*)\)', cli)
        lists += re.findall(r'seen = \{name: set\(\) for name in \(([^)]*)\)\}', cli)
        self.assertEqual(len(lists), 3)  # context and receipt choices, doctor's lifecycle table
        for found in lists:
            self.assertEqual(set(re.findall(r'["\'](\w+)["\']', found)), set(beyin_v3.HARNESSES), found)
        skill = (ROOT / 'template/.agents/skills/beyin/SKILL.md').read_text(encoding='utf-8')
        for harness in beyin_v3.HARNESSES:
            self.assertIn('`' + harness + '`' if harness != 'codex' else '--harness codex', skill)


class GeminiQwenHookTest(unittest.TestCase):
    """The installed commands, run exactly as each client runs them."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='v3-gemini-qwen-hook-')
        root = Path(cls.tmp.name)
        cls.vault, cls.state = root / 'Örnek Beyin', root / 'state'
        cls.vault.mkdir()
        cls.env = isolated_env(root / 'home')
        result = install(cls.vault, cls.state, cls.env)
        assert result.returncode == 0, result.stderr
        (cls.vault / 'notlar').mkdir()
        (cls.vault / 'notlar/quartz.md').write_text(NOTE, encoding='utf-8')
        synced = run_python(cls.vault / 'beyin.py', ['sync'], cls.vault, cls.env)
        assert synced.returncode == 0, synced.stderr

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def command(self, client, event):
        settings = json.loads((self.vault / ('.%s/settings.json' % client)).read_text(encoding='utf-8'))
        return settings['hooks'][event][0]['hooks'][0]['command']

    def run_hook(self, client, event, payload):
        command = self.command(client, event)
        if os.name == 'nt' and client == 'gemini':
            # Gemini CLI on Windows: powershell -NoProfile -Command "<command>; exit check".
            argv = ['powershell.exe', '-NoProfile', '-Command',
                    command + '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }']
        elif os.name == 'nt':
            argv = ['cmd.exe', '/d', '/s', '/c', command]  # Qwen Code: ComSpec
        else:
            argv = ['bash', '-c', command]  # both on macOS and Linux
        # The strictest environment a client gives a hook: Gemini's sanitized set keeps these
        # Windows variables, and PowerShell prints nothing at all without COMSPEC and PATHEXT.
        kept = {key: os.environ[key] for key in ('COMSPEC', 'PATHEXT', 'SYSTEMDRIVE') if key in os.environ}
        result = subprocess.run(argv, input=json.dumps(payload).encode('utf-8'), capture_output=True,
                                env=dict(self.env, **kept), cwd=self.vault, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        return json.loads(result.stdout.decode('utf-8') or '{}')

    def payload(self, event, session, **extra):
        return dict({'hook_event_name': event, 'session_id': session, 'cwd': str(self.vault),
                     'timestamp': '2026-10-11T00:00:00Z'}, **extra)

    def test_gemini_gets_the_note_in_its_own_event_name(self):
        start = self.run_hook('gemini', 'SessionStart', self.payload('SessionStart', 'g1', source='startup'))
        self.assertEqual(start['hookSpecificOutput']['hookEventName'], 'SessionStart')
        turn = self.run_hook('gemini', 'BeforeAgent', self.payload('BeforeAgent', 'g1', prompt=PROMPT))
        self.assertEqual(turn['hookSpecificOutput']['hookEventName'], 'BeforeAgent')
        self.assertIn('QUARTZ_ISARET', turn['hookSpecificOutput']['additionalContext'])

    def test_qwen_gets_the_note_in_claude_shape(self):
        turn = self.run_hook('qwen', 'UserPromptSubmit', self.payload('UserPromptSubmit', 'q1', prompt=PROMPT))
        self.assertEqual(turn['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')
        self.assertIn('QUARTZ_ISARET', turn['hookSpecificOutput']['additionalContext'])

    def test_gemini_reminds_once_to_leave_a_receipt_after_an_edit(self):
        self.run_hook('gemini', 'AfterTool', self.payload('AfterTool', 'g2', tool_name='write_file',
                                                           tool_input={'file_path': 'notlar/yeni.md'}))
        first = self.run_hook('gemini', 'AfterAgent', self.payload('AfterAgent', 'g2', prompt='x',
                                                                    prompt_response='y', stop_hook_active=False))
        self.assertEqual(first.get('decision'), 'block')  # Gemini: deny/block retries with the reason
        self.assertIn('--harness gemini', first['reason'])
        again = self.run_hook('gemini', 'AfterAgent', self.payload('AfterAgent', 'g2', prompt='x',
                                                                    prompt_response='y', stop_hook_active=True))
        self.assertNotEqual(again.get('decision'), 'block')


if __name__ == '__main__':
    unittest.main()

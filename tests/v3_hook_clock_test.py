"""Session-card time comes from the machine clock in the hook context, never from a guess.

The card heading is `## YYYY-MM-DD HH:MM · ...`; without a clock in the context an agent
wrote a UTC or invented time. Every receipt header now carries `now=` in local time with its
offset; a `now` field in the client payload is ignored.
"""
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

from tests.v3_package_helpers import inherited_env, without_hook_clock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import beyin_v3_companion as companion

CLOCK = r'now=(\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{4});'
FAKE = '2099-01-01 00:00 +0000'


class HookClockTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='v3-hook-clock-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.vault = self.root / 'vault'
        self.state = self.root / 'state'
        self.project = self.root / 'Projects' / 'Synthetic'
        for folder in (self.vault / 'notes', self.project, self.root / 'home'):
            folder.mkdir(parents=True)
        (self.vault / 'notes/calibration.md').write_text(
            '---\n{"id":"clock-calibration","visibility":"internal"}\n---\n'
            'Nebula calibration uses quartz.\n', encoding='utf-8')
        home = str(self.root / 'home')
        self.env = inherited_env(HOME=home, USERPROFILE=home, BEYIN_V3_NO_SPAWN='1',
                                 PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        from beyin_v3_sync import SyncEngine
        SyncEngine(self.vault, self.state).sync()

    def invoke(self, script, event, harness='claude', prompt='', extra=(), cwd=None):
        payload = dict(hook_event_name=event, session_id='clock-session', event_id=event + harness,
                       cwd=str(cwd or self.vault), prompt=prompt, now=FAKE)
        before = datetime.now().astimezone()
        result = subprocess.run([sys.executable, str(SCRIPTS / script), '--vault', str(self.vault),
                                 '--state', str(self.state), '--harness', harness, *extra],
                                input=json.dumps(payload), text=True, encoding='utf-8', capture_output=True,
                                cwd=cwd or self.vault, env=self.env, timeout=30)
        after = datetime.now().astimezone()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['hookSpecificOutput']['additionalContext'], before, after

    def assert_clock(self, text, before, after):
        matches = re.findall(CLOCK, text)
        self.assertEqual(len(matches), 1, text[:400])
        self.assertNotIn(FAKE, text)
        now = datetime.strptime(matches[0], '%Y-%m-%d %H:%M %z')
        self.assertIn(now.utcoffset(), (before.utcoffset(), after.utcoffset()))
        self.assertLessEqual(before.replace(second=0, microsecond=0), now)
        self.assertLessEqual(now, after)

    def test_receipt_header_is_local_wall_time_with_offset(self):
        before = datetime.now().astimezone()
        header = companion.receipt_header('a' * 24)
        after = datetime.now().astimezone()
        self.assertTrue(header.startswith('Receipt session=' + 'a' * 24 + '; now='), header)
        self.assert_clock(header, before, after)

    def test_vault_contexts_carry_the_clock_not_the_payload_value(self):
        # SessionStart builds the companion header, a prompt the plain retrieval header.
        for harness in ('claude', 'codex'):
            for event, prompt in (('SessionStart', ''), ('UserPromptSubmit', 'Nebula calibration quartz')):
                with self.subTest(harness=harness, event=event):
                    text, before, after = self.invoke('beyin_v3_hook.py', event, harness, prompt)
                    self.assertIn('Nebula calibration uses quartz', text)
                    self.assert_clock(text, before, after)

    def test_external_bridge_carries_the_clock(self):
        text, before, after = self.invoke('beyin_v3_bridge.py', 'SessionStart', 'codex', cwd=self.project,
                                          extra=('--project-root', str(self.root / 'Projects')))
        self.assert_clock(text, before, after)

    def test_without_hook_clock_only_removes_the_clock(self):
        text = 'Receipt session=abc; now=2026-11-19 01:30 +0300; --harness CLIENT.\nbody now=x'
        self.assertEqual(without_hook_clock(text), 'Receipt session=abc; now=<clock>; --harness CLIENT.\nbody now=x')


if __name__ == '__main__':
    unittest.main()

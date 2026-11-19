"""Triage must not hide open work behind fenced examples or report an incomplete scan as clean.

Four cases: a fenced example `status: done` closed a live task; fenced `###` examples in
Threads.md counted as active topics; an unreadable inbox (or invalid inbox settings) read as
"0 waiting"; an unreadable task folder or file read as a complete task count.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_TEMPLATE_SCRIPTS = str(ROOT / 'template/.claude/scripts')
if _TEMPLATE_SCRIPTS not in sys.path:
    sys.path.insert(0, _TEMPLATE_SCRIPTS)

import beyin_v3_hygiene as hygiene
import beyin_v3_triage as triage


class _Vault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-triage-integrity-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.vault, self.state = root / 'vault', root / 'state'
        self.vault.mkdir()
        self.state.mkdir()
        self.now = datetime(2026, 11, 11, tzinfo=timezone.utc).timestamp()


class TaskFenceTest(_Vault):
    def setUp(self):
        super().setUp()
        (self.vault / 'tasks').mkdir()
        self.source = self.vault / 'tasks' / 'open-task.md'

    def scan(self, body, header='status: open\nupdated_at: 2026-09-01', newline='\n'):
        self.source.write_bytes(('---\n' + header + '\n---\n' + body).replace('\n', newline).encode('utf-8'))
        before = self.source.read_bytes()
        report = triage.scan_stale_tasks(self.vault, self.now, state=self.state)
        self.assertEqual(self.source.read_bytes(), before)
        return report

    def test_fenced_terminal_status_never_closes_a_live_task(self):
        for mark in ('`', '~'):
            other = '~' if mark == '`' else '`'
            for newline in ('\n', '\r\n'):
                for indent in ('', ' ', '   '):
                    for false_close in (mark * 3, other * 4, mark * 4 + ' trailing', '    ' + mark * 4):
                        with self.subTest(mark=mark, newline=newline, indent=indent, false_close=false_close):
                            body = (indent + mark * 4 + 'yaml\n# Example heading\n' + false_close
                                    + '\nstatus: done\n' + indent + mark * 5 + ' \t\n# Real task\n')
                            report = self.scan(body, newline=newline)
                            self.assertEqual((report['open_count'], report['stale_count']), (1, 1))
                            self.assertEqual(report['stale_tasks'][0]['title'], 'Real task')
                            self.assertEqual(report['stale_tasks'][0]['status'], 'open')

    def test_unclosed_fence_cannot_close_a_task_or_supply_its_title(self):
        for mark in ('```', '~~~'):
            with self.subTest(mark=mark):
                report = self.scan(mark + 'yaml\n# Example heading\nstatus: closed\n')
                self.assertEqual(report['open_count'], 1)
                self.assertEqual(report['stale_tasks'][0]['title'], 'open-task')

    def test_unfenced_and_frontmatter_statuses_still_close(self):
        for status in ('done', 'completed', 'cancelled', 'closed', 'tamamlandi', 'iptal', 'kapandi'):
            with self.subTest(status=status):
                self.assertEqual(self.scan('# Real task\nstatus: ' + status + '\n')['open_count'], 0)
                self.assertEqual(self.scan('```yaml\nstatus: open\n```\n', header='status: ' + status)['open_count'], 0)
        # An inline backtick run and a four-space-indented run do not open a fence.
        for opener in ('```inline```', '    ```'):
            with self.subTest(opener=opener):
                self.assertEqual(self.scan(opener + '\nstatus: done\n')['open_count'], 0)


class CompanionFenceTest(_Vault):
    def setUp(self):
        super().setUp()
        self.folder = self.vault / 'Companion'
        self.folder.mkdir()
        self.source = self.folder / 'Threads.md'

    def count(self, text):
        self.source.write_bytes(text.encode('utf-8'))
        return triage.scan_companion(self.vault, self.state, now=self.now)['active_threads']

    def test_fenced_examples_are_not_active_topics(self):
        for mark in ('`', '~'):
            other = '~' if mark == '`' else '`'
            for newline in ('\n', '\r\n'):
                for false_close in (mark * 3, other * 4, mark * 4 + ' trailing', '    ' + mark * 4):
                    with self.subTest(mark=mark, newline=newline, false_close=false_close):
                        lines = ['# Threads', '## Active Threads', mark * 4 + 'md', '### Example', false_close,
                                 '### Still example', '**Status:** active', mark * 5, '### Real', '**Status:** closed']
                        self.assertEqual(self.count(newline.join(lines)), 1)
                        legacy = [line for line in lines if not line.startswith('###')]
                        legacy[-1] = '**Durum:** 🟢 Aktif'
                        self.assertEqual(self.count(newline.join(legacy)), 1)

    def test_fenced_section_headings_do_not_open_or_close_sections(self):
        for text, expected in (
                ('## Active Threads\n```md\n## Closed Threads\n```\n### Real\n', 1),
                ('```md\n## Active Threads\n### Example\n```\n### Real\n', 1),
                ('## Active Threads\n~~~md\n### Example\n**Status:** active\n', 0),
                ('```md\n**Status:** active\n```\n', 0),
                ('## Active Threads\n```inline```\n### Real\n', 1),
                ('### First\n## Closed Threads\n### Historical\n', 1)):
            with self.subTest(text=text):
                self.assertEqual(self.count(text), expected)

    def test_fenced_examples_do_not_recommend_compaction(self):
        text = '## Active Threads\n```md\n' + ''.join('### Example %d\n' % n for n in range(6)) + '```\n### Real\n'
        self.source.write_text(text, encoding='utf-8')
        report = triage.triage(self.vault, self.state, now=self.now)
        self.assertEqual(report['companion']['active_threads'], 1)
        self.assertNotIn('companion-compact', json.dumps(report['recommendations']))


class InboxScanErrorTest(_Vault):
    def test_clean_report_keeps_its_shape(self):
        expected = {'count': 0, 'oldest_days': None, 'attention': False, 'folders': []}
        self.assertEqual(triage.scan_inbox(self.vault, self.now, self.state), expected)

    def test_invalid_settings_are_reported_not_replaced_by_discovery(self):
        inbox = self.vault / 'inbox'
        inbox.mkdir()
        (inbox / 'pending.md').write_text('# Pending\n', encoding='utf-8')
        for value in ('{broken SECRET-PATH', '{"folders": "bad"}'):
            with self.subTest(value=value):
                (self.state / 'inbox-report.json').write_text(value, encoding='utf-8')
                report = triage.scan_inbox(self.vault, self.now, self.state)
                self.assertEqual((report['status'], report['reason']), ('unavailable', 'inbox_settings_invalid'))
                self.assertTrue(report['attention'])
                human = triage.format_human({'inbox': report})
                self.assertIn('Taranamadi', human)
                self.assertIn('inbox-report.json', human)
                self.assertNotIn('Bekleyen kaynak: 0', human)
                self.assertNotIn('SECRET-PATH', json.dumps(report) + human)

    def test_scan_exception_or_error_is_unavailable_without_raw_text(self):
        for kwargs in ({'side_effect': PermissionError('SECRET-PATH')},
                       {'return_value': {'folders': [], 'error': 'PermissionError', 'attention': False}}):
            with self.subTest(kwargs=kwargs), patch.object(triage, 'inbox_report', **kwargs):
                report = triage.scan_inbox(self.vault, self.now, self.state)
                self.assertEqual((report['status'], report['error']), ('unavailable', 'PermissionError'))
                self.assertTrue(report['attention'])
                human = triage.format_human({'inbox': report})
                self.assertIn('Taranamadi', human)
                self.assertNotIn('Bekleyen kaynak: 0', human)
                self.assertNotIn('SECRET-PATH', json.dumps(report) + human)
        with patch.object(triage, 'inbox_report', return_value={'folders': [], 'error': 'SECRET-PATH'}):
            self.assertNotIn('SECRET-PATH', json.dumps(triage.scan_inbox(self.vault, self.now, self.state)))

    def test_missing_named_folder_marks_the_count_partial(self):
        inbox = self.vault / 'inbox'
        inbox.mkdir()
        (inbox / 'pending.md').write_text('# Pending\n', encoding='utf-8')
        (self.state / 'inbox-report.json').write_text('{"folders": ["inbox", "Missing Captures"]}', encoding='utf-8')
        report = triage.scan_inbox(self.vault, self.now, self.state)
        self.assertEqual((report['status'], report['count']), ('partial', 1))
        human = triage.format_human({'inbox': report})
        self.assertIn('(eksik tarama)', human)
        self.assertIn('not_found', human)
        self.assertNotIn('Missing Captures: 0 not', human)

    def test_unreadable_capture_is_an_error_not_a_waiting_note(self):
        inbox = self.vault / 'inbox'
        inbox.mkdir()
        (inbox / 'pending.md').write_text('# Pending\n', encoding='utf-8')
        real_open = Path.open

        def failing_open(path, *args, **kwargs):
            if path.name == 'pending.md':
                raise PermissionError('SECRET-PATH')
            return real_open(path, *args, **kwargs)

        with patch.object(Path, 'open', failing_open):
            report = triage.scan_inbox(self.vault, self.now, self.state)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(report['folders'][0]['error'], 'PermissionError')
        self.assertNotIn('SECRET-PATH', json.dumps(report))


class TaskScanErrorTest(_Vault):
    def setUp(self):
        super().setUp()
        (self.vault / 'tasks').mkdir()
        (self.vault / 'tasks' / 'readable.md').write_text(
            '---\nstatus: open\nupdated_at: 2026-11-10\n---\n# Readable\n', encoding='utf-8')

    def test_complete_scan_keeps_its_shape(self):
        report = triage.scan_stale_tasks(self.vault, self.now, state=self.state)
        self.assertEqual(report['open_count'], 1)
        self.assertNotIn('status', report)

    def test_unreadable_task_file_marks_the_scan_partial(self):
        real_read = Path.read_text

        def failing_read(path, *args, **kwargs):
            if path.name == 'hidden.md':
                raise PermissionError('SECRET-PATH')
            return real_read(path, *args, **kwargs)

        (self.vault / 'tasks' / 'hidden.md').write_text('---\nstatus: open\n---\n# Hidden\n', encoding='utf-8')
        with patch.object(Path, 'read_text', failing_read):
            report = triage.scan_stale_tasks(self.vault, self.now, state=self.state)
        self.assertEqual(report['open_count'], 1)
        self.assertEqual((report['status'], report['reason']), ('partial', 'task_scan_incomplete'))
        self.assertEqual(report['errors'], ['PermissionError'])
        self.assertNotIn('SECRET-PATH', json.dumps(report))
        human = triage.format_human({'tasks': report})
        self.assertIn('Gorev taramasi eksik', human)
        self.assertIn('Taranabilen acik gorev: 1', human)
        recs = triage.generate_recommendations({}, report, {'count': 1, 'digest_days': 7}, {})
        self.assertTrue(any('Gorev taramasi eksik' in rec for rec in recs))

    def test_unwalkable_task_folder_marks_the_scan_partial(self):
        real_walk = os.walk

        def failing_walk(top, *args, **kwargs):
            onerror = kwargs.get('onerror')
            if onerror is not None:
                onerror(PermissionError('SECRET-PATH'))
            return real_walk(top, *args, **kwargs)

        with patch.object(triage.os, 'walk', failing_walk):
            report = triage.scan_stale_tasks(self.vault, self.now, state=self.state)
        self.assertEqual(report.get('status'), 'partial')
        self.assertNotIn('SECRET-PATH', json.dumps(report))


if __name__ == '__main__':
    unittest.main()

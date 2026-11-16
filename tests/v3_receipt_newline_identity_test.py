"""Receipt identity ignores line endings without losing edit protection.

Git for Windows (core.autocrlf=true) can check a receipt or a generated view out as CRLF, and
older writers stored CRLF summaries verbatim. A newline-only difference must not stop the daily
views, raise an event id collision or a receipt divergence; a real edit still must. Synthetic
fixtures only: an installed vault for the CLI paths, an in-process engine for zone and races.
"""
from contextlib import closing
from datetime import timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from v3_package_helpers import install, isolated_env, run_python

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    import beyin_v3_projections as projections  # noqa: E402
    import beyin_v3_sync as sync_module  # noqa: E402
finally:
    sys.dont_write_bytecode = _bytecode

EAST = timezone(timedelta(hours=14), 'UTC+14')
WEST = timezone(timedelta(hours=-12), 'UTC-12')  # 26 hours apart: never the same local day


class ReceiptNewlineIdentityTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='v3-receipt-newlines-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        self.state = self.root / 'state'
        self.env = isolated_env(self.root / 'home')
        result = install(self.vault, self.state, self.env)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        (self.vault / 'notes').mkdir()
        (self.vault / 'notes/a.md').write_text('# Synthetic source\n', encoding='utf-8')
        (self.vault / 'notes/b.md').write_text('# Other source\n', encoding='utf-8')

    def cli(self, *args, payload=None, ok=True):
        result = run_python(self.vault / 'beyin.py', args, self.vault, self.env, payload)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout.decode())
        return result

    def receipt(self, event='r1', summary='First line\nSecond line', harness='claude'):
        return self.cli('receipt', '--harness', harness, payload={
            'event_id': event, 'summary': summary, 'refs': ['notes/a.md']})

    def saved(self, event='r1'):
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            return json.loads(db.execute('SELECT payload FROM receipts WHERE id=?', (event,)).fetchone()[0])

    def views(self):
        return sorted((self.vault / 'daily/v3').glob('*.md')) + [self.vault / 'knowledge/v3/outcomes.md']

    def tracked(self, path):
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            row = db.execute('SELECT hash FROM receipt_views WHERE path=?',
                             (path.relative_to(self.vault).as_posix(),)).fetchone()
        return row and row[0]

    def seed_legacy(self):
        """Recreate an older writer's state: a CRLF summary inside LF wrappers, views tracked as written."""
        first = self.receipt()
        source = self.vault / first['source']
        for path in [source, *self.views()]:
            path.write_bytes(path.read_bytes().replace(b'First line\nSecond line', b'First line\r\nSecond line'))
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            old = self.saved()
            old['summary'] = 'First line\r\nSecond line'
            db.execute('UPDATE receipts SET payload=? WHERE id=?', (json.dumps(old), 'r1'))
            for path in self.views():
                db.execute('UPDATE receipt_views SET hash=? WHERE path=?',
                           (hashlib.sha256(path.read_bytes()).hexdigest(), path.relative_to(self.vault).as_posix()))
            db.commit()
        return source

    def assert_clean(self, report):
        self.assertEqual(report['status'], 'succeeded', report)
        self.assertEqual(report.get('conflicts', []), [], report)
        self.assertEqual(report.get('warnings', []), [], report)

    def view_snapshot(self):
        return {path: (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_ino) for path in self.views()}

    def test_new_summary_file_and_json_replays_use_lf(self):
        summary = 'İlk satır\r\nİkinci satır\rSon satır\n'
        path = self.root / 'summary.txt'
        path.write_bytes(summary.encode())
        first = self.cli('receipt', '--event-id', 'r1', '--summary-file', path, '--ref', 'notes/a.md')
        self.assertEqual(self.saved()['summary'], 'İlk satır\nİkinci satır\nSon satır\n')
        for output in [self.vault / first['source'], *self.views()]:
            self.assertNotIn(b'\r', output.read_bytes())
        self.receipt(summary=summary, harness='codex')
        self.receipt(summary=summary.replace('\r\n', '\n').replace('\r', '\n'))

    def test_legacy_views_migrate_to_lf_once_and_lf_saves_are_stable(self):
        source = self.seed_legacy()
        source_bytes, payload = source.read_bytes(), json.dumps(self.saved())
        expected = {path: path.read_bytes().replace(b'\r\n', b'\n') for path in self.views()}
        self.assert_clean(self.cli('sync', '--full'))
        for path, raw in expected.items():
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(self.tracked(path), hashlib.sha256(raw).hexdigest())
        for save in (False, True, True):
            if save:
                for path in self.views():
                    path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
            before = self.view_snapshot()
            self.assert_clean(self.cli('sync', '--full'))
            self.assertEqual(self.view_snapshot(), before, 'LF saves must not cause another replacement')
        self.receipt(harness='codex')
        self.assertEqual(self.view_snapshot(), before)
        self.assertEqual(source.read_bytes(), source_bytes)
        self.assertEqual(json.dumps(self.saved()), payload)

    def test_legacy_lf_migration_keeps_hardlink_alias_excluded(self):
        self.seed_legacy()
        view = self.vault / 'knowledge/v3/outcomes.md'
        alias = self.vault / 'notes/view-alias.md'
        try:
            os.link(view, alias)
        except OSError as exc:
            self.skipTest('Hard links unavailable: ' + str(exc))
        original = alias.read_bytes()
        self.assert_clean(self.cli('sync', '--full'))
        self.assertNotIn(b'\r', view.read_bytes())
        self.assertEqual(alias.read_bytes(), original)
        self.assertFalse(alias.samefile(view))
        self.assert_clean(self.cli('sync', '--full'))
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            self.assertNotIn('notes/view-alias.md', [row[0] for row in db.execute('SELECT source FROM markdown_sources')])

    def test_legacy_replay_preserves_source_and_index(self):
        source = self.seed_legacy()
        before, indexed = source.read_bytes(), self.saved()
        self.receipt(summary='First line\nSecond line', harness='codex')
        self.receipt(summary='First line\rSecond line')
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.saved(), indexed)

    def test_legacy_normalized_views_accept_new_receipt_without_intermediate_sync(self):
        self.seed_legacy()
        for view in self.views():
            view.write_bytes(view.read_bytes().replace(b'\r\n', b'\n'))
        second = self.receipt('r2', 'New recorded result')
        self.assertNotIn('source_sync', second)
        for view in self.views():
            self.assertIn(b'New recorded result', view.read_bytes())
            self.assertNotIn(b'\r', view.read_bytes())
        self.assert_clean(self.cli('sync', '--full'))

    def test_legacy_sources_and_views_normalize_without_divergence(self):
        source = self.seed_legacy()
        for path in [source, *self.views()]:
            path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
        before = source.read_bytes()
        self.assert_clean(self.cli('sync', '--full'))
        self.receipt(harness='codex')
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.saved()['summary'], 'First line\r\nSecond line')

    def test_full_crlf_checkout_and_state_reset_replay(self):
        first = self.receipt(summary='First line\nSecond line\n')
        source = self.vault / first['source']
        for path in [source, *self.views()]:
            path.write_bytes(path.read_bytes().replace(b'\n', b'\r\n'))
        before = source.read_bytes()
        self.assert_clean(self.cli('sync', '--full'))
        self.receipt(summary='First line\nSecond line\n')
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            db.execute('DELETE FROM receipts')
            db.execute("DELETE FROM metadata WHERE key='receipt_scan_signature'")
            db.commit()
        self.receipt(summary='First line\nSecond line\n', harness='codex')
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.saved()['harness'], 'claude')

    def test_normalized_view_with_real_edit_stays_preserved(self):
        self.seed_legacy()
        before = {}
        for view in self.views():
            raw = view.read_bytes().replace(b'\r\n', b'\n') + b'Human annotation\n'
            view.write_bytes(raw)
            before[view] = raw
        second = self.receipt('r2', 'New recorded result')
        self.assertEqual(len(second['source_sync']['warnings']), 2)
        for view, raw in before.items():
            self.assertEqual(view.read_bytes(), raw)
        self.assertEqual(self.cli('sync', '--full')['status'], 'degraded')

    def test_actual_summary_refs_links_and_source_edits_still_conflict(self):
        source = self.seed_legacy()
        for changes in ({'summary': 'Changed line\nSecond line'}, {'refs': ['notes/b.md']},
                        {'links': ['https://example.com/changed']}):
            with self.subTest(changes=changes):
                payload = {'event_id': 'r1', 'summary': 'First line\nSecond line', 'refs': ['notes/a.md']}
                payload.update(changes)
                result = self.cli('receipt', payload=payload, ok=False)
                self.assertIn(b'event id collision', result.stderr)
        source.write_bytes(source.read_bytes().replace(b'First line', b'Changed line'))
        report = self.cli('sync', '--full')
        self.assertEqual(report['status'], 'conflict')
        self.assertEqual(report['conflicts'][0]['kind'], 'receipt_divergence')

    def test_legacy_trailing_cr_keeps_indexed_summary(self):
        first = self.receipt(summary='Trailing line')
        source = self.vault / first['source']
        source.write_bytes(source.read_bytes().replace(b'Trailing line\n', b'Trailing line\r\n'))
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            old = self.saved()
            old['summary'] = 'Trailing line\r'
            db.execute('UPDATE receipts SET payload=? WHERE id=?', (json.dumps(old), 'r1'))
            db.commit()
        for spelling in (b'\r\n', b'\n'):
            source.write_bytes(source.read_bytes().replace(b'\r\n', spelling))
            self.assert_clean(self.cli('sync', '--full'))
            self.receipt(summary='Trailing line\n')
        self.assertEqual(self.saved()['summary'], 'Trailing line\r')

    def test_original_legacy_trailing_cr_replays_after_state_reset(self):
        first = self.receipt(summary='Trailing line')
        source = self.vault / first['source']
        source.write_bytes(source.read_bytes().replace(b'Trailing line\n', b'Trailing line\r\n'))
        before = source.read_bytes()
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            db.execute('DELETE FROM receipts')
            db.execute("DELETE FROM metadata WHERE key='receipt_scan_signature'")
            db.commit()
        self.receipt(summary='Trailing line\r')
        self.assertEqual(self.saved()['summary'], 'Trailing line\r')
        self.assertEqual(source.read_bytes(), before)

    def test_tracked_hash_not_links_decides_legacy_ownership(self):
        self.seed_legacy()
        before = {}
        for view in self.views():
            raw = view.read_bytes().replace(b'\r\n', b'\n').replace(b'First line', b'Altered line')
            view.write_bytes(raw)
            before[view] = raw
        self.receipt('r2', 'Second result')
        self.receipt('r3', 'Third result')
        for view, raw in before.items():
            self.assertEqual(view.read_bytes(), raw)

    def engine(self):
        return sync_module.SyncEngine(self.vault, self.state)

    def zone(self, zone):
        return patch.object(projections, '_local_zone', lambda: zone)

    def test_crlf_checkout_of_a_stale_view_is_retired(self):
        # A view this engine wrote as LF, checked out as CRLF by git, is still ours to retire
        # when the local day it was named by changes (time zone, #149).
        engine = self.engine()
        with self.zone(EAST):
            self.assert_clean(engine.receipt('r1', 'Zone result', ['notes/a.md'], 'claude'))
        stale, = (self.vault / 'daily/v3').glob('*.md')
        stale.write_bytes(stale.read_bytes().replace(b'\n', b'\r\n'))
        with self.zone(WEST):
            self.assert_clean(engine.sync(full=True))
        self.assertFalse(stale.exists())
        fresh, = (self.vault / 'daily/v3').glob('*.md')
        self.assertIn(b'Zone result', fresh.read_bytes())

    def test_edited_stale_view_is_still_preserved(self):
        engine = self.engine()
        with self.zone(EAST):
            engine.receipt('r1', 'Zone result', ['notes/a.md'], 'claude')
        stale, = (self.vault / 'daily/v3').glob('*.md')
        edited = stale.read_bytes().replace(b'\n', b'\r\n') + b'Human annotation\r\n'
        stale.write_bytes(edited)
        with self.zone(WEST):
            report = engine.sync(full=True)
        self.assertEqual(stale.read_bytes(), edited)
        self.assertTrue(any(item.get('source') == stale.relative_to(self.vault).as_posix()
                            for item in report['warnings'] + report.get('conflicts', [])), report)

    def raced(self, target, concurrent, reads, injected):
        read_bytes = Path.read_bytes
        target = target.resolve()

        def read(candidate):
            raw = read_bytes(candidate)
            if candidate.resolve() == target:
                reads.append(raw)
                if len(reads) == 1:
                    candidate.write_bytes(concurrent)
                    injected.append(candidate)
            return raw
        return patch.object(Path, 'read_bytes', read)

    def test_stale_view_retirement_rechecks_raw_bytes_before_unlink(self):
        engine = self.engine()
        with self.zone(EAST):
            engine.receipt('r1', 'Zone result', ['notes/a.md'], 'claude')
        stale, = (self.vault / 'daily/v3').glob('*.md')
        concurrent = stale.read_bytes() + b'Concurrent human edit\n'
        reads, injected = [], []
        with self.zone(WEST), engine.store._connect() as db:
            desired = projections._receipt_view_contents(engine, db)
            with self.raced(stale, concurrent, reads, injected):
                issues = projections.project_receipts(engine, db, desired=desired)
        self.assertEqual(len(injected), 1, 'the concurrent edit must actually be injected once')
        self.assertGreaterEqual(len(reads), 2, 'retirement must reread the view before removing it')
        self.assertEqual(stale.read_bytes(), concurrent)
        self.assertTrue(any(item['reason'] == 'receipt view changed during projection' for item in issues), issues)

    def test_lf_migration_rechecks_even_concurrent_newline_only_save(self):
        self.seed_legacy()
        view = self.vault / 'knowledge/v3/outcomes.md'
        before = view.read_bytes()
        inode = view.stat().st_ino
        concurrent = before.replace(b'\r\n', b'\n')
        reads, injected = [], []
        engine = self.engine()
        with engine.store._connect() as db:
            desired = projections._receipt_view_contents(engine, db)
            with self.raced(view, concurrent, reads, injected):
                issues = projections.project_receipts(engine, db, desired=desired)
            tracked = db.execute('SELECT hash FROM receipt_views WHERE path=?', ('knowledge/v3/outcomes.md',)).fetchone()[0]
        self.assertEqual(tracked, hashlib.sha256(before).hexdigest())
        self.assertEqual(len(injected), 1)
        self.assertGreaterEqual(len(reads), 2)
        self.assertEqual(view.read_bytes(), concurrent)
        self.assertEqual(view.stat().st_ino, inode, 'a concurrent LF save must not be replaced')
        self.assertTrue(any(item['reason'] == 'receipt view changed during projection' for item in issues), issues)


if __name__ == '__main__':
    unittest.main()

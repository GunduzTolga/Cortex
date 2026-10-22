#!/usr/bin/env python3
"""Large vaults: what an opening, a turn, a sync and the store itself cost, counted rather than timed.

A chat-history import or a few thousand notes made every prompt wait on bytes it never
delivers: the opening counted every note's words to rank them all at weight 0, a turn decoded
and hashed the excluded imports, a cold passage index fell back to the whole-note path on
every prompt, and opening a writable store queued behind a running sync.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3 as runtime  # noqa: E402
import beyin_v3_hook as hook  # noqa: E402
import beyin_v3_passage as passage  # noqa: E402
from beyin_v3_sync import SyncEngine  # noqa: E402


def note(vault, source, text, **metadata):
    path = vault / source
    path.parent.mkdir(parents=True, exist_ok=True)
    head = '---\n' + json.dumps(metadata, ensure_ascii=False) + '\n---\n' if metadata else ''
    path.write_text(head + text, encoding='utf-8')
    return path


class Vault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-large-vault-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        self.state = self.root / 'state'


class SnapshotTest(Vault):
    def test_the_opening_snapshot_ranks_without_counting_words(self):
        store = runtime.MemoryStore(self.state, self.vault)
        for index in range(12):
            source = f'notes/n{index:02d}.md'
            text = f'Not {index} metni.'
            note(self.vault, source, text)
            store.ingest({'id': f'n{index:02d}', 'kind': 'note', 'text': text, 'source': source,
                          'status': ('active', 'waiting', 'done')[index % 3],
                          'updated_at': f'2026-10-{10 + index % 5:02d}'})
        counted = Mock(wraps=runtime._token_counts)
        with patch.object(runtime, '_token_counts', counted):
            snapshot = store.snapshot_context(budget_chars=100000, limit=20)
        self.assertEqual([c for c in counted.call_args_list if c.args[0]], [], 'no note was tokenized')
        expected = sorted((r for r in store._records() if r['status'] in ('active', 'waiting')),
                          key=lambda r: (r['updated_at'], r['id']), reverse=True)
        self.assertEqual([r['id'] for r in snapshot['records']], [r['id'] for r in expected])
        # The order the scoring path gives: a query that matches every note equally.
        scored = store._retrieve('metni', statuses=('active', 'waiting'), limit=20, budget_chars=100000)
        self.assertEqual([r['id'] for r in scored['records']], [r['id'] for r in expected])


class TurnTest(Vault):
    def seed(self):
        note(self.vault, 'notes/kira.md', 'Ev kirası 25.000 TL, ayın beşinde.')
        note(self.vault, 'notes/eski-kira.md', 'Eski kira 20.000 TL idi.', id='eski-kira')
        note(self.vault, 'notes/yeni.md', 'Kira artışı ocakta.', supersedes=['eski-kira'])
        for index in range(3):
            note(self.vault, f'daily/import-chatgpt-{index}.md', ('Kira konuşması dökümü. ' * 400) + str(index))
        note(self.vault, 'daily/2026-10-20.md', 'Bugün kira ödendi.')
        # A retired note named only by its file name, which an excluded log shares: ambiguous, nothing retired.
        note(self.vault, 'notes/plan.md', 'Plan A.')
        note(self.vault, 'daily/plan.md', 'Günlük plan.')
        note(self.vault, 'notes/plan-b.md', 'Plan B.', supersedes=['plan'])
        engine = SyncEngine(self.vault, self.state)
        engine.sync()
        return engine

    def test_a_turn_never_reads_or_decodes_the_excluded_imports(self):
        engine = self.seed()
        store = runtime.MemoryStore(self.state, self.vault, read_only=True)
        reads, original = [], Path.read_bytes

        def counted(path):
            reads.append(Path(path).as_posix())
            return original(path)

        with patch.object(Path, 'read_bytes', counted), \
                patch.object(runtime.MemoryStore, '_records', side_effect=AssertionError('decoded every payload')):
            sources = [r['source'] for r in store.context_for('claude', 'kira ne kadar', strict=True)['records']]
        self.assertIn('notes/kira.md', sources)
        self.assertNotIn('notes/eski-kira.md', sources)
        self.assertFalse([path for path in reads if '/daily/import-' in path], reads)
        loaded = {r['source'] for r in passage.strict_records(store, passage.settings(self.state)['exclude'])}
        self.assertIn('daily/2026-10-20.md', loaded, 'a day log stays for the days a question names')
        self.assertFalse({s for s in loaded if s.startswith('daily/import-')})
        self.assertEqual(engine.sync()['status'], 'succeeded')

    def test_a_continuation_prompt_reads_only_its_saved_topic(self):
        # "bunu kontrol et" re-checks the topic the previous turn delivered: at most three records,
        # never the whole index with its imports.
        import beyin_v3_continuity as continuity
        self.seed()
        store = runtime.MemoryStore(self.state, self.vault)
        by_id = {record['id']: record for record in store._records()}
        delivered = store.context_for('claude', 'kira ne kadar', strict=True)
        self.assertIn('notes/kira.md', [r['source'] for r in delivered['records']])
        continuity.remember(store, 'claude', 'oturum', 'kira ne kadar', delivered)
        # A retired note in the saved topic still ends it: supersession is resolved over every record.
        continuity.remember(store, 'claude', 'eski', 'eski kira bedeli', {'records': [by_id['eski-kira']]})
        empty = runtime.pack_context([], budget_chars=4000)
        with patch.object(runtime.MemoryStore, '_records', side_effect=AssertionError('decoded every payload')):
            context, inherited = continuity.resolve(store, 'claude', 'oturum', 'bunu kontrol et', empty,
                                                    budget_chars=4000)
            self.assertTrue(inherited)
            self.assertIn('notes/kira.md', [r['source'] for r in context['records']])
            self.assertEqual(continuity.resolve(store, 'claude', 'eski', 'bunu kontrol et', empty, budget_chars=4000),
                             (empty, False))

    def test_retired_ids_match_a_full_resolution_with_or_without_the_last_syncs_result(self):
        self.seed()
        store = runtime.MemoryStore(self.state, self.vault)
        full = store._superseded_ids()
        self.assertEqual(full, {'eski-kira'})
        self.assertEqual(store.superseded_ids(), full)  # the sync's stored result
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db, db:
            db.execute("DELETE FROM metadata WHERE key='derived'")
        self.assertIsNone(store.derived())
        self.assertEqual(store.superseded_ids(), full)  # computed from the few rows that matter
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            self.assertEqual(runtime.resolve_supersedes(runtime.supersedes_inputs(db)),
                             runtime.resolve_supersedes(store._records()))

    def test_a_write_from_another_writer_makes_the_stored_result_stale(self):
        engine = self.seed()
        self.assertIsNotNone(engine.store.derived())
        note(self.vault, 'notes/manual.md', 'Elle eklendi.')
        engine.store.ingest({'id': 'manual', 'kind': 'note', 'text': 'Elle eklendi.',
                             'source': 'notes/manual.md', 'supersedes': ['notes/plan-b.md']})
        self.assertIsNone(engine.store.derived(), 'the records counter moved')
        plan_b = 'md-' + hashlib.sha256(b'notes/plan-b.md').hexdigest()[:24]
        self.assertEqual(engine.store.superseded_ids(), {'eski-kira', plan_b})
        self.assertEqual(engine.store.superseded_ids(), engine.store._superseded_ids())
        engine.sync()
        self.assertEqual(engine.store.derived()['retired'], sorted({'eski-kira', plan_b}))


class WarmIndexTest(Vault):
    def test_a_drain_nobody_waits_for_warms_the_index_a_read_only_turn_uses(self):
        for index in range(30):
            note(self.vault, f'notes/n{index}.md', f'Zirkon kovası yedekleme ayarı {index}. ' + 'dolgu ' * 50)
        hook.drain_queue(self.vault, self.state)
        self.assertTrue((self.state / passage.CACHE_NAME).is_file())
        marker = json.loads((self.state / passage.WARM_NAME).read_text(encoding='utf-8'))
        self.assertTrue(marker['saved'])
        store = runtime.MemoryStore(self.state, self.vault, read_only=True)
        with patch.object(passage, 'BUILD_SECONDS', -1.0), \
                patch.object(runtime, 'shared_context', side_effect=AssertionError('fell back')):
            found = store.context_for('claude', 'zirkon kovası yedekleme', strict=True)
        self.assertTrue(found['records'])
        # Unchanged since: nothing is built again.
        with patch.object(passage, 'build', side_effect=AssertionError('rebuilt')):
            self.assertFalse(passage.warm(runtime.MemoryStore(self.state, self.vault)))

    def test_a_pool_the_cache_cannot_take_is_not_rebuilt_after_every_change(self):
        # Over CACHE_MAX_BYTES the cache file is never written: rebuilding after every change of
        # the index would cost a slow laptop the whole build after each agent turn, for nothing.
        for index in range(5):
            note(self.vault, f'notes/n{index}.md', f'Zirkon kovası {index}.')
        engine = SyncEngine(self.vault, self.state)
        engine.sync()
        real_write = passage._write_cache

        def too_large(path, blob):
            return False if Path(path).name == passage.CACHE_NAME else real_write(path, blob)
        with patch.object(passage, '_write_cache', side_effect=too_large):
            self.assertTrue(passage.warm(engine.store))
        self.assertIs(json.loads((self.state / passage.WARM_NAME).read_text(encoding='utf-8'))['saved'], False)
        note(self.vault, 'notes/n9.md', 'Yeni zirkon notu.')
        engine.sync()
        with patch.object(passage, 'build', side_effect=AssertionError('rebuilt after a change')):
            self.assertFalse(passage.warm(engine.store))
        # A day later it is tried again (the vault may have shrunk).
        later = time.time() + passage.WARM_RETRY_SECONDS + 60
        with patch.object(passage.time, 'time', return_value=later):
            self.assertTrue(passage.warm(engine.store))
        self.assertTrue((self.state / passage.CACHE_NAME).is_file())

    def test_a_prompt_worker_leaves_housekeeping_to_the_next_stop(self):
        note(self.vault, 'notes/a.md', 'Zirkon.')
        hook.drain_queue(self.vault, self.state, housekeep=False)
        self.assertFalse((self.state / passage.CACHE_NAME).exists())
        self.assertFalse((self.state / passage.WARM_NAME).exists())

    def test_a_large_pool_still_building_answers_nothing_instead_of_counting_every_note(self):
        store = runtime.MemoryStore(self.state, self.vault)
        pending = passage.IndexPending('passage index pending: 1/900 records', pending_total=900)
        with patch.object(passage, 'context_for', side_effect=pending), \
                patch.object(runtime, 'shared_context', side_effect=AssertionError('note-level fallback')):
            self.assertEqual(store.context_for('claude', 'zirkon', strict=True)['records'], [])
        small = passage.IndexPending('passage index pending: 1/3 records', pending_total=3)
        with patch.object(passage, 'context_for', side_effect=small), \
                patch.object(runtime, 'shared_context', return_value={'records': ['note-level']}) as fallback:
            self.assertEqual(store.context_for('claude', 'zirkon', strict=True), {'records': ['note-level']})
        self.assertEqual(fallback.call_count, 1)


class StoreOpenTest(Vault):
    def test_an_initialized_store_opens_without_the_write_lock(self):
        runtime.MemoryStore(self.state, self.vault)
        with closing(sqlite3.connect(self.state / 'memory.sqlite3', isolation_level=None)) as writer:
            writer.execute('BEGIN IMMEDIATE')  # a running sync
            started = time.monotonic()
            store = runtime.MemoryStore(self.state, self.vault, busy_timeout=2)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(store._records(), [])
            other = self.root / 'other vault'
            other.mkdir()
            with self.assertRaisesRegex(ValueError, 'runtime belongs to another vault'):
                runtime.MemoryStore(self.state, other, busy_timeout=2)
            writer.execute('ROLLBACK')

    def test_a_store_missing_part_of_its_schema_is_completed(self):
        runtime.MemoryStore(self.state, self.vault)
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db, db:
            db.execute('DROP INDEX events_record_sequence')
        runtime.MemoryStore(self.state, self.vault)
        with closing(sqlite3.connect(self.state / 'memory.sqlite3')) as db:
            self.assertTrue(db.execute("SELECT 1 FROM sqlite_master WHERE name='events_record_sequence'").fetchone())


class EventHistoryTest(Vault):
    def history_rows(self, store):
        with closing(sqlite3.connect(store.database)) as db:
            return db.execute('SELECT record_id, event_type FROM events ORDER BY sequence').fetchall()

    def test_each_record_keeps_its_newest_snapshots(self):
        path = note(self.vault, 'notes/gunluk.md', 'Sürüm 0', id='gunluk')
        engine = SyncEngine(self.vault, self.state)
        engine.sync()
        for revision in range(1, 30):
            path.write_text('---\n{"id": "gunluk"}\n---\nSürüm ' + str(revision), encoding='utf-8')
            engine.sync()
        store = engine.store
        self.assertEqual(len(self.history_rows(store)), 30)
        removed = store.prune_events(now=1_000_000)
        self.assertEqual(removed, 30 - store.EVENTS_KEEP)
        history = store.history('gunluk')
        self.assertEqual(len(history), store.EVENTS_KEEP)
        self.assertIn('Sürüm 29', history[-1]['record']['text'])
        self.assertEqual(store.prune_events(now=1_000_000 + 60), 0, 'once a day')

    def test_a_note_deleted_long_ago_leaves_no_text_behind(self):
        path = note(self.vault, 'notes/silinen.md', 'Gizli eski metin.', id='silinen')
        note(self.vault, 'notes/kalan.md', 'Kalan not.', id='kalan')
        engine = SyncEngine(self.vault, self.state)
        engine.sync()
        store = engine.store
        day = 86400
        store.prune_events(now=10 * day)
        path.unlink()
        engine.sync()
        self.assertTrue(store.history('silinen'), 'a fresh delete keeps its audit trail')
        with closing(sqlite3.connect(store.database)) as db:
            sequence_before = db.execute('SELECT MAX(sequence) FROM events').fetchone()[0]
        store.prune_events(now=12 * day)  # the delete is after the sequence noted on day 10
        self.assertTrue(store.history('silinen'))
        store.prune_events(now=(12 + store.EVENTS_DELETED_DAYS) * day)
        self.assertEqual(store.history('silinen'), [])
        self.assertNotIn('silinen', {row[0] for row in self.history_rows(store)})
        self.assertTrue(store.history('kalan'))
        # Sequences are never reused, so cut-offs such as receipt_view_history stay valid.
        note(self.vault, 'notes/yeni.md', 'Yeni not.', id='yeni')
        engine.sync()
        with closing(sqlite3.connect(store.database)) as db:
            self.assertGreater(db.execute("SELECT sequence FROM events WHERE record_id='yeni'").fetchone()[0],
                               sequence_before)

    def test_a_locked_store_is_left_for_the_next_drain(self):
        note(self.vault, 'notes/a.md', 'A.', id='a')
        engine = SyncEngine(self.vault, self.state)
        engine.sync()
        with closing(sqlite3.connect(engine.store.database, isolation_level=None)) as writer:
            writer.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError):
                engine.store.prune_events(busy_timeout=0.05)
            writer.execute('ROLLBACK')
        self.assertGreaterEqual(engine.store.prune_events(), 0)


if __name__ == '__main__':
    unittest.main()

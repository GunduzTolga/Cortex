"""A receipt ref that names a withheld record in another case or Unicode form stays withheld.

Old receipts may spell a note path differently from the index (KNOWLEDGE/OZEL.MD, an NFD
name from macOS, Turkish dotted/dotless i). The privacy/trust gate must still recognise the
record behind that spelling. Real in-memory SQLite, real receipt file in a temporary vault.
"""
from datetime import date
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unicodedata
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'template/.claude/scripts'))

from beyin_v3_index import dir_key
from beyin_v3_projections import EXCLUDED_DIRS_ROW, _hidden_ref_sources, latest_receipts, recent_receipts


class ReceiptCaseAliasTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE records(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE markdown_sources(id TEXT PRIMARY KEY, source TEXT NOT NULL);
            CREATE TABLE receipts(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
        ''')

    def record(self, source, **metadata):
        self.db.execute('INSERT INTO records VALUES (?,?)', (source, json.dumps({'source': source, **metadata})))
        self.db.execute('INSERT INTO markdown_sources VALUES (?,?)', (source, source))

    def reset(self):
        self.db.execute('DELETE FROM records')
        self.db.execute('DELETE FROM markdown_sources')

    def test_upper_case_alias_of_private_note_is_hidden(self):
        self.record('knowledge/ozel.md', visibility='private')
        self.assertEqual(_hidden_ref_sources(self.db, ['KNOWLEDGE/OZEL.MD', 'knowledge/ozel.md']),
                         {'KNOWLEDGE/OZEL.MD', 'knowledge/ozel.md'})

    def test_private_and_untrusted_aliases_use_unicode_fold(self):
        source = 'knowledge/Özel-öğüşç-İ-ı-ß.md'
        alias = 'KNOWLEDGE/öZEL-ÖĞÜŞÇ-i̇-ı-SS.MD'
        for metadata in ({'visibility': 'private'}, {'trust': 'untrusted'}, {'trusted': False},
                         {'status': 'untrusted'}, {'kind': 'untrusted'}):
            with self.subTest(metadata=metadata):
                self.reset()
                self.record(source, **metadata)
                self.assertEqual(_hidden_ref_sources(self.db, [source, alias]), {source, alias})

    def test_nfd_and_turkish_letter_pairs_are_hidden(self):
        pairs = (
            ('nfc-nfd', 'knowledge/Özel.md', unicodedata.normalize('NFD', 'knowledge/Özel.md')),
            ('nfd-nfc', unicodedata.normalize('NFD', 'knowledge/Özel.md'), 'knowledge/Özel.md'),
            ('İ-i', 'knowledge/İstanbul.md', 'knowledge/istanbul.md'),
            ('I-ı', 'knowledge/Işık.md', 'knowledge/ışık.md'),
            ('ı-i', 'knowledge/ısı.md', 'knowledge/isi.md'),
        )
        for name, source, alias in pairs:
            with self.subTest(name=name):
                self.reset()
                self.record(source, visibility='private')
                self.assertEqual(_hidden_ref_sources(self.db, [alias]), {alias})

    def test_alias_lookup_works_while_a_caller_iterates_the_same_connection(self):
        # latest_receipts keeps a cursor open on the same connection while it asks the gate.
        self.record('knowledge/ozel.md', visibility='private')
        self.db.execute('INSERT INTO receipts VALUES (?,?)', ('r', json.dumps({'refs': ['KNOWLEDGE/OZEL.MD']})))
        for ident in 'stuv':  # the cursor reads one row ahead: later calls run with it still open
            self.db.execute('INSERT INTO receipts VALUES (?,?)', (ident, json.dumps({'refs': ['knowledge/yok.md']})))
        hidden = [_hidden_ref_sources(self.db, json.loads(payload)['refs'])
                  for (payload,) in self.db.execute('SELECT payload FROM receipts ORDER BY id')]
        self.assertEqual(hidden, [{'KNOWLEDGE/OZEL.MD'}] + [set()] * 4)

    def test_internal_and_public_aliases_stay_visible(self):
        for name, metadata in (('default', {}), ('internal', {'visibility': 'internal'}),
                               ('public', {'visibility': 'public'})):
            source = 'knowledge/' + name + '.md'
            self.record(source, **metadata)
            with self.subTest(name=name):
                self.assertEqual(_hidden_ref_sources(self.db, [source, source.upper()]), set())
        self.assertEqual(_hidden_ref_sources(self.db, ['knowledge/missing.md']), set())

    def test_every_file_type_under_an_excluded_directory_stays_hidden_in_any_spelling(self):
        # Cortex withholds every path under an excluded directory, not only Markdown: a script
        # or data file there may describe the same private material.
        self.db.execute('INSERT INTO metadata VALUES (?,?)',
                        (EXCLUDED_DIRS_ROW, json.dumps([dir_key('Arçlar-İ-I')])))
        alias = unicodedata.normalize('NFD', 'ARÇLAR-i-ı')
        refs = [alias + '/NOT.MD', alias + '/ARAC.PY', alias + '/veri.json']
        self.assertEqual(_hidden_ref_sources(self.db, refs), set(refs))

    def test_existing_receipt_alias_is_hidden_without_sync_or_rewrite(self):
        with tempfile.TemporaryDirectory(prefix='v3-receipt-case-reader-') as temp:
            vault = Path(temp)
            (vault / 'receipts').mkdir()
            (vault / 'knowledge').mkdir()
            (vault / 'knowledge/ozel.md').write_text('Synthetic private note.\n', encoding='utf-8')
            self.record('knowledge/ozel.md', visibility='private')
            event = {'event_id': 'old-case-alias', 'summary': 'Synthetic private receipt.',
                     'created_at': '2026-10-25T12:00:00Z', 'refs': ['KNOWLEDGE/OZEL.MD']}
            payload = json.dumps(event)
            self.db.execute('INSERT INTO receipts VALUES (?,?)', (event['event_id'], payload))
            source = 'receipts/' + hashlib.sha256(event['event_id'].encode()).hexdigest() + '.md'
            (vault / source).write_text(event['summary'], encoding='utf-8')
            with self.subTest(reader='latest_receipts'):
                self.assertEqual(list(latest_receipts(self.db, vault)), [])
            with self.subTest(reader='recent_receipts'):
                item, = recent_receipts(self.db, vault=vault, today=date(2026, 10, 25))['items']
                self.assertEqual(item['refs'], [])
                self.assertEqual(item['refs_withheld'], {'private': 1, 'missing': 0})
            self.assertEqual(self.db.execute('SELECT payload FROM receipts').fetchone()[0], payload)

    def test_large_ref_batch_only_withholds_private_aliases(self):
        refs, hidden = [], set()
        for number in range(505):
            source = 'knowledge/note-%d.md' % number
            private = number % 2 == 0
            self.record(source, visibility='private' if private else 'internal')
            refs.append(source.upper())
            if private:
                hidden.add(source.upper())
        self.assertEqual(_hidden_ref_sources(self.db, refs), hidden)


if __name__ == '__main__':
    unittest.main()

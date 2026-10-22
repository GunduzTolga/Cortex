"""Tests-first offline semver package update and recovery contract."""
import hashlib
import importlib.util
import json
import os
import stat
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
from concurrent.futures import ThreadPoolExecutor

from v3_package_helpers import ROOT, build_package, clean_environ, install, isolated_env, rewrite_zip, snapshot, run_python

MODULE = ROOT / 'template/.claude/scripts/beyin_v3_update.py'


def load_updater():
    if not MODULE.is_file():
        raise AssertionError('Versioned updater not implemented')
    spec = importlib.util.spec_from_file_location('beyin_v3_update_test_subject', MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class OfflineUpdateTest(unittest.TestCase):
    def setUp(self):
        self.module = load_updater()
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-update-test-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.vault = self.base / 'Synthetic Vault Ölçüm'
        self.vault.mkdir()
        self.state = self.base / 'runtime'
        self.env = isolated_env(self.base / 'home')
        result = install(self.vault, self.state, self.env)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(self.version(), '0.0.0')
        self.note = self.vault / 'user-note.md';self.note.write_text('Synthetic original user note.\n')
        self.package = build_package(self.base / 'release.zip', '3.0.1', self.env)
        def changed_runtime(files):
            name = 'template/.claude/scripts/beyin_v3.py'
            files[name] += b'\n# Synthetic offline release change.\n'
            metadata = json.loads(files['manifest.json'])
            metadata['files'][name] = hashlib.sha256(files[name]).hexdigest()
            files['manifest.json'] = json.dumps(metadata).encode()
        rewrite_zip(self.package, self.package, changed_runtime)

    def version(self):
        return (self.vault / '.beyin-version').read_text(encoding='utf-8').strip()

    def test_retry_interrupted_rollback_finishes_original_rollback(self):
        core = self.vault / '.claude/scripts/beyin_v3.py'
        original = core.read_bytes()
        self.module.update(self.vault, self.state, self.package)
        user_note = self.vault / 'after-update.md'
        user_note.write_text('Synthetic note survives rollback retry.')
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                raise OSError('Synthetic rollback interruption')
        with patch.object(self.module, 'transaction_hook', crash):
            with self.assertRaises(OSError):
                self.module.rollback(self.vault, self.state)
        self.assertEqual(json.loads((self.state / 'update-journal.json').read_text())['direction'], 'rollback')
        result = self.module.rollback(self.vault, self.state)
        self.assertEqual(result['status'], 'rolled_back')
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(core.read_bytes(), original)
        self.assertEqual(user_note.read_text(), 'Synthetic note survives rollback retry.')
        self.assertFalse((self.state / 'update-journal.json').exists())
        self.assertFalse((self.state / 'last-update.json').exists())

    def test_check_is_read_only_with_available_version(self):
        before_vault, before_state = snapshot(self.vault), snapshot(self.state)
        report = self.module.update(self.vault, self.state, self.package, check=True)
        self.assertEqual(report['status'], 'available')
        self.assertEqual(snapshot(self.vault), before_vault)
        self.assertEqual(snapshot(self.state), before_state)
        self.assertEqual(self.version(), '0.0.0')

    def test_update_idempotent_and_rollback_preserves_new_user_note(self):
        core = self.vault / '.claude/scripts/beyin_v3.py'
        original = core.read_bytes()
        report = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(report['status'], 'updated')
        self.assertEqual(self.version(), '3.0.1')
        self.assertNotEqual(core.read_bytes(), original)
        before = snapshot(self.vault)
        self.assertEqual(self.module.update(self.vault, self.state, self.package)['status'], 'noop')
        self.assertEqual(snapshot(self.vault), before)
        self.note.write_text('User edit after system update.\n')
        rolled = self.module.rollback(self.vault, self.state)
        self.assertEqual(rolled['status'], 'rolled_back')
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(core.read_bytes(), original)
        self.assertEqual(self.note.read_text(), 'User edit after system update.\n')

    def orphaned_flush(self, name, age=7200):
        """The record a stock V2 flush leaves when it dies mid-summary, beside its free lock."""
        legacy = self.vault / '.claude/scripts/.state'
        legacy.mkdir(parents=True, exist_ok=True)
        sentinel = legacy / (name + '.json')
        sentinel.write_bytes(json.dumps({'session_id': name, 'ts': int(time.time()) - age, 'status': 'inflight'}).encode('utf-8'))
        (legacy / (name + '.lock')).write_bytes(b'')
        return sentinel

    def test_update_reports_a_flush_sentinel_orphaned_after_the_cutover(self):
        # A kept V2 flush that dies mid-summary leaves "inflight" behind. update takes no flags,
        # so a guard that ignored the proof of its own lock stopped every later update here.
        sentinel = self.orphaned_flush('flush-example')
        left = sentinel.read_bytes()
        report = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(report['status'], 'updated')
        self.assertEqual(report['orphaned_legacy_state'], ['.claude/scripts/.state/flush-example.json'])
        self.assertEqual(self.version(), '3.0.1')
        self.assertEqual(sentinel.read_bytes(), left)

    def test_update_waits_for_a_recent_flush_sentinel(self):
        sentinel = self.orphaned_flush('flush-example', age=30)
        left = sentinel.read_bytes()
        before = snapshot(self.vault)
        with self.assertRaisesRegex(RuntimeError, r'flush-example\.json; its lock is free here.*60 minutes old'):
            self.module.update(self.vault, self.state, self.package)
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(sentinel.read_bytes(), left)
        self.assertEqual(snapshot(self.vault), before)
        self.assertFalse((self.state / 'update-journal.json').exists())

    def test_update_does_not_repeat_sentinels_the_cutover_receipt_lists(self):
        # After a cutover that retired flush nothing ever rewrites its dead sentinels: a note
        # about them on every later update would never stop. Only a later one is news.
        self.vault = self.base / 'Synthetic Vault Devir'
        self.vault.mkdir()
        self.state = self.base / 'runtime-devir'
        self.orphaned_flush('flush-before')
        installed = install(self.vault, self.state, self.env)
        self.assertEqual(installed.returncode, 0, installed.stderr.decode('utf-8', errors='replace'))
        recorded = ['.claude/scripts/.state/flush-before.json']
        self.assertEqual(json.loads(installed.stdout)['orphaned_legacy_state'], recorded)
        receipt = (self.state / 'v2-migration.json').read_bytes()
        self.assertEqual(json.loads(receipt)['orphaned_legacy_state'], recorded)
        self.orphaned_flush('flush-later')
        report = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(report['status'], 'updated')
        self.assertEqual(report['orphaned_legacy_state'], ['.claude/scripts/.state/flush-later.json'])
        self.assertEqual((self.state / 'v2-migration.json').read_bytes(), receipt)
        self.assertEqual(self.module.rollback(self.vault, self.state)['status'], 'rolled_back')
        (self.vault / '.claude/scripts/.state/flush-later.json').unlink()
        again = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(again['status'], 'updated')
        self.assertNotIn('orphaned_legacy_state', again)

    def lock_directory(self, key, days):
        """What a V2 prompt-counter hook killed between its mkdir and its rmdir leaves behind."""
        path = self.vault / '.claude/scripts/.state' / ('prompt_count.' + key * 64 + '.lock')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir()
        stamp = time.time() - days * 86400
        os.utime(path, (stamp, stamp))
        return path

    def test_update_reports_a_stale_lock_directory_the_receipt_does_not_list(self):
        self.vault = self.base / 'Synthetic Vault Kilit'
        self.vault.mkdir()
        self.state = self.base / 'runtime-kilit'
        before = self.lock_directory('a', days=9)
        installed = install(self.vault, self.state, self.env)
        self.assertEqual(installed.returncode, 0, installed.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(json.loads(installed.stdout)['stale_legacy_locks'], [before.relative_to(self.vault).as_posix()])
        later = self.lock_directory('b', days=9)
        report = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(report['status'], 'updated')
        self.assertEqual(report['stale_legacy_locks'], [later.relative_to(self.vault).as_posix()])
        self.assertTrue(before.is_dir() and later.is_dir())

    def test_update_stops_on_a_young_lock_directory_with_a_clear_error(self):
        lock = self.lock_directory('a', days=0)
        before = snapshot(self.vault)
        with self.assertRaisesRegex(RuntimeError, r'legacy writer lock directory in \.claude/scripts/\.state/prompt_count\.a{64}\.lock'
                                                  r' is less than 8 days old.*remove that empty directory and rerun'):
            self.module.update(self.vault, self.state, self.package)
        self.assertEqual(self.version(), '0.0.0')
        self.assertTrue(lock.is_dir())
        self.assertEqual(snapshot(self.vault), before)
        self.assertFalse((self.state / 'update-journal.json').exists())

    def test_recover_meets_the_same_lock_directory_rule(self):
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                raise OSError('Synthetic interruption after first managed replacement')
        with patch.object(self.module, 'transaction_hook', side_effect=crash):
            with self.assertRaises(OSError):
                self.module.update(self.vault, self.state, self.package)
        lock = self.lock_directory('a', days=0)
        with self.assertRaisesRegex(RuntimeError, r'legacy writer lock directory in .*is less than 8 days old'):
            self.module.recover(self.vault, self.state)
        self.assertEqual(self.version(), '0.0.0')
        self.assertTrue((self.state / 'update-journal.json').exists())
        lock.rmdir()
        self.assertEqual(self.module.recover(self.vault, self.state)['status'], 'recovered')
        self.assertEqual(self.version(), '3.0.1')

    def test_update_message_counts_orphaned_flush_sentinels(self):
        spec = importlib.util.spec_from_file_location('update_test_entry_cli', ROOT / 'scripts/beyin_entry.py')
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        report = {'status': 'updated', 'from_version': '3.0.0', 'version': '3.0.1'}
        self.assertNotIn('flush', entry.human_result(report, 'update'))
        message = entry.human_result(dict(report, orphaned_legacy_state=['a.json', 'b.json']), 'update')
        self.assertIn('Yarida kesilmis 2 eski surumden kalma flush kaydi var (durumu inflight', message)
        self.assertIn('daily/ altina yazilmamis olabilir', message)
        self.assertTrue(message.isascii())
        self.assertNotIn('kilit klasoru', message)
        message = entry.human_result(dict(report, stale_legacy_locks=['a.lock']), 'update')
        self.assertIn('Sahipsiz kalmis 1 eski surumden kalma kilit klasoru var (prompt_count.*.lock, sekiz gunden eski)', message)
        self.assertNotIn('flush', message)
        self.assertTrue(message.isascii())

    def test_update_lock_does_not_create_empty_sqlite_file(self):
        import sqlite3
        memory_db = self.state / 'memory.sqlite3'
        self.assertFalse(memory_db.exists())
        with self.module.locked(self.vault, self.state):
            pass
        self.assertFalse(memory_db.exists())

    def test_update_lock_holds_runtime_writer_lock_for_uri_special_state_paths(self):
        import sqlite3
        import os
        # '?' cannot appear in a Windows path; '#' and '%' still exercise the URI escaping there.
        names = ('state #1', '100%25 state') + (() if os.name == 'nt' else ('q?x state',))
        for name in names:
            state = self.base / name
            state.mkdir()
            database = state / 'memory.sqlite3'
            sqlite3.connect(database).close()
            with self.module.locked(self.vault, state):
                other = sqlite3.connect(database, timeout=0.1)
                try:
                    with self.assertRaises(sqlite3.OperationalError, msg=name):
                        other.execute('BEGIN IMMEDIATE')
                finally:
                    other.close()

    def test_rollback_preserves_original_file_mtime(self):
        import os
        core = self.vault / '.claude/scripts/beyin_v3.py'
        old_time = 1500000000.0
        os.utime(core, (old_time, old_time))
        self.module.update(self.vault, self.state, self.package)
        self.assertEqual(self.version(), '3.0.1')
        self.module.rollback(self.vault, self.state)
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(core.stat().st_mtime, old_time)

    def test_rollback_keeps_new_mtime_of_merged_settings(self):
        import os, time
        config = self.vault / '.claude/settings.local.json'
        old_time = 1500000000.0
        os.utime(config, (old_time, old_time))
        self.module.update(self.vault, self.state, self.package)
        after = json.loads(config.read_text(encoding='utf-8'))
        after['post_update_user_preference'] = 'kept'
        config.write_text(json.dumps(after), encoding='utf-8')
        before_rollback = time.time() - 5
        self.module.rollback(self.vault, self.state)
        # The merged file holds an edit made after the update; an old mtime would hide it.
        self.assertEqual(json.loads(config.read_text(encoding='utf-8'))['post_update_user_preference'], 'kept')
        self.assertGreater(config.stat().st_mtime, before_rollback)

    def test_interrupted_apply_keeps_old_version_and_recovers_once(self):
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                raise OSError('Synthetic interruption after first managed replacement')
        with patch.object(self.module, 'transaction_hook', side_effect=crash):
            with self.assertRaises(OSError):
                self.module.update(self.vault, self.state, self.package)
        self.assertEqual(self.version(), '0.0.0', 'Version stamp must be the last successful step')
        self.assertEqual(self.note.read_text(), 'Synthetic original user note.\n')
        recovered = self.module.recover(self.vault, self.state)
        self.assertEqual(recovered['status'], 'recovered')
        self.assertEqual(self.version(), '3.0.1')
        before = snapshot(self.vault)
        self.module.recover(self.vault, self.state)
        self.assertEqual(snapshot(self.vault), before)

    def test_recover_completes_after_a_user_note_changes_following_the_interruption(self):
        # The cutover receipt from the first install is already on disk, so recovery has no
        # migration left to prove; an edited note must not make it impossible.
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                raise OSError('Synthetic interruption after first managed replacement')
        with patch.object(self.module, 'transaction_hook', side_effect=crash):
            with self.assertRaises(OSError):
                self.module.update(self.vault, self.state, self.package)
        self.assertTrue((self.state / 'update-journal.json').exists())
        self.note.write_text('User edit after the interruption.\n')
        recovered = self.module.recover(self.vault, self.state)
        self.assertEqual(recovered['status'], 'recovered')
        self.assertEqual(self.version(), '3.0.1')
        self.assertEqual(self.note.read_text(), 'User edit after the interruption.\n')
        self.assertFalse((self.state / 'update-journal.json').exists())


    def test_builder_manifest_contains_matching_allowlisted_file_hashes(self):
        with zipfile.ZipFile(self.package) as archive:
            names = archive.namelist()
            self.assertEqual(len(names), len(set(names)))
            metadata = json.loads(archive.read('manifest.json'))
            self.assertEqual(metadata['schema'], 1)
            self.assertEqual(metadata['version'], '3.0.1')
            self.assertEqual(metadata['min_python'], '3.11')
            self.assertEqual(metadata['migrations'], [])
            self.assertEqual(set(names), {'manifest.json'} | set(metadata['files']))
            for name, expected in metadata['files'].items():
                self.assertFalse(Path(name).is_absolute())
                self.assertNotIn('..', Path(name).parts)
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected)
            self.assertIn('scripts/install_v3.py', metadata['files'])
            self.assertIn('scripts/beyin_entry.py', metadata['files'])

    def test_corrupt_checksum_rejected_without_any_vault_write(self):
        def corrupt(files):
            files['template/.claude/scripts/beyin_v3.py'] += b'\n# corrupt undeclared content\n'
        bad = rewrite_zip(self.package, self.base / 'corrupt.zip', corrupt)
        before = snapshot(self.vault)
        with self.assertRaises(ValueError):
            self.module.update(self.vault, self.state, bad)
        self.assertEqual(snapshot(self.vault), before)

        def corrupt_missing(files):
            metadata = json.loads(files['manifest.json'])
            metadata['files']['scripts/beyin_entry.py'] = None
            files['manifest.json'] = json.dumps(metadata).encode()
        bad2 = rewrite_zip(self.package, self.base / 'corrupt2.zip', corrupt_missing)
        with self.assertRaisesRegex(ValueError, 'package checksum mismatch'):
            self.module.update(self.vault, self.state, bad2)
        self.assertEqual(snapshot(self.vault), before)
        self.assertEqual(self.version(), '0.0.0')

    def test_path_traversal_and_nonallowlisted_paths_rejected(self):
        for name in ('../escaped.txt', '/absolute.txt', 'notes/user-note.md'):
            def extra(files, name=name):
                files[name] = b'Synthetic forbidden payload'
                metadata = json.loads(files['manifest.json'])
                metadata['files'][name] = hashlib.sha256(files[name]).hexdigest()
                files['manifest.json'] = json.dumps(metadata).encode()
            bad = rewrite_zip(self.package, self.base / ('bad-' + str(abs(hash(name))) + '.zip'), extra)
            before = snapshot(self.vault)
            with self.subTest(entry=name):
                with self.assertRaises(ValueError):
                    self.module.update(self.vault, self.state, bad)
                self.assertEqual(snapshot(self.vault), before)
        self.assertFalse((self.base / 'escaped.txt').exists())

    def test_edited_managed_runtime_conflicts_without_overwrite_or_version_stamp(self):
        core = self.vault / '.claude/scripts/beyin_v3.py'
        modified = core.read_bytes() + b'\n# User managed-runtime customization\n'
        core.write_bytes(modified)
        with self.assertRaises(ValueError):
            self.module.update(self.vault, self.state, self.package)
        self.assertEqual(core.read_bytes(), modified)
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(self.note.read_text(), 'Synthetic original user note.\n')

    def test_unrelated_config_addition_survives_update_and_rollback(self):
        config = self.vault / '.claude/settings.local.json'
        value = json.loads(config.read_text(encoding='utf-8'))
        value['custom_product_preference'] = 'Synthetic ölçüm preference'
        config.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        self.module.update(self.vault, self.state, self.package)
        self.assertEqual(json.loads(config.read_text(encoding='utf-8'))['custom_product_preference'], value['custom_product_preference'])
        after = json.loads(config.read_text(encoding='utf-8'))
        after['post_update_user_preference'] = 'Do not roll back user preferences'
        config.write_text(json.dumps(after, ensure_ascii=False), encoding='utf-8')
        self.module.rollback(self.vault, self.state)
        restored = json.loads(config.read_text(encoding='utf-8'))
        self.assertEqual(restored['custom_product_preference'], value['custom_product_preference'])
        self.assertEqual(restored['post_update_user_preference'], after['post_update_user_preference'])

    def test_semver_uses_numeric_order_and_rejects_downgrade(self):
        newer = build_package(self.base / 'newer.zip', '3.0.10', self.env)
        self.assertEqual(self.module.update(self.vault, self.state, newer)['status'], 'updated')
        older = build_package(self.base / 'older.zip', '3.0.2', self.env)
        with self.assertRaises(ValueError):
            self.module.update(self.vault, self.state, older)
        self.assertEqual(self.version(), '3.0.10')

    def test_parallel_updates_are_serialized_and_idempotent(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            reports = list(pool.map(lambda _: self.module.update(self.vault, self.state, self.package), range(2)))
        self.assertEqual(sorted(r['status'] for r in reports), ['noop', 'updated'])
        self.assertEqual(self.version(), '3.0.1')
        self.assertEqual(self.note.read_text(), 'Synthetic original user note.\n')

    def test_recovery_preserves_user_edit_to_partially_replaced_managed_file(self):
        replaced = []
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                replaced.append(True)
                raise OSError('Synthetic interruption')
        with patch.object(self.module, 'transaction_hook', side_effect=crash):
            with self.assertRaises(OSError):
                self.module.update(self.vault, self.state, self.package)
        self.assertTrue(replaced)
        core = self.vault / '.claude/scripts/beyin_v3.py'
        core.write_bytes(core.read_bytes() + b'\n# User edit during recovery window\n')
        modified = core.read_bytes()
        with self.assertRaises(ValueError):
            self.module.recover(self.vault, self.state)
        self.assertEqual(core.read_bytes(), modified)
        self.assertEqual(self.version(), '0.0.0')


    def test_installed_entrypoint_check_apply_and_rollback(self):
        entry = self.vault / 'beyin.py'
        self.assertTrue(entry.is_file())
        for arguments, status in [(['update', '--check', '--package', str(self.package)], 'available'),
                                  (['update', '--package', str(self.package)], 'updated'),
                                  (['rollback'], 'rolled_back')]:
            result = run_python(entry, arguments, self.vault, self.env)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
            self.assertEqual(json.loads(result.stdout)['status'], status)
        self.assertEqual(self.version(), '0.0.0')


    def test_truncated_download_artifact_cannot_apply_or_stamp_version(self):
        truncated = self.base / 'truncated.zip'
        raw = self.package.read_bytes()
        truncated.write_bytes(raw[:len(raw) // 2])
        before = snapshot(self.vault)
        with self.assertRaises((ValueError, zipfile.BadZipFile)):
            self.module.update(self.vault, self.state, truncated)
        self.assertEqual(snapshot(self.vault), before)
        self.assertEqual(self.version(), '0.0.0')


    def test_checksum_valid_broken_runtime_fails_preflight_before_target_writes(self):
        for label, code in [('syntax', b'def broken(:\n    pass\n'),
                            ('import-crash', b'raise RuntimeError("SYNTHETIC_PACKAGE_PREFLIGHT_FAILURE")\n')]:
            def broken(files, code=code):
                name = 'template/.claude/scripts/beyin_v3.py'
                files[name] = code
                metadata = json.loads(files['manifest.json'])
                metadata['files'][name] = hashlib.sha256(code).hexdigest()
                files['manifest.json'] = json.dumps(metadata).encode()
            package = rewrite_zip(self.package, self.base / (label + '.zip'), broken)
            before = snapshot(self.vault)
            with self.subTest(failure=label):
                with self.assertRaises((ValueError, SyntaxError, RuntimeError)):
                    self.module.update(self.vault, self.state, package)
                self.assertEqual(snapshot(self.vault), before)
                self.assertEqual(self.version(), '0.0.0')


    @unittest.skipIf(os.name == 'nt', 'POSIX permission bits; native Windows mode semantics differ')
    def test_recovery_repairs_mode_after_replace_before_chmod_failure(self):
        original_chmod = Path.chmod
        failed_target = []
        def fail_first_target_mode(path, mode, *args, **kwargs):
            if path.resolve().is_relative_to(self.vault.resolve()) and not failed_target:
                failed_target.append((path, mode))
                raise OSError('Synthetic failure after replacement before chmod')
            return original_chmod(path, mode, *args, **kwargs)
        with patch.object(Path, 'chmod', fail_first_target_mode):
            with self.assertRaises(OSError):
                self.module.update(self.vault, self.state, self.package)
        self.assertEqual(len(failed_target), 1)
        path, intended_mode = failed_target[0]
        self.assertEqual(self.version(), '0.0.0')
        self.assertEqual(self.module.recover(self.vault, self.state)['status'], 'recovered')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), intended_mode)
        self.assertEqual(self.version(), '3.0.1')


    def test_rollback_restores_bundled_skill_copies_after_mirror_state_advances(self):
        canonical = self.vault / '.agents/skills/beyin/SKILL.md'
        mirror = self.vault / '.claude/skills/beyin/SKILL.md'
        self.assertFalse(mirror.is_symlink(), 'Exercise Windows-style physical copy reconciliation')
        original = canonical.read_bytes()
        spec = importlib.util.spec_from_file_location('product_copy_skills', ROOT / 'template/.claude/scripts/beyin_v3_skills.py')
        skills = importlib.util.module_from_spec(spec);spec.loader.exec_module(skills)
        self.assertEqual(skills.sync_skills(self.vault, self.state, mode='copy')['conflicts'], [])
        def changed_skill(files):
            name = 'template/.agents/skills/beyin/SKILL.md'
            files[name] += b'\nSynthetic new release skill marker.\n'
            metadata = json.loads(files['manifest.json'])
            metadata['files'][name] = hashlib.sha256(files[name]).hexdigest()
            files['manifest.json'] = json.dumps(metadata).encode()
        package = rewrite_zip(self.package, self.base / 'changed-skill.zip', changed_skill)
        self.module.update(self.vault, self.state, package)
        self.assertNotEqual(canonical.read_bytes(), original)
        self.assertEqual(mirror.read_bytes(), canonical.read_bytes())
        self.assertEqual(skills.sync_skills(self.vault, self.state, mode='copy')['conflicts'], [])
        self.module.rollback(self.vault, self.state)
        self.assertEqual(skills.sync_skills(self.vault, self.state, mode='copy')['conflicts'], [])
        self.assertEqual(canonical.read_bytes(), original)
        self.assertEqual(mirror.read_bytes(), original)

    def test_update_refreshes_release_cache_and_avoids_stale_ahead_status(self):
        # status() honours BEYIN_UPDATES_OFF; a suite run from a configured shell must not inherit it.
        with clean_environ():
            self._update_refreshes_release_cache()

    def _update_refreshes_release_cache(self):
        spec = importlib.util.spec_from_file_location('beyin_v3_releases', ROOT / 'template/.claude/scripts/beyin_v3_releases.py')
        releases = importlib.util.module_from_spec(spec); spec.loader.exec_module(releases)
        cache_file = self.state / 'release-cache.json'
        old_cache = {
            'schema': 1,
            'checked_at': 1000,
            'attempted_at': 1000,
            'next_check_at': 1000 + 86400,
            'etag': '"old-etag"',
            'release': {
                'release_id': 1,
                'version': '3.0.0',
                'published_at': '2026-09-01T00:00:00Z',
                'release_url': 'https://github.com/GunduzTolga/Cortex/releases/tag/v3.0.0',
                'asset_id': 1,
                'asset_name': 'beyin-v3-3.0.0.zip',
                'asset_url': 'https://github.com/GunduzTolga/Cortex/releases/download/v3.0.0/beyin-v3-3.0.0.zip',
                'asset_size': 1000,
                'asset_sha256': '00' * 32,
                'checksum_url': None,
            },
            'failures': 0,
        }
        releases.atomic_json(cache_file, old_cache)
        self.module.update(self.vault, self.state, self.package)
        self.assertFalse(cache_file.exists())
        self.assertEqual(releases.status(self.vault, self.state)['status'], 'unknown')
        releases.atomic_json(cache_file, old_cache)
        self.module.rollback(self.vault, self.state)
        self.assertFalse(cache_file.exists())
        fake_meta = {
            'release_id': 2,
            'version': '3.0.1',
            'published_at': '2026-09-10T00:00:00Z',
            'release_url': 'https://github.com/GunduzTolga/Cortex/releases/tag/v3.0.1',
            'asset_id': 2,
            'asset_name': 'beyin-v3-3.0.1.zip',
            'asset_url': 'https://github.com/GunduzTolga/Cortex/releases/download/v3.0.1/beyin-v3-3.0.1.zip',
            'asset_size': 1000,
            'asset_sha256': '11' * 32,
            'checksum_url': None,
        }
        # The release is read first (an engine ahead of it downloads nothing), then its package.
        with patch.object(self.module, '_release', return_value=(fake_meta, '"etag-301"')), \
                patch.object(self.module, '_download', return_value=(self.package, '3.0.1')):
            self.module.update(self.vault, self.state)
        self.assertTrue(cache_file.exists())
        st = releases.status(self.vault, self.state)
        self.assertEqual(st['status'], 'up_to_date')
        self.assertEqual(st['version'], '3.0.1')
        self.assertEqual(st['current_version'], '3.0.1')

    def test_cache_left_by_an_older_updater_is_not_reported_as_ahead(self):
        # 3.6.0 and 3.7.0 run their own updater, which never touches the cache (#188). The
        # first fixed release must still read the cache it inherits correctly: installed doctor.
        self.module.update(self.vault, self.state, self.package)
        stamped = (self.vault / '.beyin-version').stat().st_mtime
        release = {'release_id': 1, 'version': '3.0.0', 'published_at': '2026-09-01T00:00:00Z',
                   'release_url': 'https://github.com/GunduzTolga/Cortex/releases/tag/v3.0.0',
                   'asset_id': 1, 'asset_name': 'beyin-v3-3.0.0.zip',
                   'asset_url': 'https://github.com/GunduzTolga/Cortex/releases/download/v3.0.0/beyin-v3-3.0.0.zip',
                   'asset_size': 1000, 'asset_sha256': '00' * 32, 'checksum_url': None}
        cache = self.state / 'release-cache.json'
        def doctor():
            result = run_python(self.vault / 'beyin.py', ['doctor', '--json'], self.vault, self.env)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
            return json.loads(result.stdout)['updates']
        checked = stamped - 60
        cache.write_text(json.dumps({'schema': 1, 'checked_at': checked, 'attempted_at': checked,
                                     'next_check_at': checked + 86400, 'etag': '"old"', 'release': release, 'failures': 0}))
        self.assertEqual(doctor(), {'status': 'unknown'})
        # A check made after the install that still finds 3.0.0 is a genuine dev install ahead.
        checked = time.time()
        self.assertGreater(checked, stamped)
        cache.write_text(json.dumps({'schema': 1, 'checked_at': checked, 'attempted_at': checked,
                                     'next_check_at': checked + 86400, 'etag': '"old"', 'release': release, 'failures': 0}))
        self.assertEqual(doctor()['status'], 'ahead')

    def test_windows_permission_error_restores_write_mode_during_apply(self):
        file_path = self.vault / 'readonly_file.txt'
        file_path.write_text('new content', encoding='utf-8')
        os.chmod(file_path, stat.S_IREAD)
        journal = {
            'schema': 1,
            'vault': str(self.vault),
            'direction': 'rollback',
            'operations': [
                {
                    'scope': 'vault',
                    'name': 'readonly_file.txt',
                    'old': self.module.encode(b'new content'),
                    'new': self.module.encode(b'restored content')
                }
            ]
        }
        # POSIX replaces a read-only file; Windows refuses (WinError 5). Emulate that refusal so
        # the test fails without the fix on every platform, not only on the Windows runner.
        original_replace = os.replace
        def windows_replace(source, destination):
            if os.path.exists(destination) and not os.access(destination, os.W_OK):
                raise PermissionError(13, 'Access is denied', str(destination))
            return original_replace(source, destination)
        with patch.object(self.module.os, 'replace', side_effect=windows_replace):
            self.module._apply(self.vault, self.state, journal)
        self.assertEqual(file_path.read_text(encoding='utf-8'), 'restored content')
        self.assertFalse(os.access(file_path, os.W_OK), 'the read-only flag is the user\'s lock')

    def test_update_and_rollback_keep_a_read_only_managed_file_locked(self):
        version = self.vault / '.beyin-version'
        os.chmod(version, stat.S_IREAD)
        original_replace = os.replace
        def windows_replace(source, destination):
            if os.path.exists(destination) and not os.access(destination, os.W_OK):
                raise PermissionError(13, 'Access is denied', str(destination))
            return original_replace(source, destination)
        with patch.object(self.module.os, 'replace', side_effect=windows_replace):
            self.assertEqual(self.module.update(self.vault, self.state, self.package)['status'], 'updated')
            self.assertEqual(self.version(), '3.0.1')
            self.assertFalse(os.access(version, os.W_OK))
            self.module.rollback(self.vault, self.state)
        self.assertEqual(self.version(), '0.0.0')
        self.assertFalse(os.access(version, os.W_OK))

    # --- install-update-5, -6, -7, -9, -1 and the C1 codes ---

    def crash_after_first_replacement(self, package=None, vault=None, state=None):
        def crash(phase, index=None):
            if phase == 'after_replace' and index == 0:
                raise OSError('Synthetic interruption after first managed replacement')
        with patch.object(self.module, 'transaction_hook', side_effect=crash):
            with self.assertRaises(OSError):
                self.module.update(vault or self.vault, state or self.state, package or self.package)
        self.assertTrue(((state or self.state) / 'update-journal.json').exists())

    def test_the_cli_is_written_before_the_entry_that_loads_it(self):
        installer = load_installer()
        names = list(installer.install(self.vault, self.state, plan_only=True)['planned'])
        entry = names.index('beyin.py')
        self.assertLess(names.index('.claude/scripts/beyin_v3_cli.py'), entry)
        for name in names:
            if name.startswith('.claude/scripts/beyin_v3'):
                self.assertLess(names.index(name), entry, name)

    def test_recover_runs_under_an_entry_newer_than_its_cli(self):
        # An update cut short between beyin.py and beyin_v3_cli.py left an entry calling a
        # resolve_state the older CLI did not have: every command failed, recover too.
        vault, state = self.base / 'Eski CLI Kasasi', self.base / 'eski-cli-state'
        vault.mkdir()
        def without_resolve_state(files):
            name = 'scripts/beyin_v3.py'
            files[name] = files[name].replace(b'def resolve_state(', b'def resolve_state_not_yet(')
            metadata = json.loads(files['manifest.json'])
            metadata['files'][name] = hashlib.sha256(files[name]).hexdigest()
            files['manifest.json'] = json.dumps(metadata).encode()
        older = rewrite_zip(build_package(self.base / 'cli-old.zip', '3.0.1', self.env), self.base / 'cli-old-patched.zip',
                            without_resolve_state)
        unpacked = self.base / 'cli-old'
        with zipfile.ZipFile(older) as archive:
            archive.extractall(unpacked)
        installed = run_python(unpacked / 'scripts/install_v3.py', ['--vault', vault, '--state', state], unpacked, self.env)
        self.assertEqual(installed.returncode, 0, installed.stderr.decode('utf-8', errors='replace'))
        doctor = run_python(vault / 'beyin.py', ['doctor'], vault, self.env)
        self.assertNotEqual(doctor.returncode, 0, 'the fixture CLI really lacks resolve_state')
        self.crash_after_first_replacement(build_package(self.base / 'cli-new.zip', '3.0.2', self.env), vault, state)
        recovered = run_python(vault / 'beyin.py', ['recover'], vault, self.env)
        self.assertEqual(recovered.returncode, 0, recovered.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(json.loads(recovered.stdout)['status'], 'recovered')
        self.assertEqual((vault / '.beyin-version').read_text(encoding='utf-8').strip(), '3.0.2')
        self.assertEqual(run_python(vault / 'beyin.py', ['doctor'], vault, self.env).returncode, 0)

    def test_recover_keeps_a_permission_granted_after_the_interruption(self):
        # "Her zaman izin ver" in a chat between the interruption and the retry wrote to
        # .claude/settings.local.json, and recover then failed forever on it (install-update-6).
        self.crash_after_first_replacement()
        config = self.vault / '.claude/settings.local.json'
        data = json.loads(config.read_text(encoding='utf-8'))
        data.setdefault('permissions', {}).setdefault('allow', []).append('Bash(git status:*)')
        config.write_text(json.dumps(data, indent=2), encoding='utf-8')
        agents = self.vault / 'AGENTS.md'
        agents.write_text(agents.read_text(encoding='utf-8') + '\nKesintiden sonra eklenen satır.\n', encoding='utf-8')
        self.assertEqual(self.module.recover(self.vault, self.state)['status'], 'recovered')
        self.assertEqual(self.version(), '3.0.1')
        merged = json.loads(config.read_text(encoding='utf-8'))
        self.assertIn('Bash(git status:*)', merged['permissions']['allow'])
        self.assertIn('beyin_v3_hook.py', json.dumps(merged['hooks']))
        self.assertIn('Kesintiden sonra eklenen satır.', agents.read_text(encoding='utf-8'))
        record = json.loads((self.state / 'v3-install.json').read_text(encoding='utf-8'))['files']
        for path in (config, agents):
            self.assertEqual(record[path.relative_to(self.vault).as_posix()]['installed_hash'],
                             hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(self.module.rollback(self.vault, self.state)['status'], 'rolled_back')
        self.assertIn('Bash(git status:*)', json.loads(config.read_text(encoding='utf-8'))['permissions']['allow'])
        self.assertIn('Kesintiden sonra eklenen satır.', agents.read_text(encoding='utf-8'))

    def interrupted_first_install(self, vault, state, during=None):
        """A first install whose write of beyin.py fails (a file held by a scanner, a power cut)."""
        installer = load_installer()
        real = os.replace
        def replace(source, destination, *args, **kwargs):
            if Path(destination).name == 'beyin.py':
                if during is None:
                    raise OSError('Synthetic interruption')
                during()
            return real(source, destination, *args, **kwargs)
        with patch('os.replace', side_effect=replace):
            try:
                return installer.install(vault, state)
            except OSError:
                return None

    def test_an_interrupted_first_install_completes_after_a_note_changes(self):
        vault, state = self.base / 'Yarim Kurulum', self.base / 'yarim-state'
        vault.mkdir()
        note = vault / 'eski-not.md'
        note.write_text('Kurulumdan önceki not.\n', encoding='utf-8')
        self.assertIsNone(self.interrupted_first_install(vault, state))
        self.assertTrue((state / 'update-journal.json').exists())
        self.assertFalse((vault / '.beyin-version').exists())
        note.write_text('Kesintiden sonra değişen not.\n', encoding='utf-8')
        result = load_installer().install(vault, state)
        self.assertEqual(result['status'], 'recovered')
        self.assertTrue(result['install_resumed'])
        self.assertTrue((vault / '.beyin-version').exists())
        receipt = json.loads((state / 'v2-migration.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['sources']['eski-not.md'], hashlib.sha256(note.read_bytes()).hexdigest())

    def test_a_note_edited_during_the_first_install_stops_it_once_and_the_retry_completes(self):
        vault, state = self.base / 'Yarisan Kurulum', self.base / 'yarisan-state'
        vault.mkdir()
        note = vault / 'eski-not.md'
        note.write_text('Kurulumdan önceki not.\n', encoding='utf-8')
        installer = load_installer()
        real = os.replace
        def replace(source, destination, *args, **kwargs):
            if Path(destination).name == 'beyin.py':
                note.write_text('OneDrive başka cihazdan güncelledi.\n', encoding='utf-8')
            return real(source, destination, *args, **kwargs)
        with patch('os.replace', side_effect=replace):
            with self.assertRaises(RuntimeError) as raised:
                installer.install(vault, state)
        self.assertEqual(raised.exception.code, 'migration_changed')
        self.assertFalse((vault / '.beyin-version').exists())
        result = load_installer().install(vault, state)
        self.assertEqual(result['status'], 'recovered')
        self.assertTrue((vault / '.beyin-version').exists())

    def test_rollback_keeps_text_and_settings_added_outside_the_managed_parts(self):
        self.assertEqual(self.module.update(self.vault, self.state, self.package)['status'], 'updated')
        added = {'AGENTS.md': '\nGüncellemeden sonra eklenen talimat.\n',
                 'CLAUDE.md': '\nClaude için kendi notum.\n',
                 '.codex/config.toml': '\n[profiles.benim]\nmodel = "gpt-5"\n'}
        for name, text in added.items():
            path = self.vault / name
            path.write_text(path.read_text(encoding='utf-8') + text, encoding='utf-8')
        gemini = self.vault / '.gemini/settings.json'
        settings = json.loads(gemini.read_text(encoding='utf-8'))
        settings['ui'] = {'theme': 'Atom One'}
        gemini.write_text(json.dumps(settings, indent=2), encoding='utf-8')
        self.assertEqual(self.module.rollback(self.vault, self.state)['status'], 'rolled_back')
        self.assertEqual(self.version(), '0.0.0')
        for name, text in added.items():
            self.assertIn(text.strip(), (self.vault / name).read_text(encoding='utf-8'), name)
        self.assertEqual(json.loads(gemini.read_text(encoding='utf-8'))['ui'], {'theme': 'Atom One'})

    def test_an_engine_ahead_of_the_latest_release_is_ahead_not_a_downgrade(self):
        newer = build_package(self.base / 'newer.zip', '3.0.5', self.env)
        self.assertEqual(self.module.update(self.vault, self.state, newer)['status'], 'updated')
        latest = {'version': '3.0.1'}
        with patch.object(self.module, '_release', return_value=(latest, None)), \
                patch.object(self.module, '_download') as download:
            self.assertEqual(self.module.update(self.vault, self.state),
                             {'status': 'ahead', 'current_version': '3.0.5', 'version': '3.0.1'})
            self.assertEqual(self.module.update(self.vault, self.state, check=True)['status'], 'ahead')
        download.assert_not_called()
        self.assertEqual(self.module.update(self.vault, self.state, self.package, check=True)['status'], 'ahead')
        # Only an explicit older package, applied, is refused, and it says how to go back.
        with self.assertRaisesRegex(ValueError, 'beyin.py rollback'):
            self.module.update(self.vault, self.state, self.package)
        self.assertEqual(self.version(), '3.0.5')
        entry = load_entry()
        self.assertIn('ileride', entry.human_result({'status': 'ahead', 'current_version': '3.0.5', 'version': '3.0.1'}, 'update'))

    def test_a_package_of_the_installed_version_with_other_code_refreshes_it(self):
        # Several 1.0.32 builds went to testers; the updater took each for "noop" (install-update-1).
        self.assertEqual(self.module.update(self.vault, self.state, self.package)['status'], 'updated')
        voice = self.vault / '.claude/scripts/beyin_v3_ses.py'
        def fixed(files):
            name = 'template/.claude/scripts/beyin_v3_ses.py'
            files[name] += b'\n# The same version, a later build.\n'
            metadata = json.loads(files['manifest.json'])
            metadata['files'][name] = hashlib.sha256(files[name]).hexdigest()
            files['manifest.json'] = json.dumps(metadata).encode()
        later = rewrite_zip(self.package, self.base / 'same-version-later.zip', fixed)
        check = self.module.update(self.vault, self.state, later, check=True)
        self.assertEqual((check['status'], check.get('refresh')), ('available', True))
        report = self.module.update(self.vault, self.state, later)
        self.assertEqual((report['status'], report['from_version'], report['version']), ('refreshed', '3.0.1', '3.0.1'))
        self.assertTrue(voice.read_bytes().endswith(b'# The same version, a later build.\n'))
        self.assertEqual(self.module.update(self.vault, self.state, later)['status'], 'noop')
        self.assertEqual(self.module.update(self.vault, self.state, later, check=True)['status'], 'noop')
        # A script edited by hand is not a reason to refresh: the record says what was written.
        voice.write_bytes(voice.read_bytes() + b'# benim\n')
        self.assertEqual(self.module.update(self.vault, self.state, later)['status'], 'noop')
        self.assertTrue(voice.read_bytes().endswith(b'# benim\n'))

    def test_update_refreshes_an_installed_theme_and_leaves_its_switch_alone(self):
        sys.path.insert(0, str(ROOT / 'template/.claude/scripts'))
        self.addCleanup(sys.path.remove, str(ROOT / 'template/.claude/scripts'))
        import beyin_v3_tema as tema
        tema.install(self.vault)
        snippet = self.vault / '.obsidian/snippets/ananas.css'
        appearance = self.vault / '.obsidian/appearance.json'
        appearance.write_text('{"enabledCssSnippets": []}\n', encoding='utf-8')  # switched off in Obsidian
        snippet.write_text(tema.OURS + ' an older edition */\n', encoding='utf-8')
        report = self.module.update(self.vault, self.state, self.package)
        self.assertEqual(report['theme'], 'yenilendi')
        self.assertEqual(snippet.read_text(encoding='utf-8'), tema.css())
        self.assertEqual(appearance.read_text(encoding='utf-8'), '{"enabledCssSnippets": []}\n')

    def test_a_busy_engine_is_named_for_the_desktop_app(self):
        import sqlite3
        holder = sqlite3.connect(self.state / 'update-lock.sqlite3')
        holder.execute('BEGIN IMMEDIATE')
        try:
            result = run_python(self.vault / 'beyin.py', ['update', '--package', self.package], self.vault, self.env)
        finally:
            holder.close()
        self.assertEqual(result.returncode, 1)
        error = json.loads(result.stderr.decode('utf-8').strip().splitlines()[-1])
        self.assertEqual(error['code'], 'updater_busy')
        self.assertIn('birkaç saniye sonra yeniden dene', error['message'])
        self.assertEqual(self.version(), '0.0.0')


def load_installer():
    spec = importlib.util.spec_from_file_location('beyin_update_test_installer', ROOT / 'scripts/install_v3.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_entry():
    spec = importlib.util.spec_from_file_location('beyin_update_test_entry', ROOT / 'scripts/beyin_entry.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UserRegionTest(unittest.TestCase):
    """The splice and merge recovery and rollback use for files the person shares with the engine."""

    def setUp(self):
        self.module = load_updater()

    def test_markers_and_files_match_the_installer(self):
        installer = load_installer()
        self.assertEqual((self.module.START, self.module.END), (installer.START, installer.END))
        self.assertEqual(set(self.module.USER_REGION_FILES), set(installer.USER_REGION_FILES))

    def block(self, text):
        return self.module.START + '\n' + text + '\n' + self.module.END

    def test_a_block_is_replaced_in_place_around_the_persons_text(self):
        base = ('# Benim\n\n' + self.block('eski') + '\n').encode()
        current = ('# Benim\nyeni satırım\n\n' + self.block('eski') + '\n\nsonra da bu\n').encode().replace(b'\n', b'\r\n')
        target = ('# Benim\n\n' + self.block('yeni') + '\n').encode()
        self.assertEqual(self.module._splice_block(base, current, target),
                         ('# Benim\nyeni satırım\n\n' + self.block('yeni') + '\n\nsonra da bu\n').encode())

    def test_an_appended_block_is_appended_and_taken_back(self):
        base, target = b'# Benim\n', ('# Benim\n\n' + self.block('blok') + '\n').encode()
        current = b'# Benim\nyeni\n'
        spliced = self.module._splice_block(base, current, target)
        self.assertEqual(spliced, ('# Benim\nyeni\n\n' + self.block('blok') + '\n').encode())
        # Rollback runs the same step backwards: the block goes, the person's line stays.
        self.assertEqual(self.module._splice_block(target, spliced, base), b'# Benim\nyeni\n')

    def test_an_edited_block_or_an_unknown_step_is_no_splice(self):
        base = (self.block('eski') + '\n').encode()
        self.assertIsNone(self.module._splice_block(base, (self.block('elle') + '\n').encode(),
                                                    (self.block('yeni') + '\n').encode()))
        self.assertIsNone(self.module._splice_block(b'a\n', b'b\n', b'c\n'))

    def test_settings_merge_keeps_the_persons_keys_and_refuses_overlap(self):
        base = b'{"hooks": {"Stop": [1]}, "permissions": {"allow": ["a"]}}'
        current = b'{"hooks": {"Stop": [1]}, "permissions": {"allow": ["a", "b"]}}'
        target = b'{"hooks": {"Stop": [2]}, "permissions": {"allow": ["a"]}}'
        merged = json.loads(self.module._user_region_merge('.claude/settings.local.json', base, current, target))
        self.assertEqual(merged, {'hooks': {'Stop': [2]}, 'permissions': {'allow': ['a', 'b']}})
        self.assertIsNone(self.module._user_region_merge('.claude/settings.local.json', base,
                                                         b'{"hooks": {"Stop": [3]}}', target))
        self.assertIsNone(self.module._user_region_merge('.claude/scripts/beyin_v3.py', b'a', b'b', b'c'))

    def test_a_single_line_managed_part_must_still_be_there(self):
        merge = self.module._user_region_merge
        self.assertEqual(merge('CLAUDE.md', b'@AGENTS.md\n', b'@AGENTS.md\nbenim\n', b'@AGENTS.md\n'), b'@AGENTS.md\nbenim\n')
        self.assertIsNone(merge('CLAUDE.md', b'@AGENTS.md\n', b'yalniz benim\n', b'@AGENTS.md\n'))
        toml = b'[features]\nhooks = true\n'
        self.assertEqual(merge('.codex/config.toml', toml, toml + b'model = "x"\n', toml), toml + b'model = "x"\n')
        self.assertIsNone(merge('.codex/config.toml', toml, b'model = "x"\n', toml))


class ReleaseVersionTest(unittest.TestCase):
    def test_the_app_and_the_engine_it_carries_are_one_version(self):
        # The installer is named after the first, the vault's engine told apart by the second;
        # release.yml refuses to publish them apart (install-update-2).
        version = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
        self.assertEqual(json.loads((ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version'], version)


if __name__ == '__main__':
    unittest.main()

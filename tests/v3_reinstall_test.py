"""A vault deleted and made again where it was, or emptied, installs afresh on the record left by the first install."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from v3_package_helpers import ROOT


class ReinstallOnAStaleRecordTest(unittest.TestCase):
    """1 November: the desktop's first run makes Documents\\Cortex. Cortex had been installed there before, the
    folder deleted, and the install record kept in the state outside the vault (default_state is per vault path).
    Every recorded file then read as one the person had deleted, and "Hafızayı kur" stopped for good with
    "Cortex'in yönettiği .claude/scripts/beyin_v3.py dosyası silinmiş"."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-reinstall-')
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.vault = base / 'Belgeler' / 'Cortex'
        self.vault.mkdir(parents=True)
        self.state = base / 'state'
        spec = importlib.util.spec_from_file_location('beyin_reinstall_installer', ROOT / 'scripts/install_v3.py')
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)
        self.installer.install(self.vault, self.state)
        self.assertTrue((self.vault / '.claude/scripts/beyin_v3.py').is_file())

    def test_a_vault_made_again_where_one_was_deleted_installs_afresh(self):
        shutil.rmtree(self.vault)
        self.vault.mkdir()
        (self.vault / 'İlk not.md').write_text('Yeni kasa.\n', encoding='utf-8')
        result = self.installer.install(self.vault, self.state)
        self.assertNotEqual(result.get('status'), 'conflict', result)
        self.assertTrue((self.vault / '.claude/scripts/beyin_v3.py').is_file())
        self.assertTrue((self.vault / 'beyin.py').is_file())
        self.assertEqual((self.vault / 'İlk not.md').read_text(encoding='utf-8'), 'Yeni kasa.\n')
        # And the record now describes this install: a later update sees no deleted file.
        again = self.installer.install(self.vault, self.state)
        self.assertNotEqual(again.get('status'), 'conflict', again)

    def test_one_engine_file_deleted_from_an_installed_vault_is_still_a_conflict(self):
        (self.vault / '.claude/scripts/beyin_v3.py').unlink()
        with self.assertRaises(ValueError) as raised:
            self.installer.install(self.vault, self.state)
        self.assertEqual(raised.exception.code, 'update_conflict')
        self.assertIn('.claude/scripts/beyin_v3.py dosyası silinmiş', str(raised.exception))


class ReinstallAfterEverythingWasRemovedTest(unittest.TestCase):
    """1 November: Cortex uninstalled with "her şeyiyle sil" (its state in %LOCALAPPDATA%\\beyin-v3 gone, the vault
    kept), and the next version installed: "Kasada Cortex'in yazacağı .claude/scripts/beyin_v3_ses.py dosyası zaten
    var ve içeriği farklı", and Pyn's memory could not be updated."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-reinstall-all-')
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.vault = base / 'Belgeler' / 'Cortex'
        self.vault.mkdir(parents=True)
        self.state = base / 'state'
        spec = importlib.util.spec_from_file_location('beyin_reinstall_all_installer', ROOT / 'scripts/install_v3.py')
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)
        # As a released package stamps it (a source-tree install stamps 0.0.0).
        self.installer.install(self.vault, self.state, version='1.0.43')
        # The earlier version's engine: one of its files as that version wrote it.
        self.ses = self.vault / '.claude/scripts/beyin_v3_ses.py'
        self.ses.write_bytes(b'# 1.0.43\n')  # bytes: Windows would write its own line ending
        (self.vault / 'Notlarım.md').write_text('Benim notum.\n', encoding='utf-8')

    def test_the_next_version_installs_over_cortex_s_own_earlier_engine_once_its_record_is_gone(self):
        shutil.rmtree(self.state)
        result = self.installer.install(self.vault, self.state, version='1.0.44')
        self.assertNotEqual(result.get('status'), 'conflict', result)
        self.assertEqual(self.ses.read_bytes(), (ROOT / 'template/.claude/scripts/beyin_v3_ses.py').read_bytes())
        self.assertEqual((self.vault / 'Notlarım.md').read_text(encoding='utf-8'), 'Benim notum.\n', 'the notes untouched')
        record = json.loads((self.state / 'v3-install.json').read_text(encoding='utf-8'))
        original = record['files']['.claude/scripts/beyin_v3_ses.py']['original']
        self.assertEqual(base64.b64decode(original), b'# 1.0.43\n', 'what was there is kept in the record')

    def test_a_file_of_that_name_in_a_vault_cortex_never_installed_still_stops_it(self):
        shutil.rmtree(self.state)
        (self.vault / '.beyin-version').unlink()
        with self.assertRaises(ValueError) as raised:
            self.installer.install(self.vault, self.state, version='1.0.44')
        self.assertEqual(raised.exception.code, 'update_conflict')
        self.assertIn('beyin_v3_ses.py dosyası zaten var ve içeriği farklı', str(raised.exception))

    def test_with_its_record_there_an_engine_file_changed_by_hand_still_stops_it(self):
        with self.assertRaises(ValueError) as raised:
            self.installer.install(self.vault, self.state, version='1.0.44')
        self.assertEqual(raised.exception.code, 'update_conflict')
        self.assertIn('elle değiştirilmiş', str(raised.exception))


if __name__ == '__main__':
    unittest.main()

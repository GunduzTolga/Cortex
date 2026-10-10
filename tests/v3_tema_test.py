"""Optional Ananas Obsidian theme (beyin.py tema): generated data, safe install, installed entry."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from v3_package_helpers import inherited_env

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_tema as tema  # noqa: E402


def generator():
    spec = importlib.util.spec_from_file_location('ananas_tema_generator', ROOT / 'scripts/ananas_tema.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TemaDataTest(unittest.TestCase):
    def test_packaged_data_matches_the_design_source(self):
        # tema/ananas/ is the design source; the packaged module must be regenerated from it.
        gen = generator()
        self.assertEqual(gen.MODULE.read_text(encoding='utf-8'), gen.module_text(),
                         'Run: py -3 scripts/ananas_tema.py uret')
        self.assertEqual(gen.BRAND_MODULE.read_text(encoding='utf-8'), gen.brand_text(),
                         'Run: py -3 scripts/ananas_tema.py uret')
        self.assertEqual(tema.css(), gen.css())

    def test_brand_marks_are_real_images(self):
        import base64
        import beyin_v3_marka as marka
        for size in (28, 42, 56):
            png = base64.b64decode(''.join(getattr(marka, 'MUHUR_%d' % size)))
            self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
            self.assertEqual(int.from_bytes(png[16:20], 'big'), size)  # IHDR width
        ico = base64.b64decode(''.join(marka.ICO))
        self.assertEqual(ico[:4], b'\x00\x00\x01\x00')
        self.assertGreaterEqual(int.from_bytes(ico[4:6], 'little'), 4)  # several sizes for every DPI

    def test_css_embeds_turkish_capable_fonts_and_labels_runtime_folders(self):
        text = tema.css()
        self.assertTrue(text.startswith(tema.OURS))
        self.assertEqual(text.count('@font-face {'), 8)  # three faces (+ italic), latin and latin-ext each
        import beyin_v3_companion as companion
        import beyin_v3_yakala as yakala
        for folder in (companion.DEFAULT_DIRECTORY, yakala.INBOX, 'receipts', 'tasks', 'daily', 'knowledge'):
            self.assertIn('data-path="' + folder + '"', text)
        for icon in (Path(SCRIPTS).parents[2] / 'tema/ananas/ikonlar').glob('*.svg'):
            self.assertIn('--ananas-ikon-' + icon.stem + ':', text)  # every icon the CSS can name exists
        import re
        for used in set(re.findall(r'var\(--ananas-ikon-([a-z-]+)\)', text)):
            self.assertIn('--ananas-ikon-' + used + ':', text)


class TemaInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-tema-')
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / 'Örnek Beyin'
        (self.vault / '.obsidian').mkdir(parents=True)
        self.snippet = self.vault / '.obsidian/snippets/ananas.css'
        self.appearance = self.vault / '.obsidian/appearance.json'

    def write_appearance(self, data):
        self.appearance.write_text(json.dumps(data), encoding='utf-8')

    def read_appearance(self):
        return json.loads(self.appearance.read_text(encoding='utf-8'))

    def test_install_keeps_other_settings_and_is_idempotent(self):
        self.write_appearance({'accentColor': '#123456', 'enabledCssSnippets': ['benim'], 'theme': 'obsidian'})
        self.assertEqual(tema.install(self.vault)['status'], 'kuruldu')
        self.assertEqual(self.read_appearance(), {'accentColor': '#123456', 'enabledCssSnippets': ['benim', 'ananas'],
                                                  'theme': 'obsidian'})
        written = self.snippet.read_bytes()
        self.assertEqual(tema.install(self.vault)['status'], 'guncel')
        self.assertEqual(self.read_appearance()['enabledCssSnippets'], ['benim', 'ananas'])
        self.assertEqual(self.snippet.read_bytes(), written)
        self.assertEqual(tema.status(self.vault), {'status': 'guncel', 'enabled': True, 'snippet': str(self.snippet)})

    def test_fresh_vault_without_obsidian_settings(self):
        (self.vault / '.obsidian').rmdir()
        self.assertEqual(tema.install(self.vault)['status'], 'kuruldu')
        self.assertEqual(self.read_appearance(), {'enabledCssSnippets': ['ananas']})

    def test_foreign_snippet_and_unreadable_settings_are_left_alone(self):
        self.snippet.parent.mkdir()
        self.snippet.write_text('/* benim kendi temam */', encoding='utf-8')
        with self.assertRaises(ValueError):
            tema.install(self.vault)
        with self.assertRaises(ValueError):
            tema.uninstall(self.vault)
        self.assertEqual(self.snippet.read_text(encoding='utf-8'), '/* benim kendi temam */')
        self.snippet.unlink()
        self.appearance.write_text('{bozuk', encoding='utf-8')
        with self.assertRaises(ValueError):
            tema.install(self.vault)
        self.assertFalse(self.snippet.exists())  # nothing is written when settings cannot be merged
        self.assertEqual(self.appearance.read_text(encoding='utf-8'), '{bozuk')

    def test_uninstall_removes_only_ours(self):
        self.write_appearance({'enabledCssSnippets': ['benim']})
        tema.install(self.vault)
        self.assertEqual(tema.uninstall(self.vault)['status'], 'kaldirildi')
        self.assertFalse(self.snippet.exists())
        self.assertEqual(self.read_appearance(), {'enabledCssSnippets': ['benim']})
        self.assertEqual(tema.uninstall(self.vault)['status'], 'kurulu_degil')

    def test_an_older_edition_is_reported_and_replaced(self):
        self.snippet.parent.mkdir()
        self.snippet.write_text(tema.OURS + ' eski surum */\n', encoding='utf-8')
        self.assertEqual(tema.status(self.vault)['status'], 'eski')
        self.assertEqual(tema.install(self.vault)['status'], 'kuruldu')
        self.assertEqual(tema.status(self.vault)['status'], 'guncel')


class TemaInstalledEntryTest(unittest.TestCase):
    def test_installed_entry_installs_and_removes_the_theme(self):
        with tempfile.TemporaryDirectory(prefix='v3-tema-installed-') as tmp:
            root = Path(tmp)
            vault, state = root / 'Örnek Beyin', root / 'state'
            vault.mkdir()
            env = inherited_env(BEYIN_V3_NO_SPAWN='1', PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8',
                                HOME=str(root / 'home'), APPDATA=str(root / 'appdata'))
            installed = subprocess.run([sys.executable, str(ROOT / 'scripts/install_v3.py'), '--vault', str(vault),
                                        '--state', str(state)], capture_output=True, text=True, encoding='utf-8',
                                       env=env, timeout=120)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            for name in ('beyin_v3_tema.py', 'beyin_v3_tema_veri.py'):
                self.assertTrue((vault / '.claude/scripts' / name).is_file(), name)

            def entry(*args):
                result = subprocess.run([sys.executable, str(vault / 'beyin.py'), 'tema', *args], capture_output=True,
                                        text=True, encoding='utf-8', env=env, cwd=vault, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)  # piped output is machine-readable

            self.assertEqual(entry('kur')['status'], 'kuruldu')
            self.assertTrue((vault / '.obsidian/snippets/ananas.css').read_text(encoding='utf-8').startswith(tema.OURS))
            self.assertEqual(entry('durum')['status'], 'guncel')
            self.assertEqual(entry('kaldir')['status'], 'kaldirildi')
            self.assertFalse((vault / '.obsidian/snippets/ananas.css').exists())


if __name__ == '__main__':
    unittest.main()

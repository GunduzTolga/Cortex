"""Optional Ananas Obsidian theme (beyin.py tema): generated data, safe install, installed entry."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

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
    def check(self, gen):
        """`ananas_tema.py kontrol` in this process: (exit code, what it said on stderr)."""
        said = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(said):
            code = gen.main(['kontrol'])
        return code, said.getvalue()

    def test_packaged_data_matches_the_design_source(self):
        # tema/ananas/ is the design source; every module generated from it (the theme, Pyn's brand,
        # the yakala window's fonts) must be regenerated from it. The generator's own check walks the
        # targets it writes, so a module it gains is compared here too (misc-scripts-4).
        gen = generator()
        code, said = self.check(gen)
        self.assertEqual(code, 0, said)
        self.assertEqual(tema.css(), gen.css())

    def test_the_check_covers_every_generated_module(self):
        # The fonts were the module no test compared: same-size TTFs with other bytes went unseen.
        gen = generator()
        with tempfile.TemporaryDirectory(prefix='v3-tema-kontrol-') as tmp:
            for name in ('MODULE', 'BRAND_MODULE', 'FONT_MODULE'):
                stale = Path(tmp) / getattr(gen, name).name
                stale.write_text('# eski\n', encoding='utf-8')
                with mock.patch.object(gen, name, stale):
                    code, said = self.check(gen)
                self.assertEqual(code, 1, name)
                self.assertIn(stale.name, said)

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


class FontLicenceTest(unittest.TestCase):
    """OFL 1.1 condition 2: the notice and the licence go with every copy of the faces (misc-scripts-6)."""

    def test_the_css_and_the_ttf_module_carry_the_licence(self):
        import beyin_v3_yazitipi as yazitipi
        text = tema.css()
        head = text.split('@font-face', 1)[0]
        for owner in ('The Fraunces Project Authors', 'The JetBrains Mono Project Authors',
                      'The Schibsted-Grotesk Project Authors'):
            self.assertIn('Copyright', head.split(owner, 1)[0][-60:])
            self.assertIn(owner, yazitipi.LICENSE)
        for clause in ('SIL OPEN FONT LICENSE Version 1.1', 'PERMISSION & CONDITIONS', 'DISCLAIMER'):
            self.assertIn(clause, head)
            self.assertIn(clause, yazitipi.LICENSE)
        self.assertTrue(text.startswith(tema.OURS))
        self.assertEqual(head.count('*/'), 2)  # the marker's comment and the licence's, nothing cut short

    def test_yakala_writes_the_licence_beside_the_fonts_it_copies(self):
        import types
        from unittest import mock
        import beyin_v3_yakala as yakala
        import beyin_v3_yazitipi as yazitipi
        with tempfile.TemporaryDirectory(prefix='v3-yazitipi-') as state:
            # Windows only: GDI is not here, so the faces are written and their loading fails quietly.
            with mock.patch.object(yakala, 'os', types.SimpleNamespace(name='nt')), \
                    mock.patch.object(yakala, '_fonts_loaded', False):
                yakala._load_fonts(state)
            folder = Path(state) / yakala.FONT_DIR
            self.assertEqual((folder / 'OFL.txt').read_text(encoding='utf-8'), yazitipi.LICENSE)
            self.assertTrue(list(folder.glob('*.ttf')))


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


    def test_refresh_rewrites_only_an_older_snippet_of_ours_and_never_the_switch(self):
        # After an engine update the theme followed only a hand-run `tema kur` (misc-scripts-5).
        self.write_appearance({'enabledCssSnippets': ['benim']})  # Ananas switched off in Obsidian
        before = self.appearance.read_bytes()
        self.assertEqual(tema.refresh(self.vault)['status'], 'kurulu_degil')
        self.assertFalse(self.snippet.exists())
        self.snippet.parent.mkdir()
        self.snippet.write_text(tema.OURS + ' eski surum */\n', encoding='utf-8')
        self.assertEqual(tema.refresh(self.vault)['status'], 'yenilendi')
        self.assertEqual(self.snippet.read_text(encoding='utf-8'), tema.css())
        self.assertEqual(tema.refresh(self.vault)['status'], 'guncel')
        self.assertEqual(self.appearance.read_bytes(), before)
        self.snippet.write_text('/* benim kendi temam */', encoding='utf-8')
        self.assertEqual(tema.refresh(self.vault)['status'], 'kurulu_degil')
        self.assertEqual(self.snippet.read_text(encoding='utf-8'), '/* benim kendi temam */')
        self.assertEqual(self.appearance.read_bytes(), before)


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
            self.assertEqual(entry('yenile')['status'], 'guncel')
            self.assertEqual(entry('kaldir')['status'], 'kaldirildi')
            self.assertFalse((vault / '.obsidian/snippets/ananas.css').exists())


if __name__ == '__main__':
    unittest.main()

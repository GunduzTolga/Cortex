"""beyin.py relocate (C2): a vault moved, renamed or copied is bound to where it is now.

Moved - OneDrive taking Documents over, a rename - every hook failed (exit 2 blocked the client) and
doctor, sync and hook-reconcile all said "runtime belongs to another vault" with no command to mend
it (hooks-clients-2, hooks-clients-M1). A copy must not share its original's runtime.
"""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from v3_package_helpers import install, isolated_env, run_python, snapshot

ROOT = Path(__file__).resolve().parents[1]


class RelocateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='v3-relocate-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.env = isolated_env(self.base / 'home')
        self.vault = self.base / 'Belgeler' / 'Beynim'
        self.vault.mkdir(parents=True)
        (self.vault / 'not.md').write_text('---\n{"id":"not","kind":"fact","status":"active"}\n---\nTaşınan kasa.\n',
                                           encoding='utf-8')
        # The machine's default state, as the desktop app's installs pin it.
        installed = run_python(ROOT / 'scripts/install_v3.py', ['--vault', self.vault], ROOT, self.env)
        self.assertEqual(installed.returncode, 0, installed.stderr.decode('utf-8', errors='replace'))
        self.state = Path(json.loads((self.vault / '.beyin-runtime.json').read_text(encoding='utf-8'))['state'])
        synced = self.beyin(self.vault, 'sync')
        self.assertEqual(synced.returncode, 0, synced.stderr)

    def beyin(self, vault, *arguments):
        return subprocess.run([sys.executable, str(vault / 'beyin.py'), *arguments, '--json'], cwd=vault, env=self.env,
                              capture_output=True, text=True, encoding='utf-8', timeout=120)

    def relocate(self, vault):
        result = self.beyin(vault, 'relocate')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual({'status', 'vault', 'state'} - set(report), set())
        return report

    def binding(self, state):
        db = sqlite3.connect(state / 'memory.sqlite3')
        try:
            return db.execute("SELECT value FROM metadata WHERE key='vault_root'").fetchone()[0]
        finally:
            db.close()

    def hook(self, vault, event='UserPromptSubmit'):
        settings = json.loads((vault / '.claude/settings.local.json').read_text(encoding='utf-8'))
        return settings['hooks'][event][0]['hooks'][0]['command']

    def test_a_vault_already_bound_here_is_unchanged_and_nothing_is_written(self):
        before_vault, before_state = snapshot(self.vault), snapshot(self.state)
        report = self.relocate(self.vault)
        self.assertEqual(report['status'], 'unchanged')
        self.assertEqual(report['vault'], str(self.vault.resolve()))
        self.assertEqual(snapshot(self.vault), before_vault)
        self.assertEqual(snapshot(self.state), before_state)

    def test_a_moved_vault_is_bound_where_it_is_and_its_hooks_follow(self):
        moved = self.base / 'OneDrive' / 'Belgeler' / 'Ayşe’nin Beyni'
        moved.parent.mkdir(parents=True)
        shutil.move(str(self.vault), str(moved))
        doctor = self.beyin(moved, 'doctor')
        self.assertNotEqual(doctor.returncode, 0)
        error = json.loads(doctor.stderr.strip().splitlines()[-1])
        self.assertEqual(error['code'], 'vault_moved')
        self.assertIn('beyin.py relocate', error['message'])
        if os.name != 'nt':
            # The stale hook fails, and says so, but never with the blocking 2 (C3).
            stale = subprocess.run(self.hook(moved), shell=True, input='{}', capture_output=True, text=True,
                                   env=self.env, timeout=60)
            self.assertEqual(stale.returncode, 1, stale.stderr)
        report = self.relocate(moved)
        self.assertEqual(report['status'], 'relocated')
        self.assertEqual(report['previous_vault'], str(self.vault.resolve()))
        self.assertEqual(report['state'], str(self.state.resolve()))
        self.assertEqual(self.binding(self.state), str(moved.resolve()))
        self.assertIn('last-update.json', report['journals'])
        self.assertEqual(json.loads((self.state / 'last-update.json').read_text(encoding='utf-8'))['vault'],
                         str(moved.resolve()))
        self.assertEqual(len(report['hooks']['files']), 6, report['hooks'])
        self.assertTrue((moved / '.claude/settings.local.json.bak').is_file())
        self.assertIn(str(moved.resolve()), self.hook(moved).replace("'\"'\"'", "'"))
        doctor = self.beyin(moved, 'doctor')
        self.assertEqual(doctor.returncode, 0, doctor.stderr)
        self.assertEqual(json.loads(doctor.stdout)['hook_paths']['status'], 'ok')
        # The update launcher names the vault's entry: written again for the new place.
        launcher = next(name for name in report['files'] if name.startswith('Beyni'))
        self.assertIn(str(moved.resolve() / 'beyin.py') if os.name != 'nt' else 'EncodedCommand',
                      (moved / launcher).read_text(encoding='utf-8'))
        self.assertEqual(self.relocate(moved)['status'], 'unchanged')
        if os.name != 'nt':
            context = subprocess.run(self.hook(moved, 'SessionStart'), shell=True, capture_output=True, text=True,
                                     input=json.dumps({'session_id': 'tasindi', 'hook_event_name': 'SessionStart',
                                                       'cwd': str(moved)}), env=self.env, timeout=60)
            self.assertEqual(context.returncode, 0, context.stderr)
            self.assertNotIn('sync failed', context.stdout)

    def test_a_binding_the_first_read_missed_is_moved_all_the_same(self):
        # The read before the lock may meet a busy or unreadable index and see no binding; the
        # hooks still name the old folder, and "relocated" must not leave the memory bound there.
        moved = self.base / 'Yeni Yer' / 'Beynim'
        moved.parent.mkdir(parents=True)
        shutil.move(str(self.vault), str(moved))
        code = ('import importlib.util, json, sys\n'
                'from pathlib import Path\n'
                "spec = importlib.util.spec_from_file_location('relocate_cli', sys.argv[1])\n"
                'cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)\n'
                'cli._vault_binding = lambda state: None\n'
                'print(json.dumps(cli.relocate(Path(sys.argv[2]), Path(sys.argv[3]))))\n')
        result = subprocess.run([sys.executable, '-c', code, str(moved / '.claude/scripts/beyin_v3_cli.py'), str(moved),
                                 str(self.state)], cwd=moved, env=self.env, capture_output=True, text=True,
                                encoding='utf-8', timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'relocated')
        self.assertEqual(self.binding(self.state), str(moved.resolve()))
        self.assertEqual(self.relocate(moved)['status'], 'unchanged')

    def test_hook_files_bound_back_and_forth_keep_one_backup_per_content(self):
        # Hook files synced between two computers are bound again on each the app opens them on:
        # every switch added a backup of every hook file, the same two contents over and over.
        moved = self.base / 'Tasindi' / 'Beynim'
        moved.parent.mkdir(parents=True)
        shutil.move(str(self.vault), str(moved))
        settings = moved / '.claude/settings.local.json'
        here_before = settings.read_bytes()
        self.assertEqual(self.relocate(moved)['status'], 'relocated')
        here = settings.read_bytes()
        for _ in range(2):
            settings.write_bytes(here_before)  # the other computer's edition synced back
            self.assertEqual(self.relocate(moved)['status'], 'relocated')
            self.assertEqual(settings.read_bytes(), here)
        backups = sorted(path.name for path in settings.parent.glob('settings.local.json.bak*'))
        self.assertEqual(backups, ['settings.local.json.bak'])

    def test_a_copy_gets_a_state_of_its_own_and_the_original_keeps_its_own(self):
        copy = self.base / 'Yedek' / 'Beynim'
        shutil.copytree(self.vault, copy, symlinks=True)
        original_vault, original_state = snapshot(self.vault), snapshot(self.state)
        report = self.relocate(copy)
        self.assertEqual(report['status'], 'separated')
        self.assertEqual(report['previous_state'], str(self.state.resolve()))
        own = Path(report['state'])
        self.assertNotEqual(own, self.state.resolve())
        self.assertEqual(json.loads((copy / '.beyin-runtime.json').read_text(encoding='utf-8'))['state'], str(own))
        self.assertTrue((own / 'v3-install.json').is_file())
        manifest = json.loads((own / 'v3-install.json').read_text(encoding='utf-8'))
        import hashlib
        self.assertEqual(manifest['files']['.beyin-runtime.json']['installed_hash'],
                         hashlib.sha256((copy / '.beyin-runtime.json').read_bytes()).hexdigest())
        self.assertEqual(snapshot(self.vault), original_vault)
        self.assertEqual(snapshot(self.state), original_state)
        synced = self.beyin(copy, 'sync')
        self.assertEqual(synced.returncode, 0, synced.stderr)
        self.assertEqual(self.binding(own), str(copy.resolve()))
        self.assertEqual(self.binding(self.state), str(self.vault.resolve()))
        self.assertEqual(self.relocate(copy)['status'], 'unchanged')
        self.assertEqual(self.relocate(self.vault)['status'], 'unchanged')
        # The copy updates from its own install record, as the original does.
        doctor = self.beyin(copy, 'doctor')
        self.assertEqual(json.loads(doctor.stdout)['hook_paths']['status'], 'ok')

    def test_a_folder_left_at_the_old_place_on_no_state_of_ours_is_no_original(self):
        # Something stands at the old path again (a sync client's leftover, a new folder of that
        # name) with a pin to a state that is not there: it shares nothing, and the vault moved.
        moved = self.base / 'Yeni' / 'Beynim'
        moved.parent.mkdir(parents=True)
        shutil.move(str(self.vault), str(moved))
        self.vault.mkdir()
        (self.vault / '.beyin-runtime.json').write_text(
            json.dumps({'state': str(self.base / 'olmayan-state'), 'schema': 1}), encoding='utf-8')
        report = self.relocate(moved)
        self.assertEqual(report['status'], 'relocated')
        self.assertEqual(report['state'], str(self.state.resolve()))
        self.assertEqual(self.binding(self.state), str(moved.resolve()))

    def test_without_the_install_record_it_says_to_install_again(self):
        moved = self.base / 'Tasindi'
        shutil.move(str(self.vault), str(moved))
        (self.state / 'v3-install.json').unlink()
        result = self.beyin(moved, 'relocate')
        self.assertEqual(result.returncode, 1)
        error = json.loads(result.stderr.strip().splitlines()[-1])
        self.assertEqual(error['code'], 'vault_moved')
        self.assertIn('yeniden kur', error['message'])

    def test_a_vault_from_another_computer_installs_again_as_relocate_says(self):
        # Copied or synced here with its pin, hooks, launcher and plugins, its state left on the other
        # computer: relocate cannot bind it and says to install again, and that install must not stop
        # on every file that carries the other computer's paths.
        elsewhere = self.base / 'Baska Bilgisayar' / 'Beynim'
        shutil.copytree(self.vault, elsewhere, symlinks=True)
        pin = elsewhere / '.beyin-runtime.json'
        pin.write_text(json.dumps({'state': str(self.base / 'oteki-bilgisayar' / 'state'), 'schema': 1}), encoding='utf-8')
        result = self.beyin(elsewhere, 'relocate')
        self.assertEqual(result.returncode, 1, result.stdout)
        error = json.loads(result.stderr.strip().splitlines()[-1])
        self.assertEqual(error['code'], 'vault_moved')
        self.assertIn('yeniden kur', error['message'])
        fresh = self.base / 'bu-bilgisayar-state'
        installed = install(elsewhere, fresh, self.env)
        self.assertEqual(installed.returncode, 0, installed.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(json.loads(pin.read_text(encoding='utf-8'))['state'], str(fresh.resolve()))
        self.assertEqual(self.relocate(elsewhere)['status'], 'unchanged')
        doctor = self.beyin(elsewhere, 'doctor')
        self.assertEqual(json.loads(doctor.stdout)['hook_paths']['status'], 'ok')
        # A pin naming a state this machine has is no copy's: it still stops a recordless install.
        refused = install(elsewhere, self.base / 'ucuncu-state', self.env)
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(json.loads(refused.stderr.decode('utf-8').strip().splitlines()[-1])['code'], 'vault_moved')
        # And a file of a generated name that is not the installer's still stops it.
        pin.write_text(json.dumps({'state': str(self.base / 'oteki-bilgisayar' / 'state'), 'schema': 1}), encoding='utf-8')
        kiro = elsewhere / '.kiro/hooks/beyin-v3.json'
        kiro.write_text('{"version": "v1", "hooks": [{"name": "benim"}]}\n', encoding='utf-8')
        again = install(elsewhere, self.base / 'ucuncu-state', self.env)
        self.assertEqual(again.returncode, 1)
        self.assertEqual(json.loads(again.stderr.decode('utf-8').strip().splitlines()[-1])['code'], 'update_conflict')


if __name__ == '__main__':
    unittest.main()

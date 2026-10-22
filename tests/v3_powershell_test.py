"""Command text Cortex writes for other programs (beyin_v3_powershell): one quoting, and hooks that never block.

security-5: PowerShell ends a single-quoted literal at the typographic quotes U+2018..U+201B too, so a
vault named on an iPhone ("Ayşe’nin Kasası") broke every hook, the update launcher and Pyn's status
line while eight copies of the quoting doubled only the ASCII quote. C3: a hook command never exits
with 2, which Claude Code, Codex and Qwen read as "block" (a vault moved: Python cannot open the script).
"""
import base64
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'template/.claude/scripts'
sys.path.insert(0, str(SCRIPTS))
import beyin_v3_powershell as ps  # noqa: E402

TYPOGRAPHIC = '\u2018\u2019\u201a\u201b'
VAULT = 'C:\\Users\\ayse\\iCloudDrive\\iCloud~md~obsidian\\Ayşe\u2019nin Kasası'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decoded(command):
    match = re.search(r'-EncodedCommand\s+([A-Za-z0-9+/=]+)', command)
    return base64.b64decode(match.group(1)).decode('utf-16le')


def tokens(script):
    """PowerShell's own reading of single-quoted literals: any of the five quote characters ends
    one, and two of them in a row stand for one. What `literal` writes must read back whole."""
    found, index, quotes = [], 0, "'" + TYPOGRAPHIC
    while index < len(script):
        if script[index] not in quotes:
            index += 1
            continue
        index += 1
        value = ''
        while True:
            if index >= len(script):
                raise AssertionError('unterminated literal in ' + script)
            if script[index] in quotes:
                if index + 1 < len(script) and script[index + 1] in quotes:
                    value += script[index + 1]
                    index += 2
                    continue
                index += 1
                break
            value += script[index]
            index += 1
        found.append(value)
    return found


class QuotingTest(unittest.TestCase):
    def test_every_quote_powershell_ends_a_literal_at_is_doubled(self):
        for value in (VAULT, "it's", 'a\u2018b\u201ac\u201bd', '\u2019\u2019', 'plain'):
            with self.subTest(value=value):
                literal = ps.literal(value)
                self.assertEqual(tokens(literal), [value])
                self.assertEqual(ps.literals(literal), [value])

    def test_values_without_quotes_are_spelled_as_before(self):
        # Byte for byte the old spelling: no installed hook or launcher churns on an update.
        for value in ('C:\\Python312\\python.exe', '/home/ayşe/Kasa $HOME `x`', 'it\'s'):
            self.assertEqual(ps.literal(value), "'" + value.replace("'", "''") + "'")

    def test_the_hook_script_maps_two_and_nothing_to_one_without_any_quote(self):
        script = ps.hook_script(['python.exe', VAULT + '\\.claude\\scripts\\beyin_v3_hook.py'])
        self.assertTrue(script.endswith(ps.EXIT_NOT_TWO))
        self.assertIn('$c -eq 2', script)
        self.assertIn('$null -eq $c', script)
        self.assertNotRegex(ps.EXIT_NOT_TWO, "['" + TYPOGRAPHIC + "]")
        self.assertEqual(tokens(script), ['python.exe', VAULT + '\\.claude\\scripts\\beyin_v3_hook.py'])


@unittest.skipIf(os.name == 'nt', 'the POSIX form runs under /bin/sh')
class PosixExitTest(unittest.TestCase):
    def run_hook(self, argv, via_shell):
        command = ps.posix_hook(argv)
        if via_shell:
            return subprocess.run(command, shell=True, capture_output=True, timeout=30).returncode
        import shlex
        return subprocess.run(shlex.split(command), capture_output=True, timeout=30).returncode

    def test_a_missing_script_exits_one_whether_a_shell_runs_it_or_not(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / 'moved vault\u2019s' / '.claude/scripts/beyin_v3_hook.py'
            for via_shell in (True, False):
                with self.subTest(via_shell=via_shell):
                    self.assertEqual(self.run_hook([sys.executable, missing], via_shell), 1)

    def test_other_exit_codes_pass_unchanged(self):
        for code in (0, 1, 3):
            with self.subTest(code=code):
                self.assertEqual(self.run_hook([sys.executable, '-c', 'raise SystemExit(%d)' % code], True), code)
        self.assertEqual(self.run_hook([sys.executable, '-c', 'raise SystemExit(2)'], True), 1)

    def test_arguments_read_back_through_the_wrapper(self):
        argv = [sys.executable, '/v/K\u2019asa/.claude/scripts/beyin_v3_hook.py', '--vault', "/v/it's"]
        self.assertEqual(ps.posix_arguments(ps.posix_hook(argv)), argv + ['||', '{', 's=$?;', '[', '$s', '-eq', '2', ']',
                                                                           '&&', 's=1;', 'exit', '$s;', '}'])


class GeneratorsTest(unittest.TestCase):
    """Every place that writes a command spells it through the one helper."""

    def setUp(self):
        self.installer = load('beyin_powershell_installer', ROOT / 'scripts/install_v3.py')
        self.cli = load('beyin_powershell_cli', ROOT / 'scripts/beyin_v3.py')

    def argv(self):
        return ['C:\\Python312\\python.exe', VAULT + '\\.claude\\scripts\\beyin_v3_hook.py', '--vault', VAULT,
                '--state', 'C:\\Users\\ayse\\AppData\\Local\\beyin-v3\\0123456789abcdef', '--harness', 'claude']

    def test_installer_and_reconcile_write_the_same_commands(self):
        argv = self.argv()
        posix, windows = self.installer.commands(argv)
        self.assertEqual((posix, windows), self.cli._hook_commands(argv))
        script = decoded(windows)
        self.assertEqual(script, ps.hook_script(argv))
        self.assertIn('Ayşe\u2019\u2019nin Kasası', script)
        self.assertEqual(self.installer.powershell_call(argv), ps.hook_script(argv))
        # doctor and hook-reconcile read the paths back exactly, curly apostrophe and all.
        self.assertEqual(self.cli._hook_arguments(windows), argv)
        self.assertEqual(self.cli._hook_arguments(self.installer.powershell_call(argv)), argv)
        self.assertEqual(self.cli._hook_arguments(posix)[:len(argv)], [value.replace('\\', '/') if os.name == 'nt'
                                                                       else value for value in argv])

    def test_bridge_launcher_and_pyn_use_the_shared_quoting(self):
        bridge = load('beyin_powershell_bridge', SCRIPTS / 'beyin_v3_bridge.py')
        pyn = load('beyin_powershell_pyn', SCRIPTS / 'beyin_v3_pyn.py')
        launchers = load('beyin_powershell_launchers', SCRIPTS / 'beyin_v3_launchers.py')
        argv = self.argv()
        self.assertEqual(decoded(pyn._powershell(argv)), ps.hook_script(argv))
        block = pyn.shell_block(VAULT, python='C:\\Python312\\python.exe', windows=True)
        self.assertIn('function pyn { ' + ps.call(['C:\\Python312\\python.exe', Path(VAULT) / 'beyin.py']) + ' pyn @args }',
                      block)
        self.assertNotIn('"', block.split('\n')[2])
        if os.name == 'nt':
            self.assertEqual(decoded(bridge.shell_command(argv)), ps.hook_script(argv))
            text = launchers.plan_launchers(Path(VAULT), Path(VAULT))['Beyni Guncelle.cmd'].decode('ascii')
            self.assertIn('\u2019\u2019nin', decoded(text))
        else:
            self.assertEqual(bridge.shell_command(argv), ps.posix_hook(argv))


if __name__ == '__main__':
    unittest.main()

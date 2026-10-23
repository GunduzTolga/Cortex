"""scripts/run_v3_tests.py: the suite in one process, or every test file in a process of its own (--each)."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from v3_package_helpers import inherited_env

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/run_v3_tests.py'

# The first file leaves a folder on the path as it loads, as the engine's loaders did; the second
# passes only when the first was loaded before it, in the same process (tests-ci-3).
FIRST = '''import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'yan'))


class First(unittest.TestCase):
    def test_first(self):
        pass
'''
SECOND = '''import unittest


class Second(unittest.TestCase):
    def test_second(self):
        import komsu
        self.assertEqual(komsu.VALUE, 1)

    @unittest.skip('counted')
    def test_skipped(self):
        pass
'''
STUCK = '''import threading
import unittest


class Stuck(unittest.TestCase):
    def test_stuck(self):
        threading.Event().wait()
'''


class RunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='v3-runner-')
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)
        self.tests = self.folder / 'tests'
        (self.tests / 'yan').mkdir(parents=True)
        (self.tests / 'yan' / 'komsu.py').write_text('VALUE = 1\n', encoding='utf-8')
        (self.tests / 'v3_a_test.py').write_text(FIRST, encoding='utf-8')
        (self.tests / 'v3_b_test.py').write_text(SECOND, encoding='utf-8')

    def run_suite(self, *args):
        result = subprocess.run([sys.executable, str(RUNNER), *args], cwd=self.folder, capture_output=True,
                                env=inherited_env(PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8'), timeout=120)
        said = result.stdout.decode('utf-8', errors='replace') + result.stderr.decode('utf-8', errors='replace')
        # On Windows a printed line ends in \r\n on a pipe, and the lines below are matched to their end.
        return result.returncode, said.replace('\r\n', '\n')

    def test_one_process_lets_a_file_lean_on_another(self):
        code, said = self.run_suite()
        self.assertEqual(code, 0, said)

    def test_each_file_alone_names_the_one_that_leans_on_another(self):
        code, said = self.run_suite('--each', '--jobs', '2')
        self.assertEqual(code, 1, said)
        self.assertRegex(said, r'(?m)^ok .* v3_a_test\.py  \(1 tests\)$')
        self.assertRegex(said, r'(?m)^FAIL .* v3_b_test\.py  \(2 tests, 1 skipped\)$')
        self.assertIn("No module named 'komsu'", said, 'the failing file says why')
        self.assertIn('Ran 3 tests in 2 files, 2 at a time', said)
        self.assertIn('FAILED (failures=0, errors=1, skipped=1): v3_b_test.py', said)

    def test_each_file_alone_passes_when_every_file_stands_alone(self):
        (self.tests / 'v3_b_test.py').write_text('import sys\nfrom pathlib import Path\n'
                                                 "sys.path.insert(0, str(Path(__file__).parent / 'yan'))\n" + SECOND,
                                                 encoding='utf-8')
        code, said = self.run_suite('--each', '--jobs', '0')
        self.assertEqual(code, 0, said)
        self.assertEqual(said.strip().splitlines()[-1], 'OK (skipped=1)')

    def test_a_file_that_hangs_says_where_and_the_others_still_run(self):
        (self.tests / 'v3_c_test.py').write_text(STUCK, encoding='utf-8')
        (self.tests / 'v3_b_test.py').unlink()
        code, said = self.run_suite('--each', '--hang-after', '2')
        self.assertEqual(code, 1, said)
        self.assertRegex(said, r'(?m)^ok .* v3_a_test\.py')
        self.assertRegex(said, r'(?m)^FAIL .* v3_c_test\.py')
        self.assertIn('test_stuck', said, "the hung file's threads are written out")
        self.assertIn('FAILED (failures=0, errors=1, skipped=0): v3_c_test.py', said)


if __name__ == '__main__':
    unittest.main()

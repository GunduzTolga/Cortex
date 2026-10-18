#!/usr/bin/env python3
"""The offline v3 suite as CI runs it: `python -m unittest discover -s tests -p "v3_*test.py"`.

With `--hang-after SECONDS` a suite still running then is taken for hung: every thread's stack
is written out (faulthandler) and the run ends with an error. A job's own time limit only says
"cancelled" and shows nothing of where it stood (17 October: macOS, 15 minutes, no clue).
"""
import argparse
import faulthandler
import os
import sys
import unittest


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--hang-after', type=float, default=0, help='seconds; 0 waits forever')
    args = parser.parse_args(argv)
    # As `python -m unittest` has it: the working folder first on the path, not this script's (`from tests.… import`).
    sys.path[0] = os.getcwd()
    if args.hang_after > 0:
        faulthandler.dump_traceback_later(args.hang_after, exit=True)
    program = unittest.main(module=None, argv=['unittest', 'discover', '-s', 'tests', '-p', 'v3_*test.py'], exit=False)
    faulthandler.cancel_dump_traceback_later()
    return 0 if program.result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())

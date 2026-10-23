#!/usr/bin/env python3
"""The offline v3 suite as CI runs it: `python -m unittest discover -s tests -p "v3_*test.py"`.

With `--hang-after SECONDS` a suite still running then is taken for hung: every thread's stack
is written out (faulthandler) and the run ends with an error. A job's own time limit only says
"cancelled" and shows nothing of where it stood (17 October: macOS, 15 minutes, no clue).

With `--each` every test file runs in a process of its own, `--jobs N` of them at a time. A file
that passes only because another one, loaded before it, left the engine's folder on the path
fails here as it does when run alone (tests-ci-3); with several cores the suite also takes a
fraction of the time (tests-ci-4). `--hang-after` then holds for each file.
"""
import argparse
import concurrent.futures
import faulthandler
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest

PATTERN = 'v3_*test.py'


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--hang-after', type=float, default=0, help='seconds; 0 waits forever')
    parser.add_argument('--each', action='store_true', help='every test file in a process of its own')
    parser.add_argument('--jobs', type=int, default=1, help='with --each: how many files run at the same time; 0, one a core')
    # The one file a process of --each runs.
    parser.add_argument('--pattern', default=PATTERN, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.each:
        args.jobs = args.jobs if args.jobs > 0 else os.cpu_count() or 1
        return each(args)
    # As `python -m unittest` has it: the working folder first on the path, not this script's (`from tests.… import`).
    sys.path[0] = os.getcwd()
    if args.hang_after > 0:
        faulthandler.dump_traceback_later(args.hang_after, exit=True)
    program = unittest.main(module=None, argv=['unittest', 'discover', '-s', 'tests', '-p', args.pattern], exit=False)
    faulthandler.cancel_dump_traceback_later()
    return 0 if program.result.wasSuccessful() else 1


def counts(output):
    """What a file's run said at its end: tests run, failures, errors and skips."""
    ran = re.findall(r'^Ran (\d+) tests? in ', output, re.M)
    ended = re.findall(r'^(?:OK|FAILED)(?: \((.*)\))?\s*$', output, re.M)
    said = dict((key, int(value)) for key, value in re.findall(r'(\w[\w ]*)=(\d+)', ended[-1] if ended else ''))
    return {'tests': int(ran[-1]) if ran else 0, 'failures': said.get('failures', 0),
            'errors': said.get('errors', 0), 'skipped': said.get('skipped', 0)}


def each(args):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(errors='replace')
    # The largest files first: the long runs start at once and the short ones fill in around them.
    files = sorted(Path('tests').glob(args.pattern), key=lambda path: (-path.stat().st_size, path.name))
    env = dict(os.environ, PYTHONIOENCODING=os.environ.get('PYTHONIOENCODING') or 'utf-8')
    # Past --hang-after a file's own process writes its threads out and ends; this is only for one
    # that cannot even do that.
    limit = args.hang_after + 120 if args.hang_after > 0 else None

    def run(path):
        command = [sys.executable, os.path.abspath(__file__), '--pattern', path.name]
        if args.hang_after > 0:
            command += ['--hang-after', str(args.hang_after)]
        begun = time.monotonic()
        try:
            done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, timeout=limit)
            output, code = done.stdout, done.returncode
        except subprocess.TimeoutExpired as exc:
            output, code = (exc.stdout or b'') + b'\n[stopped: still running two minutes after --hang-after]\n', None
        # Windows' Python ends its lines with \r\n on a pipe; printed again here they would end in \r\r\n.
        return path, code, output.decode('utf-8', errors='replace').replace('\r\n', '\n'), time.monotonic() - begun

    begun = time.monotonic()
    total = {'tests': 0, 'failures': 0, 'errors': 0, 'skipped': 0}
    failed = []
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for future in concurrent.futures.as_completed([pool.submit(run, path) for path in files]):
            path, code, output, seconds = future.result()
            found = counts(output)
            if code != 0 and not (found['failures'] or found['errors']):
                found['errors'] += 1  # ended without saying why: an import, a crash, a hang
            for key in total:
                total[key] += found[key]
            ok = code == 0
            print('%-4s %7.1f s  %s  (%d tests%s)' % ('ok' if ok else 'FAIL', seconds, path.name, found['tests'],
                                                    ', %d skipped' % found['skipped'] if found['skipped'] else ''),
                  flush=True)
            if not ok:
                failed.append((path.name, output))
    for name, output in sorted(failed):
        print('\n' + '=' * 70 + '\n' + name + '\n' + '=' * 70 + '\n' + output.rstrip(), flush=True)
    print('\nRan %d tests in %d files, %d at a time, in %.0f s' % (total['tests'], len(files), args.jobs,
                                                                    time.monotonic() - begun))
    if failed:
        print('FAILED (failures=%d, errors=%d, skipped=%d): %s' % (total['failures'], total['errors'], total['skipped'],
                                                                    ', '.join(sorted(name for name, _ in failed))))
        return 1
    print('OK (skipped=%d)' % total['skipped'] if total['skipped'] else 'OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())

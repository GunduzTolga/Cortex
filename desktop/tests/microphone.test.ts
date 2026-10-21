import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BEAT_EVERY, microphoneFile, microphoneWord } from '../electron/services/microphone';

/**
 * The microphone listens all the time only while Cortex runs and the person
 * allowed it (electron/services/microphone.ts): the app's word, and the
 * engine's reading of it (beyin_v3_ses.wake_allowed), which are one contract.
 */

// The tests run from desktop/, as every other one reads the sources.
const SCRIPTS = path.resolve('..', 'template', '.claude', 'scripts');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PYTHON, ['--version'], { windowsHide: true }).status === 0;

test('the word is kept beside every vault’s state, where the engine looks for it', () => {
  assert.equal(microphoneFile({ LOCALAPPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Local') }), path.join('C:', 'Users', 'x', 'AppData', 'Local', 'beyin-v3', 'masaustu.json'));
  assert.ok(microphoneFile({}).endsWith(path.join('AppData', 'Local', 'beyin-v3', 'masaustu.json')));
  // Said often enough that the engine, which takes 20 seconds of silence as closed, never thinks a running app gone.
  assert.ok(BEAT_EVERY * 3 < 20_000);
});

test('what the app says: running and allowed, running and not, or quit', () => {
  assert.deepEqual(JSON.parse(microphoneWord(true, false, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, dinle: true });
  assert.deepEqual(JSON.parse(microphoneWord(false, false, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, dinle: false });
  assert.deepEqual(JSON.parse(microphoneWord(true, true, 1_000_000)), { surum: 1, pid: process.pid, at: 1000, kapali: true }, 'quit says nothing of leave');
});

test('the engine reads the app’s word as the app means it', { skip: !hasPython }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mikrofon-'));
  const file = path.join(dir, 'masaustu.json');
  const allowed = () => {
    const run = spawnSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import beyin_v3_ses as s; print(s.wake_allowed({"uyandirma": True}, sys.argv[2]))', SCRIPTS, file], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  try {
    fs.writeFileSync(file, microphoneWord(true, false));
    assert.equal(allowed(), 'True', 'running, and allowed');
    fs.writeFileSync(file, microphoneWord(false, false));
    assert.equal(allowed(), 'False', 'running, not allowed');
    fs.writeFileSync(file, microphoneWord(true, true));
    assert.equal(allowed(), 'False', 'quit');
    fs.writeFileSync(file, microphoneWord(true, false, Date.now() - 60_000));
    assert.equal(allowed(), 'False', 'silent for a minute: crashed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

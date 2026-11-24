import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localMoment, recordOpening, recordTime, resetOpeningForTests, TIMINGS_MAX, timingLine, timingsFile } from '../electron/services/timings';

/**
 * The app's opening in the steps' times the engine keeps (beyin_v3_ses.TIMES_FILE): on another computer
 * "Hey Pyn" took about a minute and nothing said which part was slow (1 November). The app writes when its
 * window's first frame was shown, timed from the process's start; the step's name and how long only.
 */

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sureler-'));

test('the file is the one the engine writes beside every vault state, or the one named', () => {
  assert.equal(timingsFile({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Local', 'beyin-v3', 'sureler.jsonl'));
  assert.equal(timingsFile({}, 'linux', '/home/a'), path.join('/home/a', '.local', 'state', 'beyin-v3', 'sureler.jsonl'));
  assert.equal(timingsFile({ XDG_STATE_HOME: '/x' }, 'linux', '/home/a'), path.join('/x', 'beyin-v3', 'sureler.jsonl'));
  assert.equal(timingsFile({}, 'darwin', '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'beyin-v3', 'sureler.jsonl'));
  assert.equal(timingsFile({ BEYIN_SURELER: '/t/s.jsonl' }, 'win32', 'C:\\Users\\a'), '/t/s.jsonl');
});

test('a line is when, the step and how long, as the engine writes it', () => {
  const line = timingLine('acilis', 2345.6, new Date(2026, 10, 24, 10, 12, 3));
  assert.ok(line);
  const said = JSON.parse(line);
  assert.deepEqual(Object.keys(said).sort(), ['adim', 'at', 'ms']);
  assert.equal(said.adim, 'acilis');
  assert.equal(said.ms, 2346);
  assert.match(said.at, /^2026-11-24T10:12:03[+-]\d\d:\d\d$/);
  assert.match(localMoment(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 25 * 3600_000]) assert.equal(timingLine('acilis', bad), null, String(bad));
});

test('a step not named is not written, whatever reached it past the type', () => {
  const dir = folder();
  const file = path.join(dir, 'sureler.jsonl');
  for (const step of ['baska', 'Yarın toplantı var', '']) {
    assert.equal(timingLine(step as unknown as 'acilis', 10), null, step);
    assert.equal(recordTime(step as unknown as 'acilis', 10, file), false, step);
  }
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the opening is written once a run, and a full file is kept aside', () => {
  const dir = folder();
  const file = path.join(dir, 'beyin-v3', 'sureler.jsonl');
  resetOpeningForTests();
  assert.equal(recordOpening(1500, file), true);
  assert.equal(recordOpening(9000, file), false, 'a window made again later is no opening');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.adim, line.ms]), [['acilis', 1500]]);
  fs.writeFileSync(file, 'x'.repeat(TIMINGS_MAX + 1));
  assert.equal(recordTime('acilis', 10, file), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.ok(fs.existsSync(`${file}.1`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that cannot be written is not the app trouble', () => {
  const dir = folder();
  const blocked = path.join(dir, 'dosya');
  fs.writeFileSync(blocked, '');
  assert.equal(recordTime('acilis', 10, path.join(blocked, 'sureler.jsonl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

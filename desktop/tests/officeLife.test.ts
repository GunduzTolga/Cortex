import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as art from '../src/office/office-art.js';
import { REACTIONS, hopAt, lightAt, lightForHour, lightOfMode, springStep } from '../src/office/ofis-engine.js';
import { enOf } from '../src/office/ofis-en.js';

/** The office's light following the clock by the minute, a click's reaction, the plants' spring. */

const close = (a: number[], b: number[], d = 1) => a.every((v, i) => Math.abs(v - b[i]) <= d);

test('the light holds each mode through the middle of its hours', () => {
  for (const [hour, mode] of [[3, 'gece'], [8, 'sabah'], [13, 'ogle'], [18.5, 'aksam'], [23, 'gece']] as const) {
    assert.equal(lightForHour(hour), mode);
    assert.deepEqual(lightAt(hour).tint, lightOfMode(mode).tint, `${hour}:00`);
    assert.equal(lightAt(hour).brainK, 0);
  }
});

test('the evening comes in by the minute: no jump between two minutes across the whole day', () => {
  let was = lightAt(0);
  let biggest = 0;
  for (let minute = 1; minute <= 24 * 60; minute++) {
    const now = lightAt(minute / 60);
    biggest = Math.max(biggest, ...now.tint.map((v, i) => Math.abs(v - was.tint[i])), Math.abs(now.glow - was.glow) * 1000);
    was = now;
  }
  // The pinned modes' tints are up to ~190 apart; spread over an hour it is a few levels a minute.
  assert.ok(biggest <= 8, `largest step in a minute: ${biggest}`);
  // Half-way through the fade into night it is neither evening nor night.
  const dusk = lightAt(20);
  assert.equal(dusk.brain, 'aksam');
  assert.equal(dusk.brainNext, 'gece');
  assert.ok(dusk.brainK > 0.3 && dusk.brainK < 0.7);
  assert.ok(!close(dusk.tint, lightOfMode('aksam').tint, 5) && !close(dusk.tint, lightOfMode('gece').tint, 5));
});

test('a click hops once and is still again', () => {
  assert.equal(hopAt(-0.1), 0);
  assert.ok(hopAt(0.18) > 2.5);
  assert.equal(hopAt(0.5), 0);
});

test('a pushed plant swings back to rest', () => {
  let [p, v] = [0, 1.2];
  let peak = 0;
  for (let i = 0; i < 60 * 3; i++) {
    [p, v] = springStep(p, v, 1 / 60);
    peak = Math.max(peak, Math.abs(p));
  }
  assert.ok(peak > 0.05, 'it moved');
  assert.ok(Math.abs(p) < 0.01 && Math.abs(v) < 0.05, `at rest after 3 s: ${p}, ${v}`);
});

test('everyone has a line when clicked, in both languages', () => {
  for (const id of Object.keys(art.CHARACTERS)) {
    assert.ok(REACTIONS[id], id);
    const same = ['Hmm?'];
    if (!same.includes(REACTIONS[id])) assert.notEqual(enOf(REACTIONS[id]), REACTIONS[id], `English for ${id}`);
  }
});

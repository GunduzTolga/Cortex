import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { WINDOW_MIN, onAScreen, readWindowState, windowStateOf } from '../electron/services/windowState';

/**
 * The window opened where it was left (electron/services/windowState.ts): maximized the first
 * time, at its own size and place after, never on a screen that is gone.
 */

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1040 }];
// The app's own folder is there before any window; the stub's is made by whoever writes first.
fs.mkdirSync(app.getPath('userData'), { recursive: true });

test('the first opening fills the screen: nothing kept, or something that is not a state', () => {
  fs.rmSync(path.join(app.getPath('userData'), 'window.json'), { force: true });
  assert.deepEqual(readWindowState(), { bounds: null, maximized: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), '{not json');
  assert.deepEqual(readWindowState(), { bounds: null, maximized: true });
  for (const kept of [null, 'big', 7, []]) assert.deepEqual(windowStateOf(kept, SCREEN), { bounds: null, maximized: true });
});

test('a size and place left is kept, and so is a window left unmaximized', () => {
  const kept = { bounds: { x: 100, y: 80, width: 1500, height: 950 }, maximized: false };
  fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify(kept));
  assert.deepEqual(readWindowState(), kept);
  assert.deepEqual(windowStateOf({ bounds: kept.bounds, maximized: true }, SCREEN), { bounds: kept.bounds, maximized: true });
  fs.rmSync(path.join(app.getPath('userData'), 'window.json'), { force: true });
});

test('a place on a screen no longer there is not reused; a size under the least is raised to it', () => {
  // On a second monitor to the right, since unplugged.
  assert.equal(windowStateOf({ bounds: { x: 2200, y: 100, width: 1400, height: 900 }, maximized: false }, SCREEN).bounds, null);
  // Mostly off the top: its title bar cannot be reached.
  assert.equal(onAScreen({ x: 200, y: -880, width: 1400, height: 900 }, SCREEN), false);
  // Half on the screen: still seen, still dragged.
  assert.equal(onAScreen({ x: 1200, y: 100, width: 1400, height: 900 }, SCREEN), true);
  const small = windowStateOf({ bounds: { x: 10, y: 10, width: 300, height: 200 }, maximized: false }, SCREEN).bounds;
  assert.deepEqual(small, { x: 10, y: 10, width: WINDOW_MIN.width, height: WINDOW_MIN.height });
  assert.equal(windowStateOf({ bounds: { x: Number.NaN, y: 0, width: 1400, height: 900 }, maximized: false }, SCREEN).bounds, null);
});

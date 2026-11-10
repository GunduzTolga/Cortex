import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { WINDOW_DEFAULT, WINDOW_MIN, minSizeOn, onAScreen, openSizeOn, readWindowState, windowSizesFor, windowStateOf } from '../electron/services/windowState';

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

test('on a small screen the least size comes down to the screen: the window is never held larger than its work area (G8)', () => {
  // 1366x768 at 150% and at 125%, less the taskbar, as Electron counts them (scaled pixels).
  const at150 = { x: 0, y: 0, width: 911, height: 472 };
  const at125 = { x: 0, y: 0, width: 1093, height: 574 };
  assert.deepEqual(minSizeOn(at150), { width: 911, height: 472 });
  assert.deepEqual(minSizeOn(at125), { width: WINDOW_MIN.width, height: 574 }, 'each side by itself');
  // Where the screen has the room, the least size is what it was; with no screen to ask, too.
  assert.deepEqual(minSizeOn(SCREEN[0]), WINDOW_MIN);
  assert.deepEqual(minSizeOn(null), WINDOW_MIN);
  assert.deepEqual(minSizeOn({ width: 0, height: 0 }), WINDOW_MIN);
  assert.notEqual(minSizeOn(null), WINDOW_MIN, 'a copy: nothing changes the constant through it');
  // The size it opens at, where none was kept, fits too.
  assert.deepEqual(openSizeOn(at150), { width: 911, height: 472 });
  assert.deepEqual(openSizeOn(SCREEN[0]), WINDOW_DEFAULT);
  // A size kept on that screen is read back as it was, not raised past the screen at the next start.
  const kept = { bounds: { x: 0, y: 0, width: 911, height: 472 }, maximized: false };
  assert.deepEqual(windowStateOf(kept, [at150]), kept);
  const tiny = windowStateOf({ bounds: { x: 0, y: 0, width: 300, height: 200 }, maximized: false }, [at150]).bounds;
  assert.deepEqual(tiny, { x: 0, y: 0, width: 911, height: 472 }, 'raised to that screen’s least, no further');
  // With no screen to ask (this stub has no main display), the sizes are the defaults.
  assert.deepEqual(windowSizesFor(null), { min: WINDOW_MIN, open: WINDOW_DEFAULT });
  // And the window is made with them: no fixed least size in the main process.
  const main = fs.readFileSync('electron/main.ts', 'utf8');
  assert.match(main, /minWidth: sizes\.min\.width,\s+minHeight: sizes\.min\.height/);
  assert.match(main, /windowSizesFor\(kept\.bounds\)/);
});

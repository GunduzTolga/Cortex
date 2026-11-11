import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { leavesWithBrowser, secondLaunchShows, startedHidden } from '../electron/services/quietStart';

/**
 * Cortex started to stay out of sight (electron/services/quietStart.ts, electron/main.ts): with Windows, or by Cortex
 * Browser when it finds Cortex closed (`Cortex.exe --gizli`). Started so a second time, while it runs, nothing
 * appears; and where the person keeps `background` off, a Cortex the browser started stays only while a browser is
 * there. The rules are plain functions; that main.ts follows them is read from its source, as its window's rules are
 * (tests/window.test.ts).
 */

const main = fs.readFileSync('electron/main.ts', 'utf8');

test('a second launch brings the window to the front, unless it asked to stay hidden', () => {
  assert.equal(secondLaunchShows(['C:\\Programs\\Cortex\\Cortex.exe']), true);
  assert.equal(secondLaunchShows(['C:\\Programs\\Cortex\\Cortex.exe', '--allow-file-access-from-files', '--gizli']), false, 'wherever Chromium puts the flag among its own');
  assert.equal(secondLaunchShows(['Cortex.exe', '--gizlilik', 'gizli', '--GIZLI']), true, 'only the flag itself');
  assert.equal(startedHidden(['Cortex.exe', '--gizli']), true);
  assert.equal(startedHidden(['Cortex.exe']), false);
  // main.ts hands the second launch's own arguments to the rule, and starts hidden by the same flag.
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) => \{[^}]*if \(secondLaunchShows\(argv\)\) showWindow\(\);/);
  assert.doesNotMatch(main, /app\.on\('second-instance', \(\) => showWindow\(\)\)/);
  assert.match(main, /const START_HIDDEN = \[startedHidden\(process\.argv\), startedByQuietInstall\(\)\]\.some\(Boolean\);/);
});

test('with `background` off, a Cortex started hidden leaves once the browser that needed it is gone, and only then', () => {
  const gone = { startedHidden: true, background: false, seen: false, hadBrowser: true, clients: 0, busy: false };
  assert.equal(leavesWithBrowser(gone), true);
  // The person's setting is theirs: with `background` on, Cortex stays in the notification area as it ever did.
  assert.equal(leavesWithBrowser({ ...gone, background: true }), false);
  // Opened by the person since: the window's own closing decides, as on any day.
  assert.equal(leavesWithBrowser({ ...gone, seen: true }), false);
  // A browser still there, or none ever was (started hidden by something else): it stays.
  assert.equal(leavesWithBrowser({ ...gone, clients: 1 }), false);
  assert.equal(leavesWithBrowser({ ...gone, hadBrowser: false }), false);
  // An answer still going, or a setup: not cut off.
  assert.equal(leavesWithBrowser({ ...gone, busy: true }), false);
  // Started by the person, in sight: never.
  assert.equal(leavesWithBrowser({ ...gone, startedHidden: false }), false);
});

test('main.ts opens the link once the app is ready, tells the browsers when it quits, and leaves by the rule alone', () => {
  assert.match(main, /void startBrowserLink\(\)/);
  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.match(quit, /quitting = true;[\s\S]*stopBrowserLink\(\);/, 'after the quit is certain: a quit held back for a setup closes nothing');
  assert.match(main, /if \(leavesWithBrowser\(state\)\) void quitWhenSetupAllows\(\);/);
  // The person's setting is read, never written, by the start in the background.
  assert.doesNotMatch(main, /updateSettings|background = /);
});

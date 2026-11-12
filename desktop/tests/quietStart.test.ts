import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { START_ARGUMENTS } from '../shared/browserLink';
import { asksForBrowserLink, leaveWatch, leavesWithBrowser, secondLaunchShows, startedHidden } from '../electron/services/quietStart';

/**
 * Cortex started to stay out of sight (electron/services/quietStart.ts, electron/main.ts): with Windows, or by Cortex
 * Browser when it finds Cortex closed (`Cortex.exe --gizli --tarayici`). Started so a second time, while it runs,
 * nothing appears, and the link is opened; and where the person keeps `background` off, a Cortex the browser started
 * stays only while a browser is there. The rules are plain functions, run here as the app runs them; that main.ts
 * hands them what happens is read from its source, as its window's rules are (tests/window.test.ts).
 */

const main = fs.readFileSync('electron/main.ts', 'utf8');

test('a second launch brings the window to the front, unless it asked to stay hidden; one that asks for the link opens it', () => {
  assert.equal(secondLaunchShows(['C:\\Programs\\Cortex\\Cortex.exe']), true);
  assert.equal(secondLaunchShows(['C:\\Programs\\Cortex\\Cortex.exe', '--allow-file-access-from-files', '--gizli']), false, 'wherever Chromium puts the flag among its own');
  assert.equal(secondLaunchShows(['Cortex.exe', '--gizlilik', 'gizli', '--GIZLI']), true, 'only the flag itself');
  assert.equal(startedHidden(['Cortex.exe', '--gizli']), true);
  assert.equal(startedHidden(['Cortex.exe']), false);
  // What the browser starts Cortex with is the contract's: hidden, and with the link opened.
  assert.deepEqual([startedHidden(['Cortex.exe', ...START_ARGUMENTS]), asksForBrowserLink(['Cortex.exe', ...START_ARGUMENTS])], [true, true]);
  assert.equal(asksForBrowserLink(['Cortex.exe', '--gizli']), false, 'started with Windows, nobody asked for the link');
  assert.equal(asksForBrowserLink(['Cortex.exe', '--tarayicilar', 'tarayici']), false);
  // main.ts hands the second launch's own arguments to the rules, and starts by the same flags.
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) => \{[^}]*if \(secondLaunchShows\(argv\)\) showWindow\(\);/);
  // The browser's word, not the person's switch: it opens nothing the person closed (services/browserLink.ts).
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) => \{[\s\S]*?if \(asksForBrowserLink\(argv\)\) void openBrowserLinkForBrowser\(\);/);
  assert.doesNotMatch(main, /setBrowserLinkOn/, 'the switch is the settings’ alone');
  assert.doesNotMatch(main, /app\.on\('second-instance', \(\) => showWindow\(\)\)/);
  assert.match(main, /const START_HIDDEN = \[startedHidden\(process\.argv\), startedByQuietInstall\(\)\]\.some\(Boolean\);/);
  assert.match(main, /void startBrowserLink\(\{ asked: asksForBrowserLink\(process\.argv\) \}\)/);
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

/** The watch with a clock of the test's: what it would run later, and when. */
function watched(start: { startedHidden?: boolean; background?: boolean } = {}) {
  const state = { startedHidden: true, background: false, seen: false, busy: false, ...start };
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
  let quits = 0;
  const heard = leaveWatch({
    state: () => state,
    quit: () => (quits += 1),
    after: 30_000,
    later: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => ((timer as { live: boolean }).live = false),
  });
  const due = () => timers.filter((one) => one.live);
  const fire = () => {
    const [next] = due();
    next.live = false;
    next.run();
  };
  return { state, heard, due, fire, quits: () => quits };
}

test('the watch, as the app runs it: gone a while, Cortex quits; back in time, it stays; busy, it looks again', () => {
  // The browser comes and goes: looked at a while after, and quit.
  const one = watched();
  one.heard(0);
  assert.equal(one.due().length, 0, 'no browser yet: nothing is waited for');
  one.heard(1);
  one.heard(0);
  assert.deepEqual(one.due().map((timer) => timer.ms), [30_000]);
  assert.equal(one.quits(), 0, 'not at once: a browser that only starts again is back before then');
  one.fire();
  assert.equal(one.quits(), 1);
  assert.equal(one.due().length, 0);

  // Back before the wait is over: the wait is called off, however often it comes and goes.
  const two = watched();
  two.heard(1);
  two.heard(0);
  two.heard(1);
  assert.equal(two.due().length, 0);
  two.heard(0);
  two.heard(0);
  assert.equal(two.due().length, 1, 'one wait, not one for each word');
  two.heard(2);
  two.heard(1);
  assert.equal(two.due().length, 0, 'a browser still there');
  assert.equal(two.quits(), 0);

  // An answer still going when the wait is over: not cut off, looked at again; then quit.
  const three = watched();
  three.heard(1);
  three.heard(0);
  three.state.busy = true;
  three.fire();
  assert.deepEqual([three.quits(), three.due().length], [0, 1]);
  three.state.busy = false;
  three.fire();
  assert.equal(three.quits(), 1);

  // Opened by the person meanwhile: theirs now, and nothing more is waited for.
  const four = watched();
  four.heard(1);
  four.heard(0);
  four.state.seen = true;
  four.fire();
  assert.deepEqual([four.quits(), four.due().length], [0, 0]);

  // `background` on, or not started hidden: Cortex is not the browser's to end.
  for (const kept of [watched({ background: true }), watched({ startedHidden: false })]) {
    kept.heard(1);
    kept.heard(0);
    while (kept.due().length) kept.fire();
    assert.equal(kept.quits(), 0);
  }
});

test('main.ts opens the link once the app is ready, tells the browsers when it quits, and leaves by the watch alone', () => {
  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.match(quit, /quitting = true;[\s\S]*stopBrowserLink\(\);/, 'after the quit is certain: a quit held back for a setup closes nothing');
  assert.match(main, /onBrowsersThere\(\s*leaveWatch\(\{/);
  assert.match(main, /quit: \(\) => void quitWhenSetupAllows\(\)/);
  // The person's setting is read, never written, by the start in the background.
  assert.doesNotMatch(main, /updateSettings|background = /);
});

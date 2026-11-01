import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHECK_EVERY, FIRST_CHECK, forgetUpdates, installUpdate, pendingUpdate, startUpdates, updatesWanted, type Updater } from '../electron/services/updater';

/**
 * The app keeping itself up to date from the releases (electron/services/updater.ts): only an installed app on
 * Windows asks, a downloaded update is told once and waits for the person, and installing it is refused while a
 * setup runs. electron-updater and the clock are stood in for; what it reads on a release is checked where the
 * build and the release workflow write it.
 */

function fakeUpdater() {
  const listeners = new Map<string, (arg: never) => void>();
  const calls = { checks: 0, installs: [] as unknown[][] };
  const updater: Updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on: (event: string, listener: (arg: never) => void) => listeners.set(event, listener),
    checkForUpdates: async () => {
      calls.checks += 1;
      return null;
    },
    quitAndInstall: (...args: unknown[]) => void calls.installs.push(args),
  } as Updater;
  const emit = (event: string, arg: unknown) => (listeners.get(event) as (value: unknown) => void)(arg);
  return { updater, calls, emit };
}

function fakeClock() {
  const timers: { run: () => void; ms: number; repeat: boolean }[] = [];
  return {
    timers,
    schedule: {
      after: (run: () => void, ms: number) => void timers.push({ run, ms, repeat: false }),
      every: (run: () => void, ms: number) => void timers.push({ run, ms, repeat: true }),
    },
  };
}

test('only an installed Cortex on Windows follows the releases, and never in the end-to-end run or when turned off', () => {
  assert.equal(updatesWanted({}, 'win32', true), true);
  assert.equal(updatesWanted({}, 'win32', false), false, 'a build run from the source tree');
  assert.equal(updatesWanted({}, 'linux', true), false);
  assert.equal(updatesWanted({ CORTEX_HIDDEN: '1' }, 'win32', true), false);
  assert.equal(updatesWanted({ CORTEX_NO_UPDATE: '1' }, 'win32', true), false);
});

test('a newer Cortex is fetched in the background, told once it is ready, and not looked for again until installed', async () => {
  forgetUpdates();
  const { updater, calls, emit } = fakeUpdater();
  const clock = fakeClock();
  const told: unknown[] = [];
  await startUpdates((update) => told.push(update), async () => updater, clock.schedule);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true, 'unanswered, it is installed at the next quit');
  assert.deepEqual(clock.timers.map(({ ms, repeat }) => [ms, repeat]), [[FIRST_CHECK, false], [CHECK_EVERY, true]]);
  clock.timers[0].run();
  assert.equal(calls.checks, 1);
  assert.equal(pendingUpdate(), null);
  emit('update-downloaded', { version: '1.0.43' });
  assert.deepEqual(told, [{ version: '1.0.43' }]);
  assert.deepEqual(pendingUpdate(), { version: '1.0.43' }, 'a window opened later asks for it');
  clock.timers[1].run();
  assert.equal(calls.checks, 1, 'nothing more to fetch while one waits');
  // A failed check is quiet: no throw, no word to the person.
  emit('error', new Error('getaddrinfo ENOTFOUND api.github.com'));
  forgetUpdates();
});

test('installing it now is refused while a setup runs, and with none waiting; otherwise the app quits into the installer', async () => {
  forgetUpdates();
  assert.deepEqual(installUpdate(false), { installed: false, reason: 'none' });
  const { updater, calls, emit } = fakeUpdater();
  await startUpdates(() => undefined, async () => updater, fakeClock().schedule);
  assert.deepEqual(installUpdate(false), { installed: false, reason: 'none' }, 'started, nothing downloaded yet');
  emit('update-downloaded', { version: '1.0.43' });
  assert.deepEqual(installUpdate(true), { installed: false, reason: 'busy' });
  assert.deepEqual(calls.installs, []);
  assert.deepEqual(installUpdate(false), { installed: true });
  assert.deepEqual(calls.installs, [[true, true]], 'without the installer’s pages, and Cortex opened again after');
  forgetUpdates();
});

test('the build writes what the updater reads beside the installer, and a release carries it', () => {
  const build = JSON.parse(fs.readFileSync('package.json', 'utf8')).build;
  assert.deepEqual(build.publish, [{ provider: 'github', owner: 'GunduzTolga', repo: 'Cortex', releaseType: 'release' }]);
  assert.equal(build.nsis.artifactName, 'Cortex-Setup-${version}.${ext}', 'no spaces: GitHub turns one in an asset name into a dot');
  const release = fs.readFileSync('../.github/workflows/release.yml', 'utf8');
  assert.match(release, /gh release upload "v\$VERSION" "Cortex-Setup-\$VERSION\.exe" "Cortex-Setup-\$VERSION\.exe\.blockmap" latest\.yml/);
  assert.match(release, /"Cortex-Setup-\$VERSION\.exe\.blockmap" latest\.yml; do/, 'not published without them');
  const desktop = fs.readFileSync('../.github/workflows/desktop.yml', 'utf8');
  assert.match(desktop, /grep -Fq "path: Cortex-Setup-\$version\.exe" release\/latest\.yml/);
});

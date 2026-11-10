import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetSettings, updateSettings } from '../electron/services/settings';
import { RELEASES_PAGE } from '../shared/api';
import { en } from '../src/i18n/en';
import { tr } from '../src/i18n/tr';
import { CHECK_EVERY, FIRST_CHECK, RETRY_AFTER, TROUBLE_AFTER, forgetUpdates, installUpdate, onUpdateTrouble, pendingUpdate, quietAttempt, startUpdates, startedByQuietInstall, updatesSwitchedOn, updatesWanted, type UpdateTrouble, type Updater } from '../electron/services/updater';

/**
 * The app keeping itself up to date from the releases (electron/services/updater.ts): only an installed app on
 * Windows asks, a downloaded update is told once and waits for the person, and installing it is refused while a
 * setup runs; started with Windows and not yet seen, it is installed unasked. electron-updater and the clock are
 * stood in for; what it reads on a release is checked where the build and the release workflow write it.
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
  await startUpdates((update) => told.push(update), null, async () => updater, clock.schedule);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true, 'unanswered, it is installed at the next quit');
  // No word that nobody is interrupted: nothing is installed unasked.
  assert.deepEqual(calls.installs, []);
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

test('turned off in the settings, nothing is asked of GitHub and nothing fetched; turned on again, it is asked at once (G2)', async () => {
  // 10 November: the installer (some 160 MB) came down unasked, and only an environment variable stopped it.
  forgetUpdates();
  forgetSettings();
  try {
    const { updater, calls } = fakeUpdater();
    const clock = fakeClock();
    updateSettings((settings) => {
      settings.autoUpdate = false;
    });
    await startUpdates(() => undefined, null, async () => updater, clock.schedule);
    clock.timers[0].run();
    clock.timers[1].run();
    assert.equal(calls.checks, 0, 'off: neither the first look nor the ones every few hours');
    updatesSwitchedOn();
    assert.equal(calls.checks, 0, 'still off: the switch has not moved');
    updateSettings((settings) => {
      settings.autoUpdate = true;
    });
    updatesSwitchedOn();
    assert.equal(calls.checks, 1, 'on: asked now, not hours later');
    clock.timers[1].run();
    assert.equal(calls.checks, 2);
    // Off again while it runs: the next round asks nothing.
    updateSettings((settings) => {
      settings.autoUpdate = false;
    });
    clock.timers[1].run();
    assert.equal(calls.checks, 2);
  } finally {
    updateSettings((settings) => {
      settings.autoUpdate = true;
    });
    forgetUpdates();
  }
});

test('a newer version that will not come down twice running is said once; a check that fails with none known stays quiet (G4)', async () => {
  forgetUpdates();
  const { updater, calls, emit } = fakeUpdater();
  const clock = fakeClock();
  const said: UpdateTrouble[] = [];
  onUpdateTrouble((word) => said.push(word));
  await startUpdates(() => undefined, null, async () => updater, clock.schedule);
  // No newer version known: GitHub out of reach is not news, however often, and nothing is tried sooner for it.
  for (let i = 0; i < 5; i += 1) emit('error', new Error('getaddrinfo ENOTFOUND api.github.com'));
  assert.deepEqual(said, []);
  assert.equal(clock.timers.length, 2);
  // One is found and its download fails: once is a bad moment, tried again in ten minutes, not six hours.
  assert.equal(TROUBLE_AFTER, 2);
  emit('update-available', { version: '1.0.62' });
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.deepEqual(said, []);
  assert.deepEqual(clock.timers.slice(2).map(({ ms, repeat }) => [ms, repeat]), [[RETRY_AFTER, false]]);
  assert.ok(RETRY_AFTER < CHECK_EVERY / 6);
  clock.timers[2].run();
  assert.equal(calls.checks, 1, 'the retry asks again');
  // Twice running is said.
  emit('update-available', { version: '1.0.62' });
  emit('error', new Error('sha512 checksum mismatch'));
  assert.deepEqual(said, [{ kind: 'download', version: '1.0.62' }]);
  assert.equal(clock.timers.length, 3, 'one retry for a version, not one after every failure');
  // Not said again for the same version, at every round after.
  emit('update-available', { version: '1.0.62' });
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.equal(said.length, 1);
  // A newer one starts its own count.
  emit('update-available', { version: '1.0.63' });
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.equal(said.length, 1);
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.deepEqual(said.at(-1), { kind: 'download', version: '1.0.63' });
  // Downloaded in the end: nothing more is said, whatever fails after.
  emit('update-downloaded', { version: '1.0.63' });
  emit('error', new Error('late'));
  assert.equal(said.length, 2);
  forgetUpdates();
});

test('a failure between two downloads that went wrong is counted from the start again once one goes through (G4)', async () => {
  forgetUpdates();
  const { updater, emit } = fakeUpdater();
  const said: UpdateTrouble[] = [];
  onUpdateTrouble((word) => said.push(word));
  await startUpdates(() => undefined, null, async () => updater, fakeClock().schedule);
  emit('update-available', { version: '1.0.62' });
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  // Another version named before the second failure: the count is that version's own.
  emit('update-available', { version: '1.0.63' });
  emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.deepEqual(said, [], 'one failure each is not two running');
  forgetUpdates();
});

test('installing it now is refused while a setup runs, and with none waiting; otherwise the app quits into the installer', async () => {
  forgetUpdates();
  assert.deepEqual(installUpdate(false), { installed: false, reason: 'none' });
  const { updater, calls, emit } = fakeUpdater();
  await startUpdates(() => undefined, null, async () => updater, fakeClock().schedule);
  assert.deepEqual(installUpdate(false), { installed: false, reason: 'none' }, 'started, nothing downloaded yet');
  emit('update-downloaded', { version: '1.0.43' });
  assert.deepEqual(installUpdate(true), { installed: false, reason: 'busy' });
  assert.deepEqual(calls.installs, []);
  assert.deepEqual(installUpdate(false), { installed: true });
  assert.deepEqual(calls.installs, [[true, true]], 'without the installer’s pages, and Cortex opened again after');
  forgetUpdates();
});

test('started with Windows and not yet seen, a waiting update is installed unasked, and the start the installer makes stays unseen', async () => {
  // 10 November: 1.0.59 was downloaded on the 7th, "installed when Cortex restarts"; a Windows start and an app start
  // later Cortex was still 1.0.56. Windows ending the session never emits the app's `quit`, where it was to be installed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-quiet-'));
  const file = path.join(dir, 'update-quiet.json');
  try {
    forgetUpdates();
    const { updater, calls, emit } = fakeUpdater();
    const told: unknown[] = [];
    let unseen = false;
    await startUpdates((update) => told.push(update), { unseen: () => unseen, file }, async () => updater, fakeClock().schedule);
    // The window open, or something running: told, and left to the person.
    emit('update-downloaded', { version: '1.0.61' });
    assert.deepEqual(told, [{ version: '1.0.61' }]);
    assert.deepEqual(calls.installs, []);
    assert.equal(quietAttempt(file), null);
    // Unseen: installed now, without a word, the version written down first.
    unseen = true;
    emit('update-downloaded', { version: '1.0.61' });
    assert.deepEqual(calls.installs, [[true, true]], 'without the installer’s pages, and Cortex opened again after');
    assert.equal(told.length, 1, 'nothing more said');
    assert.equal(quietAttempt(file), '1.0.61');

    // The start the installer makes (`--updated`), now that version: unseen too, and nothing is kept.
    assert.equal(startedByQuietInstall(['Cortex.exe', '--updated'], '1.0.61', file), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(startedByQuietInstall(['Cortex.exe', '--updated'], '1.0.61', file), false, 'a restart the person asked for opens the window');
    assert.equal(startedByQuietInstall(['Cortex.exe', '--gizli'], '1.0.61', file), false);

    // An installer that did not install: that version is not begun unasked again, at this start or a later one.
    emit('update-downloaded', { version: '1.0.62' });
    assert.equal(calls.installs.length, 2);
    assert.equal(startedByQuietInstall(['Cortex.exe', '--updated'], '1.0.61', file), true, 'its own start, still unseen');
    assert.equal(startedByQuietInstall(['Cortex.exe', '--updated'], '1.0.61', file), false, 'and no later one');
    const troubles: UpdateTrouble[] = [];
    onUpdateTrouble((word) => troubles.push(word));
    emit('update-downloaded', { version: '1.0.62' });
    assert.equal(calls.installs.length, 2, 'not run again at every start');
    assert.deepEqual(told.at(-1), { version: '1.0.62' }, 'it waits for the person, as before');
    // G4: and the person is told it did not install by itself, where before nothing said why Cortex stayed as it was.
    assert.deepEqual(troubles, [{ kind: 'install', version: '1.0.62' }]);
    // A newer one is.
    emit('update-downloaded', { version: '1.0.63' });
    assert.equal(calls.installs.length, 3);

    // Where the version cannot be written down, nothing is begun: it would be begun at every start.
    forgetUpdates();
    const second = fakeUpdater();
    const said: unknown[] = [];
    await startUpdates((update) => said.push(update), { unseen: () => true, file: path.join(dir, 'update-quiet.json', 'no-folder-here', 'x.json') }, async () => second.updater, fakeClock().schedule);
    second.emit('update-downloaded', { version: '1.0.64' });
    assert.deepEqual(second.calls.installs, []);
    assert.deepEqual(said, [{ version: '1.0.64' }]);
  } finally {
    forgetUpdates();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('the switch is in the settings beside the releases page, and the documents say what the updater does in the same words (G2, G3)', () => {
  // 10 November: the README said the one automatic request "can be turned off" (only an environment variable did),
  // KULLANIM said in one place that the app never updates itself and in another that it does, desktop/README "no
  // automatic update".
  const dialog = fs.readFileSync('src/ui/SettingsDialog.tsx', 'utf8');
  assert.match(dialog, /<Switch checked=\{settings\.autoUpdate\} onChange=\{\(on\) => void set\(\{ autoUpdate: on \}\)\} label=\{t\('settings\.autoUpdate'\)\} hint=\{t\('settings\.autoUpdate\.hint'\)\}/);
  assert.match(dialog, /href=\{RELEASES_PAGE\} target="_blank"/);
  assert.equal(RELEASES_PAGE, 'https://github.com/GunduzTolga/Cortex/releases/latest');
  const readme = fs.readFileSync('../README.md', 'utf8');
  const guide = fs.readFileSync('../docs/KULLANIM.md', 'utf8');
  const desktop = fs.readFileSync('README.md', 'utf8');
  assert.ok(readme.includes(`(${RELEASES_PAGE})`), 'the page the settings open is the one the README sends people to');
  // Named as the settings name it, in each document, and in the README's English part.
  for (const [name, text] of [['README.md', readme], ['docs/KULLANIM.md', guide], ['desktop/README.md', desktop]] as const) {
    assert.ok(text.includes(tr['settings.autoUpdate']), `${name} names the switch`);
  }
  assert.ok(readme.includes(en['settings.autoUpdate']));
  // The times said are the code's: half a minute after the start, then every six hours.
  assert.deepEqual([FIRST_CHECK, CHECK_EVERY], [30_000, 6 * 60 * 60_000]);
  for (const text of [readme, guide, tr['settings.autoUpdate.hint']]) {
    assert.match(text, /yarım dakika sonra/);
    assert.match(text, /6 saatte bir/);
  }
  assert.match(desktop, /30 saniye sonra ve 6 saatte bir/);
  // What they said before, and the code never did.
  assert.doesNotMatch(readme, /Tek otomatik ağ isteği|only automatic network request is an update check/);
  assert.doesNotMatch(guide, /Uygulama kendiliğinden güncellenmez|Kendiliğinden yapılan tek istek/);
  assert.doesNotMatch(desktop, /Otomatik güncelleme yok|uygulama hiçbir yere sürüm sormuyor/);
});

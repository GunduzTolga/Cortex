import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppUpdate, UpdateInstall } from '../../shared/api';
import { writeWhole } from './fileWrite';
import { readSettings } from './settings';

/**
 * The app keeping itself up to date from the repository's releases, as the vault's engine already does with its
 * package (beyin_v3_update.py). electron-updater reads `latest.yml` on the latest release - which the release
 * workflow puts there beside the installer (.github/workflows/release.yml) - fetches a newer installer in the
 * background, checks its SHA-512 against that file, and runs it when the app quits.
 *
 * Only an installed app on Windows asks: a build run from the source tree has no release to follow, and the
 * end-to-end run (CORTEX_HIDDEN) must not reach the network. A person who installs by hand turns it off in the
 * settings ("Güncellemeleri kendiliğinden indir", `autoUpdate`; CORTEX_NO_UPDATE does the same from outside): off,
 * nothing is asked of GitHub at all, and nothing fetched - 10 November: the installer (some 160 MB) came down unasked
 * and only an environment variable stopped it, while the README said it could be turned off. A check that cannot
 * reach GitHub is quiet: the next one is in a few hours. A newer version found and not fetched twice running is said
 * once (`onUpdateTrouble`): before, a person never learnt why Cortex stayed as it was.
 *
 * What it is told is said once it is ready to install, not while it downloads: the person decides when to restart.
 * Unanswered, the installer runs the next time the app quits (autoInstallOnAppQuit), or, for an app that starts with
 * Windows and is never quit, at its next start there, before anybody has opened it (QuietInstall).
 */

/** The first look a while after the start, not in its busiest seconds; then a few times a day. */
export const FIRST_CHECK = 30_000;
export const CHECK_EVERY = 6 * 60 * 60_000;
/** A version found and not fetched this many times running is said to the person. */
export const TROUBLE_AFTER = 2;
/**
 * A version found whose download failed is tried once more after this long, not at the next round six hours on: a
 * passing fault mends itself, and a lasting one is said while the person is still at the computer.
 */
export const RETRY_AFTER = 10 * 60_000;

/**
 * What the person is told went wrong, once for a version: it was found on GitHub and could not be fetched or checked
 * (`download`), or it had been begun unasked at a start with Windows and Cortex is still the older one (`install`).
 */
export interface UpdateTrouble {
  kind: 'download' | 'install';
  version: string;
}

/** What of electron-updater's AppUpdater this uses: the tests stand in for it. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/**
 * An update installed unasked, where nobody is interrupted. 10 November: 1.0.59 had been downloaded on the 7th and the
 * notification area said it would be installed when Cortex restarted; a Windows start and an app start later, Cortex
 * was still 1.0.56. Windows ending the session does not emit the app's `quit` (Electron: "will not be emitted if the
 * app is closed due to a shutdown/restart of the system or a user logout"), so autoInstallOnAppQuit never ran for an
 * app that starts with Windows and lives in the notification area: only "Yeniden başlat" in the window, or the icon's
 * "Çıkış", installed anything.
 *
 * `unseen` is the app's word that nobody is interrupted: started with Windows, its window not opened since, nothing
 * running (electron/main.ts, ipc.ts). The version is written down first (`file`), for the start the installer then
 * makes: that one stays in the notification area too (startedByQuietInstall), and an installer that did not install is
 * not run again at every start - that version waits for the person, as before.
 */
export interface QuietInstall {
  unseen: () => boolean;
  file: string;
}

interface QuietKept {
  version: string;
  /** The start after it found another version running: the installer did not install it. */
  failed?: boolean;
}

export const quietFile = (): string => path.join(app.getPath('userData'), 'update-quiet.json');

function readQuiet(file: string): QuietKept | null {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<QuietKept> | null;
    return kept && typeof kept.version === 'string' ? { version: kept.version, failed: kept.failed === true } : null;
  } catch {
    return null;
  }
}

/** The version a quiet install was last begun for, where one is written down: installed since, nothing is. */
export function quietAttempt(file: string = quietFile()): string | null {
  return readQuiet(file)?.version ?? null;
}

/**
 * Whether this start is the installer's after a quiet install (it starts the app with `--updated`): the window then
 * stays closed, as at the start with Windows it took the place of. Asked once, at the start: installed, what was
 * written down is forgotten; not installed, it is kept as failed, and no later start is taken for the installer's.
 */
export function startedByQuietInstall(argv: readonly string[] = process.argv, version: string = app.getVersion(), file: string = quietFile()): boolean {
  const kept = readQuiet(file);
  if (!kept || kept.failed) return false;
  try {
    if (kept.version === version) fs.rmSync(file, { force: true });
    else writeWhole(file, JSON.stringify({ version: kept.version, failed: true }));
  } catch {
    /* Read again at the next start. */
  }
  return argv.includes('--updated');
}

let updater: Updater | null = null;
let ready: AppUpdate | null = null;
let checkNow: () => void = () => undefined;
let trouble: (word: UpdateTrouble) => void = () => undefined;

/** Where a version that would not come down, or would not install, is heard: once for each (electron/ipc.ts says it). */
export function onUpdateTrouble(listener: (word: UpdateTrouble) => void): void {
  trouble = listener;
}

/** Whether the person lets Cortex ask GitHub and fetch a newer one by itself (Settings › Hakkında); read at every check. */
const allowed = (): boolean => readSettings().autoUpdate;

/** Installed now, unasked, where nobody is interrupted and this version was not begun so before; whether it was begun. */
function installQuietly(quiet: QuietInstall, version: string): boolean {
  if (!updater || !quiet.unseen() || quietAttempt(quiet.file) === version) return false;
  try {
    // Written down before the installer runs: one that cannot be remembered is not begun, or it would be at every start.
    writeWhole(quiet.file, JSON.stringify({ version }));
  } catch {
    return false;
  }
  updater.quitAndInstall(true, true);
  return true;
}

/** Whether this app follows the releases at all. */
export function updatesWanted(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, packaged: boolean = app.isPackaged): boolean {
  return packaged && platform === 'win32' && !env.CORTEX_HIDDEN && !env.CORTEX_NO_UPDATE;
}

async function loadUpdater(): Promise<Updater> {
  const { autoUpdater } = await import('electron-updater');
  return autoUpdater as unknown as Updater;
}

/**
 * Following the releases, from the app's start: `tell` hears of an update once it is downloaded and checked, unless
 * it is installed unasked (`quiet`). `load` and the timers stand in for electron-updater and the clock in the tests.
 */
export async function startUpdates(
  tell: (update: AppUpdate) => void,
  quiet: QuietInstall | null = null,
  load: () => Promise<Updater> = loadUpdater,
  schedule: { after: (run: () => void, ms: number) => void; every: (run: () => void, ms: number) => void } = {
    after: (run, ms) => setTimeout(run, ms).unref(),
    every: (run, ms) => setInterval(run, ms).unref(),
  },
): Promise<void> {
  if (updater) return;
  updater = await load();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // Its own log goes to the console: a person never sees a failed check, the developer can.
  updater.logger = { info: () => undefined, warn: console.warn, error: console.warn, debug: () => undefined };
  const check = (): void => {
    // Once one is waiting there is nothing more to fetch until it is installed. Turned off, nothing is asked at all.
    if (ready || !updater || !allowed()) return;
    void updater.checkForUpdates().catch((err: unknown) => console.warn('[updates]', err instanceof Error ? err.message : err));
  };
  checkNow = check;
  // The newer version GitHub named, and how many times running it then failed to come down; said once for a version.
  let found: string | null = null;
  let failures = 0;
  let saidFor: string | null = null;
  let retriedFor: string | null = null;
  updater.on('update-available', (info) => {
    const version = String(info.version);
    if (version !== found) failures = 0;
    found = version;
  });
  updater.on('update-downloaded', (info) => {
    ready = { version: String(info.version) };
    failures = 0;
    if (quiet && installQuietly(quiet, ready.version)) return;
    // Begun unasked at an earlier start and Cortex is still the older one (startedByQuietInstall wrote it down): said.
    if (quiet && readQuiet(quiet.file)?.version === ready.version) trouble({ kind: 'install', version: ready.version });
    tell(ready);
  });
  updater.on('error', (err) => {
    console.warn('[updates]', err.message);
    // With no newer version known, a check that failed stays quiet: there may be nothing to fetch.
    if (!found || ready) return;
    failures += 1;
    if (retriedFor !== found) {
      retriedFor = found;
      schedule.after(check, RETRY_AFTER);
    }
    if (failures < TROUBLE_AFTER || saidFor === found) return;
    saidFor = found;
    trouble({ kind: 'download', version: found });
  });
  schedule.after(check, FIRST_CHECK);
  schedule.every(check, CHECK_EVERY);
}

/** The switch turned on (Settings › Hakkında): asked now, not at the next round hours away. */
export function updatesSwitchedOn(): void {
  checkNow();
}

/** The update downloaded and waiting, if one is: asked by a window opened after it was told. */
export function pendingUpdate(): AppUpdate | null {
  return ready;
}

/**
 * Installed now: the app quits, the installer runs without its pages (the person chose this) and opens Cortex again.
 * Not while a setup job runs, which quitting would cut short (electron/main.ts, quitWhenSetupAllows): the person is
 * told to try again once it has finished, and it is installed at the next quit anyway.
 */
export function installUpdate(busy: boolean): UpdateInstall {
  if (!ready || !updater) return { installed: false, reason: 'none' };
  if (busy) return { installed: false, reason: 'busy' };
  updater.quitAndInstall(true, true);
  return { installed: true };
}

/** For the tests: as before any start. */
export function forgetUpdates(): void {
  updater = null;
  ready = null;
  checkNow = () => undefined;
  trouble = () => undefined;
}

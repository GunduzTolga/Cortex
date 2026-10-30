import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SyncState, type SyncStatus, remoteLabel, secretsAdded } from '../../shared/vaultSync';
import { onPathFile } from './clis';
import { readSettings, updateSettings } from './settings';

/**
 * The vault kept in step with the git remote its branch follows, by the rules a server's own sync script keeps
 * (shared/vaultSync.ts): everything added, the new lines scanned for a secret, commit, pull with rebase, push.
 * When: the app's start and a vault opened, every few minutes, a little after a file in the vault changes (a note
 * saved here, or written by an agent), and once more as the app quits. One at a time.
 *
 * Nothing is ever written over: a conflict is backed out of (`rebase --abort`) and said, the notes left as they were
 * on both sides; a secret in a new line stops it before the commit; with no network the notes stay here and go the
 * next time. Off (the default), nothing leaves the computer. Git is the person's own, on the PATH; Cortex brings none,
 * and asks no password: git is told never to prompt, and a remote it cannot reach is said as such.
 */

const EVERY_MS = 5 * 60_000;
const AFTER_CHANGE_MS = 30_000;
const QUIT_WAIT_MS = 12_000;
const GIT_TIMEOUT_MS = 120_000;
/** A remote that could not be reached (no network, the host down, the credentials refused) rather than a conflict. */
const UNREACHABLE = /could not resolve host|unable to access|failed to connect|connection (?:timed out|refused|reset)|network is unreachable|could not read from remote repository|authentication failed|timed out/i;

interface GitResult {
  code: number;
  out: string;
  err: string;
}
type Git = (args: string[], cwd: string, timeout?: number) => Promise<GitResult>;

/**
 * Git's own program, found on the PATH alone and never inside the folder it works on: run by its bare name with the
 * vault as its folder, Windows looks in that folder first, and a git.exe there (one a remote brought) would have run.
 */
export function gitProgram(folder: string): string | null {
  const inside = (file: string) => {
    const relative = path.relative(path.resolve(folder), file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  return onPathFile([process.platform === 'win32' ? 'git.exe' : 'git'], process.env, (file) => path.isAbsolute(file) && !inside(file));
}

const realGit: Git = (args, cwd, timeout = GIT_TIMEOUT_MS) =>
  new Promise((done) => {
    const program = gitProgram(cwd);
    if (!program) return done({ code: 127, out: '', err: 'git not found' });
    execFile(
      program,
      [
        // The vault named, not made the working folder (see gitProgram).
        '-C',
        cwd,
        // Paths as they are written (the vault's emoji and Turkish folders), not quoted in octal escapes.
        '-c',
        'core.quotepath=false',
        // Nothing of the repository's own runs in a sync: no hooks, no file-system monitor program.
        '-c',
        `core.hooksPath=${os.devNull}`,
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd: os.homedir(),
        timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        // Never a prompt for a name or a password (a console, or Git Credential Manager's window): it fails instead.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', LANG: 'C' },
      },
      (error, out, err) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : 127) : 0;
        done({ code, out: String(out ?? ''), err: String(err ?? '') });
      },
    );
  });
let git: Git = realGit;
/** The tests stand in for git's failures; everything else they run with the real git. */
export function setVaultSyncGit(stand: Git | null): void {
  git = stand ?? realGit;
}

let state: SyncState = 'idle';
let detail: string[] = [];
let lastSyncedAt: number | null = null;
let syncedVault: string | null = null;
let running: Promise<void> | null = null;
let again = false;
let every: ReturnType<typeof setInterval> | null = null;
let soon: ReturnType<typeof setTimeout> | null = null;
/** File changes the sync makes itself (what a pull brings) are no reason to sync again. */
let quietUntil = 0;
let tell: (status: SyncStatus) => void = () => undefined;
let trouble: (state: SyncState, detail: string[]) => void = () => undefined;

/** Where the window hears every change of the status. */
export function onVaultSync(listener: (status: SyncStatus) => void): void {
  tell = listener;
}
/** Where a conflict, a secret or an error is said once, as it begins (a toast). */
export function onVaultSyncTrouble(listener: (state: SyncState, detail: string[]) => void): void {
  trouble = listener;
}

const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';
const sameFolder = (a: string, b: string) => {
  const key = (one: string) => {
    let full = path.resolve(one);
    try {
      full = fs.realpathSync.native(full);
    } catch {
      /* as written */
    }
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  return key(a) === key(b);
};

/** What the vault offers: git there, a repository at its top, a branch that follows a remote one, and the remote's name. */
async function inspect(vault: string | null): Promise<Pick<SyncStatus, 'available' | 'missing' | 'remote'>> {
  const version = await git(['--version'], vault && fs.existsSync(vault) ? vault : os.homedir(), 15_000);
  if (version.code !== 0) return { available: false, missing: 'git', remote: null };
  if (!vault || !fs.existsSync(vault)) return { available: false, missing: 'repo', remote: null };
  const top = await git(['rev-parse', '--show-toplevel'], vault, 15_000);
  if (top.code !== 0 || !sameFolder(top.out.trim(), vault)) return { available: false, missing: 'repo', remote: null };
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], vault, 15_000);
  if (upstream.code !== 0 || !upstream.out.trim()) return { available: false, missing: 'remote', remote: null };
  const name = upstream.out.trim().split('/')[0];
  const url = await git(['remote', 'get-url', name], vault, 15_000);
  return { available: true, missing: null, remote: url.code === 0 ? remoteLabel(url.out) : null };
}

export async function vaultSyncStatus(): Promise<SyncStatus> {
  const vault = readSettings().vault;
  if (vault !== syncedVault) {
    // Another vault: what was said of the last one is not said of this one.
    syncedVault = vault;
    state = 'idle';
    detail = [];
    lastSyncedAt = null;
  }
  return { ...(await inspect(vault)), on: readSettings().vaultSync, state, lastSyncedAt, detail };
}

async function say(next: SyncState, said: string[] = []): Promise<void> {
  const before = state;
  state = next;
  detail = said;
  if (next !== before && (next === 'conflict' || next === 'secret' || next === 'error')) trouble(next, said);
  tell(await vaultSyncStatus());
}

const stamp = (when: Date) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(when.getDate())}.${two(when.getMonth() + 1)}.${when.getFullYear()} ${two(when.getHours())}:${two(when.getMinutes())}`;
};

async function syncOnce(vault: string): Promise<void> {
  await say('syncing', detail);
  const run = (args: string[]) => git(args, vault);
  // A rebase left standing (a conflict being solved by hand) is the person's: nothing is done over it.
  if (fs.existsSync(path.join(vault, '.git', 'rebase-merge')) || fs.existsSync(path.join(vault, '.git', 'rebase-apply'))) {
    return say('conflict', ['git: rebase']);
  }
  let step = await run(['add', '-A']);
  if (step.code) return say('error', [lastLine(step.err)]);
  // Only what is new is read, as the server's scan reads it; found, nothing is committed, the files stay as they are.
  const added = await run(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff']);
  const secrets = secretsAdded(added.out);
  if (secrets.length) {
    await run(['reset', '-q']);
    return say('secret', secrets.slice(0, 10).map((one) => `${one.file}:${one.line} ${one.kind}`));
  }
  const staged = await run(['diff', '--cached', '--quiet']);
  if (staged.code === 1) {
    step = await run(['commit', '-q', '--no-verify', '-m', `senkron: ${os.hostname()} ${stamp(new Date())}`]);
    if (step.code) return say('error', [lastLine(step.err || step.out)]);
  }
  step = await run(['pull', '-q', '--rebase']);
  if (step.code) {
    const conflicted = (await run(['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    await run(['rebase', '--abort']);
    if (!conflicted.length && UNREACHABLE.test(step.err)) return say('offline', [lastLine(step.err)]);
    return say('conflict', conflicted.length ? conflicted.slice(0, 10) : [lastLine(step.err)]);
  }
  step = await run(['push', '-q']);
  if (step.code) return say(UNREACHABLE.test(step.err) ? 'offline' : 'error', [lastLine(step.err)]);
  lastSyncedAt = Date.now();
  return say('synced');
}

/** One sync, after the one going on if one is; asked while it runs, it runs once more after. */
function sync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      const { vault, vaultSync } = readSettings();
      if (!vault || !vaultSync) return;
      const offered = await inspect(vault);
      if (!offered.available) {
        tell({ ...offered, on: vaultSync, state, lastSyncedAt, detail });
        return;
      }
      try {
        await syncOnce(vault);
      } catch (err) {
        await say('error', [String((err as Error)?.message ?? err).slice(0, 300)]);
      } finally {
        quietUntil = Date.now() + 5_000;
      }
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

function syncIn(ms: number): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => {
    soon = null;
    void sync();
  }, ms);
  soon.unref?.();
}

/** The switch (Settings › Sunucu): on, in step at once and from now on; off, nothing leaves the computer. */
export async function setVaultSync(on: unknown): Promise<SyncStatus> {
  if (typeof on !== 'boolean') return vaultSyncStatus();
  updateSettings((settings) => {
    settings.vaultSync = on;
  });
  if (on) void sync();
  else if (soon) clearTimeout(soon);
  return vaultSyncStatus();
}

/** In step now, when it is on; the status after it. */
export async function syncVaultNow(): Promise<SyncStatus> {
  await sync();
  return vaultSyncStatus();
}

/** The app started, or another vault was opened: in step in a moment, and every few minutes from then. */
export function startVaultSync(): void {
  // Neither timer holds the process open: the app keeps itself running, a test that opened a vault does not.
  if (!every) every = setInterval(() => void sync(), EVERY_MS);
  every.unref?.();
  syncIn(2_000);
}

/** A file in the vault changed: in step a little after the last change, not at every key. */
export function vaultFilesChanged(): void {
  if (!readSettings().vaultSync || Date.now() < quietUntil || running) return;
  syncIn(AFTER_CHANGE_MS);
}

/** The app quitting: what was written goes now, waited for at most a few seconds; the next start sends the rest. */
export async function syncBeforeQuit(): Promise<void> {
  if (every) clearInterval(every);
  every = null;
  if (soon) clearTimeout(soon);
  if (!readSettings().vaultSync) return;
  await Promise.race([sync(), new Promise((done) => setTimeout(done, QUIT_WAIT_MS))]);
}

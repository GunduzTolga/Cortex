/**
 * The vault kept in step with a git remote (electron/services/vaultSync.ts): what the window is told. The rules and the
 * scan that keeps a secret from leaving with a note are the engine's (`beyin.py esitle`, 3 November): everything is
 * added, the new lines are scanned, then commit, pull with rebase, push; a conflict is backed out of and said.
 */

export type SyncState = 'idle' | 'syncing' | 'synced' | 'conflict' | 'secret' | 'offline' | 'error';

export interface SyncStatus {
  /** Git is there and the vault is a git repository whose branch follows a remote one. */
  available: boolean;
  /** What is missing when it is not: git itself, a repository at the vault's top, or a remote branch to follow. */
  missing: 'git' | 'repo' | 'remote' | null;
  /** Where git is missing: Cortex can bring its own here (Windows: MinGit, services/gitTool.ts). */
  canBringGit: boolean;
  /** Kept in step: the person's switch (Settings › Sunucu). */
  on: boolean;
  state: SyncState;
  /** The remote as host and path (`github.com/owner/repo`), never with a name or password in it. */
  remote: string | null;
  /** When the last sync went through, in ms. */
  lastSyncedAt: number | null;
  /** For a conflict, the files; for a secret, `file:line kind` (never the secret); for an error, what git said. */
  detail: string[];
}

export interface VaultSyncApi {
  status(): Promise<SyncStatus>;
  /** The switch: on, the vault is kept in step from now (and once at once); off, nothing leaves the computer. */
  setOn(on: boolean): Promise<SyncStatus>;
  /** In step now: the status after it. */
  now(): Promise<SyncStatus>;
  /** Git brought by Cortex where there is none (Windows); the status after it. */
  installGit(): Promise<SyncStatus>;
}

/** The remote's address said without a name, password or token in it: `github.com/owner/repo`. */
export function remoteLabel(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  const scp = /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?$/.exec(text);
  if (scp && !text.includes('://')) return `${scp[1]}/${scp[2]}`;
  // A folder on this computer or the network is said as it is: no name or password is ever in one.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  try {
    const parsed = new URL(text);
    return `${parsed.host}${parsed.pathname.replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The vault kept in step with a git remote (electron/services/vaultSync.ts): what the window is told, and the scan that
 * keeps a secret from leaving with a note. The same rules as a server's own sync script: everything is added, the new
 * lines are scanned, then commit, pull with rebase, push; a conflict is backed out of and said, never written over.
 */

export type SyncState = 'idle' | 'syncing' | 'synced' | 'conflict' | 'secret' | 'offline' | 'error';

export interface SyncStatus {
  /** Git is there and the vault is a git repository whose branch follows a remote one. */
  available: boolean;
  /** What is missing when it is not: git itself, a repository at the vault's top, or a remote branch to follow. */
  missing: 'git' | 'repo' | 'remote' | null;
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
}

/** A secret a new line holds: where it is and what kind, never the secret itself. */
export interface SecretFound {
  file: string;
  line: number;
  kind: string;
}

const PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['AWS key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/],
  ['Tailscale key', /\btskey-[a-z]+-[A-Za-z0-9-]{20,}/],
  ['Notion token', /\b(?:secret_|ntn_)[A-Za-z0-9]{40,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
/** "parola: Xy7…", "api_key = …": counted only where the value looks random (a placeholder or a plain word is not). */
const ASSIGNMENT = /\b(?:password|passwd|parola|şifre|sifre|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"'`<>]{16,})/i;
const PLACEHOLDER = /(\$\{|\$\(|xxx|\.\.\.|<|example|ornek|örnek|placeholder|your[_-]|changeme)/i;
/** A line written on purpose as an example says so, and is let through. */
export const SECRET_ALLOWED = 'sir-tarama:izin';

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let sum = 0;
  for (const count of counts.values()) sum -= (count / text.length) * Math.log2(count / text.length);
  return sum;
}

/** The kind of secret a line holds, or null. */
export function secretIn(line: string): string | null {
  if (line.includes(SECRET_ALLOWED)) return null;
  for (const [kind, pattern] of PATTERNS) if (pattern.test(line)) return kind;
  const assigned = ASSIGNMENT.exec(line);
  if (assigned && !PLACEHOLDER.test(assigned[1]) && entropy(assigned[1]) >= 3.5) return 'password or key';
  return null;
}

/** The secrets in the lines a diff adds (`git diff --cached -U0`): only what is new is read, as the server's scan reads it. */
export function secretsAdded(diff: string): SecretFound[] {
  const found: SecretFound[] = [];
  let file = '';
  let line = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      file = row.startsWith('+++ b/') ? row.slice(6) : row.slice(4);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('+') && !row.startsWith('+++')) {
      const kind = secretIn(row.slice(1));
      if (kind) found.push({ file, line, kind });
      line += 1;
    }
  }
  return found;
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

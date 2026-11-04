/**
 * The vault kept on GitHub (Faz 1, docs/superpowers/specs/2026-11-04-faz1-github-esitleme-design.md): signing in with
 * a code (GitHub's device flow, for the "Cortex Kasa" GitHub App), a private repository made or picked, and the vault
 * joined to it by the engine (`beyin.py esitle --baslat` / `--baglan`). What the window is told; the tokens never
 * reach it.
 */

/**
 * The GitHub App Cortex signs in as. Its client ID is not a secret (the device flow needs no client secret, and none is
 * kept anywhere); empty, the button is not offered. The slug is the app's address on GitHub, where it is installed.
 */
export const GITHUB_APP = { clientId: '', slug: 'cortex-kasa' };

export type GithubState = 'off' | 'waiting' | 'connected' | 'expired' | 'denied' | 'error';

export interface GithubStatus {
  /** Whether Cortex can sign in at all: an app is set (GITHUB_APP.clientId). */
  offered: boolean;
  state: GithubState;
  /** The account signed in, when one is. */
  login: string | null;
  /** The repository the vault was joined to from here (`owner/name`), when it was. */
  repo: string | null;
  /** For an error: what went wrong, in a sentence the window shows as it is. */
  detail: string | null;
}

export interface GithubCode {
  /** The code the person types on GitHub's page. */
  userCode: string;
  /** GitHub's page for it (github.com/login/device). */
  verifyUrl: string;
  /** Seconds the code holds. */
  expiresIn: number;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  /** Nothing in it yet (GitHub's size 0): the vault goes there (`--baslat`); otherwise it is joined (`--baglan`). */
  empty: boolean;
}

/** The repositories the app may reach, or, where it is installed nowhere yet, the page that installs it. */
export type GithubRepos = { repos: GithubRepo[]; installUrl: null } | { repos: []; installUrl: string };

export interface VaultConnected {
  /** The engine's state: `synced` when it went through; otherwise `secret`, `offline`, `already`, `error` … */
  state: string;
  repo: string;
  /** Notes that were different on both sides: this computer's kept under another name (`<ad> (bu bilgisayar).md`). */
  kept: Array<{ file: string; as: string }>;
  /** For a secret, `file:line kind`; for an error, what git said. */
  detail: string[];
}

export interface GithubApi {
  status(): Promise<GithubStatus>;
  /** A code to type on GitHub; the answer comes as the status (`on.github`). */
  start(): Promise<GithubCode>;
  /** GitHub's page for the code, opened in the browser. */
  openVerify(): Promise<void>;
  repos(): Promise<GithubRepos>;
  /** The app's install page on GitHub, opened in the browser. */
  openInstall(): Promise<void>;
  /** A new private repository for the vault, under the account signed in. */
  create(name: string): Promise<GithubRepo>;
  /** The vault joined to a repository: sent to an empty one, or taken in from one that has a vault. */
  connect(fullName: string): Promise<VaultConnected>;
  /** Signed out of GitHub here and the vault no longer kept in step; the repository and the notes stay as they are. */
  disconnect(): Promise<GithubStatus>;
}

/** A repository's name as GitHub takes one: letters, digits, `.`, `_`, `-`; not `.` or `..`. */
export const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
/** `owner/name`, as GitHub writes it. */
export const REPO_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

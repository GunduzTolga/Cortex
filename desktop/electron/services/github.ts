import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage, shell } from 'electron';
import {
  GITHUB_APP,
  type GithubCode,
  type GithubRepo,
  type GithubRepos,
  type GithubState,
  type GithubStatus,
  REPO_FULL_NAME,
  REPO_NAME,
  type VaultConnected,
} from '../../shared/github';
import { remoteLabel } from '../../shared/vaultSync';
import { writeWhole } from './fileWrite';
import { readSettings } from './settings';
import { joinVault, setVaultSync, setVaultSyncCredentials } from './vaultSync';

/**
 * The vault kept on GitHub (Faz 1, docs/superpowers/specs/2026-11-04-faz1-github-esitleme-design.md).
 *
 * Signing in is GitHub's device flow for the "Cortex Kasa" GitHub App: a code is shown, the person types it on
 * github.com/login/device, and the app is given a user token that reaches only the repositories the app is installed
 * on (Contents read/write, Metadata, Repository creation) - never the person's other repositories, as an OAuth App's
 * `repo` scope would. The token holds eight hours and is renewed with its refresh token (six months); a token from
 * the device flow is renewed without a client secret, so none is kept anywhere.
 *
 * Both tokens are encrypted with the system's store (safeStorage, as keys.ts) into the app's data folder, never the
 * vault, and go out only to GitHub: to its API from here, and to git through the engine as its environment
 * (`CORTEX_GIT_TOKEN`, which the engine hands git as an extra header, never on a command line or in a file). The
 * window learns the account's name and the repository, never a token.
 */

let hosts = { web: 'https://github.com', api: 'https://api.github.com' };
let clientId = GITHUB_APP.clientId;
const githubUrl = (fullName: string) => `https://github.com/${fullName}.git`;
let gitUrl = githubUrl;
/** The tests stand a local server in for GitHub, a folder for a repository's git address, and set an app. */
export function setGithubForTests(next: { web: string; api: string; clientId: string; gitUrl: (fullName: string) => string } | null): void {
  hosts = next ? { web: next.web, api: next.api } : { web: 'https://github.com', api: 'https://api.github.com' };
  clientId = next ? next.clientId : GITHUB_APP.clientId;
  gitUrl = next ? next.gitUrl : githubUrl;
  pending = null;
  generation += 1;
  state = 'off';
  detail = null;
}

const REQUEST_MS = 20_000;
/** A token renewed when it has less than this left: a sync may run for minutes after it is handed over. */
const RENEW_BEFORE_MS = 15 * 60_000;

interface Kept {
  login: string;
  id: number;
  access: string;
  /** When the access token stops, in ms; null where the app's tokens do not expire. */
  accessUntil: number | null;
  refresh: string | null;
  refreshUntil: number | null;
  /** The repository the vault was joined to from here. */
  repo: string | null;
}

const file = () => path.join(app.getPath('userData'), 'github.json');
const say = (tr: string, en: string) => (readSettings().language === 'en' ? en : tr);

export class GithubRefusal extends Error {
  /** GitHub could not be reached: the network, not the connection; a sync says it is offline, not failed. */
  offline = false;
}
const unreachableRefusal = () => Object.assign(new GithubRefusal(unreachable()), { offline: true });

function readKept(): Kept | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, '')) as Partial<Kept>;
    if (typeof raw.login !== 'string' || typeof raw.access !== 'string') return null;
    return {
      login: raw.login,
      id: typeof raw.id === 'number' ? raw.id : 0,
      access: raw.access,
      accessUntil: typeof raw.accessUntil === 'number' ? raw.accessUntil : null,
      refresh: typeof raw.refresh === 'string' ? raw.refresh : null,
      refreshUntil: typeof raw.refreshUntil === 'number' ? raw.refreshUntil : null,
      repo: typeof raw.repo === 'string' && REPO_FULL_NAME.test(raw.repo) ? raw.repo : null,
    };
  } catch {
    return null;
  }
}

function writeKept(kept: Kept | null): void {
  if (!kept) {
    fs.rmSync(file(), { force: true });
    return;
  }
  writeWhole(file(), JSON.stringify(kept), 0o600);
}

const seal = (text: string) => safeStorage.encryptString(text).toString('base64');
const unseal = (text: string): string | null => {
  try {
    return safeStorage.decryptString(Buffer.from(text, 'base64'));
  } catch {
    return null;
  }
};

let state: GithubState = 'off';
let detail: string | null = null;
let tell: (status: GithubStatus) => void = () => undefined;
/** Where the window hears the sign-in end (`on.github`). */
export function onGithub(listener: (status: GithubStatus) => void): void {
  tell = listener;
}

export function githubStatus(): GithubStatus {
  const kept = readKept();
  const signedIn = kept && unseal(kept.access) !== null;
  const now: GithubState = signedIn && (state === 'off' || state === 'connected') ? 'connected' : state === 'connected' ? 'off' : state;
  return { offered: Boolean(clientId), state: now, login: signedIn ? kept.login : null, repo: signedIn ? kept.repo : null, detail };
}

function settle(next: GithubState, said: string | null = null): void {
  state = next;
  detail = said;
  tell(githubStatus());
}

const unreachable = () => say("GitHub'a ulaşılamadı; internet bağlantını kontrol et.", "GitHub could not be reached; check the internet connection.");

/** A form posted to GitHub's sign-in endpoints, the answer read as JSON (GitHub answers 200 with an `error` too). */
async function postForm(where: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${hosts.web}${where}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Cortex' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch {
    throw unreachableRefusal();
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw new GithubRefusal(say(`GitHub beklenmedik bir cevap verdi (${response.status}).`, `GitHub gave an unexpected answer (${response.status}).`));
  return body;
}

/** GitHub's REST API as the account signed in; the answer, or a sentence for what went wrong. */
async function api(method: string, where: string, token: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${hosts.api}${where}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cortex',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch {
    throw unreachableRefusal();
  }
  const json = (await response.json().catch(() => null)) as unknown;
  if (response.status === 401) {
    // The token was taken back on GitHub (the app's authorization revoked): signed out here too.
    forgetTokens('expired');
    throw new GithubRefusal(expiredText());
  }
  return { status: response.status, json };
}

const expiredText = () => say('GitHub bağlantısının süresi doldu. Yeniden bağlan.', 'The GitHub connection has expired. Connect again.');

function forgetTokens(next: GithubState): void {
  writeKept(null);
  settle(next, next === 'expired' ? expiredText() : null);
}

/** Tokens as GitHub's token endpoint gives them, kept. */
function keep(answer: Record<string, unknown>, who: { login: string; id: number }, repo: string | null): string {
  const access = String(answer.access_token);
  const now = Date.now();
  const seconds = (value: unknown) => (typeof value === 'number' && value > 0 ? now + value * 1000 : null);
  writeKept({
    login: who.login,
    id: who.id,
    access: seal(access),
    accessUntil: seconds(answer.expires_in),
    refresh: typeof answer.refresh_token === 'string' ? seal(answer.refresh_token) : null,
    refreshUntil: seconds(answer.refresh_token_expires_in),
    repo,
  });
  return access;
}

let pending: { code: GithubCode; deviceCode: string } | null = null;
/** A newer start (or a test's reset) ends the polling of an older one. */
let generation = 0;

/** A code to type on GitHub; polled for in the background until it is typed, refused or runs out. */
export async function startGithub(): Promise<GithubCode> {
  if (!clientId) throw new GithubRefusal(say("Bu Cortex'te GitHub bağlantısı yok.", 'This Cortex has no GitHub connection.'));
  const answer = await postForm('/login/device/code', { client_id: clientId });
  if (typeof answer.device_code !== 'string' || typeof answer.user_code !== 'string') {
    throw new GithubRefusal(answer.error === 'device_flow_disabled' ? say("GitHub uygulamasında cihaz kodu girişi kapalı.", "The GitHub app's device flow is off.") : say('GitHub bir kod vermedi.', 'GitHub gave no code.'));
  }
  const code: GithubCode = {
    userCode: answer.user_code,
    // The page is always GitHub's own: an address from the answer is not opened.
    verifyUrl: `${hosts.web}/login/device`,
    expiresIn: typeof answer.expires_in === 'number' ? answer.expires_in : 900,
  };
  pending = { code, deviceCode: answer.device_code };
  const mine = ++generation;
  settle('waiting');
  void poll(mine, answer.device_code, typeof answer.interval === 'number' ? answer.interval : 5, Date.now() + code.expiresIn * 1000);
  return code;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function poll(mine: number, deviceCode: string, interval: number, until: number): Promise<void> {
  let every = interval;
  while (mine === generation) {
    await wait(every * 1000);
    if (mine !== generation) return;
    if (Date.now() > until) return settle('expired', say('Kodun süresi doldu. Yeniden dene.', 'The code has expired. Try again.'));
    let answer: Record<string, unknown>;
    try {
      answer = await postForm('/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    } catch {
      // The network gone a moment: asked again at the next turn, while the code holds.
      continue;
    }
    if (mine !== generation) return;
    const error = typeof answer.error === 'string' ? answer.error : null;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      every = typeof answer.interval === 'number' ? answer.interval : every + 5;
      continue;
    }
    pending = null;
    if (error === 'expired_token') return settle('expired', say('Kodun süresi doldu. Yeniden dene.', 'The code has expired. Try again.'));
    if (error === 'access_denied') return settle('denied', say('GitHub bağlantısı onaylanmadı.', 'The GitHub connection was not approved.'));
    if (error || typeof answer.access_token !== 'string') return settle('error', say(`GitHub girişi tamamlanamadı (${error ?? 'yanıt'}).`, `The GitHub sign-in did not finish (${error ?? 'answer'}).`));
    try {
      const user = await api('GET', '/user', answer.access_token);
      const who = user.json as { login?: unknown; id?: unknown } | null;
      if (user.status !== 200 || typeof who?.login !== 'string') throw new GithubRefusal(say('GitHub hesabı okunamadı.', 'The GitHub account could not be read.'));
      keep(answer, { login: who.login, id: typeof who.id === 'number' ? who.id : 0 }, null);
      return settle('connected');
    } catch (err) {
      return settle('error', (err as Error).message);
    }
  }
}

export async function openVerify(): Promise<void> {
  await shell.openExternal(pending?.code.verifyUrl ?? `${hosts.web}/login/device`);
}

export async function openInstall(): Promise<void> {
  await shell.openExternal(`${hosts.web}/apps/${GITHUB_APP.slug}/installations/new`);
}

let renewing: Promise<string> | null = null;

/** The access token, renewed first where it is about to stop. Refused, with the sentence to show, where it cannot be. */
export function githubToken(): Promise<string> {
  const kept = readKept();
  const access = kept ? unseal(kept.access) : null;
  if (!kept || !access) return Promise.reject(new GithubRefusal(say('GitHub ile bağlı değil.', 'Not connected to GitHub.')));
  if (kept.accessUntil === null || kept.accessUntil - Date.now() > RENEW_BEFORE_MS) return Promise.resolve(access);
  if (!renewing) {
    renewing = renew(kept).finally(() => {
      renewing = null;
    });
  }
  return renewing;
}

async function renew(kept: Kept): Promise<string> {
  const refresh = kept.refresh ? unseal(kept.refresh) : null;
  if (!refresh || (kept.refreshUntil !== null && kept.refreshUntil <= Date.now())) {
    forgetTokens('expired');
    throw new GithubRefusal(expiredText());
  }
  const answer = await postForm('/login/oauth/access_token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh });
  if (typeof answer.access_token !== 'string') {
    forgetTokens('expired');
    throw new GithubRefusal(expiredText());
  }
  return keep(answer, kept, kept.repo);
}

/** The repositories the app is installed on for this account; where it is installed nowhere, the page that installs it. */
export async function githubRepos(): Promise<GithubRepos> {
  const token = await githubToken();
  const installations = await api('GET', '/user/installations?per_page=100', token);
  const list = ((installations.json as { installations?: unknown } | null)?.installations ?? []) as Array<{ id?: unknown; app_slug?: unknown }>;
  const ours = list.filter((one) => one.app_slug === GITHUB_APP.slug && typeof one.id === 'number');
  if (installations.status !== 200 || !ours.length) return { repos: [], installUrl: `${hosts.web}/apps/${GITHUB_APP.slug}/installations/new` };
  const repos: GithubRepo[] = [];
  for (const one of ours) {
    for (let page = 1; page <= 10; page += 1) {
      const answer = await api('GET', `/user/installations/${one.id}/repositories?per_page=100&page=${page}`, token);
      const got = ((answer.json as { repositories?: unknown } | null)?.repositories ?? []) as Array<{ full_name?: unknown; private?: unknown; size?: unknown }>;
      for (const repo of got) {
        if (typeof repo.full_name === 'string' && REPO_FULL_NAME.test(repo.full_name) && !repos.some((seen) => seen.fullName === repo.full_name)) {
          repos.push({ fullName: repo.full_name, private: repo.private === true, empty: repo.size === 0 });
        }
      }
      if (got.length < 100) break;
    }
  }
  return { repos, installUrl: null };
}

/** A new private repository for the vault under the account signed in; nothing in it, so the vault goes there. */
export async function createRepo(name: unknown): Promise<GithubRepo> {
  if (typeof name !== 'string' || !REPO_NAME.test(name.trim())) throw new GithubRefusal(say('Repo adında yalnız harf, rakam, nokta, alt çizgi ve tire olabilir.', 'A repository name takes only letters, digits, dots, underscores and hyphens.'));
  const token = await githubToken();
  const made = await api('POST', '/user/repos', token, {
    name: name.trim(),
    private: true,
    description: 'Cortex kasası',
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    auto_init: false,
  });
  const repo = made.json as { full_name?: unknown; private?: unknown } | null;
  if (made.status === 201 && typeof repo?.full_name === 'string') return { fullName: repo.full_name, private: repo.private === true, empty: true };
  if (made.status === 422) throw new GithubRefusal(say('Bu adla bir repo zaten var; başka bir ad seç ya da "Var olan kasama bağlan"ı kullan.', 'A repository by that name is there already; pick another name, or join it.'));
  if (made.status === 403) throw new GithubRefusal(say("Cortex'in GitHub'da repo açma izni yok. GitHub'da Cortex'e izin ver, sonra buraya dön.", 'Cortex may not make repositories on GitHub. Allow it on GitHub, then come back.'));
  throw new GithubRefusal(say(`Repo açılamadı (${made.status}).`, `The repository could not be made (${made.status}).`));
}

/**
 * The environment the engine hands git for the repository the vault was joined to from here: the token, and the
 * account as the commits' author. Any other remote - another GitHub repository among them - is git's own business,
 * with the person's own credentials: the token goes nowhere it was not given for.
 */
export async function githubCredentials(remote: string | null): Promise<Record<string, string>> {
  const kept = readKept();
  if (!kept?.repo || !remote || remote.toLowerCase() !== `github.com/${kept.repo}`.toLowerCase()) return {};
  return envFor(kept);
}

async function envFor(kept: Kept): Promise<Record<string, string>> {
  const token = await githubToken();
  return {
    CORTEX_GIT_TOKEN: token,
    CORTEX_GIT_NAME: kept.login,
    CORTEX_GIT_EMAIL: `${kept.id ? `${kept.id}+` : ''}${kept.login}@users.noreply.github.com`,
  };
}
setVaultSyncCredentials(githubCredentials);

/**
 * The vault joined to a repository the app reaches: sent to it where it is empty (`--baslat`), taken in where it has
 * a vault (`--baglan`), and kept in step from then on. Nothing is deleted on either side.
 */
export async function connectRepo(fullName: unknown): Promise<VaultConnected> {
  if (typeof fullName !== 'string' || !REPO_FULL_NAME.test(fullName)) throw new GithubRefusal(say('Böyle bir repo yok.', 'There is no such repository.'));
  const { repos } = await githubRepos();
  const repo = repos.find((one) => one.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repo) throw new GithubRefusal(say("Cortex bu repoya ulaşamıyor; GitHub'da Cortex'e bu repo için izin ver.", 'Cortex cannot reach this repository; allow it on GitHub.'));
  const url = gitUrl(repo.fullName);
  const kept = readKept();
  if (!kept) throw new GithubRefusal(say('GitHub ile bağlı değil.', 'Not connected to GitHub.'));
  const env = await envFor(kept);
  const first = await joinVault(url, repo.empty ? 'baslat' : 'baglan', env);
  // GitHub's size lags a push by a while: the engine is the one that looks, and says which way it should have gone.
  const result = first.state === 'not_empty' ? await joinVault(url, 'baglan', env) : first.state === 'empty' ? await joinVault(url, 'baslat', env) : first;
  // Joined to this very repository already (signed out and in again): no conflict, kept in step again.
  const same = result.state === 'already' && typeof result.remote === 'string' && result.remote.toLowerCase() === (remoteLabel(url) ?? '').toLowerCase();
  const ok = result.state === 'synced' || same;
  if (ok) {
    if (same) await setVaultSync(true);
    const now = readKept();
    if (now) writeKept({ ...now, repo: repo.fullName });
    tell(githubStatus());
  }
  return {
    state: same ? 'synced' : String(result.state ?? 'error'),
    repo: repo.fullName,
    kept: Array.isArray(result.kept) ? (result.kept as Array<{ file?: unknown; as?: unknown }>).filter((one) => typeof one.file === 'string' && typeof one.as === 'string').map((one) => ({ file: one.file as string, as: one.as as string })) : [],
    detail: Array.isArray(result.detail) ? result.detail.map(String).slice(0, 10) : [],
  };
}

/** Signed out of GitHub here and the vault no longer kept in step; the repository and the notes stay as they are. */
export async function disconnectGithub(): Promise<GithubStatus> {
  generation += 1;
  pending = null;
  forgetTokens('off');
  await setVaultSync(false);
  return githubStatus();
}

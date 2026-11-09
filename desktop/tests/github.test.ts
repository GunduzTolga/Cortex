import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app, shellCalls } from 'electron';
import {
  connectRepo,
  createRepo,
  disconnectGithub,
  githubCredentials,
  githubRepos,
  githubStatus,
  githubToken,
  onGithub,
  openInstall,
  setGithubForTests,
  startGithub,
} from '../electron/services/github';
import { readSettings, updateSettings } from '../electron/services/settings';
import { setVaultSyncEngine } from '../electron/services/vaultSync';
import { GITHUB_APP, type GithubStatus } from '../shared/github';

/**
 * The vault kept on GitHub (electron/services/github.ts) against a local server standing in for GitHub: the device
 * flow (pending, slow down, denied, expired), the tokens kept sealed and renewed without a client secret, the app's
 * repositories or its install page, a new private repository, and the vault joined to one by the engine's source
 * module, with real git and bare repositories in place of GitHub's.
 */

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
setVaultSyncEngine(path.resolve('..', 'template', '.claude', 'scripts', 'beyin_v3_esitle.py'));
const temp = (prefix: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// The computer's own git identity is not the test's: git reads the person's settings from an empty file here. Where one
// was set (a developer's computer, 10 November), the vault's first commit took it, as the engine means it to
// (beyin_v3_esitle.py, _identity), and the commit was not the account's.
process.env.GIT_CONFIG_GLOBAL = path.join(temp('cortex-github-git-'), 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NL = String.fromCharCode(10);

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  form: URLSearchParams;
  json: unknown;
}

/** GitHub as the tests need it: each answer a test sets, each request kept. */
const fake = {
  seen: [] as Seen[],
  /** The token endpoint's answers for the device code, in turn; the last one repeats. */
  polls: [] as Array<Record<string, unknown>>,
  refresh: { access_token: 'tok-2', expires_in: 28800, refresh_token: 'ref-2', refresh_token_expires_in: 15811200 } as Record<string, unknown>,
  installations: [] as Array<{ id: number; app_slug: string }>,
  repos: [] as Array<{ full_name: string; private: boolean; size: number }>,
  create: { status: 201 } as { status: number },
};

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const url = request.url ?? '';
    const form = new URLSearchParams(request.headers['content-type']?.includes('urlencoded') ? body : '');
    let json: unknown = null;
    try {
      json = body && request.headers['content-type']?.includes('json') ? JSON.parse(body) : null;
    } catch {
      /* not JSON */
    }
    fake.seen.push({ method: request.method ?? '', url, auth: request.headers.authorization, form, json });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url === '/login/device/code') return send(200, { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://elsewhere.example/', expires_in: 900, interval: 0.02 });
    if (url === '/login/oauth/access_token') {
      if (form.get('grant_type') === 'refresh_token') return send(200, form.get('refresh_token') === 'ref-1' || form.get('refresh_token') === 'ref-2' ? fake.refresh : { error: 'bad_refresh_token' });
      return send(200, fake.polls.length > 1 ? fake.polls.shift() : fake.polls[0]);
    }
    if (url.startsWith('/api/')) {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      if (token !== 'tok-1' && token !== 'tok-2') return send(401, { message: 'Bad credentials' });
      const where = url.slice('/api'.length);
      if (where === '/user') return send(200, { login: 'tolga', id: 42 });
      if (where.startsWith('/user/installations?')) return send(200, { total_count: fake.installations.length, installations: fake.installations });
      if (/^\/user\/installations\/7\/repositories/.test(where)) return send(200, { total_count: fake.repos.length, repositories: fake.repos });
      if (where === '/user/repos' && request.method === 'POST') {
        const name = (json as { name: string }).name;
        if (fake.create.status !== 201) return send(fake.create.status, { message: 'name already exists on this account' });
        fake.repos.push({ full_name: `tolga/${name}`, private: true, size: 0 });
        return send(201, { full_name: `tolga/${name}`, private: true });
      }
    }
    send(404, { message: 'Not Found' });
  });
});
server.listen(0, '127.0.0.1');
await new Promise((done) => server.once('listening', done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

/** Where each repository's git address points: a bare repository per name, as GitHub would hold it. */
const remotes = temp('cortex-github-remotes-');
const bare = (fullName: string) => path.join(remotes, fullName.replace('/', '__') + '.git');
const reset = () => {
  setGithubForTests({ web: base, api: `${base}/api`, clientId: 'Iv23-test', gitUrl: bare });
  fake.seen = [];
  fake.installations = [];
  fake.repos = [];
  fake.create = { status: 201 };
  fs.rmSync(path.join(app.getPath('userData'), 'github.json'), { force: true });
};

let heard: GithubStatus[] = [];
onGithub((status) => heard.push(status));
const settled = async (state: string) => {
  for (let i = 0; i < 200 && githubStatus().state !== state; i += 1) await new Promise((done) => setTimeout(done, 10));
  assert.equal(githubStatus().state, state);
};

/** Signed in through the device flow, once GitHub has asked to wait and to slow down. */
async function signIn(): Promise<void> {
  fake.polls = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 0.02 }, { access_token: 'tok-1', token_type: 'bearer', expires_in: 28800, refresh_token: 'ref-1', refresh_token_expires_in: 15811200 }];
  await startGithub();
  await settled('connected');
}

test('the app is set, as GitHub registered it; with none, the button is not offered and a start is refused', async () => {
  setGithubForTests(null);
  assert.equal(githubStatus().offered, true);
  assert.match(GITHUB_APP.clientId, /^Iv23[A-Za-z0-9]{16}$/);
  setGithubForTests({ web: base, api: `${base}/api`, clientId: '', gitUrl: bare });
  assert.equal(githubStatus().offered, false);
  await assert.rejects(() => startGithub(), /GitHub bağlantısı yok/);
});

test('the device flow waits, slows down when told, and keeps the tokens sealed', async () => {
  reset();
  heard = [];
  fake.polls = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 0.02 }, { access_token: 'tok-1', expires_in: 28800, refresh_token: 'ref-1', refresh_token_expires_in: 15811200 }];
  const code = await startGithub();
  assert.equal(code.userCode, 'ABCD-1234');
  assert.equal(code.verifyUrl, `${base}/login/device`, "GitHub's own page, never an address from the answer");
  assert.equal(githubStatus().state, 'waiting');
  await settled('connected');
  const status = githubStatus();
  assert.deepEqual({ state: status.state, login: status.login, repo: status.repo, offered: status.offered }, { state: 'connected', login: 'tolga', repo: null, offered: true });
  assert.ok(heard.some((one) => one.state === 'waiting') && heard.at(-1)?.state === 'connected');
  const kept = fs.readFileSync(path.join(app.getPath('userData'), 'github.json'), 'utf8');
  assert.ok(!kept.includes('tok-1') && !kept.includes('ref-1'), 'no token in the clear');
  assert.ok(!JSON.stringify(status).includes('tok-'), 'the window hears no token');
  const polls = fake.seen.filter((one) => one.url === '/login/oauth/access_token');
  assert.ok(polls.length >= 3);
  assert.ok(polls.every((one) => one.form.get('client_id') === 'Iv23-test' && !one.form.has('client_secret')));
});

test('a code refused on GitHub, or run out, is said and nothing is kept', async () => {
  reset();
  fake.polls = [{ error: 'access_denied' }];
  await startGithub();
  await settled('denied');
  assert.match(githubStatus().detail ?? '', /onaylanmadı/);
  assert.equal(githubStatus().login, null);
  fake.polls = [{ error: 'expired_token' }];
  await startGithub();
  await settled('expired');
  assert.match(githubStatus().detail ?? '', /süresi doldu/);
});

test('a token about to stop is renewed with its refresh token and no client secret; a refused renewal signs out', async () => {
  reset();
  await signIn();
  assert.equal(await githubToken(), 'tok-1');
  const file = path.join(app.getPath('userData'), 'github.json');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...kept, accessUntil: Date.now() + 60_000 }));
  assert.equal(await githubToken(), 'tok-2');
  const renewal = fake.seen.find((one) => one.form.get('grant_type') === 'refresh_token');
  assert.ok(renewal && renewal.form.get('refresh_token') === 'ref-1' && !renewal.form.has('client_secret'));
  assert.equal(await githubToken(), 'tok-2', 'renewed once, then kept');

  // A passing error keeps the connection: only a refused refresh token ends it.
  fake.refresh = { error: 'server_error' };
  const busy = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...busy, accessUntil: Date.now() }));
  await assert.rejects(() => githubToken(), /yenilenemedi \(server_error\)/);
  assert.equal(fs.existsSync(file), true, 'still connected');
  assert.notEqual(githubStatus().state, 'expired');

  fake.refresh = { error: 'bad_refresh_token' };
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...again, accessUntil: Date.now() }));
  await assert.rejects(() => githubToken(), /süresi doldu/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(githubStatus().state, 'expired');
  fake.refresh = { access_token: 'tok-2', expires_in: 28800, refresh_token: 'ref-2', refresh_token_expires_in: 15811200 };
});

test('installed nowhere, the install page is offered; installed, its repositories are listed with whether they are empty', async () => {
  reset();
  await signIn();
  const none = await githubRepos();
  assert.deepEqual(none, { repos: [], installUrl: `${base}/apps/cortex-kasa/installations/new` });
  await openInstall();
  assert.deepEqual(shellCalls.at(-1), ['openExternal', `${base}/apps/cortex-kasa/installations/new`]);
  fake.installations = [{ id: 9, app_slug: 'some-other-app' }, { id: 7, app_slug: 'cortex-kasa' }];
  fake.repos = [
    { full_name: 'tolga/kasa', private: true, size: 120 },
    { full_name: 'tolga/bos', private: true, size: 0 },
  ];
  assert.deepEqual(await githubRepos(), {
    repos: [
      { fullName: 'tolga/kasa', private: true, empty: false },
      { fullName: 'tolga/bos', private: true, empty: true },
    ],
    installUrl: null,
  });
  assert.ok(fake.seen.every((one) => !one.url.includes('/installations/9/')), "another app's installation is not read");
});

test('a new repository is private and empty; a bad or taken name is refused with a sentence', async () => {
  reset();
  await signIn();
  await assert.rejects(() => createRepo('kasa ad'), /yalnız harf/);
  await assert.rejects(() => createRepo('..'), /yalnız harf/);
  assert.deepEqual(await createRepo('cortex-kasa'), { fullName: 'tolga/cortex-kasa', private: true, empty: true });
  const made = fake.seen.find((one) => one.url === '/api/user/repos');
  assert.deepEqual({ private: (made?.json as { private: boolean }).private, auto_init: (made?.json as { auto_init: boolean }).auto_init }, { private: true, auto_init: false });
  fake.create = { status: 422 };
  await assert.rejects(() => createRepo('cortex-kasa'), /zaten var/);
});

test('the token goes to git only for the repository the vault was joined to', async () => {
  reset();
  await signIn();
  assert.deepEqual(await githubCredentials('github.com/tolga/kasa'), {}, 'joined to none yet');
  const file = path.join(app.getPath('userData'), 'github.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), repo: 'tolga/kasa' }));
  const env = await githubCredentials('github.com/Tolga/Kasa');
  assert.equal(env.CORTEX_GIT_TOKEN, 'tok-1');
  assert.equal(env.CORTEX_GIT_EMAIL, '42+tolga@users.noreply.github.com');
  assert.deepEqual(await githubCredentials('github.com/tolga/baska'), {}, "another GitHub repository: the person's own credentials");
  assert.deepEqual(await githubCredentials('gitlab.com/tolga/kasa'), {});
  assert.deepEqual(await githubCredentials('/srv/kasa.git'), {});
  assert.deepEqual(await githubCredentials(null), {});
});

test('a vault sent to a new repository, then joined from a second computer: nothing deleted, a differing note kept twice', { skip: !hasGit }, async () => {
  reset();
  await signIn();
  fake.installations = [{ id: 7, app_slug: 'cortex-kasa' }];
  const pc = temp('cortex-github-pc-');
  fs.writeFileSync(path.join(pc, 'Plan.md'), ['# Plan', '', "PC'de yazıldı", ''].join(NL));
  fs.writeFileSync(path.join(pc, 'Ortak.md'), ['# Ortak', ''].join(NL));
  updateSettings((settings) => {
    settings.vault = pc;
    settings.vaultSync = false;
  });
  await assert.rejects(() => connectRepo('tolga/yok'), /ulaşamıyor/);
  const made = await createRepo('kasa');
  git(remotes, 'init', '-q', '--bare', '-b', 'main', bare(made.fullName));
  const first = await connectRepo(made.fullName);
  assert.equal(first.state, 'synced', JSON.stringify(first));
  assert.deepEqual(first.kept, []);
  assert.equal(readSettings().vaultSync, true, 'kept in step from now on');
  assert.equal(githubStatus().repo, 'tolga/kasa');
  assert.match(git(bare(made.fullName), 'log', '--format=%an %ae', '-1'), /^tolga 42\+tolga@users\.noreply\.github\.com$/);
  assert.equal(git(bare(made.fullName), 'show', 'main:Plan.md').includes("PC'de yazıldı"), true);

  // The second computer: its own vault, with a Plan.md of its own; GitHub still says the repository is empty
  // (its size lags a push), and the engine, seeing a vault there, joins it instead.
  const laptop = temp('cortex-github-laptop-');
  fs.writeFileSync(path.join(laptop, 'Plan.md'), ['# Plan', '', "Laptop'ta yazıldı", ''].join(NL));
  fs.writeFileSync(path.join(laptop, 'Ortak.md'), ['# Ortak', ''].join(NL));
  fs.writeFileSync(path.join(laptop, 'Yalniz-laptop.md'), ['# Yalnız laptop', ''].join(NL));
  updateSettings((settings) => {
    settings.vault = laptop;
    settings.vaultSync = false;
  });
  const second = await connectRepo(made.fullName);
  assert.equal(second.state, 'synced', JSON.stringify(second));
  assert.deepEqual(second.kept, [{ file: 'Plan.md', as: 'Plan (bu bilgisayar).md' }]);
  assert.match(fs.readFileSync(path.join(laptop, 'Plan.md'), 'utf8'), /PC'de yazıldı/);
  assert.match(fs.readFileSync(path.join(laptop, 'Plan (bu bilgisayar).md'), 'utf8'), /Laptop'ta yazıldı/);
  assert.ok(fs.existsSync(path.join(laptop, 'Yalniz-laptop.md')));
  const files = git(bare(made.fullName), 'ls-tree', '-r', '--name-only', 'main').split(NL);
  for (const name of ['Plan.md', 'Plan (bu bilgisayar).md', 'Ortak.md', 'Yalniz-laptop.md']) assert.ok(files.includes(name), name);

  // Joined again after signing out: the same repository is no conflict.
  await disconnectGithub();
  assert.equal(readSettings().vaultSync, false);
  assert.equal(githubStatus().login, null);
  await signIn();
  const again = await connectRepo(made.fullName);
  assert.equal(again.state, 'synced', JSON.stringify(again));
  assert.equal(readSettings().vaultSync, true);
});

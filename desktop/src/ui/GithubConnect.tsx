import { useCallback, useEffect, useState } from 'react';
import { Copy, FolderGit2, Github, Plus, RefreshCw, Unlink } from 'lucide-react';
import { type GithubCode, type GithubRepos, type GithubStatus, REPO_NAME, type VaultConnected } from '@shared/github';
import { useT } from '../i18n/useT';
import { Button, Spinner, inputClass } from './ui';

/**
 * The vault kept on GitHub, for someone who has never used git (Faz 1; electron/services/github.ts): "Connect with
 * GitHub" shows a code to type on GitHub's page; once it is approved, a new private repository is made for the vault
 * ("Yeni yedek oluştur") or one that already holds it is picked ("Var olan kasama bağlan"), and the vault is joined to
 * it. Nothing is deleted on either side: a note that differs in the two places is kept twice, this computer's under
 * "(bu bilgisayar)", and that is said in one line. Shown in Settings › Sunucu, and as the first run's optional step.
 */

function Line({ children, tone = 'muted', data }: { children: React.ReactNode; tone?: 'muted' | 'error' | 'ok'; data?: string }) {
  const colour = tone === 'error' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-500';
  return (
    <p className={`px-3 text-[11.5px] leading-relaxed ${colour}`} data-github-note={data}>
      {children}
    </p>
  );
}

const DEFAULT_NAME = 'cortex-kasa';

export function GithubConnect({ onConnected }: { onConnected?: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [code, setCode] = useState<GithubCode | null>(null);
  const [repos, setRepos] = useState<GithubRepos | null>(null);
  const [choosing, setChoosing] = useState<'new' | 'join' | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [result, setResult] = useState<VaultConnected | null>(null);

  useEffect(() => {
    void window.cortex.github.status().then(setStatus, () => setStatus(null));
    return window.cortex.on.github((next) => {
      setStatus(next);
      if (next.state !== 'waiting') setCode(null);
    });
  }, []);

  const signedIn = status?.state === 'connected' && Boolean(status.login);
  const readRepos = useCallback(async () => {
    setRefusal(null);
    try {
      setRepos(await window.cortex.github.repos());
    } catch (err) {
      setRefusal((err as Error).message);
    }
  }, []);
  useEffect(() => {
    if (signedIn && !status?.repo) void readRepos();
  }, [signedIn, status?.repo, readRepos]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setRefusal(null);
    try {
      await work();
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      setResult(null);
      setCode(await window.cortex.github.start());
    });
  const copyAndOpen = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.userCode);
    } catch {
      /* typed by hand: the code is on the screen */
    }
    await window.cortex.github.openVerify();
  };
  const connect = (fullName: string) =>
    run(async () => {
      const done = await window.cortex.github.connect(fullName);
      setResult(done);
      if (done.state === 'synced') {
        setChoosing(null);
        onConnected?.();
      }
    });
  const create = () =>
    run(async () => {
      const made = await window.cortex.github.create(name.trim());
      const done = await window.cortex.github.connect(made.fullName);
      setResult(done);
      if (done.state === 'synced') {
        setChoosing(null);
        onConnected?.();
      }
    });
  const disconnect = () =>
    run(async () => {
      setResult(null);
      setRepos(null);
      setStatus(await window.cortex.github.disconnect());
    });

  if (!status?.offered) return null;

  const outcome = result ? (
    result.state === 'synced' ? (
      <>
        <Line tone="ok" data="connected">{t('github.done', { repo: result.repo })}</Line>
        {result.kept.length ? <Line data="kept">{t('github.kept', { count: result.kept.length })}</Line> : null}
      </>
    ) : (
      <Line tone="error" data={`result-${result.state}`}>
        {t(
          result.state === 'secret'
            ? 'github.result.secret'
            : result.state === 'offline'
              ? 'github.result.offline'
              : result.state === 'already'
                ? 'github.result.already'
                : result.state === 'missing'
                  ? 'github.result.missing'
                  : result.state === 'denied'
                    ? 'github.result.denied'
                    : 'github.result.error',
        )}
        {result.detail.length ? ` ${result.detail.join(', ')}` : ''}
      </Line>
    )
  ) : null;

  // Signed in and joined: who, where, and the way out.
  if (signedIn && status.repo) {
    return (
      <div className="mb-2 space-y-1" data-github="joined">
        <Line tone="ok">
          <span className="inline-flex items-center gap-1.5">
            <Github size={12} /> {t('github.joined', { login: status.login ?? '', repo: status.repo })}
          </span>
        </Line>
        {outcome}
        <div className="px-3 pt-1">
          <Button tone="danger" disabled={busy} onClick={() => void disconnect()} data-github-disconnect>
            <Unlink size={13} />
            {t('github.disconnect')}
          </Button>
        </div>
      </div>
    );
  }

  // Signed in, no repository yet: the app installed on GitHub, then a new one or one that holds the vault.
  if (signedIn) {
    const empty = repos?.repos.filter((repo) => repo.empty) ?? [];
    const full = repos?.repos.filter((repo) => !repo.empty) ?? [];
    return (
      <div className="mb-2 space-y-1.5" data-github="signed-in">
        <Line>
          <span className="inline-flex items-center gap-1.5">
            <Github size={12} /> {t('github.signedIn', { login: status.login ?? '' })}
          </span>
        </Line>
        {!repos ? (
          refusal ? null : (
            <Line>
              <span className="inline-flex items-center gap-1.5">
                <Spinner size={11} /> {t('github.reading')}
              </span>
            </Line>
          )
        ) : repos.installUrl ? (
          <>
            <Line data="install">{t('github.install')}</Line>
            <div className="flex flex-wrap gap-2 px-3">
              <Button tone="primary" onClick={() => void window.cortex.github.openInstall()} data-github-install>
                <Github size={13} />
                {t('github.install.open')}
              </Button>
              <Button tone="ghost" disabled={busy} onClick={() => void readRepos()} data-github-reread>
                <RefreshCw size={13} />
                {t('github.install.back')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 px-3">
              <Button tone={choosing === 'new' ? 'primary' : 'ghost'} disabled={busy} onClick={() => setChoosing('new')} data-github-new>
                <Plus size={13} />
                {t('github.new')}
              </Button>
              <Button tone={choosing === 'join' ? 'primary' : 'ghost'} disabled={busy || (!full.length && !empty.length)} onClick={() => setChoosing('join')} data-github-join>
                <FolderGit2 size={13} />
                {t('github.join')}
              </Button>
            </div>
            {choosing === 'new' ? (
              <div className="flex items-center gap-2 px-3">
                <input
                  className={`${inputClass} h-8`}
                  value={name}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && REPO_NAME.test(name.trim())) void create();
                  }}
                  aria-label={t('github.new.name')}
                  data-github-name
                />
                <Button tone="primary" className="h-8 shrink-0" disabled={busy || !REPO_NAME.test(name.trim())} onClick={() => void create()} data-github-create>
                  {busy ? <Spinner size={12} /> : null}
                  {t('github.new.go')}
                </Button>
              </div>
            ) : null}
            {choosing === 'new' ? <Line>{t('github.new.hint')}</Line> : null}
            {choosing === 'join' ? (
              <div className="space-y-1 px-3" data-github-repos>
                {[...full, ...empty].map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    disabled={busy}
                    onClick={() => void connect(repo.fullName)}
                    className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-left text-[11.5px] text-darkDelegation hover:border-zinc-400 disabled:opacity-40"
                    data-github-repo={repo.fullName}
                  >
                    <span className="truncate">{repo.fullName}</span>
                    <span className="ml-2 shrink-0 text-[10.5px] text-zinc-400">{repo.empty ? t('github.repo.empty') : t('github.repo.full')}</span>
                  </button>
                ))}
                {busy ? (
                  <Line>
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner size={11} /> {t('github.joining')}
                    </span>
                  </Line>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {refusal ? <Line tone="error" data="refusal">{refusal}</Line> : null}
        {outcome}
        <div className="px-3 pt-1">
          <Button tone="quiet" disabled={busy} onClick={() => void disconnect()} data-github-signout>
            {t('github.signOut')}
          </Button>
        </div>
      </div>
    );
  }

  // Not signed in: the button, then the code while GitHub waits for it.
  return (
    <div className="mb-2 space-y-1.5" data-github="off">
      {code && status.state === 'waiting' ? (
        <>
          <Line>{t('github.code.hint')}</Line>
          <div className="flex flex-wrap items-center gap-3 px-3">
            <code className="rounded-lg bg-paper-2 px-3 py-1.5 font-mono text-[18px] font-bold tracking-[0.2em] text-darkDelegation" data-github-code>
              {code.userCode}
            </code>
            <Button tone="primary" onClick={() => void copyAndOpen()} data-github-open>
              <Copy size={13} />
              {t('github.code.open')}
            </Button>
          </div>
          <Line>
            <span className="inline-flex items-center gap-1.5">
              <Spinner size={11} /> {t('github.code.waiting')}
            </span>
          </Line>
        </>
      ) : (
        <>
          <Line>{t('github.hint')}</Line>
          {status.detail && (status.state === 'expired' || status.state === 'denied' || status.state === 'error') ? (
            <Line tone="error" data={status.state}>{status.detail}</Line>
          ) : null}
          <div className="px-3">
            <Button tone="primary" disabled={busy} onClick={() => void start()} data-github-start>
              {busy ? <Spinner size={12} /> : <Github size={13} />}
              {t('github.start')}
            </Button>
          </div>
        </>
      )}
      {refusal ? <Line tone="error" data="refusal">{refusal}</Line> : null}
    </div>
  );
}

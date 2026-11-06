import { useCallback, useEffect, useState } from 'react';
import { Download, Link2, RefreshCw, Server, Unlink } from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import type { TailnetStatus } from '@shared/pairing';
import type { SyncStatus } from '@shared/vaultSync';
import { useChat } from '../chat/chatStore';
import { useT } from '../i18n/useT';
import { GithubConnect } from './GithubConnect';
import { Section } from './settingsParts';
import { Button, Spinner, Switch, inputClass } from './ui';

/**
 * The vault kept in step with its git remote, and Pyn on a server (Settings › Sunucu): the one place for what lives on
 * another machine. On, what is written here goes to the remote and on to the other devices, and theirs comes here
 * (electron/services/vaultSync.ts); off, nothing leaves the computer. The switch is offered only where it can work: a
 * vault that is a git repository whose branch follows a remote one, with git on this computer.
 */

function Note({ children, tone = 'muted', data }: { children: React.ReactNode; tone?: 'muted' | 'error' | 'ok'; data?: string }) {
  const colour = tone === 'error' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-500';
  return (
    <p className={`px-3 text-[11.5px] leading-relaxed ${colour}`} data-server-note={data}>
      {children}
    </p>
  );
}

// The hour as both languages write it (13:42): the system's own format said 01:42 PM beside Turkish words.
const clock = (ms: number) => {
  const when = new Date(ms);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};

export function ServerSection({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Where Cortex can sign in to GitHub, a vault that is no repository yet is not a dead end: the button below makes it one.
  const [github, setGithub] = useState(false);

  const read = useCallback(() => {
    void window.cortex.vaultSync.status().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(() => {
    if (open) read();
    if (open) void window.cortex.github.status().then((status) => setGithub(status.offered), () => setGithub(false));
  }, [open, read]);
  useEffect(() => window.cortex.on.vaultSync(setStatus), []);

  const turn = async (on: boolean) => {
    setBusy(true);
    try {
      setStatus(await window.cortex.vaultSync.setOn(on));
    } finally {
      setBusy(false);
    }
  };
  const now = async () => {
    setBusy(true);
    try {
      setStatus(await window.cortex.vaultSync.now());
    } finally {
      setBusy(false);
    }
  };

  const [gitRefusal, setGitRefusal] = useState<string | null>(null);
  const bringGit = async () => {
    setBusy(true);
    setGitRefusal(null);
    try {
      setStatus(await window.cortex.vaultSync.installGit());
    } catch (err) {
      setGitRefusal((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const syncing = status?.state === 'syncing';
  return (
    <Section title={t('server.title')} data="server">
      <p className="mb-1.5 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('server.hint')}</p>
      {open ? <GithubConnect onConnected={read} /> : null}
      {!status ? null : !status.available && status.missing === 'git' ? (
        // No git here: on Windows Cortex brings its own (MinGit); elsewhere, where to get it.
        <div className="space-y-1" data-server-git>
          <Note data="missing-git">{t(status.canBringGit ? 'server.missing.git.bring' : 'server.missing.git')}</Note>
          {status.canBringGit ? (
            <div className="px-3 pt-0.5">
              <Button tone="ghost" disabled={busy} onClick={() => void bringGit()} data-server-bring-git>
                {busy ? <Spinner size={12} /> : <Download size={13} />}
                {t(busy ? 'server.git.bringing' : 'server.git.bring')}
              </Button>
            </div>
          ) : null}
          {gitRefusal ? <Note tone="error" data="git-refusal">{gitRefusal}</Note> : null}
        </div>
      ) : !status.available ? (
        github ? null : <Note data={`missing-${status.missing ?? 'repo'}`}>{t(status.missing === 'remote' ? 'server.missing.remote' : 'server.missing.repo')}</Note>
      ) : (
        <>
          <Switch
            checked={status.on}
            onChange={(on) => void turn(on)}
            label={t('server.sync')}
            hint={status.remote ? t('server.sync.with', { remote: status.remote }) : t('server.sync.hint')}
            data-server-sync
          />
          {status.on ? (
            <div className="mt-1 space-y-1" data-server-state={status.state}>
              {status.state === 'syncing' ? (
                <Note>
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner size={11} /> {t('server.state.syncing')}
                  </span>
                </Note>
              ) : status.state === 'synced' && status.lastSyncedAt ? (
                <Note tone="ok">{t('server.state.synced', { time: clock(status.lastSyncedAt) })}</Note>
              ) : status.state === 'conflict' ? (
                <Note tone="error">{t('server.state.conflict')}</Note>
              ) : status.state === 'secret' ? (
                <Note tone="error">{t('server.state.secret')}</Note>
              ) : status.state === 'offline' ? (
                <Note>{t('server.state.offline')}</Note>
              ) : status.state === 'error' ? (
                <Note tone="error">{t('server.state.error')}</Note>
              ) : (
                <Note>{t('server.state.idle')}</Note>
              )}
              {status.detail.length && status.state !== 'synced' && status.state !== 'syncing' ? (
                <pre className="mx-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-paper-2 px-2.5 py-1.5 font-mono text-[10.5px] text-zinc-600" data-server-detail>
                  {status.detail.join('\n')}
                </pre>
              ) : null}
              <div className="px-3 pt-1">
                <Button tone="ghost" disabled={busy || syncing} onClick={() => void now()} data-server-now>
                  {busy || syncing ? <Spinner size={12} /> : <RefreshCw size={13} />}
                  {t('server.now')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      <PairBlock open={open} />
      {/* Pyn on the server is set where the other AI tools are; its door is here too, beside the vault it shares. */}
      <div className="mt-2 px-3">
        <Button
          tone="ghost"
          onClick={() => {
            onClose();
            useChat.getState().openAuth('hermes');
          }}
          data-server-pyn
        >
          <Server size={13} />
          {t('server.pyn')}
        </Button>
      </div>
    </Section>
  );
}

/**
 * "Kodla bağlan" (electron/services/tailnet.ts): the code from the phone's "Bilgisayar ekle" pasted here connects Pyn
 * on the server with nothing installed. The code is a secret: typed into a password field, sent once, and cleared
 * whatever the answer; the window never keeps it nor hears it back. What it hears is the connection's state and, where
 * something is wrong, one sentence in its language.
 */
function PairBlock({ open }: { open: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<TailnetStatus | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (open) void window.cortex.tailnet.status().then(setStatus, () => setStatus(null));
  }, [open]);
  useEffect(() => window.cortex.on.tailnet(setStatus), []);

  const pair = async () => {
    const typed = code;
    setCode('');
    setBusy(true);
    setRefused(null);
    try {
      setStatus(await window.cortex.tailnet.pair(typed));
      // Offered in the chat's tool chip from now on.
      void useChat.getState().refreshClis();
    } catch (err) {
      setRefused(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    setBusy(true);
    setRefused(null);
    try {
      setStatus(await window.cortex.tailnet.forget());
      void useChat.getState().refreshClis();
    } catch (err) {
      setRefused(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const state = status?.state ?? 'kapali';
  const paired = state !== 'kapali';
  return (
    <div className="mt-3 border-t border-zinc-100 pt-3" data-server-pair>
      <p className="px-3 text-[12px] font-semibold text-darkDelegation">{t('server.pair.title')}</p>
      <p className="mb-1.5 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('server.pair.hint')}</p>
      <div className="space-y-1" data-pair-state={state}>
        {state === 'bagli' ? (
          <Note tone="ok" data="pair-connected">{t(status?.direct ? 'server.pair.connected.direct' : 'server.pair.connected')}</Note>
        ) : state === 'baglaniyor' ? (
          <Note data="pair-connecting">
            <span className="inline-flex items-center gap-1.5">
              <Spinner size={11} /> {t('server.pair.connecting')}
            </span>
          </Note>
        ) : state === 'hata' ? (
          <Note tone="error" data="pair-error">{status?.message ?? t('server.pair.error')}</Note>
        ) : (
          <Note data="pair-none">{t('server.pair.none')}</Note>
        )}
        {state === 'kapali' || state === 'hata' ? (
          <form
            noValidate
            className="flex flex-wrap gap-1.5 px-3 pt-1"
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('server.pair.placeholder')}
              aria-label={t('server.pair.code')}
              className={`${inputClass} min-w-0 flex-1`}
              data-pair-code
            />
            <Button tone="primary" type="submit" disabled={busy || !code.trim()} data-pair-connect>
              {busy ? <Spinner size={12} /> : <Link2 size={13} />}
              {t(busy ? 'server.pair.connecting' : 'server.pair.connect')}
            </Button>
          </form>
        ) : null}
        {refused ? <Note tone="error" data="pair-refused">{refused}</Note> : null}
        {paired ? (
          <div className="px-3 pt-1">
            <Button tone="ghost" disabled={busy} onClick={() => void forget()} data-pair-forget>
              {busy ? <Spinner size={12} /> : <Unlink size={13} />}
              {t('server.pair.forget')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

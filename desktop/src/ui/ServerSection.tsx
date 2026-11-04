import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import type { SyncStatus } from '@shared/vaultSync';
import { useChat } from '../chat/chatStore';
import { useT } from '../i18n/useT';
import { GithubConnect } from './GithubConnect';
import { Section } from './settingsParts';
import { Button, Spinner, Switch } from './ui';

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

  const syncing = status?.state === 'syncing';
  return (
    <Section title={t('server.title')} data="server">
      <p className="mb-1.5 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('server.hint')}</p>
      {open ? <GithubConnect onConnected={read} /> : null}
      {!status ? null : !status.available ? (
        github && status.missing !== 'git' ? null : <Note data={`missing-${status.missing ?? 'repo'}`}>{t(status.missing === 'git' ? 'server.missing.git' : status.missing === 'remote' ? 'server.missing.remote' : 'server.missing.repo')}</Note>
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

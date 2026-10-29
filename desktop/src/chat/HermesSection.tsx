import { useEffect, useState } from 'react';
import { PlugZap, Trash2 } from 'lucide-react';
import type { HermesStatus } from '@shared/hermes';
import { messageOf } from '@shared/ipcError';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Button, Spinner, inputClass } from '../ui/ui';
import { useChat } from './chatStore';

/**
 * A Hermes Agent on another machine, set up as a chat engine in the AI tools
 * window (electron/services/hermesChat.ts): its API server's address, the
 * profile it serves under `/p/<profile>/` where it serves several, and its
 * key. The key goes to the main process and is never shown again, only
 * whether one is kept; once an address is saved, Hermes is offered in the
 * chat's tool chip.
 */
export function HermesSection({ focused }: { focused: boolean }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // The fields changed since they were saved: the test asks the saved server, so it waits for a save. After a save
  // refused, it tested the old address while the field showed the new one (29 October).
  const [dirty, setDirty] = useState(false);
  const failed = (err: unknown) => toast({ tone: 'error', title: t('auth.failed'), detail: messageOf(err) });

  const shown = (next: HermesStatus) => {
    setStatus(next);
    setUrl(next.url ?? '');
    setProfile(next.profile ?? '');
    setKey('');
    setDirty(false);
  };

  useEffect(() => {
    window.cortex.hermes.status().then(shown, () => setStatus({ url: null, profile: null, key: false }));
  }, []);

  const save = async () => {
    setBusy(true);
    const typed = Boolean(key.trim());
    try {
      shown(await window.cortex.hermes.save({ url: url.trim(), profile: profile.trim() || null, ...(typed ? { key: key.trim() } : {}) }));
      // "Key saved" only when one was typed; an address changed alone is just saved.
      toast({ tone: 'success', title: typed ? t('auth.key.saved', { name: 'Pyn' }) : t('settings.saved') });
      // Offered in the tool chip from now on.
      void useChat.getState().refreshClis();
    } catch (err) {
      failed(err);
    }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try {
      const { sessions } = await window.cortex.hermes.test();
      toast({ tone: 'success', title: t('hermes.test.ok', { count: sessions }) });
    } catch (err) {
      failed(err);
    }
    setBusy(false);
  };
  const forget = async () => {
    setBusy(true);
    try {
      shown(await window.cortex.hermes.forget());
      void useChat.getState().refreshClis();
    } catch (err) {
      failed(err);
    }
    setBusy(false);
  };

  const saved = Boolean(status?.url);
  return (
    <li className={`rounded-xl border px-4 py-3 ${focused ? 'border-darkDelegation/40 bg-paper-2' : 'border-zinc-100'}`} data-auth-tool="hermes">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13.5px] font-semibold text-darkDelegation">{t('hermes.name')}</p>
        {/* An address with no key that can be used (one kept on another computer) is not "set": it needs its key. */}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${saved && status?.key ? 'bg-good/15 text-good' : saved ? 'bg-gold/25 text-darkDelegation' : 'bg-zinc-100 text-zinc-500'}`} data-hermes-status={saved && status?.key ? 'set' : saved ? 'key' : 'unset'}>
          {t(saved && status?.key ? 'hermes.status.set' : saved ? 'hermes.status.keyNeeded' : 'hermes.status.unset')}
        </span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-400">{t('hermes.note')}</p>
      {status === null ? (
        <div className="mt-2.5">
          <Spinner size={12} />
        </div>
      ) : (
        <form
          // The address is checked by the main process, which says what is wrong in the window's language; the
          // browser's own check stopped the save with an English bubble and nothing else (29 October).
          noValidate
          className="mt-2.5 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input type="url" autoComplete="off" spellCheck={false} value={url} onChange={(event) => {
              setUrl(event.target.value);
              setDirty(true);
            }} placeholder="https://host:8642" aria-label={t('hermes.url')} className={inputClass} data-hermes-url />
          <input type="text" autoComplete="off" spellCheck={false} value={profile} onChange={(event) => {
              setProfile(event.target.value);
              setDirty(true);
            }} placeholder={t('hermes.profile.placeholder')} aria-label={t('hermes.profile')} className={inputClass} data-hermes-profile />
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t(status.key ? 'hermes.key.kept' : 'hermes.key.placeholder')}
            aria-label={t('auth.key')}
            className={inputClass}
            data-hermes-key
          />
          <p className="text-[11px] leading-relaxed text-zinc-400">{t('hermes.key.note')}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button tone="primary" type="submit" disabled={busy || !url.trim() || (!status.key && !key.trim())} data-hermes-save>
              {busy ? <Spinner size={12} /> : null}
              {t('auth.key.save')}
            </Button>
            {saved ? (
              <Button tone="ghost" onClick={() => void test()} disabled={busy || dirty} title={dirty ? t('hermes.test.saveFirst') : undefined} data-hermes-test>
                <PlugZap size={13} />
                {t('hermes.test')}
              </Button>
            ) : null}
            {saved || status.key ? (
              <Button tone="danger" onClick={() => void forget()} disabled={busy} data-hermes-forget>
                <Trash2 size={13} />
                {t('hermes.forget')}
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </li>
  );
}

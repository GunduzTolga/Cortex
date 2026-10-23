import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Link2, RefreshCw, Send, Unlink } from 'lucide-react';
import { messageOf } from '@shared/ipcError';
import { BOT_KEY, type TelegramStatus } from '@shared/telegram';
import { useT } from '../i18n/useT';
import { useSaved } from '../store/saved';
import { Section } from './settingsParts';
import { Button, Spinner, inputClass } from './ui';

/**
 * Notes from the phone through the person's own Telegram bot
 * (shared/telegram.ts): the key from @BotFather given once, the phone paired
 * by opening a link, and from then on what is sent to the bot lands in the
 * inbox. The key is never shown again; it can only be given anew or forgotten.
 * A new key is taken where the pairing is shown too: one Telegram stopped
 * taking (revoked at @BotFather) is replaced there, the pairing kept, where
 * before the only way out was to forget the bot and pair the phone again.
 */

function Note({ children, tone = 'muted', data }: { children: React.ReactNode; tone?: 'muted' | 'error' | 'ok'; data?: string }) {
  const colour = tone === 'error' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-500';
  return (
    <p className={`px-3 text-[11.5px] leading-relaxed ${colour}`} data-telegram-note={data}>
      {children}
    </p>
  );
}

/** While the phone is not paired yet, the status is asked again this often, so the pairing shows the moment it happens. */
const WAITING_MS = 3_000;

/** The field the bot's key is pasted into, and its button; the key goes to the main process and is not kept here. */
function KeyField({ busy, onConnect }: { busy: boolean; onConnect: (key: string) => void }) {
  const t = useT();
  const [key, setKey] = useState('');
  const looksRight = BOT_KEY.test(key.trim());
  const connect = () => {
    if (!looksRight || busy) return;
    onConnect(key.trim());
    setKey('');
  };
  return (
    <>
      <div className="mt-2 flex items-center gap-2 px-3">
        <input
          className={`${inputClass} h-8`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          disabled={busy}
          placeholder="123456789:AA…"
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') connect();
          }}
          data-telegram-key
        />
        <Button tone="ghost" className="h-8 shrink-0" disabled={busy || !looksRight} onClick={connect} data-telegram-connect>
          {busy ? <Spinner size={12} label={t('telegram.connecting')} /> : <Link2 size={13} />}
          {t('telegram.connect')}
        </Button>
      </div>
      {key.trim() && !looksRight ? <Note data="key-shape">{t('telegram.key.shape')}</Note> : null}
    </>
  );
}

export function TelegramSection({ open }: { open: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The key asked for again where the bot is known: shown by "Anahtarı değiştir", or by Telegram refusing the one kept.
  const [newKey, setNewKey] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.cortex.telegram.status());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const waiting = Boolean(open && status?.key && status.bot && !status.paired);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), WAITING_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const act = async (work: () => Promise<TelegramStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await work());
      setNewKey(false);
      useSaved.getState().flash();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const connect = (key: string) => void act(() => window.cortex.telegram.connect(key));

  if (!status?.supported) return null;
  // Telegram no longer takes the key kept (revoked at @BotFather): the listener stopped, and waits for a new one.
  const refused = Boolean(status.key && status.bot && status.errorCode === 'anahtar_gecersiz');
  return (
    <Section title={t('telegram.title')} data="telegram">
      {!status.key || !status.bot ? (
        <>
          <Note data="intro">{t('telegram.intro')}</Note>
          <ol className="mt-2 list-decimal space-y-1 pl-8 pr-3 text-[12px] leading-relaxed text-darkDelegation" data-telegram-steps>
            <li>
              {t('telegram.step.botfather.before')}{' '}
              <a className="font-semibold underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                @BotFather
              </a>{' '}
              {t('telegram.step.botfather.after')}
            </li>
            <li>{t('telegram.step.key')}</li>
          </ol>
          <KeyField busy={busy} onConnect={connect} />
        </>
      ) : !status.paired ? (
        <>
          <Note data="pair">{t('telegram.pair', { bot: status.bot })}</Note>
          {status.link ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 px-3">
              <a
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-darkDelegation px-3 text-[10px] font-black uppercase tracking-widest text-white"
                href={status.link}
                target="_blank"
                rel="noreferrer"
                data-telegram-link
              >
                <Send size={13} />
                {t('telegram.pair.open')}
              </a>
              <span className="text-[11.5px] text-zinc-500" data-telegram-code>
                {t('telegram.pair.code', { code: status.code ?? '' })}
              </span>
            </div>
          ) : (
            <Note tone="error" data="code-gone">
              {t('telegram.pair.gone')}
            </Note>
          )}
          <div className="mt-2 flex items-center gap-2 px-3 text-[11.5px] text-zinc-500" data-telegram-waiting>
            <Spinner size={11} label={t('telegram.pair.waiting')} />
            {t('telegram.pair.waiting')}
          </div>
        </>
      ) : (
        <>
          <Note tone="ok" data="paired">
            {t('telegram.paired', { bot: status.bot, person: status.person ?? '' })}
          </Note>
          <Note data="listening">
            {status.listening ? t('telegram.listening', { count: status.captured }) : refused ? t('telegram.stopped.key') : t('telegram.notListening')}
          </Note>
          {!status.voiceNotes ? <Note data="voice">{t('telegram.voice.off')}</Note> : null}
        </>
      )}
      {refused ? (
        <div className="mt-2" data-telegram-refused>
          <Note tone="error" data="key-refused">
            {t('telegram.key.refused')}
          </Note>
          <KeyField busy={busy} onConnect={connect} />
        </div>
      ) : status.key && status.bot && status.error ? (
        <Note tone="error" data="engine-error">
          {status.error}
        </Note>
      ) : null}
      {status.key && status.bot && !refused && newKey ? (
        <div className="mt-2" data-telegram-new-key>
          <Note data="key-change">{t('telegram.key.changeHint')}</Note>
          <KeyField busy={busy} onConnect={connect} />
        </div>
      ) : null}
      {status.key && status.bot ? (
        <div className="mt-2 flex flex-wrap gap-2 px-3">
          {status.paired ? (
            <Button tone="ghost" disabled={busy} onClick={() => void act(() => window.cortex.telegram.pairAgain())} data-telegram-pair-again>
              <RefreshCw size={13} />
              {t('telegram.pairAgain')}
            </Button>
          ) : null}
          {!refused ? (
            <Button tone="ghost" disabled={busy} onClick={() => setNewKey((shown) => !shown)} data-telegram-change-key>
              <KeyRound size={13} />
              {t('telegram.key.change')}
            </Button>
          ) : null}
          <Button tone="ghost" disabled={busy} onClick={() => void act(() => window.cortex.telegram.disconnect())} data-telegram-disconnect>
            <Unlink size={13} />
            {t('telegram.disconnect')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Note tone="error" data="error">
            {error}
          </Note>
        </div>
      ) : null}
      <div className="mt-2">
        <Note data="privacy">{t('telegram.privacy')}</Note>
      </div>
    </Section>
  );
}

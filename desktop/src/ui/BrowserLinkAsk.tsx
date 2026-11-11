import { useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useBrowserLink } from '../store/browserLink';
import { Button, Modal } from './ui';

/**
 * Asked when a program connects as Cortex Browser without leave (electron/services/browserLink.ts): whether it may
 * ask Pyn here. Cortex does not know that the program is the browser, and says so: it shows the short code that
 * program was told, for the person to compare with the one the browser shows. It says what allowing does - the
 * browser's assistant answers with the person's own AI tool, and the conversations are kept here - and what is sent. Closed without an answer is a "no", as the microphone's
 * question is (MicConsent.tsx); the browser can ask again, and the leave can be taken back in the settings.
 */
export function BrowserLinkAsk() {
  const t = useT();
  const asking = useBrowserLink((s) => s.status?.asking === true);
  const code = useBrowserLink((s) => s.status?.code ?? null);
  const failed = useBrowserLink((s) => s.failed);
  const decide = useBrowserLink((s) => s.decide);
  useEffect(() => {
    void useBrowserLink.getState().boot();
  }, []);
  if (!asking) return null;
  return (
    <Modal
      open
      title={t('browserLink.ask.title')}
      onClose={() => void decide(false)}
      width="max-w-lg"
      dismissOnBackdrop={false}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button tone="quiet" onClick={() => void decide(false)} data-browser-link-refuse>
            {t('browserLink.ask.refuse')}
          </Button>
          <Button tone="primary" onClick={() => void decide(true)} data-browser-link-allow>
            <Globe size={13} />
            {t('browserLink.ask.allow')}
          </Button>
        </div>
      }
    >
      <div className="space-y-2.5 text-[13px] leading-relaxed text-zinc-700" data-browser-link-ask>
        <p>{t('browserLink.ask.body')}</p>
        {/* The same code the browser shows: compared by the person, never typed. Who connected is not otherwise known. */}
        {code ? (
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5">
            <p className="flex items-baseline gap-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{t('browserLink.ask.code')}</span>
              <span className="select-text font-mono text-2xl tracking-[0.3em] text-darkDelegation" data-browser-link-code>
                {code}
              </span>
            </p>
            <p className="mt-1 text-[12px] text-zinc-600">{t('browserLink.ask.compare')}</p>
          </div>
        ) : null}
        <p className="text-[12px] text-zinc-500">{t('browserLink.ask.sent')}</p>
        {failed ? (
          <p className="text-[12px] text-red-700" data-browser-link-ask-failed>
            {t('browserLink.ask.failed')}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

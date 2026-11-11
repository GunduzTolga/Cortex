import { useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useBrowserLink } from '../store/browserLink';
import { Button, Modal } from './ui';

/**
 * Asked the first time Cortex Browser connects on this computer (electron/services/browserLink.ts): whether it may
 * ask Pyn here. It says what allowing does - the browser's assistant answers with the person's own AI tool, and the
 * conversations are kept here - and what the browser sends. Closed without an answer is a "no", as the microphone's
 * question is (MicConsent.tsx); the browser can ask again, and the leave can be taken back in the settings.
 */
export function BrowserLinkAsk() {
  const t = useT();
  const asking = useBrowserLink((s) => s.status?.asking === true);
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

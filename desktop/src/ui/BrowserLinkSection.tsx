import { useEffect } from 'react';
import { Unplug } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useBrowserLink } from '../store/browserLink';
import { Row, Section } from './settingsParts';
import { Button } from './ui';

/**
 * Settings › "Cortex Browser bağlantısı" (electron/services/browserLink.ts): whether the person let Cortex Browser
 * ask Pyn here - connected now, allowed and not connected, or not allowed - and "İzni kaldır", which forgets the
 * leave and closes a browser's link. Said as it is: "connected" only while a browser is.
 */
export function BrowserLinkSection({ open }: { open: boolean }) {
  const t = useT();
  const status = useBrowserLink((s) => s.status);
  const failed = useBrowserLink((s) => s.failed);
  // Asked again as the dialog opens; followed while it is open (src/store/browserLink.ts).
  useEffect(() => {
    if (open) void useBrowserLink.getState().boot();
  }, [open]);
  const state = status?.connected ? 'connected' : status?.allowed ? 'allowed' : 'none';
  return (
    <Section title={t('settings.browserLink')} data="browser-link">
      <p className="mb-1 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('settings.browserLink.hint')}</p>
      {status ? (
        <Row label={t('settings.browserLink.state')}>
          <span className={`min-w-0 truncate text-[12px] ${state === 'connected' ? 'font-semibold text-emerald-700' : 'text-zinc-500'}`} data-browser-link-state={state}>
            {t(state === 'connected' ? 'settings.browserLink.connected' : state === 'allowed' ? 'settings.browserLink.allowed' : 'settings.browserLink.none')}
          </span>
          {status.allowed ? (
            <Button tone="ghost" className="h-8 shrink-0" onClick={() => void useBrowserLink.getState().unpair()} data-browser-link-unpair>
              <Unplug size={13} />
              {t('settings.browserLink.unpair')}
            </Button>
          ) : null}
        </Row>
      ) : null}
      {failed ? (
        <p className="px-3 text-[11.5px] leading-relaxed text-red-700" data-browser-link-failed>
          {t('settings.browserLink.failed')}
        </p>
      ) : null}
    </Section>
  );
}

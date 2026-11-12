import { useEffect } from 'react';
import { Check, Unplug } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useBrowserLink } from '../store/browserLink';
import { Row, Section } from './settingsParts';
import { Button, Switch } from './ui';

/**
 * Settings › "Cortex Browser bağlantısı" (electron/services/browserLink.ts). The switch that opens the link: off,
 * nothing listens - and switched off here by the person, Cortex Browser cannot open it by itself, which is said. On: whether a browser is let in - connected now, allowed and not connected, or not allowed - and
 * "İzni kaldır", which forgets the leave and closes a browser's link. Said as it is: "connected" only while a browser
 * is; on and not listening, that it could not be opened. A program waiting can be let in from here too, by its code;
 * and after three refusals in a row, when nobody is asked about any more, the person lets the browser ask again here.
 */
export function BrowserLinkSection({ open }: { open: boolean }) {
  const t = useT();
  const status = useBrowserLink((s) => s.status);
  const failed = useBrowserLink((s) => s.failed);
  // Asked again as the dialog opens; followed while it is open (src/store/browserLink.ts).
  useEffect(() => {
    if (open) void useBrowserLink.getState().boot();
  }, [open]);
  const link = useBrowserLink.getState();
  const state = status?.connected ? 'connected' : status?.allowed ? 'allowed' : 'none';
  return (
    <Section title={t('settings.browserLink')} data="browser-link">
      <p className="mb-1 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('settings.browserLink.hint')}</p>
      {status ? (
        <>
          <Switch checked={status.on} onChange={(on) => void link.setOn(on)} label={t('settings.browserLink.on')} hint={t('settings.browserLink.on.hint')} data-browser-link-on={status.on ? 'on' : 'off'} />
          {/* Closed by the person, which the browser cannot undo: said, so the switch reads as what it is. */}
          {status.turnedOff ? (
            <p className="px-3 text-[11.5px] leading-relaxed text-zinc-600" data-browser-link-turned-off>
              {t('settings.browserLink.turnedOff')}
            </p>
          ) : null}
          {status.on && !status.listening ? (
            <p className="px-3 text-[11.5px] leading-relaxed text-red-700" data-browser-link-not-listening>
              {t('settings.browserLink.notListening')}
            </p>
          ) : null}
          {status.on || status.allowed ? (
            <Row label={t('settings.browserLink.state')}>
              <span className={`min-w-0 truncate text-[12px] ${state === 'connected' ? 'font-semibold text-emerald-700' : 'text-zinc-500'}`} data-browser-link-state={state}>
                {t(state === 'connected' ? 'settings.browserLink.connected' : state === 'allowed' ? 'settings.browserLink.allowed' : 'settings.browserLink.none')}
              </span>
              {status.allowed ? (
                <Button tone="ghost" className="h-8 shrink-0" onClick={() => void link.unpair()} data-browser-link-unpair>
                  <Unplug size={13} />
                  {t('settings.browserLink.unpair')}
                </Button>
              ) : null}
            </Row>
          ) : null}
          {status.asking || status.locked ? (
            <div className="mx-3 mt-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5" data-browser-link-pending={status.asking ? 'waiting' : 'locked'}>
              <p className="text-[12px] leading-relaxed text-darkDelegation">{status.asking ? t('settings.browserLink.waiting', { code: status.code ?? '' }) : t('settings.browserLink.locked')}</p>
              <Button tone="ghost" className="mt-2 h-8" onClick={() => void link.allow()} data-browser-link-allow-here>
                <Check size={13} />
                {t(status.asking ? 'settings.browserLink.allow' : 'settings.browserLink.askAgain')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {failed ? (
        <p className="px-3 text-[11.5px] leading-relaxed text-red-700" data-browser-link-failed>
          {t('settings.browserLink.failed')}
        </p>
      ) : null}
    </Section>
  );
}

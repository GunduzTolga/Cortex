import { Mic, MicOff } from 'lucide-react';
import { wakePhraseLabel } from '@shared/setup';
import { useLanguage, useT } from '../i18n/useT';
import { useConsent } from '../store/consent';
import { useSetup } from '../store/setup';
import { Button, Modal } from './ui';

/**
 * Leave to use the microphone, asked in the app before Cortex opens it: once
 * before voice typing is set up, and before the microphone listens all the
 * time for the wake phrase (src/store/consent.ts). Each says what listens,
 * when, where the sound goes - nowhere - and how it is turned off. Closed
 * without an answer is a "no".
 */
export function MicConsent() {
  const t = useT();
  const english = useLanguage() === 'en';
  const asking = useConsent((s) => s.asking);
  const answer = useConsent((s) => s.answer);
  const phrase = wakePhraseLabel(useSetup((s) => s.status?.voice?.wakePhrase), english);
  if (!asking) return null;
  const wake = asking !== 'voice';
  return (
    <Modal
      open
      title={t(wake ? 'consent.wake.title' : 'consent.voice.title')}
      onClose={() => answer(false)}
      width="max-w-lg"
      dismissOnBackdrop={false}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button tone="quiet" onClick={() => answer(false)} data-consent-no>
            {asking === 'wakeFound' ? <MicOff size={13} /> : null}
            {t(asking === 'wakeFound' ? 'consent.wakeFound.no' : 'consent.no')}
          </Button>
          <Button tone="primary" onClick={() => answer(true)} data-consent-yes autoFocus>
            <Mic size={13} />
            {t(asking === 'wake' ? 'consent.wake.yes' : 'consent.yes')}
          </Button>
        </div>
      }
    >
      <div className="space-y-2.5 text-[13px] leading-relaxed text-zinc-700" data-consent={asking}>
        {asking === 'wakeFound' ? <p className="font-semibold text-darkDelegation">{t('consent.wakeFound.body')}</p> : null}
        {wake ? (
          <>
            <p>{t('consent.wake.when', { phrase })}</p>
            <p>{t('consent.wake.where')}</p>
            <p>{t('consent.wake.off')}</p>
          </>
        ) : (
          <>
            <p>{t('consent.voice.when')}</p>
            <p>{t('consent.voice.where')}</p>
          </>
        )}
        <p className="text-[12px] text-zinc-500">{t('consent.windows')}</p>
      </div>
    </Modal>
  );
}

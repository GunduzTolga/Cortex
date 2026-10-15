import type { ReactNode } from 'react';
import { FolderOpen, KeyRound } from 'lucide-react';
import { useChat } from '../chat/chatStore';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { LanguageSwitch } from './LanguageSwitch';
import { Button, Modal, Switch } from './ui';

/**
 * The app's settings, from the gear in the top bar or Ctrl+,: the language
 * and the vault, how the notes tree shows the vault, and the AI tools' sign-ins.
 * Each change is the main process's to keep (electron/services/settings.ts)
 * and takes effect at once; there is nothing to save.
 */

function Section({ title, children, data }: { title: string; children: ReactNode; data: string }) {
  return (
    <section className="border-b border-zinc-100 py-4 first:pt-0 last:border-b-0 last:pb-0" data-settings-section={data}>
      <h3 className="mb-2 px-3 text-[10px] font-black uppercase tracking-widest text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-darkDelegation">{label}</span>
      {children}
    </div>
  );
}

export function SettingsDialog() {
  const t = useT();
  const open = useApp((s) => s.settingsOpen);
  const settings = useApp((s) => s.settings);
  const vault = useApp((s) => s.vault.vault);
  const version = useApp((s) => s.version);
  const close = () => useApp.getState().openSettings(false);
  const set = useApp.getState().setSettings;
  return (
    <Modal open={open} title={t('settings.title')} onClose={close} width="max-w-lg">
      <div data-settings>
        <Section title={t('settings.general')} data="general">
          <Row label={t('settings.language')}>
            <LanguageSwitch />
          </Row>
          {vault ? (
            <Row label={t('settings.vault')}>
              <span className="min-w-0 truncate text-[12px] text-zinc-500" data-settings-vault>
                {vault.name}
              </span>
              <Button tone="ghost" className="h-8 shrink-0" onClick={() => void useApp.getState().chooseVault(t('app.vault.failed'))}>
                <FolderOpen size={13} />
                {t('settings.vault.change')}
              </Button>
            </Row>
          ) : null}
        </Section>
        <Section title={t('settings.notes')} data="notes">
          <Switch checked={settings.allFiles} onChange={(on) => void set({ allFiles: on })} label={t('settings.allFiles')} hint={t('settings.allFiles.hint')} data-settings-all-files />
          <Switch checked={settings.nameIcons} onChange={(on) => void set({ nameIcons: on })} label={t('settings.nameIcons')} hint={t('settings.nameIcons.hint')} data-settings-name-icons />
        </Section>
        <Section title={t('settings.ai')} data="ai">
          <p className="mb-2.5 px-3 text-[11.5px] leading-relaxed text-zinc-500">{t('settings.ai.hint')}</p>
          <div className="px-3">
            <Button
              tone="ghost"
              onClick={() => {
                close();
                useChat.getState().openAuth();
              }}
              data-settings-auth
            >
              <KeyRound size={13} />
              {t('auth.manage')}
            </Button>
          </div>
        </Section>
        <Section title={t('settings.about')} data="about">
          <p className="px-3 font-mono text-[12px] text-zinc-500">{t('settings.version', { version })}</p>
        </Section>
      </div>
    </Modal>
  );
}

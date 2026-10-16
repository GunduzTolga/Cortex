import { useEffect, useState } from 'react';
import { FolderOpen, KeyRound, ListChecks } from 'lucide-react';
import { useChat } from '../chat/chatStore';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { LanguageSwitch } from './LanguageSwitch';
import { SetupSections } from './SetupSections';
import { Row, Section } from './settingsParts';
import { Button, Modal, Switch, inputClass } from './ui';

/**
 * The app's settings, from the gear in the top bar or Ctrl+,: the language
 * and the vault, how the notes tree shows the vault, the AI tools' sign-ins,
 * and Cortex's own setup, its engine in the vault and voice typing
 * (SetupSections), so that nothing is installed from a terminal. Each change is the main process's to keep (electron/services/settings.ts)
 * and takes effect at once; there is nothing to save.
 */

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
          <Row label={t('settings.name')}>
            <NameField />
          </Row>
          <Switch checked={settings.background} onChange={(on) => void set({ background: on })} label={t('settings.background')} hint={t('settings.background.hint')} data-settings-background />
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
        <SetupSections open={open} />
        <Section title={t('settings.onboarding')} data="onboarding">
          <div className="px-3">
            <Button
              tone="ghost"
              onClick={() => {
                close();
                void set({ onboarded: false });
              }}
              data-settings-onboarding
            >
              <ListChecks size={13} />
              {t('settings.onboarding.open')}
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

/** How Pyn and the office address the person: kept when the field is left or Enter is pressed. */
function NameField() {
  const t = useT();
  const saved = useApp((s) => s.settings.userName);
  const [name, setName] = useState(saved ?? '');
  useEffect(() => setName(saved ?? ''), [saved]);
  const keep = () => {
    if (name.trim() !== (saved ?? '')) void useApp.getState().setSettings({ userName: name.trim() || null });
  };
  return (
    <input
      className={`${inputClass.replace('w-full', '')} h-8 w-56 shrink-0`}
      value={name}
      maxLength={40}
      placeholder={t('settings.name.placeholder')}
      onChange={(event) => setName(event.target.value)}
      onBlur={keep}
      onKeyDown={(event) => {
        if (event.key === 'Enter') keep();
      }}
      data-settings-name
    />
  );
}

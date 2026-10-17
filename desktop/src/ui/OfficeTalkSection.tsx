import type { TalkTool } from '@shared/office';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { TALK_EVERY, TALK_TOOL_NAME, useTalk, useTalkModels, useTalkTools, type TalkToolState } from '../office/talkPrefs';
import { Row, Section, Segments } from './settingsParts';
import { Switch, inputClass } from './ui';

/**
 * The office's live conversations from the app's settings: the same choice
 * as the office's own settings (src/office/talkPrefs.ts), so it is found
 * where every other setting is. Which tool writes them (a model server on
 * this machine, or Claude Code), with which model, how often.
 */

const STATE_WORD: Record<TalkToolState, Key> = { ready: 'office.talk.ready', off: 'office.talk.off', signedOut: 'office.talk.signedOut' };

function Note({ children, data }: { children: React.ReactNode; data?: string }) {
  return (
    <p className="px-3 text-[11.5px] leading-relaxed text-zinc-500" data-settings-office-note={data}>
      {children}
    </p>
  );
}

export function OfficeTalkSection() {
  const t = useT();
  const talk = useTalk();
  const tools = useTalkTools();
  const ready = tools.some((one) => one.id === talk.tool && one.state === 'ready');
  const models = useTalkModels(talk.live ? talk.tool : null, ready);
  // A model chosen before that the server no longer lists is still shown as the choice.
  const names = models ? [...models.models, ...(talk.model && !models.models.includes(talk.model) ? [talk.model] : [])] : [];
  return (
    <Section title={t('settings.office')} data="office">
      <Switch checked={talk.live} onChange={(live) => talk.change({ live })} label={t('office.settings.live')} hint={t('office.settings.live.hint')} data-settings-office-live />
      {talk.live ? (
        <>
          <Row label={t('office.settings.tool')}>
            <Segments<TalkTool>
              label={t('office.settings.tool')}
              data="settings-office-tool"
              chosen={talk.tool}
              onChoose={(tool) => talk.change({ tool, model: null })}
              options={tools.map(({ id, state }) => ({
                id,
                title: t(STATE_WORD[state]),
                label: (
                  <>
                    <span className={`h-1.5 w-1.5 rounded-full ${state === 'ready' ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                    {TALK_TOOL_NAME[id]}
                  </>
                ),
              }))}
            />
          </Row>
          {!talk.tool ? <Note data="pick">{t('settings.office.pick')}</Note> : null}
          {talk.tool && !ready ? (
            <Note data="not-ready">{t(talk.tool === 'claude' ? 'office.settings.tool.signedOut' : 'office.settings.tool.off', { tool: TALK_TOOL_NAME[talk.tool] })}</Note>
          ) : null}
          {talk.tool && ready ? (
            <Row label={t('office.settings.model')}>
              {!models ? (
                <span className="text-[12px] text-zinc-500">{t('office.settings.model.loading')}</span>
              ) : (
                <select
                  className={`${inputClass.replace('w-full', '')} h-8 w-56 shrink-0`}
                  value={talk.model ?? ''}
                  onChange={(event) => talk.change({ model: event.target.value || null })}
                  data-settings-office-model
                >
                  <option value="">{t(talk.tool === 'claude' ? 'office.settings.model.quick' : 'office.settings.model.loaded')}</option>
                  {names.map((name) => (
                    <option key={name} value={name}>
                      {(models.loaded.includes(name) ? '● ' : '') + name}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          ) : null}
          {talk.tool && ready && models && !models.models.length ? <Note data="no-models">{t('office.settings.model.none')}</Note> : null}
          <Row label={t('office.settings.every')}>
            <Segments<number>
              label={t('office.settings.every')}
              data="settings-office-every"
              chosen={talk.every}
              onChoose={(every) => talk.change({ every })}
              options={TALK_EVERY.map((minutes) => ({ id: minutes, label: t('office.settings.minutes', { count: minutes }) }))}
            />
          </Row>
          <Note>{t('settings.office.note')}</Note>
        </>
      ) : null}
    </Section>
  );
}

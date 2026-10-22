import { create } from 'zustand';
import { messageOf } from '@shared/ipcError';
import type { ListenerWord, SetupJob, SetupPush, SetupStatus, VoicePatch } from '@shared/setup';
import { translate } from '../i18n';
import { useApp } from './app';
import { useConsent } from './consent';
import { useSaved } from './saved';

/**
 * Cortex's engine and voice typing being set up (shared/setup.ts), held
 * outside the settings window: a 2 GB download goes on with the window
 * closed, and its end is said in a toast wherever the person is.
 */

interface SetupState {
  status: SetupStatus | null;
  /** The job going on and the last of what it said; a download's percent replaces the one before it. */
  steps: { job: SetupJob; lines: string[] } | null;
  error: { job: SetupJob; text: string } | null;
  /** How the voice helper is: fetching a model (how far), loading, ready, failed; null without a listener running. */
  helper: ListenerWord | null;
  refresh(): Promise<void>;
  run(job: SetupJob): Promise<void>;
  voice(patch: VoicePatch): Promise<void>;
}

/** A download's progress line, as the engine says it ("%40 (650 / 1624 MB)") or in English ("40% (…)"). */
const percent = (line: string) => /^%?\d+%? \(\d+ \/ \d+ MB\)$/.test(line.trim());
let listening = false;

const DONE = { python: 'setup.python.done', engine: 'setup.engine.done', voice: 'setup.voice.done' } as const;

function said(key: (typeof DONE)[SetupJob] | 'setup.failed', values?: Record<string, string>): string {
  return translate(useApp.getState().settings.language ?? 'tr', key, values);
}

export const useSetup = create<SetupState>((set, get) => {
  const listen = () => {
    if (listening) return;
    listening = true;
    window.cortex.on.voiceStatus((voice) => set((state) => (state.status ? { status: { ...state.status, voice } } : {})));
    window.cortex.on.voiceHelper((helper) => set({ helper }));
    window.cortex.on.setup((push: SetupPush) => {
      if ('step' in push) {
        const before = get().steps;
        const lines = before?.job === push.job ? [...before.lines] : [];
        if (lines.length && percent(lines[lines.length - 1]) && percent(push.step)) lines[lines.length - 1] = push.step;
        else lines.push(push.step);
        set({ steps: { job: push.job, lines: lines.slice(-6) } });
        return;
      }
      if (push.ok) {
        useApp.getState().toast({ tone: 'success', title: said(DONE[push.job]) });
      } else {
        useApp.getState().toast({ tone: 'error', title: said('setup.failed'), detail: push.error, sticky: true });
      }
    });
  };

  return {
    status: null,
    steps: null,
    error: null,
    helper: null,

    async refresh() {
      listen();
      try {
        const [status, helper] = await Promise.all([window.cortex.setup.status(), window.cortex.setup.helper()]);
        set({ status, helper });
      } catch (err) {
        set({ error: { job: 'engine', text: messageOf(err) } });
      }
    },

    async run(job) {
      // Voice typing uses the microphone: asked before it is set up.
      if (job === 'voice' && !useApp.getState().settings.voiceConsent) {
        if (!(await useConsent.getState().ask('voice'))) return;
        await useApp.getState().setSettings({ voiceConsent: true });
      }
      listen();
      const status = get().status;
      set({ error: null, steps: { job, lines: [] }, status: status && { ...status, job } });
      try {
        const api = window.cortex.setup;
        const after = job === 'python' ? await api.installPython() : job === 'engine' ? await api.installEngine() : await api.installVoice();
        set({ status: after, steps: null });
      } catch (err) {
        set({ error: { job, text: messageOf(err) }, steps: null });
        await get().refresh();
      }
    },

    async voice(patch) {
      // Listening all the time: asked before it is turned on (services/microphone.ts keeps it to while Cortex runs).
      if (patch.wake === true && !useApp.getState().settings.wakeConsent) {
        if (!(await useConsent.getState().ask('wake'))) return;
        await useApp.getState().setSettings({ wakeConsent: true });
      }
      try {
        set({ status: await window.cortex.setup.voice(patch), error: null });
        useSaved.getState().flash();
      } catch (err) {
        set({ error: { job: 'voice', text: messageOf(err) } });
      }
    },
  };
});

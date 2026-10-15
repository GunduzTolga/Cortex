import { create } from 'zustand';
import { messageOf } from '@shared/ipcError';
import type { SetupJob, SetupPush, SetupStatus } from '@shared/setup';
import { translate } from '../i18n';
import { useApp } from './app';

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
  refresh(): Promise<void>;
  run(job: SetupJob): Promise<void>;
  voice(patch: { on?: boolean; wake?: boolean }): Promise<void>;
}

const percent = (line: string) => line.trimStart().startsWith('%');
let listening = false;

function said(key: 'setup.engine.done' | 'setup.voice.done' | 'setup.failed', values?: Record<string, string>): string {
  return translate(useApp.getState().settings.language ?? 'tr', key, values);
}

export const useSetup = create<SetupState>((set, get) => {
  const listen = () => {
    if (listening) return;
    listening = true;
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
        useApp.getState().toast({ tone: 'success', title: said(push.job === 'engine' ? 'setup.engine.done' : 'setup.voice.done') });
      } else {
        useApp.getState().toast({ tone: 'error', title: said('setup.failed'), detail: push.error, sticky: true });
      }
    });
  };

  return {
    status: null,
    steps: null,
    error: null,

    async refresh() {
      listen();
      try {
        set({ status: await window.cortex.setup.status() });
      } catch (err) {
        set({ error: { job: 'engine', text: messageOf(err) } });
      }
    },

    async run(job) {
      listen();
      const status = get().status;
      set({ error: null, steps: { job, lines: [] }, status: status && { ...status, job } });
      try {
        const after = job === 'engine' ? await window.cortex.setup.installEngine() : await window.cortex.setup.installVoice();
        set({ status: after, steps: null });
      } catch (err) {
        set({ error: { job, text: messageOf(err) }, steps: null });
        await get().refresh();
      }
    },

    async voice(patch) {
      try {
        set({ status: await window.cortex.setup.voice(patch), error: null });
      } catch (err) {
        set({ error: { job: 'voice', text: messageOf(err) } });
      }
    },
  };
});

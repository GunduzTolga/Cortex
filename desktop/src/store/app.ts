import { create } from 'zustand';
import type { BootstrapPayload, VaultStatus, WindowSettings } from '@shared/api';
import { messageOf } from '@shared/ipcError';

/**
 * What the window holds around the notes screen: whether it has heard from
 * the main process, the language, the vault by name, and the toasts.
 * Krewgent's library store cut to this app (its projects, profiles and
 * services are not here); the toasts are its, as the notes screen calls them.
 */

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
  /** Stays until the person closes it: for what must not be missed while they look elsewhere. */
  sticky?: boolean;
}

interface AppState {
  ready: boolean;
  bootError: string | null;
  settings: WindowSettings;
  vault: VaultStatus;
  settingsUnreadable: BootstrapPayload['settingsUnreadable'];
  version: string;
  toasts: Toast[];
  boot(): Promise<void>;
  setLanguage(language: WindowSettings['language']): Promise<void>;
  /** The system's dialog; the vault chosen, or the reason it could not be, said in a toast. */
  chooseVault(failed: string): Promise<void>;
  refreshVault(): Promise<void>;
  toast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  settings: { language: null },
  vault: { vault: null, missing: false },
  settingsUnreadable: null,
  version: '',
  toasts: [],

  async boot() {
    try {
      const payload = await window.cortex.bootstrap();
      set({ ready: true, bootError: null, settings: payload.settings, vault: payload.vault, settingsUnreadable: payload.settingsUnreadable, version: payload.version });
    } catch (err) {
      set({ bootError: messageOf(err) });
    }
  },

  async setLanguage(language) {
    try {
      set({ settings: await window.cortex.settings.set({ language }) });
    } catch (err) {
      get().toast({ tone: 'error', title: 'Cortex', detail: messageOf(err) });
    }
  },

  async chooseVault(failed) {
    try {
      const status = await window.cortex.vault.choose();
      if (status) set({ vault: status });
    } catch (err) {
      get().toast({ tone: 'error', title: failed, detail: messageOf(err) });
    }
  },

  async refreshVault() {
    try {
      set({ vault: await window.cortex.vault.status() });
    } catch {
      /* the last one read stands */
    }
  },

  toast(toast) {
    toastSeq += 1;
    const id = `toast-${toastSeq}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    if (!toast.sticky) setTimeout(() => get().dismissToast(id), toast.tone === 'error' ? 9000 : 4500);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((one) => one.id !== id) }));
  },
}));

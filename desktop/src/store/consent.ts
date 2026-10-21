import { create } from 'zustand';

/**
 * The microphone asked for before Cortex uses it (src/ui/MicConsent.tsx): for
 * voice typing before it is set up, and before it listens all the time for the
 * wake phrase - or, found listening all the time without having been asked,
 * whether it may go on. One question at a time; a new one answers the last
 * "no".
 */

export type ConsentKind = 'voice' | 'wake' | 'wakeFound';

interface ConsentState {
  asking: ConsentKind | null;
  /** The question shown; true when the person allows it. */
  ask(kind: ConsentKind): Promise<boolean>;
  answer(allowed: boolean): void;
}

let waiting: ((allowed: boolean) => void) | null = null;

export const useConsent = create<ConsentState>((set) => ({
  asking: null,

  ask(kind) {
    waiting?.(false);
    return new Promise<boolean>((resolve) => {
      waiting = resolve;
      set({ asking: kind });
    });
  },

  answer(allowed) {
    const resolve = waiting;
    waiting = null;
    set({ asking: null });
    resolve?.(allowed);
  },
}));

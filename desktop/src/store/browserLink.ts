import { create } from 'zustand';
import type { BrowserLinkStatus } from '@shared/browserLink';

/**
 * Cortex Browser's link as the window holds it (electron/services/browserLink.ts): whether it is open, whether the
 * person let the browser in, whether one is connected, and whether one waits to be let in - the question the window then asks
 * (src/ui/BrowserLinkAsk.tsx), and the row in the settings (src/ui/BrowserLinkSection.tsx). The main process tells
 * every change; what an answer came to is taken from the answer itself, without waiting to be told.
 */
interface BrowserLinkState {
  /** Null until it has been asked for. */
  status: BrowserLinkStatus | null;
  /** The last thing asked of the main process was not taken: said where it was asked. */
  failed: boolean;
  boot(): Promise<void>;
  setOn(on: boolean): Promise<void>;
  decide(allow: boolean): Promise<void>;
  /** "Allow" in the settings: the browser waiting let in, or one refused too often let ask again. */
  allow(): Promise<void>;
  unpair(): Promise<void>;
}

let listening = false;

export const useBrowserLink = create<BrowserLinkState>((set) => {
  const ask = async (work: () => Promise<BrowserLinkStatus>) => {
    try {
      set({ status: await work(), failed: false });
    } catch {
      set({ failed: true });
    }
  };
  return {
    status: null,
    failed: false,
    async boot() {
      if (!listening) {
        listening = true;
        window.cortex.on.browserLink((status) => set({ status }));
      }
      await ask(() => window.cortex.browserLink.status());
    },
    setOn: (on) => ask(() => window.cortex.browserLink.setOn(on)),
    decide: (allow) => ask(() => window.cortex.browserLink.decide(allow)),
    allow: () => ask(() => window.cortex.browserLink.allow()),
    unpair: () => ask(() => window.cortex.browserLink.unpair()),
  };
});

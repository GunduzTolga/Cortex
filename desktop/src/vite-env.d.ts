/// <reference types="vite/client" />
import type { CortexApi } from '@shared/api';

declare global {
  interface Window {
    /** The one object the preload hands the window (electron/preload.ts). */
    cortex: CortexApi;
  }
}

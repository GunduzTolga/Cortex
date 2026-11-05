import { net } from 'electron';

/**
 * A request through Chromium's network stack (Electron's net.fetch): it uses Windows' proxy settings (a PAC file, a
 * company proxy) and its certificate store, which Node's own fetch does not. On a company network GitHub's sign-in, the
 * Git download and the tools' packages failed with "GitHub'a ulaşılamadı" while the browser on the same machine reached
 * them (2026-11-05). Only once the app is ready, as every caller here is.
 */
export function netFetch(url: string, init?: RequestInit): Promise<Response> {
  return net.fetch(url, init);
}

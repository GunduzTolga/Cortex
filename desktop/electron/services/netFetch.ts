import { net } from 'electron';

/**
 * A request through Chromium's network stack (Electron's net.fetch): it uses Windows' proxy settings (a PAC file, a
 * company proxy) and its certificate store, which Node's own fetch does not. On a company network GitHub's sign-in, the
 * Git download and the tools' packages failed with "GitHub'a ulaşılamadı" while the browser on the same machine reached
 * them (2026-11-05). Only once the app is ready, as every caller here is.
 */
export function netFetch(url: string, init?: RequestInit): Promise<Response> {
  // Not from Chromium's HTTP cache, which Node's fetch never had: GitHub answers `private, max-age=60`, and the repository
  // list read again a moment after "Yeni repo aç" came from the cache without the new one (the review of 1.0.56). Large
  // downloads (Git, tool packages) are not written to it either.
  // `cache` is Chromium's (seen in Electron 43); Node's RequestInit type does not name it.
  return net.fetch(url, { ...init, cache: 'no-store' } as Parameters<typeof net.fetch>[1]);
}

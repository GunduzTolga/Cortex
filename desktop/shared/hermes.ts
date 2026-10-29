/**
 * A Hermes Agent running on another machine, as the chat's engine: the chat
 * talks to its gateway's API server over HTTP (electron/services/hermesChat.ts),
 * and can continue one of its sessions - one begun on a phone, in its own
 * terminal, anywhere - where it left off.
 *
 * What the window sets is the server's address, the profile it serves under
 * `/p/<profile>/` on that address where it serves several, and its key
 * (`API_SERVER_KEY`). The address and the profile are plain settings; the key
 * is kept encrypted with the others (electron/services/keys.ts), and the
 * window learns only whether one is kept.
 */

export interface HermesStatus {
  /** The server's address (`https://host:8642`), or null before one is given. */
  url: string | null;
  /** The profile served under `/p/<profile>/` on that address; null for the server's own. */
  profile: string | null;
  /** A key is kept here, encrypted; the window never reads it back. */
  key: boolean;
}

export interface HermesSetup {
  url: string;
  profile?: string | null;
  /** A new key; left out, the one kept stays. */
  key?: string;
}

export interface HermesApi {
  status(): Promise<HermesStatus>;
  save(setup: HermesSetup): Promise<HermesStatus>;
  /** The address, the profile and the key forgotten. */
  forget(): Promise<HermesStatus>;
  /** The server asked with the key kept, as a chat would ask it: how many sessions it lists, or a sentence saying what is wrong. */
  test(): Promise<{ sessions: number }>;
}

/** A profile's name, as Hermes takes one in its path. */
export const HERMES_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * An address as it is kept: `http(s)://host[:port][/path]`, its closing `/` taken off; null for
 * anything else - another scheme, a name and a password in it, a query, spaces.
 */
export function hermesAddress(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

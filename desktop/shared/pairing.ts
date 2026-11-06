import { HERMES_PROFILE, hermesAddress } from './hermes';

/**
 * A pairing code: everything a desktop Cortex needs to reach Pyn on the person's own server, in one line, so the person
 * never sees an address or a key (docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md).
 *
 *     cortex-pair-1:<base64url, no padding, of {"v":1,"url","profile","authkey","hermesKey","exp"}>
 *
 * Written by the server (template/.claude/scripts/beyin_v3_eslestir.py, `code`); read here, in the main process, which
 * keeps what it decoded (the address and the profile as settings, the agent's key encrypted, the tailnet key spent on
 * joining) and drops the code itself. The code is a secret: nothing here says any part of it back, a refusal included.
 */

export const PAIRING_PREFIX = 'cortex-pair-1:';
/** Longer than any code the server writes (a few hundred characters): pasted text, not a code. */
export const PAIRING_MAX = 4000;

export interface Pairing {
  /** The agent's address in the tailnet, as hermesAddress keeps it. */
  url: string;
  /** The profile served under `/p/<profile>/`; null for the server's own. */
  profile: string | null;
  /** Tailscale's one-off auth key (`tskey-…`), spent by the helper's first `up`. */
  authkey: string;
  /** The agent's API key (API_SERVER_KEY), kept encrypted (keys.ts). */
  hermesKey: string;
  /** When the code stops being tried, in ms since the epoch. */
  exp: number;
}

/** Why a code was not taken; each but `expired` is told as "not a Cortex pairing code" (pairingRefusalText). */
export type PairingRefusal = 'length' | 'prefix' | 'encoding' | 'json' | 'version' | 'field' | 'url' | 'profile' | 'authkey' | 'expired';

export type PairingResult = { ok: true; pairing: Pairing } | { ok: false; refusal: PairingRefusal };

/** `YYYY-MM-DDTHH:MM:SSZ`, as the server writes it (UTC, no fraction). */
const EXP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** base64url without padding, as Python's urlsafe_b64encode(...).rstrip('=') writes it; null for anything else. */
function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const isSingleLine = (value: string, max: number) => value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);

/** A pasted code read and checked, against `now` (ms): the pairing it carries, or why it is refused. Pure. */
export function parsePairing(input: unknown, now: number = Date.now()): PairingResult {
  const refuse = (refusal: PairingRefusal): PairingResult => ({ ok: false, refusal });
  if (typeof input !== 'string') return refuse('prefix');
  if (input.length > PAIRING_MAX) return refuse('length');
  // Copied from a phone, a code can come with a line break in it; base64url has no white space of its own.
  const text = input.replace(/\s+/g, '');
  if (!text.startsWith(PAIRING_PREFIX)) return refuse('prefix');
  const json = fromBase64Url(text.slice(PAIRING_PREFIX.length));
  if (json === null) return refuse('encoding');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return refuse('json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('json');
  const data = raw as Record<string, unknown>;
  if (data.v !== 1) return refuse('version');
  const { url, profile, authkey, hermesKey, exp } = data;
  if (typeof url !== 'string' || typeof authkey !== 'string' || typeof hermesKey !== 'string' || typeof exp !== 'string') return refuse('field');
  if (profile !== null && profile !== undefined && typeof profile !== 'string') return refuse('field');
  // As keys.ts keeps a key: one line, not empty, not longer than 500.
  if (!isSingleLine(hermesKey.trim(), 500)) return refuse('field');
  const address = hermesAddress(url);
  if (!address) return refuse('url');
  if (typeof profile === 'string' && !HERMES_PROFILE.test(profile)) return refuse('profile');
  if (!authkey.startsWith('tskey-') || authkey.length > 500 || /\s/.test(authkey)) return refuse('authkey');
  const at = EXP.exec(exp);
  const when = at ? Date.UTC(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6]) : NaN;
  // A date that does not exist (02-30) comes back as another day: refused rather than read as one.
  if (!at || !Number.isFinite(when) || new Date(when).toISOString().slice(0, 19) + 'Z' !== exp) return refuse('field');
  if (when <= now) return refuse('expired');
  return { ok: true, pairing: { url: address, profile: typeof profile === 'string' ? profile : null, authkey, hermesKey: hermesKey.trim(), exp: when } };
}

/** The one sentence a refusal is told with, in the window's language (the design's "Hata ve uç durumlar"). */
export function pairingRefusalText(refusal: PairingRefusal, english: boolean): string {
  if (refusal === 'expired') return english ? 'The code has expired. Get a new code.' : 'Kodun süresi dolmuş. Yeni kod al.';
  return english
    ? "This is not a Cortex pairing code. Get a new code from 'Add a computer' on the phone."
    : "Bu bir Cortex eşleştirme kodu değil. Telefondaki 'Bilgisayar ekle'den yeni kod al.";
}

/* ------------------------------------------------------------------ */
/* The connection, as the window is told it                            */
/* ------------------------------------------------------------------ */

/**
 * - `kapali`: no pairing made here.
 * - `baglaniyor`: the helper is joining, or coming back after a start or a crash.
 * - `bagli`: requests reach the server (through the helper, or straight where this computer is in the tailnet already).
 * - `hata`: the helper could not join or keep up; `message` says what to do.
 */
export type TailnetState = 'kapali' | 'baglaniyor' | 'bagli' | 'hata';

export interface TailnetStatus {
  state: TailnetState;
  /** One sentence for the person, in the window's language; null where the state says it all. */
  message: string | null;
  /** Bağlı without the helper: this computer reaches the address itself (Tailscale already installed). */
  direct: boolean;
}

export interface TailnetApi {
  status(): Promise<TailnetStatus>;
  /** A code pasted into "Kodla bağlan": rejected with one sentence, or the connection's status once it is up. */
  pair(code: string): Promise<TailnetStatus>;
  /** "Bağlantıyı kaldır": the helper logged out, its state deleted, the server's settings forgotten. */
  forget(): Promise<TailnetStatus>;
}

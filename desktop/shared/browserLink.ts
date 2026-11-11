/**
 * The link between Cortex and Cortex Browser on the same computer (electron/services/browserLink.ts): the browser's
 * assistant asks, and the AI tool the person uses in Cortex answers, so the browser holds no key and no model.
 *
 * What is said over it is written once, in `browser-link-contract.json` beside this file: the same file lies in the
 * browser's repository, and both sides' tests read it (tests/browserLinkContract.test.ts). The names here are that
 * file's, letter for letter. One JSON object a line (UTF-8, ended by `\n`), a line at most LINE_MAX bytes.
 *
 * Read leniently, as the contract says: a field not known is left out, a `type` not known is no message and closes
 * nothing. A line that is not JSON, is not an object, is longer than the limit, or is a known message without what it
 * needs, is a bad message.
 */

export const BROWSER_LINK_PROTOCOL = 1;
/** The longest line, in bytes, its `\n` not counted. */
export const LINE_MAX = 16 * 1024 * 1024;
/** The file in Cortex's data folder that says where the link is (Rendezvous). */
export const RENDEZVOUS_FILE = 'browser-link.json';

export const PAIRING_STATES = ['waiting', 'refused'] as const;
export const EVENT_KINDS = ['status', 'text', 'permission', 'permission_closed', 'done', 'error'] as const;
export const STATUS_PHASES = ['starting', 'thinking', 'answering'] as const;
export const ERROR_CODES = ['not_signed_in', 'no_tool', 'limit', 'network', 'tool_failed', 'busy', 'too_long', 'internal'] as const;
export const CAPTURED_CODES = ['capture_failed', 'no_vault'] as const;
export const BYE_REASONS = ['protocol', 'unpaired', 'shutdown', 'bad_message'] as const;

export type PairingState = (typeof PAIRING_STATES)[number];
export type StatusPhase = (typeof STATUS_PHASES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type CapturedCode = (typeof CAPTURED_CODES)[number];
export type ByeReason = (typeof BYE_REASONS)[number];

/** Where the browser finds Cortex: the pipe to connect to, the program to start when nothing listens there, and the process that wrote it. */
export interface Rendezvous {
  version: number;
  pipe: string;
  exe: string;
  pid: number;
}

/** A web page the person added to a question, as the browser read it. Its text is not to be trusted. */
export interface LinkPage {
  title: string;
  url: string;
  text: string;
  /** The browser cut the text short. */
  truncated: boolean;
}

export type BrowserMessage =
  | { type: 'hello'; protocol: number; client: string; client_version: string; token: string | null }
  | { type: 'ask'; id: string; conversation: string; text: string; page: LinkPage | null }
  /** The person's answer to a card; `option` null gives it up. */
  | { type: 'answer'; id: string; permission: string; option: string | null }
  | { type: 'cancel'; id: string }
  | { type: 'capture'; id: string; title: string; url: string; note: string }
  | { type: 'bye'; reason: string };

export interface LinkPermission {
  id: string;
  title: string;
  kind: string;
  paths: string[];
  options: Array<{ id: string; name: string; kind: string }>;
  /** A web page's content was added to this conversation before the step was asked for. */
  after_page: boolean;
}

export type LinkEvent =
  | { type: 'event'; id: string; kind: 'status'; phase: StatusPhase }
  | { type: 'event'; id: string; kind: 'text'; text: string }
  | { type: 'event'; id: string; kind: 'permission'; permission: LinkPermission }
  | { type: 'event'; id: string; kind: 'permission_closed'; permission: string; option: string | null }
  | { type: 'event'; id: string; kind: 'done'; cancelled: boolean }
  | { type: 'event'; id: string; kind: 'error'; code: ErrorCode; detail: string };

export type CortexMessage =
  | { type: 'pairing'; state: PairingState }
  | { type: 'hello_ok'; protocol: number; app_version: string; tool: { id: string; name: string } | null; vault_name: string | null; token: string | null }
  | LinkEvent
  | { type: 'captured'; id: string; ok: true; path: string }
  | { type: 'captured'; id: string; ok: false; code: CapturedCode; detail: string }
  | { type: 'bye'; reason: ByeReason };

/** The longest id a message names (an ask, a conversation, a card): a name, not a text. */
export const ID_MAX = 200;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;
const isText = (value: unknown): value is string => typeof value === 'string';
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
/** Left out, or null, is none. */
const none = (value: unknown) => value === undefined || value === null;

function readPage(value: unknown): LinkPage | null | undefined {
  if (none(value)) return null;
  if (!isObject(value) || !isText(value.title) || !isText(value.url) || !isText(value.text)) return undefined;
  if (!none(value.truncated) && typeof value.truncated !== 'boolean') return undefined;
  return { title: value.title, url: value.url, text: value.text, truncated: value.truncated === true };
}

/**
 * A message from the browser, with only the fields this protocol knows: null for a `type` not known (ignored),
 * undefined for anything that is not a message - no object, no `type`, a known one without what it needs.
 */
export function readBrowserMessage(value: unknown): BrowserMessage | null | undefined {
  if (!isObject(value) || !isText(value.type)) return undefined;
  switch (value.type) {
    case 'hello':
      // Only the protocol is asked of every hello: one of a protocol not known is answered `bye {reason: protocol}`.
      if (typeof value.protocol !== 'number' || !Number.isInteger(value.protocol)) return undefined;
      if (!none(value.token) && !isText(value.token)) return undefined;
      return { type: 'hello', protocol: value.protocol, client: isText(value.client) ? value.client : '', client_version: isText(value.client_version) ? value.client_version : '', token: isText(value.token) ? value.token : null };
    case 'ask': {
      const page = readPage(value.page);
      if (!isId(value.id) || !isId(value.conversation) || !isText(value.text) || page === undefined) return undefined;
      return { type: 'ask', id: value.id, conversation: value.conversation, text: value.text, page };
    }
    case 'answer':
      if (!isId(value.id) || !isId(value.permission) || (!none(value.option) && !isText(value.option))) return undefined;
      return { type: 'answer', id: value.id, permission: value.permission, option: isText(value.option) ? value.option : null };
    case 'cancel':
      return isId(value.id) ? { type: 'cancel', id: value.id } : undefined;
    case 'capture':
      if (!isId(value.id) || !isText(value.title) || !isText(value.url) || !isText(value.note)) return undefined;
      return { type: 'capture', id: value.id, title: value.title, url: value.url, note: value.note };
    case 'bye':
      return { type: 'bye', reason: isText(value.reason) ? value.reason : '' };
    default:
      return null;
  }
}

/** One line from the browser: its message, none for a `type` not known, or a bad message (the link is closed for it). */
export function parseBrowserLine(line: string): { message: BrowserMessage | null } | { bad: true } {
  // In bytes: a letter is at most three of them, so a short line is not measured.
  if (line.length > LINE_MAX || (line.length * 3 > LINE_MAX && new TextEncoder().encode(line).length > LINE_MAX)) return { bad: true };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { bad: true };
  }
  const message = readBrowserMessage(value);
  return message === undefined ? { bad: true } : { message };
}

function readPermission(value: unknown): LinkPermission | null {
  if (!isObject(value) || !isId(value.id) || !isText(value.title) || !isText(value.kind) || typeof value.after_page !== 'boolean') return null;
  if (!Array.isArray(value.paths) || !value.paths.every(isText) || !Array.isArray(value.options)) return null;
  const options: LinkPermission['options'] = [];
  for (const one of value.options) {
    if (!isObject(one) || !isText(one.id) || !isText(one.name) || !isText(one.kind)) return null;
    options.push({ id: one.id, name: one.name, kind: one.kind });
  }
  return { id: value.id, title: value.title, kind: value.kind, paths: [...value.paths], options, after_page: value.after_page };
}

function readEvent(value: Record<string, unknown>): LinkEvent | null {
  const id = value.id;
  if (!isId(id)) return null;
  switch (value.kind) {
    case 'status':
      return isOneOf(STATUS_PHASES, value.phase) ? { type: 'event', id, kind: 'status', phase: value.phase } : null;
    case 'text':
      return isText(value.text) ? { type: 'event', id, kind: 'text', text: value.text } : null;
    case 'permission': {
      const permission = readPermission(value.permission);
      return permission ? { type: 'event', id, kind: 'permission', permission } : null;
    }
    case 'permission_closed':
      if (!isId(value.permission) || (value.option !== null && !isText(value.option))) return null;
      return { type: 'event', id, kind: 'permission_closed', permission: value.permission, option: value.option };
    case 'done':
      return typeof value.cancelled === 'boolean' ? { type: 'event', id, kind: 'done', cancelled: value.cancelled } : null;
    case 'error':
      return isOneOf(ERROR_CODES, value.code) && isText(value.detail) ? { type: 'event', id, kind: 'error', code: value.code, detail: value.detail } : null;
    default:
      return null;
  }
}

/**
 * A message of Cortex's, with only the fields this protocol knows; null for anything it has no word for. Cortex writes
 * its messages typed, and does not read them: this is for whoever stands in for the browser (the tests, the
 * end-to-end run), and holds the examples of the contract to the types above.
 */
export function readCortexMessage(value: unknown): CortexMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'pairing':
      return isOneOf(PAIRING_STATES, value.state) ? { type: 'pairing', state: value.state } : null;
    case 'hello_ok': {
      const tool = value.tool;
      if (typeof value.protocol !== 'number' || !isText(value.app_version)) return null;
      if (tool !== null && (!isObject(tool) || !isText(tool.id) || !isText(tool.name))) return null;
      if ((value.vault_name !== null && !isText(value.vault_name)) || (value.token !== null && !isText(value.token))) return null;
      return { type: 'hello_ok', protocol: value.protocol, app_version: value.app_version, tool: tool === null ? null : { id: tool.id as string, name: tool.name as string }, vault_name: value.vault_name, token: value.token };
    }
    case 'event':
      return readEvent(value);
    case 'captured':
      if (!isId(value.id)) return null;
      if (value.ok === true) return isText(value.path) ? { type: 'captured', id: value.id, ok: true, path: value.path } : null;
      if (value.ok !== false || !isOneOf(CAPTURED_CODES, value.code) || !isText(value.detail)) return null;
      return { type: 'captured', id: value.id, ok: false, code: value.code, detail: value.detail };
    case 'bye':
      return isOneOf(BYE_REASONS, value.reason) ? { type: 'bye', reason: value.reason } : null;
    default:
      return null;
  }
}

/** A message as it goes down the pipe: one line. */
export function encodeLine(message: CortexMessage | BrowserMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** The meeting file as it is read back; null for anything that names no pipe. */
export function readRendezvous(value: unknown): Rendezvous | null {
  if (!isObject(value) || typeof value.version !== 'number' || !isText(value.pipe) || !value.pipe || !isText(value.exe) || typeof value.pid !== 'number') return null;
  return { version: value.version, pipe: value.pipe, exe: value.exe, pid: value.pid };
}

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
/** The longest line, in bytes, its `\n` not counted (LIMITS.line_bytes). */
export const LINE_MAX = 16 * 1024 * 1024;
/** The file in Cortex's data folder that says where the link is (Rendezvous). */
export const RENDEZVOUS_FILE = 'browser-link.json';
/**
 * What the browser starts Cortex with when it finds no pipe to connect to: out of sight, and with the link opened.
 * Given to a Cortex that already runs too (a second launch hands its arguments on), which then opens the link.
 */
export const START_ARGUMENTS = ['--gizli', '--tarayici'] as const;

export const PAIRING_STATES = ['waiting', 'refused'] as const;
export const EVENT_KINDS = ['status', 'text', 'permission', 'permission_closed', 'done', 'error'] as const;
export const STATUS_PHASES = ['starting', 'thinking', 'answering'] as const;
export const ERROR_CODES = ['not_signed_in', 'no_tool', 'no_vault', 'limit', 'network', 'tool_failed', 'busy', 'too_long', 'page_unprotected', 'internal'] as const;
export const CAPTURED_CODES = ['capture_failed', 'no_vault'] as const;
export const BYE_REASONS = ['protocol', 'unpaired', 'shutdown', 'bad_message'] as const;

/** A card's answers by kind, as the chat's cards have them (shared/chat.ts, PermissionKind). */
export const OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
/** How the tool that answers asks leave: before each step, not at all, or in a way Cortex cannot tell. */
export const TOOL_PERMISSIONS = ['ask', 'auto', 'unknown'] as const;

/**
 * The contract's limits. A line in bytes: `line_bytes`, and before the browser is let in the far smaller
 * `line_bytes_before_hello_ok` (a hello is short; nobody not let in has anything long to say). `hello_wait_ms`: how
 * long a connection may stay without saying hello. In characters, counted as Unicode counts them (codePoints): an id
 * (an ask, a conversation, a card); a question's words and a page's text, past which the question is refused as too
 * long (services/chat.ts MESSAGE_MAX, services/browserPage.ts PAGE_TEXT_MAX: the test holds them to one another);
 * the longest `detail` of a failure. What Cortex itself writes is cut to them: a card's title, how many paths and
 * answers it names, a name (a tool's, an answer's, the vault's).
 */
export const LIMITS = {
  line_bytes: 16 * 1024 * 1024,
  line_bytes_before_hello_ok: 65_536,
  hello_wait_ms: 10_000,
  id_chars: 200,
  text_chars: 100_000,
  page_text_chars: 200_000,
  detail_chars: 300,
  permission_title_chars: 500,
  permission_paths: 50,
  permission_options: 8,
  name_chars: 200,
} as const;

/** A text's length in characters as Unicode has them (code points): a letter kept in two halves counts once. */
export function codePoints(text: string): number {
  let count = text.length;
  for (let at = 0; at < text.length - 1; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count -= 1;
        at += 1;
      }
    }
  }
  return count;
}

/** Whether a text is longer than that many characters, counted only where its length does not already say. */
export function longerThan(text: string, max: number): boolean {
  if (text.length <= max) return false;
  if (text.length > max * 2) return true;
  return codePoints(text) > max;
}

/** A text cut to that many characters, never through the middle of one. */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  let units = 0;
  for (let taken = 0; taken < max && units < text.length; taken += 1) {
    const unit = text.charCodeAt(units);
    const pair = unit >= 0xd800 && unit <= 0xdbff && units + 1 < text.length && text.charCodeAt(units + 1) >= 0xdc00 && text.charCodeAt(units + 1) <= 0xdfff;
    units += pair ? 2 : 1;
  }
  return text.slice(0, units);
}

export type PairingState = (typeof PAIRING_STATES)[number];
export type StatusPhase = (typeof STATUS_PHASES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type CapturedCode = (typeof CAPTURED_CODES)[number];
export type ByeReason = (typeof BYE_REASONS)[number];
export type OptionKind = (typeof OPTION_KINDS)[number];
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

/**
 * The tool that answers, as the browser is told of it: `permission`, the mode the person chose for it (`ask`: it asks
 * before a step; `auto`: it goes on unasked; `unknown`: Cortex cannot tell), and `can_ask`, whether Cortex can hold it
 * to asking in a conversation a web page was added to. Where it cannot, the browser warns before a page is added.
 */
export interface LinkTool {
  id: string;
  name: string;
  permission: ToolPermission;
  can_ask: boolean;
}

/**
 * Where the browser finds Cortex, written at every start and left when Cortex closes: that the file is there says
 * Cortex is installed and where its program is, not that it runs. `pipe`: the pipe to connect to, under a name drawn
 * anew at each start; null while the listener is not open (nobody has opened the link, the person closed it, or it
 * could not be opened), and once Cortex has closed. `off`, there only when it is so: the person closed the link in
 * Cortex's settings - starting Cortex for the browser does not open it then, and the browser does not try. The
 * program to start when there is no pipe, or nothing listens on it, and the process that wrote the file.
 */
export interface Rendezvous {
  version: number;
  pipe: string | null;
  off?: true;
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
  /** `ask_again`: the person pressed "ask again" in the browser after a refusal; the wait after a refusal is passed over. */
  | { type: 'hello'; protocol: number; client: string; client_version: string; token: string | null; ask_again?: true }
  /**
   * `page_ack`: the person was warned in the browser that the tool of this conversation may go on unasked with a page
   * in it (its `can_ask` is false), and said to send the page all the same. Without it such a question is refused
   * (`page_unprotected`).
   */
  | { type: 'ask'; id: string; conversation: string; text: string; page: LinkPage | null; page_ack?: true }
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
  options: Array<{ id: string; name: string; kind: OptionKind }>;
  /** A web page's content was added to this conversation before the step was asked for. */
  after_page: boolean;
}

export type LinkEvent =
  /** `tool`, with an ask's first status: the tool that answers this question - its conversation's own, which a new chat's default (`hello_ok.tool`) need not be. */
  | { type: 'event'; id: string; kind: 'status'; phase: StatusPhase; tool?: LinkTool }
  | { type: 'event'; id: string; kind: 'text'; text: string }
  | { type: 'event'; id: string; kind: 'permission'; permission: LinkPermission }
  | { type: 'event'; id: string; kind: 'permission_closed'; permission: string; option: string | null }
  | { type: 'event'; id: string; kind: 'done'; cancelled: boolean }
  /** `tool`, with `page_unprotected`: the tool the page was not sent to. `detail` is for a log, never a path, never shown to the person. */
  | { type: 'event'; id: string; kind: 'error'; code: ErrorCode; detail: string; tool?: LinkTool };

export type CortexMessage =
  /** `code`: a short number, shown in Cortex's question and in the browser at once, for the person to compare; never typed. */
  | { type: 'pairing'; state: 'waiting'; code: string }
  | { type: 'pairing'; state: 'refused' }
  | { type: 'hello_ok'; protocol: number; app_version: string; tool: LinkTool | null; vault_name: string | null; token: string | null }
  | LinkEvent
  | { type: 'captured'; id: string; ok: true; path: string }
  | { type: 'captured'; id: string; ok: false; code: CapturedCode; detail: string }
  | { type: 'bye'; reason: ByeReason };

/**
 * The link as the window is told of it (Settings, and the question asked when a browser first connects): whether it
 * is kept open (`on`) and is in fact listening (`listening`: on and not listening, it could not be opened);
 * `turnedOff`, that the person closed it here, which is more than its not being on: a browser cannot open it then; whether a browser has been let in, whether one is connected now, and whether one waits to be let in - with
 * the code it was told, for the person to compare with what the browser shows. `locked`: refused so often in a row
 * that no browser is asked about any more, until the person lets it ask again here.
 */
export interface BrowserLinkStatus {
  on: boolean;
  turnedOff: boolean;
  listening: boolean;
  allowed: boolean;
  connected: boolean;
  asking: boolean;
  code: string | null;
  locked: boolean;
}

export interface BrowserLinkApi {
  status(): Promise<BrowserLinkStatus>;
  /** The link opened or closed, and kept so. Closed, a browser connected is told and nothing listens; the leave given stays. */
  setOn(on: boolean): Promise<BrowserLinkStatus>;
  /** The person's answer to the browser waiting: let in, or refused. */
  decide(allow: boolean): Promise<BrowserLinkStatus>;
  /** "Allow" in the settings: the browser waiting let in; with none waiting, a browser refused too often may ask again. */
  allow(): Promise<BrowserLinkStatus>;
  /** The leave taken back: the browser's token is forgotten and its link closed. */
  unpair(): Promise<BrowserLinkStatus>;
}

/** The longest id a message names (an ask, a conversation, a card): a name, not a text. */
export const ID_MAX = LIMITS.id_chars;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !longerThan(value, ID_MAX);
const isName = (value: unknown): value is string => typeof value === 'string' && !longerThan(value, LIMITS.name_chars);
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
      if (!none(value.ask_again) && typeof value.ask_again !== 'boolean') return undefined;
      return {
        type: 'hello',
        protocol: value.protocol,
        client: isText(value.client) ? value.client : '',
        client_version: isText(value.client_version) ? value.client_version : '',
        token: isText(value.token) ? value.token : null,
        ...(value.ask_again === true ? { ask_again: true as const } : {}),
      };
    case 'ask': {
      const page = readPage(value.page);
      if (!isId(value.id) || !isId(value.conversation) || !isText(value.text) || page === undefined) return undefined;
      if (!none(value.page_ack) && typeof value.page_ack !== 'boolean') return undefined;
      return { type: 'ask', id: value.id, conversation: value.conversation, text: value.text, page, ...(value.page_ack === true ? { page_ack: true as const } : {}) };
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

/**
 * One line from the browser: its message, none for a `type` not known, or a bad message (the link is closed for it).
 * `max`: the longest line taken, in bytes (LIMITS.line_bytes; less before the browser is let in).
 */
export function parseBrowserLine(line: string, max: number = LINE_MAX): { message: BrowserMessage | null } | { bad: true } {
  // In bytes: a letter is at most three of them, so a short line is not measured.
  if (line.length > max || (line.length * 3 > max && new TextEncoder().encode(line).length > max)) return { bad: true };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { bad: true };
  }
  const message = readBrowserMessage(value);
  return message === undefined ? { bad: true } : { message };
}

function readTool(value: unknown): LinkTool | null {
  if (!isObject(value) || !isId(value.id) || !isName(value.name) || !isOneOf(TOOL_PERMISSIONS, value.permission) || typeof value.can_ask !== 'boolean') return null;
  return { id: value.id, name: value.name, permission: value.permission, can_ask: value.can_ask };
}

function readPermission(value: unknown): LinkPermission | null {
  if (!isObject(value) || !isId(value.id) || !isText(value.title) || longerThan(value.title, LIMITS.permission_title_chars) || !isName(value.kind) || typeof value.after_page !== 'boolean') return null;
  if (!Array.isArray(value.paths) || value.paths.length > LIMITS.permission_paths || !value.paths.every(isText) || !Array.isArray(value.options) || value.options.length > LIMITS.permission_options) return null;
  const options: LinkPermission['options'] = [];
  for (const one of value.options) {
    if (!isObject(one) || !isId(one.id) || !isName(one.name) || !isOneOf(OPTION_KINDS, one.kind)) return null;
    options.push({ id: one.id, name: one.name, kind: one.kind });
  }
  return { id: value.id, title: value.title, kind: value.kind, paths: [...value.paths], options, after_page: value.after_page };
}

function readEvent(value: Record<string, unknown>): LinkEvent | null {
  const id = value.id;
  if (!isId(id)) return null;
  switch (value.kind) {
    case 'status': {
      const tool = none(value.tool) ? null : readTool(value.tool);
      if (!isOneOf(STATUS_PHASES, value.phase) || (!none(value.tool) && !tool)) return null;
      return { type: 'event', id, kind: 'status', phase: value.phase, ...(tool ? { tool } : {}) };
    }
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
    case 'error': {
      const tool = none(value.tool) ? null : readTool(value.tool);
      if (!isOneOf(ERROR_CODES, value.code) || !isText(value.detail) || longerThan(value.detail, LIMITS.detail_chars) || (!none(value.tool) && !tool)) return null;
      // A page refused for its tool names the tool: the browser warns the person by it.
      if (value.code === 'page_unprotected' && !tool) return null;
      return { type: 'event', id, kind: 'error', code: value.code, detail: value.detail, ...(tool ? { tool } : {}) };
    }
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
      if (value.state === 'refused') return { type: 'pairing', state: 'refused' };
      return value.state === 'waiting' && isText(value.code) && /^\d{4}$/.test(value.code) ? { type: 'pairing', state: 'waiting', code: value.code } : null;
    case 'hello_ok': {
      const tool = value.tool;
      if (typeof value.protocol !== 'number' || !isText(value.app_version)) return null;
      const told = tool === null ? null : readTool(tool);
      if (tool !== null && !told) return null;
      if ((value.vault_name !== null && !isName(value.vault_name)) || (value.token !== null && !isText(value.token))) return null;
      return { type: 'hello_ok', protocol: value.protocol, app_version: value.app_version, tool: told, vault_name: value.vault_name, token: value.token };
    }
    case 'event':
      return readEvent(value);
    case 'captured':
      if (!isId(value.id)) return null;
      if (value.ok === true) return isText(value.path) ? { type: 'captured', id: value.id, ok: true, path: value.path } : null;
      if (value.ok !== false || !isOneOf(CAPTURED_CODES, value.code) || !isText(value.detail) || longerThan(value.detail, LIMITS.detail_chars)) return null;
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

/** The meeting file as it is read back; null for anything that is not one. Its pipe is a name, or null while the listener is closed. */
export function readRendezvous(value: unknown): Rendezvous | null {
  if (!isObject(value) || typeof value.version !== 'number' || !isText(value.exe) || typeof value.pid !== 'number') return null;
  if (value.pipe !== null && (!isText(value.pipe) || !value.pipe)) return null;
  if (!none(value.off) && typeof value.off !== 'boolean') return null;
  return { version: value.version, pipe: value.pipe, ...(value.off === true ? { off: true as const } : {}), exe: value.exe, pid: value.pid };
}

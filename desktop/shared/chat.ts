/**
 * The chat with the person's own AI command lines, as the window is told of
 * it (electron/services/chat.ts). A CLI speaks the Agent Client Protocol to
 * the main process; the main process turns what it says into these events,
 * with every path made relative to the vault, or cut to its file's name when
 * it is outside the vault. The window never learns where the vault is, and
 * never starts a program: it names a CLI from the list it was given.
 */

export type CliId = 'claude' | 'codex' | 'opencode' | 'gemini' | 'qwen' | 'lmstudio' | 'ollama' | 'hermes' | 'test' | 'test-claude' | 'test-codex';

export interface CliInfo {
  id: CliId;
  name: string;
  /** Whether it is installed on this machine. */
  available: boolean;
  /** For a model server (LM Studio, Ollama): whether its server is up with a model now, or installed and off. */
  local?: 'up' | 'off';
}

/** Whether an AI tool is signed in, and how it can be (electron/services/auth.ts). Never a key. */
export interface CliAuth {
  id: CliId;
  installed: boolean;
  /** Signed in or holding a key, as the tool says; null when it could not be asked. */
  signedIn: boolean | null;
  /** How: "Claude · kisi@example.com", "ChatGPT", "API key", the connections it keeps. */
  detail: string | null;
  /** Whether its own sign-in can be opened from here, in a window of its own. */
  canLogin: boolean;
  /** Whether it can be installed from here, by its maker's installer in a window of its own (Claude Code, on Windows). */
  canInstall: boolean;
  /** Where a key goes: kept by Cortex and given as the tool's environment, handed to the tool itself, or nowhere. */
  key: 'cortex' | 'cli' | null;
  /** Whether a key needs the OpenAI-compatible address it is for. */
  baseUrl: boolean;
  hasKey: boolean;
  /** A key Cortex keeps for it, not one of the person's own environment: the one that can be forgotten here. */
  kept: boolean;
  /** For a model server on this machine (LM Studio, Ollama), which needs no sign-in: what it has. */
  local?: { models: number; loaded: string[]; shortContext: number | null };
  /**
   * For an AI tool: whether the chat offers it (settings' chatTools). One signed in only in a terminal, never set up
   * from Cortex, is not; it is added from the AI tools window.
   */
  chosen?: boolean;
  /** Whether Cortex downloaded its program (toolPackages.ts): deleted with it when it is removed. */
  own?: boolean;
  /**
   * How its last sign-in from here ended without signing in: its window closed by itself, with an error code, or
   * ended after ten minutes. With the command that does the same in a terminal, where the browser could not be opened
   * from here and the address it gives is pasted by hand. Null once signed in or a new sign-in begun.
   */
  loginEnded?: { end: 'closed' | 'failed' | 'timeout'; code: number | null; command: string } | null;
}

/**
 * What a chat has cost so far (2 November notes: "sohbet kısmında session maliyeti"): dollars at the API's list price
 * where the tool says them (Claude Code's own reckoning, an ACP agent's `cost`), and the tokens it counted. On a
 * subscription (Claude Code, Codex) it is what the work would cost through the API, not what the person pays.
 */
/** A file added to a message (2 November notes): kept on this computer by the main process, named by its id. */
export interface ChatAttachment {
  id: string;
  name: string;
  /** A picture the model is shown, or a file it reads. */
  kind: 'image' | 'file';
}

/** The tools that take attachments now (Claude Code, Codex, and the tests' stand-ins for them); the others say they do not. */
export const ATTACHING_CLIS: readonly CliId[] = ['claude', 'codex', 'test-claude', 'test-codex'];

export interface ChatSpend {
  /** Null where the tool counts no money (Codex). */
  usd: number | null;
  tokens: number;
  subscription: boolean;
}

export interface ChatSummary {
  id: string;
  /** Empty until the first message names it. */
  title: string;
  cli: CliId;
  createdAt: number;
  updatedAt: number;
  /** Absent until a turn has said what it cost. */
  spend?: ChatSpend;
}

export interface ConfigChoice {
  value: string;
  name: string;
}

/** A setting the CLI offers for its session: the model, the mode (build or plan), how hard it thinks. */
export interface ConfigOption {
  id: string;
  name: string;
  /** `model`, `mode`, `thought_level`, or another the CLI names. */
  category: string | null;
  current: string;
  choices: ConfigChoice[];
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** What a chat shows, in the order it happened. */
export type ChatEvent =
  | { type: 'user'; text: string; at: number; attachments?: Array<{ name: string; kind: 'image' | 'file' }> }
  /** A piece of the answer, to be added to the message of that id. */
  | { type: 'text'; id: string; text: string }
  /** A piece of the CLI's thinking, shown folded. */
  | { type: 'thought'; id: string; text: string }
  /** A step the CLI takes - reading a note, running a command - or a later word on it: what it carries replaces what the step of that id had. */
  | { type: 'tool'; id: string; title?: string; kind?: string; status?: ToolStatus; paths?: string[]; output?: string }
  /** The CLI asks before a step; answered from the card it shows. */
  | { type: 'permission'; id: string; title: string; kind: string; paths: string[]; options: Array<{ id: string; name: string; kind: PermissionKind }> }
  | { type: 'answered'; id: string; option: string | null }
  | { type: 'plan'; entries: Array<{ content: string; status: string }> }
  | { type: 'usage'; used: number; size: number; cost: number | null; currency: string | null }
  /** One turn's share of the chat's cost (ChatSpend), added to the chat's total in the list; not kept in its transcript. */
  | {
      type: 'spend';
      /** This turn's dollars, where the tool tells them per turn; null where it tells none or only a running total. */
      usd: number | null;
      tokens: number;
      subscription: boolean;
      /**
       * The session's running total, where the tool keeps one (Claude Code's `total_cost_usd` counts the whole session,
       * across a resume too: measured 4 November). The chat takes the rise since the last total of the same session.
       */
      total?: { session: string; usd: number };
    }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string; kind: string | null }
  /** Something the person should know about the answer: `new-session`, the CLI could not continue the chat's conversation and began a new one. */
  | { type: 'notice'; notice: string };

export interface ChatOpened {
  chat: ChatSummary;
  events: ChatEvent[];
  running: boolean;
  options: ConfigOption[];
  /** The number of the last event in `events`: a push numbered up to it is already here. */
  seq: number;
}

/** Sent to the window as a chat goes on: an event, or its state (running, its settings). */
export interface ChatPush {
  chatId: string;
  event?: ChatEvent;
  /** The event's number in its chat, counted since the app started: a chat opened while it goes on takes only the pushes after what it read. */
  seq?: number;
  state?: { running: boolean; options: ConfigOption[] };
  /** The chat's list entry changed: its title, its time. */
  summary?: ChatSummary;
}

export interface ChatApi {
  clis(): Promise<CliInfo[]>;
  list(): Promise<ChatSummary[]>;
  open(id: string): Promise<ChatOpened>;
  /** A message, to the chat of that id or to a new one with that CLI; the chat's id. The answer comes as pushes. */
  send(id: string | null, cli: CliId, text: string, attachments?: string[]): Promise<{ id: string }>;
  /** A file's bytes (base64) kept for a message to come; at most 20 MB. */
  attach(name: string, data: string): Promise<ChatAttachment>;
  cancel(id: string): Promise<void>;
  answer(id: string, permission: string, option: string | null): Promise<void>;
  setOption(id: string, option: string, value: string): Promise<ConfigOption[]>;
  /** The settings a new chat with that CLI has before its first message (Hermes: its sessions to continue); none for most. */
  offer(cli: CliId): Promise<ConfigOption[]>;
  /**
   * One of those settings chosen in a new chat. Hermes: the chat begun on it (a session continued, its last messages
   * shown); its id. The others: kept for the chat its first message begins; no id, and the settings as they are now.
   */
  begin(cli: CliId, option: string, value: string): Promise<{ id: string | null; options?: ConfigOption[] }>;
  rename(id: string, title: string): Promise<ChatSummary>;
  remove(id: string): Promise<void>;
  /** Every AI tool, and whether it is signed in. */
  auth(): Promise<CliAuth[]>;
  /** The tool's own sign-in, in a window of its own; the statuses are pushed again when it closes. */
  login(cli: CliId): Promise<void>;
  /** The tool installed by its maker's installer, in a window of its own; its sign-in opened after; the statuses pushed again. */
  install(cli: CliId): Promise<void>;
  /** A key for a tool: kept encrypted by Cortex, or handed to the tool itself (Codex). */
  setKey(cli: CliId, key: string, baseUrl?: string): Promise<CliAuth[]>;
  /** "Ekle": the tool installed where it is not, offered in the chat, its sign-in opened where it is not signed in; every tool's sign-in, as `auth` says. */
  addTool(cli: CliId): Promise<CliAuth[]>;
  /** "Sil": the tool signed out with its own command (or its key forgotten), taken from the chat, and the program Cortex downloaded for it deleted. */
  removeTool(cli: CliId): Promise<CliAuth[]>;
  /** A message kept for later as a card in the vault's inbox (`📥 000-Inbox/Yakala`); where the card is. */
  toInbox(text: string): Promise<{ path: string; added: 'new' | 'existing' }>;
}

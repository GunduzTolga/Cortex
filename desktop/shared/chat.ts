/**
 * The chat with the person's own AI command lines, as the window is told of
 * it (electron/services/chat.ts). A CLI speaks the Agent Client Protocol to
 * the main process; the main process turns what it says into these events,
 * with every path made relative to the vault, or cut to its file's name when
 * it is outside the vault. The window never learns where the vault is, and
 * never starts a program: it names a CLI from the list it was given.
 */

export type CliId = 'claude' | 'codex' | 'opencode' | 'gemini' | 'qwen' | 'test' | 'test-claude' | 'test-codex';

export interface CliInfo {
  id: CliId;
  name: string;
  /** Whether it is installed on this machine. */
  available: boolean;
}

export interface ChatSummary {
  id: string;
  /** Empty until the first message names it. */
  title: string;
  cli: CliId;
  createdAt: number;
  updatedAt: number;
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
  | { type: 'user'; text: string; at: number }
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
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string; kind: string | null };

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
  send(id: string | null, cli: CliId, text: string): Promise<{ id: string }>;
  cancel(id: string): Promise<void>;
  answer(id: string, permission: string, option: string | null): Promise<void>;
  setOption(id: string, option: string, value: string): Promise<ConfigOption[]>;
  rename(id: string, title: string): Promise<ChatSummary>;
  remove(id: string): Promise<void>;
}

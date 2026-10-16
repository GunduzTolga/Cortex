/**
 * The office's live conversations (src/office/, electron/services/officeTalk.ts): a model the
 * person picks in the office's own settings writes a few lines for the team about the notes
 * they last worked on, and the characters say them in the office.
 */

/** What can write them: a model server on this machine, or Claude Code. */
export type TalkTool = 'lmstudio' | 'ollama' | 'claude';

export const TALK_TOOLS: readonly TalkTool[] = ['lmstudio', 'ollama', 'claude'];

export const TALK_TOOL_NAME: Record<TalkTool, string> = { lmstudio: 'LM Studio', ollama: 'Ollama', claude: 'Claude Code' };

/** How often a conversation is written while the office is in front, in minutes. */
export const TALK_EVERY = [10, 20, 30, 60];

/**
 * The live conversations as the person set them, in the office's own settings
 * or the app's (src/office/talkPrefs.ts): on or off, the tool and the model
 * that write them, how often.
 */
export interface TalkPrefs {
  live: boolean;
  tool: TalkTool | null;
  /** The model the tool writes with; null for a server's loaded one, Claude Code's quickest. */
  model: string | null;
  every: number;
}

/** Kept preferences read back: anything that is not one of the choices is its default. */
export function talkPrefsOf(raw: unknown): TalkPrefs {
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    live: given.live === true,
    tool: TALK_TOOLS.includes(given.tool as TalkTool) ? (given.tool as TalkTool) : null,
    model: typeof given.model === 'string' && given.model ? given.model : null,
    every: TALK_EVERY.includes(given.every as number) ? (given.every as number) : 20,
  };
}

/** One of the office's people, as the model is told of them. */
export interface TalkPerson {
  id: string;
  name: string;
  role: string;
  bio: string;
}

export interface TalkRequest {
  tool: TalkTool;
  /** The model to write with; null for the server's loaded one (or Claude Code's quickest). */
  model: string | null;
  cast: TalkPerson[];
  language: 'tr' | 'en';
}

/** A line said in the office: who says it (a cast id) and what. */
export interface TalkLine {
  who: string;
  text: string;
}

export interface OfficeApi {
  /** The models the tool offers, the loaded ones among them (a model server's loaded models first). */
  models(tool: TalkTool): Promise<{ models: string[]; loaded: string[] }>;
  /** A short conversation about the notes worked on last, written by the chosen model. */
  talk(request: TalkRequest): Promise<TalkLine[]>;
}

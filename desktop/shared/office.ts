/**
 * The office's live conversations (src/office/, electron/services/officeTalk.ts): a model the
 * person picks in the office's own settings writes a few lines for the team about the notes
 * they last worked on, and the characters say them in the office.
 */

/** What can write them: a model server on this machine, or Claude Code. */
export type TalkTool = 'lmstudio' | 'ollama' | 'claude';

export const TALK_TOOLS: readonly TalkTool[] = ['lmstudio', 'ollama', 'claude'];

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

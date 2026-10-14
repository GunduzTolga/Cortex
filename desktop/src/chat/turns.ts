import type { ChatEvent, ConfigOption, PermissionKind, ToolStatus } from '@shared/chat';

/**
 * A chat's events read as turns, the way the screen shows them: what the
 * person wrote, then the answer - its thinking folded, its steps folded into
 * one line of activity, its words, and how it ended. The calm transcript
 * hermes-webui settled on (desktop/README.md): the answer first, the
 * machinery a click away.
 */

export interface Step {
  id: string;
  title: string;
  kind: string;
  status: ToolStatus;
  paths: string[];
  output?: string;
}

export interface Asked {
  id: string;
  title: string;
  kind: string;
  paths: string[];
  options: Array<{ id: string; name: string; kind: PermissionKind }>;
  /** The option chosen, null when refused or cancelled; undefined while it waits. */
  answer: string | null | undefined;
}

export interface Turn {
  user: { text: string; at: number } | null;
  thought: string;
  steps: Step[];
  /** The answer's words, its messages one after another. */
  text: string;
  asked: Asked[];
  plan: Array<{ content: string; status: string }> | null;
  end: { kind: 'done'; reason: string } | { kind: 'error'; message: string; error: string | null } | null;
}

const empty = (user: Turn['user']): Turn => ({ user, thought: '', steps: [], text: '', asked: [], plan: null, end: null });

export function turnsOf(events: readonly ChatEvent[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  let lastText: string | null = null;
  const current = () => {
    if (!turn) {
      turn = empty(null);
      turns.push(turn);
    }
    return turn;
  };
  for (const event of events) {
    switch (event.type) {
      case 'user':
        turn = empty({ text: event.text, at: event.at });
        turns.push(turn);
        lastText = null;
        break;
      case 'text': {
        const now = current();
        // A new message of the same answer begins on its own paragraph.
        if (lastText !== null && lastText !== event.id && now.text && !now.text.endsWith('\n')) now.text += '\n\n';
        now.text += event.text;
        lastText = event.id;
        break;
      }
      case 'thought':
        current().thought += event.text;
        break;
      case 'tool': {
        const now = current();
        const had = now.steps.find((one) => one.id === event.id);
        if (had) {
          if (event.title !== undefined) had.title = event.title;
          if (event.kind !== undefined) had.kind = event.kind;
          if (event.status !== undefined) had.status = event.status;
          if (event.paths !== undefined && event.paths.length) had.paths = event.paths;
          if (event.output !== undefined) had.output = event.output;
        } else {
          now.steps.push({ id: event.id, title: event.title ?? event.kind ?? '', kind: event.kind ?? 'other', status: event.status ?? 'pending', paths: event.paths ?? [], output: event.output });
        }
        break;
      }
      case 'permission':
        current().asked.push({ id: event.id, title: event.title, kind: event.kind, paths: event.paths, options: event.options, answer: undefined });
        break;
      case 'answered': {
        const asked = current().asked.find((one) => one.id === event.id);
        if (asked) asked.answer = event.option;
        break;
      }
      case 'plan':
        current().plan = event.entries;
        break;
      case 'done':
        current().end = { kind: 'done', reason: event.reason };
        break;
      case 'error':
        current().end = { kind: 'error', message: event.message, error: event.kind };
        break;
      default:
        break;
    }
  }
  return turns;
}

/** The step the CLI waits on the person for, if any: the last turn's unanswered card. */
export function waitingOn(turns: readonly Turn[]): Asked | null {
  const last = turns[turns.length - 1];
  return last?.asked.find((one) => one.answer === undefined) ?? null;
}

/** The last word on how full the model's context is, and what the chat has cost. */
export function usageOf(events: readonly ChatEvent[]): Extract<ChatEvent, { type: 'usage' }> | null {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event.type === 'usage') return event;
  }
  return null;
}

/** A session's setting of a kind - `model`, `mode`, `thought_level` - by its category, else its id. */
export function optionOf(options: readonly ConfigOption[], kind: string): ConfigOption | null {
  return options.find((one) => one.category === kind) ?? options.find((one) => one.id === kind) ?? null;
}

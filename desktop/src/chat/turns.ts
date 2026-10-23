import type { ChatEvent, ConfigOption, PermissionKind, ToolStatus } from '@shared/chat';
import { parseNote, type NoteLink } from '../../core/vaultNotes';

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
  /** What the person should know about this answer (`new-session`: the CLI began the conversation anew). */
  notices: string[];
  end: { kind: 'done'; reason: string } | { kind: 'error'; message: string; error: string | null } | null;
}

const empty = (user: Turn['user']): Turn => ({ user, thought: '', steps: [], text: '', asked: [], plan: null, notices: [], end: null });

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
      case 'notice':
        if (!current().notices.includes(event.notice)) current().notices.push(event.notice);
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

/**
 * The card `waitingOn(turnsOf(events))` finds, found without reading the chat into turns: from the
 * end back to the person's last message, the first card not answered. Read for every open chat at
 * every frame (chatStore.ts, waitingChats), so it walks the last turn only.
 */
export function waitingIn(events: readonly ChatEvent[]): Extract<ChatEvent, { type: 'permission' }> | null {
  const answered = new Set<string>();
  let found: Extract<ChatEvent, { type: 'permission' }> | null = null;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event.type === 'user') break;
    // Walking back, a card's answer is met before the card.
    if (event.type === 'answered') answered.add(event.id);
    else if (event.type === 'permission' && !answered.has(event.id)) found = event;
  }
  return found;
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

/** A note of the vault a chat touched: read by a step, changed by one, or named in an answer. */
export interface NoteRef {
  path: string;
  read: boolean;
  edited: boolean;
  mentioned: boolean;
}

/*
  The links of an ended answer, by its words. The panel's list is read again
  at every streamed piece, and every answer of the chat was parsed again with
  it: some 10 ms a frame at forty answers on a 2.8 GHz server core, more on a
  laptop (desktop-ui-4). An ended answer's words do not change, so its links
  are kept; the answer still coming is parsed as it comes and not kept, or
  every piece of it would be. A few hundred answers, the oldest let go first.
*/
const LINKS_KEPT = 512;
const linksKept = new Map<string, NoteLink[]>();

/** An answer's links: kept by its words once it has ended (exported for the tests, which hold that it is kept). */
export function linksOf(turn: Turn): NoteLink[] {
  if (!turn.end) return parseNote(turn.text).links;
  const kept = linksKept.get(turn.text);
  if (kept) {
    // Used again: the last to be let go.
    linksKept.delete(turn.text);
    linksKept.set(turn.text, kept);
    return kept;
  }
  const links = parseNote(turn.text).links;
  linksKept.set(turn.text, links);
  if (linksKept.size > LINKS_KEPT) linksKept.delete(linksKept.keys().next().value as string);
  return links;
}

/**
 * The notes a chat touched, the most recent first: those its steps read or
 * changed, and those its answers link to (`[[wiki]]` or Markdown). A path that
 * is not a note of the vault - a file outside it, a note since gone - is left
 * out; `note` gives a path's note as the index has it, by any case, or null.
 */
export function notesOf(turns: readonly Turn[], note: (path: string) => string | null, resolve: (target: string, kind: 'wiki' | 'markdown') => string | null): NoteRef[] {
  const found = new Map<string, NoteRef & { at: number }>();
  const touch = (path: string | null, at: number, how: 'read' | 'edited' | 'mentioned') => {
    if (!path) return;
    const had = found.get(path) ?? { path, read: false, edited: false, mentioned: false, at };
    had[how] = true;
    had.at = Math.max(had.at, at);
    found.set(path, had);
  };
  turns.forEach((turn, at) => {
    for (const step of turn.steps) {
      for (const path of step.paths) if (path.toLowerCase().endsWith('.md')) touch(note(path), at, step.kind === 'edit' || step.kind === 'delete' || step.kind === 'move' ? 'edited' : 'read');
    }
    for (const link of linksOf(turn)) {
      const to = link.target && !link.embed ? resolve(link.target, link.kind) : null;
      // A link to an image or another file is not a note.
      if (to?.toLowerCase().endsWith('.md')) touch(to, at, 'mentioned');
    }
  });
  return [...found.values()]
    .sort((a, b) => b.at - a.at)
    .map(({ path, read, edited, mentioned }) => ({ path, read, edited, mentioned }));
}

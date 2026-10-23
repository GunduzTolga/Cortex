import { create } from 'zustand';
import type { ChatEvent, ChatOpened, ChatPush, ChatSummary, CliAuth, CliId, CliInfo, ConfigOption } from '@shared/chat';
import { messageOf } from '@shared/ipcError';
import { waitingIn } from './turns';

/**
 * What the chat screen holds: the CLIs this machine has, the vault's chats,
 * the one in front, and the events of every chat opened since the window
 * started. The main process tells it what goes on (electron/services/chat.ts)
 * as pushes; those are taken in once a frame, so a CLI streaming its answer
 * in many small pieces draws the screen at the screen's pace, not at its own.
 *
 * The CLI a new chat starts with, and what is written and not yet sent, are
 * this window's storage: conveniences, gone with a storage that will not
 * answer.
 */

export interface OpenChat {
  events: ChatEvent[];
  running: boolean;
  options: ConfigOption[];
  /** The number of the last event taken in: a push numbered up to it is already here. */
  seq: number;
}

const fromOpened = (opened: ChatOpened): OpenChat => ({ events: opened.events, running: opened.running, options: opened.options, seq: opened.seq });

interface ChatState {
  clis: CliInfo[] | null;
  chats: ChatSummary[];
  /** The chat in front; null for a new one, not yet written to. */
  active: string | null;
  open: Record<string, OpenChat>;
  /** The CLI a new chat is written to. */
  cli: CliId | null;
  /** What is written and not yet sent, by chat (`new` for a new one). */
  drafts: Record<string, string>;
  error: string | null;
  /** The panel beside the chat: whether it is open, and the note shown in it (null: the chat's notes, listed). */
  side: { open: boolean; path: string | null };
  /** The panel opened, on a note or on the chat's notes. */
  showSide(path?: string | null): void;
  hideSide(): void;
  /** Whether each AI tool is signed in; null before it is asked. */
  auth: CliAuth[] | null;
  /** The sign-in window: open on every tool, on one, or closed. */
  authOpen: CliId | 'all' | null;
  /** Tools a chat was refused by for want of a sign-in since one last answered: their own status can say signed in with a token that has expired. */
  authFailed: CliId[];
  /**
   * A tool being installed from here, its installer's window open, or whose installer ended
   * without it (`failed`). One for the window: the empty chat's button and the sign-ins' row
   * each kept their own, and neither heard the installer end (desktop-ui-9).
   */
  installing: { id: CliId; failed: boolean } | null;
  /** Its installer opened (electron/services/auth.ts, installTool); a refusal is thrown back to be said where it was asked. */
  install(id: CliId): Promise<void>;
  /** Counts the turns that ended in this window's chats: what the CLI wrote is read again (App.tsx). */
  turnsEnded: number;
  loadAuth(): Promise<void>;
  openAuth(focus?: CliId): void;
  closeAuth(): void;
  boot(): Promise<void>;
  /** The CLIs asked again: a model server opened since, or closed. */
  refreshClis(): Promise<void>;
  /** Another vault chosen: its chats listed, none of the last vault's left open. */
  vaultChanged(): Promise<void>;
  select(id: string | null): Promise<void>;
  setCli(cli: CliId): void;
  setDraft(key: string, text: string): void;
  send(text: string): Promise<boolean>;
  cancel(): void;
  answer(permission: string, option: string | null): void;
  setOption(option: string, value: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const CLI_KEY = 'cortex.chat.cli';
const SIDE_KEY = 'cortex.chat.side';
const DRAFTS_KEY = 'cortex.chat.drafts';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* for this run */
  }
}

const byTime = (a: ChatSummary, b: ChatSummary) => b.updatedAt - a.updatedAt;

export const useChat = create<ChatState>((set, get) => {
  /*
    The pushes of one frame, taken in together. A chat not opened in this
    window is told of in its list entry only; its events are read whole when
    it is opened.
  */
  let queue: ChatPush[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const pushes = queue;
    queue = [];
    set((state) => {
      const open = { ...state.open };
      let chats = state.chats;
      let authFailed = state.authFailed;
      let turnsEnded = state.turnsEnded;
      for (const push of pushes) {
        if (push.summary) {
          const summary = push.summary;
          chats = [summary, ...chats.filter((one) => one.id !== summary.id)].sort(byTime);
        }
        // A tool refused for want of a sign-in is marked until it answers again; a chat new in this frame is in `chats` already.
        const tool = chats.find((one) => one.id === push.chatId)?.cli;
        if (tool && push.event?.type === 'error' && push.event.kind === 'auth' && !authFailed.includes(tool)) authFailed = [...authFailed, tool];
        if (tool && push.event?.type === 'done' && authFailed.includes(tool)) authFailed = authFailed.filter((one) => one !== tool);
        const chat = open[push.chatId];
        if (!chat) continue;
        let next = chat;
        // Numbered, so an event read with the chat and pushed as well is taken once.
        if (push.event && (push.seq === undefined || push.seq > next.seq)) next = { ...next, events: [...next.events, push.event], seq: push.seq ?? next.seq };
        if (push.state) {
          if (next.running && !push.state.running) turnsEnded += 1;
          next = { ...next, running: push.state.running, options: push.state.options };
        }
        open[push.chatId] = next;
      }
      return { open, chats, authFailed, turnsEnded };
    });
  };
  let listening = false;
  // The cards answered and not yet told back: a second Enter, or a second click, before the push comes is not sent again.
  const answering = new Set<string>();

  return {
    clis: null,
    chats: [],
    active: null,
    open: {},
    cli: load<CliId | null>(CLI_KEY, null),
    drafts: load<Record<string, string>>(DRAFTS_KEY, {}),
    error: null,
    side: { open: load<boolean>(SIDE_KEY, false), path: null },

    showSide(path = null) {
      set({ side: { open: true, path } });
      keep(SIDE_KEY, true);
    },

    hideSide() {
      set({ side: { open: false, path: null } });
      keep(SIDE_KEY, false);
    },

    auth: null,
    authOpen: null,
    authFailed: [],
    installing: null,
    turnsEnded: 0,

    async install(id) {
      set({ installing: { id, failed: false } });
      try {
        await window.cortex.chat.install(id);
      } catch (err) {
        set({ installing: null });
        throw err;
      }
    },

    async loadAuth() {
      try {
        set({ auth: await window.cortex.chat.auth() });
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    openAuth(focus) {
      set({ authOpen: focus ?? 'all' });
      void get().loadAuth();
    },

    closeAuth() {
      set({ authOpen: null });
    },

    async boot() {
      if (!listening) {
        listening = true;
        window.cortex.on.chat((push) => {
          queue.push(push);
          if (!frame) frame = requestAnimationFrame(flush);
        });
        // A sign-in or an install ended: every tool asked again, and the CLIs, one of which may be new.
        window.cortex.on.authChanged(() => {
          void get()
            .loadAuth()
            .then(() => {
              // An installer that ended without its tool leaves its button to be pressed again, and says so; the tool there, whenever it came, nothing is left to say.
              const installing = get().installing;
              if (!installing) return;
              if (get().auth?.find((one) => one.id === installing.id)?.installed) set({ installing: null });
              else if (!installing.failed) set({ installing: { ...installing, failed: true } });
            });
          void get().refreshClis();
        });
        // Back from another app - LM Studio, where a model was just loaded, or a terminal, where a tool was installed: the CLIs asked again.
        window.addEventListener('focus', () => void get().refreshClis());
      }
      try {
        const [clis, chats] = await Promise.all([window.cortex.chat.clis(), window.cortex.chat.list()]);
        const chosen = get().cli;
        const available = clis.filter((one) => one.available);
        // The CLI last written to, while it is still here; else the first this machine has.
        const cli = chosen && available.some((one) => one.id === chosen) ? chosen : (available[0]?.id ?? null);
        set({ clis, chats, cli, error: null });
        // Asked once at the start, so the tool chip can say which tools are signed in; it takes a second or two.
        void get().loadAuth();
      } catch (err) {
        set({ error: messageOf(err), clis: [] });
      }
    },

    async vaultChanged() {
      try {
        set({ chats: await window.cortex.chat.list(), active: null, open: {}, error: null });
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async refreshClis() {
      try {
        const had = new Set((get().clis ?? []).filter((one) => one.available).map((one) => one.id));
        const clis = await window.cortex.chat.clis();
        const chosen = get().cli;
        const available = clis.filter((one) => one.available);
        set({ clis, cli: chosen && available.some((one) => one.id === chosen) ? chosen : (available[0]?.id ?? chosen) });
        // A tool installed since: whether it is signed in is asked too, for the tool chip.
        if (available.some((one) => !had.has(one.id))) void get().loadAuth();
      } catch {
        /* The list as it was. */
      }
    },

    async select(id) {
      set((state) => ({ side: { ...state.side, path: null } }));
      if (id === null) {
        set({ active: null });
        return;
      }
      if (!get().open[id]) {
        try {
          const opened = await window.cortex.chat.open(id);
          set((state) => ({ open: { ...state.open, [id]: fromOpened(opened) } }));
        } catch (err) {
          set({ error: messageOf(err) });
          return;
        }
      }
      set({ active: id });
    },

    setCli(cli) {
      set({ cli });
      keep(CLI_KEY, cli);
    },

    setDraft(key, text) {
      const drafts = { ...get().drafts };
      if (text) drafts[key] = text;
      else delete drafts[key];
      set({ drafts });
      keep(DRAFTS_KEY, drafts);
    },

    async send(text) {
      const { active, cli, open } = get();
      const chatCli = active ? get().chats.find((one) => one.id === active)?.cli : cli;
      if (!chatCli || !text.trim()) return false;
      try {
        const { id } = await window.cortex.chat.send(active, chatCli, text);
        if (!open[id]) {
          // A new chat: read whole once, its pushes after that taken by their numbers.
          const opened = await window.cortex.chat.open(id);
          set((state) => ({ open: { ...state.open, [id]: fromOpened(opened) } }));
        }
        get().setDraft(active ?? 'new', '');
        set({ active: id, error: null });
        return true;
      } catch (err) {
        set({ error: messageOf(err) });
        return false;
      }
    },

    cancel() {
      const { active } = get();
      if (active) void window.cortex.chat.cancel(active).catch((err: unknown) => set({ error: messageOf(err) }));
    },

    answer(permission, option) {
      const { active } = get();
      if (!active) return;
      const key = `${active}:${permission}`;
      if (answering.has(key)) return;
      answering.add(key);
      void window.cortex.chat.answer(active, permission, option).catch((err: unknown) => {
        // Not taken: the card stays, and can be answered again.
        answering.delete(key);
        set({ error: messageOf(err) });
      });
    },

    async setOption(option, value) {
      const { active } = get();
      if (!active) return;
      try {
        const options = await window.cortex.chat.setOption(active, option, value);
        set((state) => ({ open: { ...state.open, [active]: { ...state.open[active], options } } }));
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async rename(id, title) {
      try {
        const summary = await window.cortex.chat.rename(id, title);
        set((state) => ({ chats: state.chats.map((one) => (one.id === id ? summary : one)) }));
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async remove(id) {
      try {
        await window.cortex.chat.remove(id);
        set((state) => {
          const open = { ...state.open };
          delete open[id];
          // The chat in front gone: the most recent other one, else a new chat.
          const chats = state.chats.filter((one) => one.id !== id);
          return { chats, open, active: state.active === id ? null : state.active };
        });
        get().setDraft(id, '');
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },
  };
});

/**
 * The chats waiting on the person, each with the card it waits on: a chat still answering whose
 * card is not answered. Read for the badge on Pyn's tab, the chat list and the notice of a card
 * that comes while its chat is not in front (desktop-ui-m1); with `useShallow`, since it is a new
 * object at every read.
 */
export function waitingChats(open: Record<string, OpenChat>): Record<string, string> {
  const waiting: Record<string, string> = {};
  for (const [id, chat] of Object.entries(open)) {
    const card = chat.running ? waitingIn(chat.events) : null;
    if (card) waiting[id] = card.id;
  }
  return waiting;
}

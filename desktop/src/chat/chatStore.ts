import { create } from 'zustand';
import type { ChatEvent, ChatOpened, ChatPush, ChatSummary, CliId, CliInfo, ConfigOption } from '@shared/chat';
import { messageOf } from '@shared/ipcError';

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
  boot(): Promise<void>;
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
      for (const push of pushes) {
        if (push.summary) {
          const summary = push.summary;
          chats = [summary, ...chats.filter((one) => one.id !== summary.id)].sort(byTime);
        }
        const chat = open[push.chatId];
        if (!chat) continue;
        let next = chat;
        // Numbered, so an event read with the chat and pushed as well is taken once.
        if (push.event && (push.seq === undefined || push.seq > next.seq)) next = { ...next, events: [...next.events, push.event], seq: push.seq ?? next.seq };
        if (push.state) next = { ...next, running: push.state.running, options: push.state.options };
        open[push.chatId] = next;
      }
      return { open, chats };
    });
  };
  let listening = false;

  return {
    clis: null,
    chats: [],
    active: null,
    open: {},
    cli: load<CliId | null>(CLI_KEY, null),
    drafts: load<Record<string, string>>(DRAFTS_KEY, {}),
    error: null,

    async boot() {
      if (!listening) {
        listening = true;
        window.cortex.on.chat((push) => {
          queue.push(push);
          if (!frame) frame = requestAnimationFrame(flush);
        });
      }
      try {
        const [clis, chats] = await Promise.all([window.cortex.chat.clis(), window.cortex.chat.list()]);
        const chosen = get().cli;
        const available = clis.filter((one) => one.available);
        // The CLI last written to, while it is still here; else the first this machine has.
        const cli = chosen && available.some((one) => one.id === chosen) ? chosen : (available[0]?.id ?? null);
        set({ clis, chats, cli, error: null });
      } catch (err) {
        set({ error: messageOf(err), clis: [] });
      }
    },

    async select(id) {
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
      if (active) void window.cortex.chat.answer(active, permission, option).catch((err: unknown) => set({ error: messageOf(err) }));
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

import { useEffect, useMemo } from 'react';
import { BookOpen, PencilLine, Plus, Trash2 } from 'lucide-react';
import seal from '../../../tema/ananas/marka/pyn-muhur.svg';
import type { ChatSummary } from '@shared/chat';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { noteFor, useNotes } from '../notes/notesStore';
import { useConfirm, usePrompt } from '../notes/NotesMenus';
import { useApp } from '../store/app';
import { Spinner } from '../ui/ui';
import { useChat } from './chatStore';
import { Composer } from './Composer';
import { SidePane } from './SidePane';
import { Transcript } from './Transcript';
import { notesOf, turnsOf, usageOf, waitingOn } from './turns';

/**
 * Pyn: Cortex's first screen, where the person talks to their own AI. The
 * chats of this vault on the left, newest first; the chat in front in the
 * middle; a new chat is the greeting and the field, and becomes a chat with
 * its first message - none is made before that, and none at start.
 */

const SUGGESTIONS: Key[] = ['chat.suggest.continue', 'chat.suggest.inbox', 'chat.suggest.today'];

/** The chats in the groups a person looks for them in: today, yesterday, this week, before. */
function groupsOf(chats: ChatSummary[]): Array<{ label: Key; chats: ChatSummary[] }> {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  const yesterday = today - 86_400_000;
  const week = today - 6 * 86_400_000;
  const groups: Array<{ label: Key; chats: ChatSummary[] }> = [
    { label: 'chat.group.today', chats: [] },
    { label: 'chat.group.yesterday', chats: [] },
    { label: 'chat.group.week', chats: [] },
    { label: 'chat.group.older', chats: [] },
  ];
  for (const chat of chats) groups[chat.updatedAt >= today ? 0 : chat.updatedAt >= yesterday ? 1 : chat.updatedAt >= week ? 2 : 3].chats.push(chat);
  return groups.filter((one) => one.chats.length);
}

function ChatList() {
  const t = useT();
  const language = useLanguage();
  const chats = useChat((state) => state.chats);
  const active = useChat((state) => state.active);
  const open = useChat((state) => state.open);
  const clis = useChat((state) => state.clis);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const groups = useMemo(() => groupsOf(chats), [chats]);
  const cliName = (id: string) => clis?.find((one) => one.id === id)?.name ?? id;
  const time = (at: number) => new Date(at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });

  const remove = async (chat: ChatSummary) => {
    if (!(await confirm({ title: t('chat.remove.title', { name: chat.title || t('chat.untitled') }), detail: t('chat.remove.detail'), action: t('chat.remove.action') }))) return;
    await useChat.getState().remove(chat.id);
  };
  const rename = async (chat: ChatSummary) => {
    const title = await prompt({ title: t('chat.rename'), label: t('chat.rename.label'), value: chat.title, action: t('chat.rename.action'), check: (value) => (value.trim() ? null : t('chat.rename.empty')) });
    if (title) await useChat.getState().rename(chat.id, title);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-100" data-chat-list>
      <div className="flex h-10 shrink-0 items-center border-b border-zinc-100 px-2">
        <button
          type="button"
          onClick={() => void useChat.getState().select(null)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12px] font-semibold transition-colors ${active === null ? 'bg-zinc-100 text-darkDelegation' : 'text-zinc-500 hover:bg-zinc-50 hover:text-darkDelegation'}`}
          title={`${t('chat.new')} (Ctrl+K)`}
          data-chat-new
        >
          <Plus size={14} />
          {t('chat.new')}
          <span className="ml-auto font-mono text-[10px] font-normal text-zinc-400">Ctrl K</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {!chats.length ? <p className="px-2.5 pt-3 text-[11.5px] leading-relaxed text-zinc-400">{t('chat.list.empty')}</p> : null}
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-1 pt-3.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{t(group.label)}</p>
            <ul className="space-y-px">
              {group.chats.map((chat) => (
                <li key={chat.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => void useChat.getState().select(chat.id)}
                    className={`w-full rounded-md px-2.5 py-1.5 pr-12 text-left transition-colors ${chat.id === active ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}
                    data-chat-item={chat.id}
                  >
                    <span className={`flex items-center gap-1.5 truncate text-[13px] ${chat.id === active ? 'font-semibold text-darkDelegation' : 'text-zinc-600'}`}>
                      {open[chat.id]?.running ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-gold" data-chat-running /> : null}
                      <span className="truncate">{chat.title || t('chat.untitled')}</span>
                    </span>
                    <span className="block truncate text-[10.5px] text-zinc-400">
                      {cliName(chat.cli)} · {time(chat.updatedAt)}
                    </span>
                  </button>
                  <span className="absolute right-1.5 top-1.5 hidden gap-0.5 group-hover:flex">
                    <button type="button" onClick={() => void rename(chat)} title={t('chat.rename')} aria-label={t('chat.rename')} className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-darkDelegation">
                      <PencilLine size={12} />
                    </button>
                    <button type="button" onClick={() => void remove(chat)} title={t('chat.remove')} aria-label={t('chat.remove')} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-bad" data-chat-remove>
                      <Trash2 size={12} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function ChatView({ visible }: { visible: boolean }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const state = useChat();
  const { clis, active, open, cli, drafts, error } = state;
  const chat = active ? open[active] : null;
  const summary = active ? state.chats.find((one) => one.id === active) : null;
  const turns = useMemo(() => turnsOf(chat?.events ?? []), [chat?.events]);
  const usage = useMemo(() => usageOf(chat?.events ?? []), [chat?.events]);
  const asked = chat?.running ? waitingOn(turns) : null;
  // The notes this chat touched, for the panel beside it: read again when the vault's index is.
  const revision = useNotes((s) => s.revision);
  const touched = useMemo(
    () => notesOf(turns, noteFor, (target, kind) => useNotes.getState().resolve(target, '', kind)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, revision],
  );
  const side = state.side;
  const draftKey = active ?? 'new';

  useEffect(() => {
    void useChat.getState().boot();
    // The notes are read for what an answer links to: a link to a note not yet read would show as one not written, and make it.
    if (!useNotes.getState().index) void useNotes.getState().refresh();
  }, []);

  // A refusal from the main process - a CLI gone, a message too long - said once.
  useEffect(() => {
    if (!error) return;
    toast({ tone: 'error', title: t('chat.failed'), detail: error });
    useChat.setState({ error: null });
  }, [error, toast, t]);

  // Ctrl+K: a new chat, while Pyn is in front.
  useEffect(() => {
    if (!visible) return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void useChat.getState().select(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible]);

  if (clis === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const available = clis.filter((one) => one.available);
  const composer = (big: boolean) => (
    <Composer
      big={big}
      focusKey={`${draftKey}:${visible}`}
      draft={drafts[draftKey] ?? ''}
      onDraft={(text) => state.setDraft(draftKey, text)}
      onSend={(text) => state.send(text)}
      onStop={() => state.cancel()}
      running={Boolean(chat?.running)}
      clis={clis}
      cli={summary?.cli ?? cli}
      onCli={(id) => state.setCli(id)}
      cliFixed={Boolean(summary)}
      options={chat?.options ?? []}
      onOption={(option, value) => void state.setOption(option, value)}
      usage={usage}
      asked={asked}
      onAnswer={(option) => asked && state.answer(asked.id, option)}
      auth={state.auth}
      onAuth={() => state.openAuth(summary?.cli ?? cli ?? undefined)}
    />
  );

  return (
    <div className="flex h-full min-h-0" data-chat-view>
      <ChatList />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {chat ? (
          <>
            {!side.open ? (
              <button
                type="button"
                onClick={() => state.showSide()}
                title={t('chat.side.title')}
                className="absolute right-4 top-3 z-10 flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-paper-2 px-2.5 py-1 text-[11.5px] text-zinc-500 shadow-[0_1px_2px_rgba(27,23,18,0.06)] hover:border-zinc-400 hover:text-darkDelegation"
                data-chat-side-toggle
              >
                <BookOpen size={13} />
                {t('chat.side.toggle')}
                {touched.length ? <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-600">{touched.length}</span> : null}
              </button>
            ) : null}
            <Transcript turns={turns} running={chat.running} onSignIn={() => summary && state.openAuth(summary.cli)} />
            {composer(false)}
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10" data-chat-empty>
            <div className="w-full max-w-[46rem]">
              <div className="mb-6 flex items-center gap-4">
                <img src={seal} alt="" className="h-14 w-14 shrink-0" />
                <div>
                  <h1 className="font-display text-3xl text-darkDelegation">{t('chat.hello')}</h1>
                  <p className="mt-1 text-[13.5px] text-zinc-500">{t('chat.hello.sub')}</p>
                </div>
              </div>
              {available.length ? (
                <>
                  {composer(true)}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {SUGGESTIONS.map((one) => (
                      // A suggestion fills the field, and does not send: the person reads it first.
                      <button
                        key={one}
                        type="button"
                        onClick={() => state.setDraft('new', t(one))}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-[12px] text-zinc-500 transition-colors hover:border-zinc-400 hover:text-darkDelegation"
                        data-chat-suggestion
                      >
                        {t(one)}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-zinc-200 bg-paper-2 px-4 py-3 text-[13px] leading-relaxed text-zinc-600" data-chat-no-cli>
                  {t('chat.noCli', { names: clis.map((one) => one.name).join(', ') })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      {chat && side.open ? <SidePane notes={touched} /> : null}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Brain, Check, ChevronRight, FileText, Globe, Inbox, ListChecks, PencilLine, Search, Terminal, Wrench, X } from 'lucide-react';
// The small face: drawn for 24-32 px. While Pyn is still writing, the thinking one.
import face from '../../../tema/ananas/marka/pyn-yuz/pyn-yuz-kucuk.svg';
import thinkingFace from '../../../tema/ananas/marka/pyn-yuz/pyn-yuz-kucuk-dusunuyor.svg';
import { messageOf } from '@shared/ipcError';
import { turkishOf } from '@shared/refusalsTr';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { NoteMarkdown } from '../notes/NoteMarkdown';
import { noteFor, useNotes } from '../notes/notesStore';
import { useApp } from '../store/app';
import { Spinner } from '../ui/ui';
import { captureNoteLinks, openNote } from './noteLinks';
import type { Step, Turn } from './turns';

/**
 * A chat as it reads: what the person wrote on the right, Pyn's answers on
 * the left - the words first, the thinking and the steps each folded into one
 * line above them. A note the answer links to, or a step touched, opens in
 * the panel beside the chat (SidePane.tsx); with Ctrl, in the notes. The view follows the answer as it comes while the person is at
 * its foot, and stays where they scrolled to when they are not.
 */

const KIND_ICONS: Record<string, React.ReactNode> = {
  read: <FileText size={13} />,
  edit: <PencilLine size={13} />,
  delete: <X size={13} />,
  move: <PencilLine size={13} />,
  search: <Search size={13} />,
  execute: <Terminal size={13} />,
  fetch: <Globe size={13} />,
  think: <Brain size={13} />,
};

/** A note the CLI named, opened beside the chat; a path that is not a note of the vault is shown, not opened. */
function PathChip({ path }: { path: string }) {
  const note = useNotes((state) => (path.toLowerCase().endsWith('.md') ? noteFor(path) : null) ?? null);
  return note ? (
    <button type="button" onClick={(event) => openNote(note, event.ctrlKey || event.metaKey)} className="max-w-[16rem] truncate rounded bg-zinc-100 px-1.5 py-px font-mono text-[10.5px] text-zinc-600 hover:bg-zinc-200 hover:text-darkDelegation" data-chat-path={path}>
      {path}
    </button>
  ) : (
    <span className="max-w-[16rem] truncate rounded bg-zinc-50 px-1.5 py-px font-mono text-[10.5px] text-zinc-400">{path}</span>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const status =
    step.status === 'completed' ? (
      <Check size={12} className="text-good" />
    ) : step.status === 'failed' ? (
      <X size={12} className="text-bad" />
    ) : (
      <Spinner size={11} />
    );
  return (
    <li className="py-1" data-chat-step={step.id} data-chat-step-status={step.status}>
      <button type="button" onClick={() => setOpen(!open)} disabled={!step.output} className="flex w-full items-center gap-2 text-left disabled:cursor-default">
        <span className="shrink-0 text-zinc-400">{KIND_ICONS[step.kind] ?? <Wrench size={13} />}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-600">{step.title || step.kind}</span>
        <span className="shrink-0">{status}</span>
      </button>
      {step.paths.length ? (
        <div className="mt-1 flex flex-wrap gap-1 pl-[1.3rem]">
          {step.paths.map((one) => (
            <PathChip key={one} path={one} />
          ))}
        </div>
      ) : null}
      {open && step.output ? <pre className="mt-1.5 ml-[1.3rem] max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed text-zinc-600">{step.output}</pre> : null}
    </li>
  );
}

/** A folded line - the thinking, the activity - opened by a click. */
function Fold({ icon, label, busy, children, data }: { icon: React.ReactNode; label: string; busy: boolean; children: React.ReactNode; data: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2" data-chat-fold={data}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group flex items-center gap-1.5 text-[11.5px] text-zinc-400 hover:text-zinc-600">
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={busy ? 'animate-pulse' : ''}>{icon}</span>
        <span className={busy ? 'animate-pulse' : ''}>{label}</span>
      </button>
      {open ? <div className="mt-1.5 border-l-2 border-zinc-100 pl-3">{children}</div> : null}
    </div>
  );
}

const ERRORS: Record<string, Key> = {
  'provider.quota': 'chat.error.quota',
  auth: 'chat.error.auth',
  model: 'chat.error.model',
  stopped: 'chat.error.stopped',
  unsupported: 'chat.error.unsupported',
  'local-off': 'chat.error.localOff',
};

function Answer({ turn, live, onSignIn }: { turn: Turn; live: boolean; onSignIn?: () => void }) {
  const t = useT();
  const language = useLanguage();
  const working = live && !turn.end;
  const answered = turn.asked.filter((one) => one.answer !== undefined);
  return (
    <div className="flex gap-3" data-chat-answer>
      <img src={working ? thinkingFace : face} alt="" className="mt-0.5 h-7 w-7 shrink-0" data-chat-face={working ? 'thinking' : 'idle'} />
      <div className="min-w-0 flex-1">
        {turn.thought ? (
          <Fold data="thought" icon={<Brain size={12} />} label={t(working && !turn.text ? 'chat.thinking' : 'chat.thought')} busy={working && !turn.text}>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-zinc-500">{turn.thought}</p>
          </Fold>
        ) : null}
        {turn.steps.length || answered.length ? (
          <Fold data="activity" icon={<ListChecks size={12} />} label={t('chat.activity', { count: turn.steps.length })} busy={working && turn.steps.some((one) => one.status === 'pending' || one.status === 'in_progress')}>
            <ul className="divide-y divide-zinc-50">
              {turn.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ul>
            {answered.map((one) => (
              <p key={one.id} className="py-1 text-[11.5px] text-zinc-500">
                {t(one.answer && one.options.find((option) => option.id === one.answer)?.kind.startsWith('allow') ? 'chat.permission.allowed' : 'chat.permission.refused', { title: one.title || one.kind })}
              </p>
            ))}
          </Fold>
        ) : null}
        {turn.plan?.length ? (
          <ul className="mb-2 space-y-0.5 text-[12.5px] text-zinc-600" data-chat-plan>
            {turn.plan.map((entry, at) => (
              <li key={at} className="flex items-start gap-2">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-sm border ${entry.status === 'completed' ? 'border-good bg-good' : entry.status === 'in_progress' ? 'border-gold bg-gold/40' : 'border-zinc-300'}`} />
                <span className={entry.status === 'completed' ? 'text-zinc-400 line-through' : ''}>{entry.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {turn.text ? (
          <div className="kg-chat text-[14px]" data-chat-text>
            <NoteMarkdown path="" source={turn.text} offset={0} />
          </div>
        ) : working && !turn.thought && !turn.steps.length ? (
          <p className="flex items-center gap-2 text-[12.5px] text-zinc-400" data-chat-working>
            <Spinner size={12} />
            {t('chat.working')}
          </p>
        ) : null}
        {turn.end?.kind === 'error' ? (
          <div className="mt-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2" data-chat-error={turn.end.error ?? ''}>
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-bad">
              <AlertTriangle size={13} />
              {t(ERRORS[turn.end.error ?? ''] ?? 'chat.error.other')}
            </p>
            {/* What the main process said, in English; a CLI's own words are left as they came. */}
            <p className="mt-0.5 break-words font-mono text-[11px] text-zinc-500">{language === 'en' ? turn.end.message : turkishOf(turn.end.message)}</p>
            {turn.end.error === 'auth' && onSignIn ? (
              <button type="button" onClick={onSignIn} className="mt-2 rounded-lg border-[1.5px] border-darkDelegation bg-gold px-2.5 py-1 text-[11.5px] font-semibold text-darkDelegation hover:bg-signal" data-chat-sign-in>
                {t('chat.signIn')}
              </button>
            ) : null}
          </div>
        ) : turn.end?.kind === 'done' && turn.end.reason !== 'end_turn' ? (
          <p className="mt-1 text-[11.5px] text-zinc-400" data-chat-stopped={turn.end.reason}>
            {t(turn.end.reason === 'cancelled' ? 'chat.stopped' : turn.end.reason === 'max_tokens' ? 'chat.end.length' : turn.end.reason === 'refusal' ? 'chat.end.refusal' : 'chat.end.other', { reason: turn.end.reason })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the person wrote, kept for later in the vault's inbox with one press
 * (`📥 000-Inbox/Yakala`, as Ctrl+Alt+C and Telegram keep it): whatever the
 * model can or cannot do, the message is saved. Under the message, shown when
 * the pointer is over it or the button has the focus.
 */
function ToInbox({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [where, setWhere] = useState<string | null>(null);
  const keep = async () => {
    setState('saving');
    try {
      const saved = await window.cortex.chat.toInbox(text);
      setWhere(saved.path);
      setState('saved');
    } catch (err) {
      setState('idle');
      useApp.getState().toast({ tone: 'error', title: t('chat.inbox.failed'), detail: messageOf(err), sticky: true });
    }
  };
  if (state === 'saved') {
    return (
      <span className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-500" data-chat-inbox="saved">
        <Check size={12} className="text-good" />
        {t('chat.inbox.saved')}
        {where ? <PathChip path={where} /> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={state === 'saving'}
      onClick={() => void keep()}
      className="ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-darkDelegation focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100"
      title={t('chat.inbox.hint')}
      data-chat-inbox="button"
    >
      {state === 'saving' ? <Spinner size={11} /> : <Inbox size={12} />}
      {t('chat.inbox')}
    </button>
  );
}

export function Transcript({ turns, running, onSignIn }: { turns: Turn[]; running: boolean; onSignIn?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // Following the answer while the person is at the foot of the chat; left where they are when they scrolled up.
  const atFoot = useRef(true);
  const length = useMemo(() => turns.reduce((sum, turn) => sum + turn.text.length + turn.thought.length + turn.steps.length, 0), [turns]);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && atFoot.current) element.scrollTop = element.scrollHeight;
  }, [length, turns.length, running]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const scrolled = () => {
      atFoot.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    element.addEventListener('scroll', scrolled, { passive: true });
    return () => element.removeEventListener('scroll', scrolled);
  }, []);
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto" data-chat-transcript onClickCapture={captureNoteLinks}>
      <div className="mx-auto flex max-w-[46rem] flex-col gap-6 px-6 pb-8 pt-8">
        {turns.map((turn, at) => (
          <div key={at} className="flex flex-col gap-4">
            {turn.user ? (
              <div className="group ml-auto flex max-w-[85%] flex-col gap-1">
                <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-zinc-200/80 bg-paper-2 px-4 py-2.5 text-[14px] leading-relaxed text-darkDelegation" data-chat-user>
                  {turn.user.text}
                </div>
                <ToInbox text={turn.user.text} />
              </div>
            ) : null}
            <Answer turn={turn} live={running && at === turns.length - 1} onSignIn={onSignIn} />
          </div>
        ))}
      </div>
    </div>
  );
}

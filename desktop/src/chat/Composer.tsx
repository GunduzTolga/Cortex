import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Inbox, Settings2, ShieldQuestion, Square } from 'lucide-react';
import type { CliAuth, CliId, CliInfo, ConfigOption, PermissionKind } from '@shared/chat';
import { messageOf } from '@shared/ipcError';
import type { Key } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Spinner } from '../ui/ui';
import { useEscapeLayer } from '../ui/useEscapeLayer';
import { authDot } from './AuthDialog';
import type { Asked } from './turns';

/**
 * Where the person writes to Pyn, and what they write with: the CLI, and the
 * session's own settings - the model, the mode, how hard it thinks - as the
 * CLI offers them, each a chip that opens its list. Enter sends, Shift+Enter
 * starts a line; while an answer comes, the send button stops it. Beside it,
 * "Gelen kutusuna at" (Ctrl+Enter) keeps what is written for later in the
 * vault's inbox instead (`📥 000-Inbox/Yakala`), and nothing goes to the
 * model. How full
 * the model's context is shows as a ring. A step the CLI asks leave for is a
 * card over it, answered with a click, or Enter for once.
 */

interface Choice {
  value: string;
  name: string;
  /** A tool's state, as a dot beside its name: signed in or a server up, not signed in, a server off. */
  dot?: 'on' | 'off' | 'down' | null;
}

/** A chip that opens a list over it: a long list - sixty models - gets a field to narrow it. */
function ChipSelect({
  label,
  value,
  choices,
  onChoose,
  data,
  disabled,
  footer,
}: {
  label: string;
  value: string;
  choices: Choice[];
  onChoose: (value: string) => void;
  data: string;
  disabled?: boolean;
  /** One more thing to do from the list, under it: managing the tools' sign-ins. */
  footer?: { label: string; run: () => void };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    setFilter('');
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  const current = choices.find((one) => one.value === value);
  const query = filter.trim().toLocaleLowerCase();
  const shown = query ? choices.filter((one) => `${one.name} ${one.value}`.toLocaleLowerCase().includes(query)) : choices;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-chat-chip={data}
        className="flex max-w-[14rem] items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-darkDelegation disabled:pointer-events-none disabled:opacity-60"
      >
        <span className="truncate">{current?.name ?? value}</span>
        {disabled ? null : <ChevronDown size={11} className="shrink-0" />}
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-72 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_-16px_rgba(27,23,18,0.45)]" role="listbox" aria-label={label}>
          <p className="border-b border-zinc-100 px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{label}</p>
          {choices.length > 10 ? (
            <input
              autoFocus
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('chat.chip.filter')}
              className="mx-2 mt-2 h-7 w-[calc(100%-1rem)] rounded-md border border-zinc-200 bg-transparent px-2 text-[12px] outline-none placeholder:text-zinc-400 focus:border-zinc-400"
            />
          ) : null}
          <ul className="max-h-72 overflow-y-auto py-1">
            {shown.map((one) => (
              <li key={one.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={one.value === value}
                  data-chat-choice={one.value}
                  onClick={() => {
                    setOpen(false);
                    if (one.value !== value) onChoose(one.value);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-50"
                >
                  <span className="w-3.5 shrink-0 text-darkDelegation">{one.value === value ? <Check size={13} /> : null}</span>
                  <span className="truncate">{one.name}</span>
                  {one.dot ? <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${one.dot === 'on' ? 'bg-good' : one.dot === 'down' ? 'bg-bad' : 'bg-gold'}`} data-chat-choice-dot={one.dot} /> : null}
                </button>
              </li>
            ))}
            {!shown.length ? <li className="px-3 py-2 text-[12px] text-zinc-400">{t('chat.chip.none')}</li> : null}
          </ul>
          {footer ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                footer.run();
              }}
              className="flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-2 text-left text-[12px] text-zinc-500 hover:bg-zinc-50 hover:text-darkDelegation"
              data-chat-chip-footer
            >
              <Settings2 size={13} />
              {footer.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** How full the model's context is: a ring, the numbers on hover. */
function ContextRing({ used, size, cost, currency }: { used: number; size: number; cost: number | null; currency: string | null }) {
  const t = useT();
  const language = useLanguage();
  const share = size > 0 ? Math.min(1, used / size) : 0;
  const number = new Intl.NumberFormat(language);
  const r = 7;
  const around = 2 * Math.PI * r;
  const title = `${t('chat.context', { used: number.format(used), size: number.format(size), share: Math.round(share * 100) })}${cost ? ` · ${new Intl.NumberFormat(language, { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 4 }).format(cost)}` : ''}`;
  return (
    <span title={title} aria-label={title} className="flex h-8 w-8 items-center justify-center" data-chat-context={Math.round(share * 100)}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--color-zinc-200)" strokeWidth="2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={share > 0.85 ? 'var(--color-bad)' : share > 0.6 ? 'var(--color-warn)' : 'var(--color-zinc-500)'} strokeWidth="2" strokeDasharray={`${around * share} ${around}`} strokeLinecap="round" transform="rotate(-90 9 9)" />
      </svg>
    </span>
  );
}

const ANSWERS: Record<PermissionKind, Key> = {
  allow_once: 'chat.permission.once',
  allow_always: 'chat.permission.always',
  reject_once: 'chat.permission.reject',
  reject_always: 'chat.permission.never',
};

/** The CLI asks before a step: what it would do, and the answers it offers. Enter is "once". */
function PermissionCard({ asked, onAnswer }: { asked: Asked; onAnswer: (option: string | null) => void }) {
  const t = useT();
  const once = asked.options.find((one) => one.kind === 'allow_once');
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey && once && !(event.target as Element | null)?.closest('textarea, input')) {
        event.preventDefault();
        onAnswer(once.id);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [once, onAnswer]);
  return (
    <div className="mb-2 rounded-xl border-[1.5px] border-darkDelegation bg-paper-2 px-4 py-3 shadow-[3px_3px_0_0_#1b1712]" data-chat-permission={asked.id}>
      <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-darkDelegation">
        <ShieldQuestion size={13} />
        {t('chat.permission.title')}
      </p>
      <p className="mt-1.5 break-words font-mono text-[12px] text-zinc-700">{asked.title || asked.kind}</p>
      {asked.paths.length ? <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{asked.paths.join(' · ')}</p> : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {asked.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onAnswer(option.id)}
            data-chat-answer-option={option.kind}
            className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              option.kind === 'allow_once'
                ? 'border-[1.5px] border-darkDelegation bg-gold text-darkDelegation hover:bg-signal'
                : option.kind.startsWith('reject')
                  ? 'border border-zinc-200 text-zinc-500 hover:border-red-300 hover:text-bad'
                  : 'border border-darkDelegation/25 text-zinc-600 hover:border-darkDelegation hover:text-darkDelegation'
            }`}
          >
            {t(ANSWERS[option.kind])}
          </button>
        ))}
      </div>
    </div>
  );
}

const OPTION_ORDER = ['model', 'mode', 'thought_level'];

export function Composer({
  draft,
  onDraft,
  onSend,
  onStop,
  running,
  clis,
  cli,
  onCli,
  cliFixed,
  options,
  onOption,
  usage,
  asked,
  onAnswer,
  big = false,
  focusKey,
  auth,
  onAuth,
}: {
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  running: boolean;
  clis: CliInfo[];
  cli: CliId | null;
  onCli: (cli: CliId) => void;
  /** A chat already written to keeps its CLI. */
  cliFixed: boolean;
  options: ConfigOption[];
  onOption: (option: string, value: string) => void;
  usage: { used: number; size: number; cost: number | null; currency: string | null } | null;
  asked: Asked | null;
  onAnswer: (option: string | null) => void;
  /** The first screen's: taller, and given the cursor. */
  big?: boolean;
  /** Changed, the field takes the cursor: another chat put in front. */
  focusKey: string;
  /** Whether each tool is signed in, for the dots on the tool chip. */
  auth: CliAuth[] | null;
  onAuth: () => void;
}) {
  const t = useT();
  const field = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    field.current?.focus();
  }, [focusKey]);
  // As tall as what is written, up to a third of the window.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight / 3)}px`;
  }, [draft]);

  const send = async () => {
    if (!draft.trim() || running || sending || !cli) return;
    setSending(true);
    await onSend(draft);
    setSending(false);
  };

  // Kept for later, not sent: the model is not asked, so nothing answers it. The draft goes once it is kept.
  const [keeping, setKeeping] = useState(false);
  const keep = async () => {
    if (!draft.trim() || keeping) return;
    setKeeping(true);
    try {
      await window.cortex.chat.toInbox(draft);
      onDraft('');
      useApp.getState().toast({ tone: 'success', title: t('chat.inbox.saved') });
    } catch (err) {
      useApp.getState().toast({ tone: 'error', title: t('chat.inbox.failed'), detail: messageOf(err), sticky: true });
    } finally {
      setKeeping(false);
      field.current?.focus();
    }
  };

  const available = clis.filter((one) => one.available);
  const settings = [...options].sort((a, b) => {
    const at = (one: ConfigOption) => {
      const index = OPTION_ORDER.indexOf(one.category ?? one.id);
      return index < 0 ? OPTION_ORDER.length : index;
    };
    return at(a) - at(b);
  });

  return (
    <div className={`mx-auto w-full max-w-[46rem] ${big ? '' : 'px-6 pb-5'}`} data-chat-composer>
      {asked ? <PermissionCard asked={asked} onAnswer={onAnswer} /> : null}
      <div className="rounded-2xl border border-zinc-200 bg-paper-2 shadow-[0_1px_2px_rgba(27,23,18,0.06)] transition-colors focus-within:border-zinc-400">
        <textarea
          ref={field}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) void keep();
            else void send();
          }}
          rows={big ? 3 : 1}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          className={`block w-full resize-none bg-transparent px-4 pt-3 text-[14px] leading-relaxed text-darkDelegation outline-none placeholder:text-zinc-400 ${big ? 'min-h-[5.5rem]' : 'min-h-[2.75rem]'}`}
          data-chat-input
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <ChipSelect
            label={t('chat.chip.cli')}
            value={cli ?? ''}
            // A chat written to keeps its tool: its list is that tool alone, and still opens for the sign-ins under it.
            choices={(cliFixed ? clis.filter((one) => one.id === cli) : available).map((one) => ({ value: one.id, name: one.name, dot: one.local ? (one.local === 'up' ? 'on' : 'down') : authDot(auth, one.id) }))}
            onChoose={(value) => onCli(value as CliId)}
            data="cli"
            footer={{ label: t('auth.manage'), run: onAuth }}
          />
          {settings.map((option) => (
            <ChipSelect key={option.id} label={option.name} value={option.current} choices={option.choices} onChoose={(value) => onOption(option.id, value)} data={option.category ?? option.id} disabled={running} />
          ))}
          <div className="ml-auto flex items-center gap-1">
            {usage ? <ContextRing {...usage} /> : null}
            <button
              type="button"
              onClick={() => void keep()}
              disabled={!draft.trim() || keeping}
              title={t('chat.inbox.hint')}
              aria-label={t('chat.inbox')}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 text-zinc-600 transition-opacity hover:border-zinc-400 hover:text-darkDelegation disabled:opacity-25"
              data-chat-inbox
            >
              {keeping ? <Spinner size={13} /> : <Inbox size={14} />}
            </button>
            {running ? (
              <button type="button" onClick={onStop} title={t('chat.stop')} aria-label={t('chat.stop')} className="flex h-8 w-8 items-center justify-center rounded-full bg-darkDelegation text-white hover:bg-zinc-700" data-chat-stop>
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending || !cli}
                title={t('chat.send')}
                aria-label={t('chat.send')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-darkDelegation text-white transition-opacity hover:bg-zinc-700 disabled:opacity-25"
                data-chat-send
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

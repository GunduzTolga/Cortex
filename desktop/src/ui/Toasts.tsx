import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';

const ICONS = {
  info: <Info size={15} className="text-zinc-400" />,
  success: <CheckCircle2 size={15} className="text-emerald-500" />,
  error: <AlertTriangle size={15} className="text-red-500" />,
};

/** How many toasts are drawn at once; older ones are counted above them. */
const SHOWN = 4;

/** Krewgent's toasts: one field selected at a time, since this is on screen for the life of the window. */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismissToast = useApp((s) => s.dismissToast);
  const t = useT();
  if (!toasts.length) return null;
  // The newest few, the rest counted above them with a way to close them all: failures stay until closed, and
  // stacked, the oldest went past the top of the window, their close buttons out of reach (29 October). The notices
  // are laid from the bottom up, the newest first, under the count: taller than the window, they are cut at the oldest
  // and the count stays, where laid from the top the newest went below the window's foot (30 October). A long detail
  // scrolls inside its notice, so a few still fit. Their shadow is one the cut's margin holds: a wider one was cut in a
  // straight line round the stack.
  const shown = toasts.slice(-SHOWN);
  const behind = toasts.slice(0, -SHOWN);
  return (
    <div data-above-layers="toast" className="pointer-events-none fixed bottom-5 right-5 z-[85] flex max-h-[calc(100vh-2.5rem)] w-80 flex-col gap-2">
      {behind.length ? (
        <div className="pointer-events-auto flex shrink-0 items-center gap-2 self-end rounded-full border border-zinc-200/60 bg-white px-3 py-1 text-[11px] text-zinc-500 shadow" data-toast-more={behind.length}>
          {t('toasts.more', { count: behind.length })}
          <button type="button" onClick={() => behind.forEach((one) => dismissToast(one.id))} className="font-semibold text-darkDelegation hover:underline" data-toast-close-older>
            {t('toasts.closeOlder')}
          </button>
        </div>
      ) : null}
      <div className="-m-6 flex min-h-0 flex-col-reverse gap-2 overflow-hidden p-6">
        {[...shown].reverse().map((toast) => (
          <div key={toast.id} role="status" data-toast={toast.tone} className="animate-rise pointer-events-auto flex gap-2.5 rounded-2xl border border-zinc-200/60 bg-white px-4 py-3 shadow-lg">
            <span className="mt-0.5">{ICONS[toast.tone]}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-black uppercase tracking-widest text-darkDelegation">{toast.title}</div>
              {toast.detail ? <div className="mt-1 max-h-20 overflow-y-auto whitespace-pre-line break-words text-[11px] leading-relaxed text-zinc-500">{toast.detail}</div> : null}
            </div>
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  dismissToast(toast.id);
                  toast.action?.run();
                }}
                className="h-fit shrink-0 rounded-md border border-darkDelegation/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-darkDelegation hover:border-darkDelegation"
                data-toast-action
              >
                {toast.action.label}
              </button>
            ) : null}
            <button type="button" onClick={() => dismissToast(toast.id)} aria-label={t('common.close')} title={t('common.close')} className="h-fit rounded p-0.5 text-zinc-300 hover:text-darkDelegation" data-toast-close>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

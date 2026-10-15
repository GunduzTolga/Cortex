import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useRef } from 'react';
import { X } from 'lucide-react';
import { useDialogLayer } from './useEscapeLayer';

/**
 * The primitives the notes screen draws with, Krewgent's
 * (src/library/components/ui.tsx) cut to the four it uses: a button, a
 * dialog, the text field's class and a spinner. Paper and ink: the colours
 * are index.css's, which are tema/ananas's.
 */

type ButtonTone = 'primary' | 'ghost' | 'quiet' | 'danger';

const TONES: Record<ButtonTone, string> = {
  // Gold, an ink outline and a hard shadow it presses into.
  primary: 'kg-press border-[1.5px] border-darkDelegation bg-gold text-darkDelegation shadow-[3px_3px_0_0_#1b1712] hover:bg-signal',
  ghost: 'bg-white text-zinc-600 border border-darkDelegation/25 hover:border-darkDelegation hover:text-darkDelegation',
  quiet: 'bg-transparent text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation',
  danger: 'bg-transparent text-zinc-400 border border-transparent hover:bg-red-50 hover:text-red-500',
};

export function Button({ tone = 'ghost', className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[10px] font-black uppercase tracking-widest transition-all disabled:pointer-events-none disabled:opacity-40 ${TONES[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'max-w-2xl',
  dismissOnBackdrop = true,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** Off for a dialog that holds what somebody typed: a stray click on the page behind would throw it away. */
  dismissOnBackdrop?: boolean;
}) {
  // Escape, focus and the page behind come from the layer stack: a dialog over a dialog closes one at a time.
  const sheet = useRef<HTMLDivElement>(null);
  useDialogLayer(open, onClose, sheet);

  if (!open) return null;
  return (
    <div className="below-titlebar z-[80] flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" onMouseDown={dismissOnBackdrop ? onClose : undefined}>
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`kg-sheet animate-rise w-full ${width} overflow-hidden bg-white outline-none`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-14 items-center justify-between border-b border-zinc-100 px-6">
          <h2 className="text-xl leading-none text-darkDelegation">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-darkDelegation">
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-zinc-100 px-6 py-4">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** An on/off setting: a switch beside its name and what it does, the whole row the thing pressed. */
export function Switch({ checked, onChange, label, hint, ...data }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string } & { [key: `data-${string}`]: string | boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-zinc-50" {...data}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-darkDelegation">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11.5px] leading-relaxed text-zinc-500">{hint}</span> : null}
      </span>
      <span className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border-[1.5px] border-darkDelegation p-0.5 transition-colors ${checked ? 'bg-gold' : 'bg-zinc-100'}`} aria-hidden>
        <span className={`h-3.5 w-3.5 rounded-full bg-darkDelegation transition-transform ${checked ? 'translate-x-3.5' : ''}`} />
      </span>
    </button>
  );
}

export const inputClass =
  'w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-darkDelegation outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400';

/** `label` is what a screen reader says for it, where the spinner is the only sign that something is running. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-zinc-200 border-t-darkDelegation"
      style={{ width: size, height: size }}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

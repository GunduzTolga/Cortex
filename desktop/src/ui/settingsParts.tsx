import type { ReactNode } from 'react';
import { useT } from '../i18n/useT';
import { Button } from './ui';

/** A part of the settings window: its title, then its rows. */
export function Section({ title, children, data }: { title: string; children: ReactNode; data: string }) {
  return (
    <section className="border-b border-zinc-100 py-4 first:pt-0 last:border-b-0 last:pb-0" data-settings-section={data}>
      <h3 className="mb-2 px-3 text-[10px] font-black uppercase tracking-widest text-zinc-400">{title}</h3>
      {children}
    </section>
  );
}

/** A setting's name, and what changes it beside it. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-darkDelegation">{label}</span>
      {children}
    </div>
  );
}

/** Beside a field being typed in: kept with a press (or Enter, or leaving the field). */
export function SaveButton({ onSave, data }: { onSave: () => void; data?: string }) {
  const t = useT();
  return (
    <Button
      tone="ghost"
      className="h-8 shrink-0"
      // Kept on the press itself: the field keeps its focus, and leaving it does not keep the same thing twice.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSave}
      {...(data ? { [`data-${data}`]: true } : {})}
    >
      {t('settings.save')}
    </Button>
  );
}

/** Buttons side by side, the chosen one raised, as the language switch is. */
export function Segments<T extends string | number>({ options, chosen, onChoose, label, data }: { options: Array<{ id: T; label: React.ReactNode; title?: string }>; chosen: T | null; onChoose: (id: T) => void; label: string; data: string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-lg bg-zinc-100 p-0.5">
      {options.map((one) => {
        const current = one.id === chosen;
        return (
          <button
            key={String(one.id)}
            type="button"
            title={one.title}
            aria-pressed={current}
            onClick={() => onChoose(one.id)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-semibold transition-colors ${
              current ? 'bg-paper-2 text-darkDelegation shadow-[0_1px_2px_rgba(27,23,18,0.12)]' : 'text-zinc-500 hover:text-darkDelegation'
            }`}
            {...{ [`data-${data}`]: String(one.id) }}
          >
            {one.label}
          </button>
        );
      })}
    </div>
  );
}

import type { ReactNode } from 'react';

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

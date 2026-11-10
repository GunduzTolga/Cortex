/** A step's title on the first-run screen, and the sentence or two under it (Onboarding.tsx). */
export function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <>
      <h1 className="font-display text-3xl text-darkDelegation">{title}</h1>
      {children ? <div className="mt-3 space-y-2 text-[14px] leading-relaxed text-zinc-700">{children}</div> : null}
    </>
  );
}

/**
 * Work asked for often, done at most once in `every` milliseconds: at once when it has been that long since the last
 * time, else once more when that long has gone by, however many times it was asked meanwhile. So nothing asked for is
 * dropped, only gathered.
 *
 * For the first-run screen's "back at the window" (Onboarding.tsx): every time the window took the focus it asked each
 * tool for its sign-in again (a program started for each), read the PATH with PowerShell and asked the vault's engine
 * for voice typing - on every click back from the browser or a console (the review before 1.0.62, K9).
 */
export function atMostEvery(
  run: () => void,
  every: number,
  clock: () => number = Date.now,
  later: (work: () => void, ms: number) => unknown = (work, ms) => setTimeout(work, ms),
  never: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
): { ask(): void; stop(): void } {
  let last = -Infinity;
  let waiting: unknown = null;
  const go = () => {
    waiting = null;
    last = clock();
    run();
  };
  return {
    ask() {
      if (waiting !== null) return;
      const left = last + every - clock();
      if (left <= 0) go();
      else waiting = later(go, left);
    },
    stop() {
      if (waiting !== null) never(waiting);
      waiting = null;
    },
  };
}

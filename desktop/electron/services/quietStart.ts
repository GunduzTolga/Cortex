import { START_ARGUMENTS } from '../../shared/browserLink';

/**
 * Cortex started to stay out of sight: only its icon in the notification area, the window when asked for. So it
 * starts with Windows (services/tray.ts writes `--gizli` into the start-up entry), and so Cortex Browser starts it
 * when it has a question and finds Cortex closed (services/browserLink.ts).
 *
 * The rules, as plain functions the app follows (electron/main.ts):
 *
 * - A second launch brings the window of the one that runs to the front, unless it too asked to stay hidden: the
 *   browser starting a Cortex that is already running puts nothing on the screen.
 * - Started for the browser (`--tarayici`, beside `--gizli`: the contract's START_ARGUMENTS), at its start or as a
 *   second launch, Cortex opens the link and keeps it open from then (services/browserLink.ts). Without it nothing
 *   listens until the person opens the link in the settings.
 * - With `background` off the person has said Cortex is not to stay behind once its window is closed. A Cortex the
 *   browser started hidden is there for the browser alone: it stays while a browser is connected and leaves once the
 *   last has gone, the setting itself left as the person keeps it. Not one the person has opened since (its window's
 *   closing decides, as ever), nor one no browser ever reached (as before the link was there), nor in the middle of an
 *   answer or a setup.
 */

export const HIDDEN_FLAG: string = START_ARGUMENTS[0];
export const LINK_FLAG: string = START_ARGUMENTS[1];

/** Whether these arguments ask for a start out of sight. */
export const startedHidden = (argv: readonly string[]): boolean => argv.includes(HIDDEN_FLAG);

/** Whether these arguments ask for Cortex Browser's link to be opened: Cortex started, or started again, by the browser. */
export const asksForBrowserLink = (argv: readonly string[]): boolean => argv.includes(LINK_FLAG);

/** Whether a second launch with these arguments brings the window to the front. */
export const secondLaunchShows = (argv: readonly string[]): boolean => !startedHidden(argv);

export interface LeaveState {
  /** This run began out of sight. */
  startedHidden: boolean;
  /** The person's setting: Cortex stays in the notification area when its window is closed. */
  background: boolean;
  /** The window has been shown since the start. */
  seen: boolean;
  /** A browser has been connected since the start. */
  hadBrowser: boolean;
  /** The browsers connected now. */
  clients: number;
  /** A chat is answering, or a setup runs. */
  busy: boolean;
}

/** Whether a Cortex started hidden for the browser quits now that the browser is gone. */
export function leavesWithBrowser(state: LeaveState): boolean {
  return state.startedHidden && !state.background && !state.seen && state.hadBrowser && state.clients === 0 && !state.busy;
}

/**
 * The rule above kept as the app runs: told how many browsers are there each time that changes
 * (services/browserLink.ts, onBrowsersThere), it looks `after` milliseconds after the last has gone - a browser that
 * only starts again is back before then - and quits where the rule says so. An answer or a setup still going then is
 * not cut off: looked at again after as long. `state` is asked at the moment it looks; `later` and `cancel` are the
 * clock, a test's own in a test.
 */
export function leaveWatch(given: {
  state(): Omit<LeaveState, 'hadBrowser' | 'clients'>;
  quit(): void;
  after: number;
  later?: (run: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}): (clients: number) => void {
  const later = given.later ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel = given.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let hadBrowser = false;
  let waiting: unknown = null;
  const look = () => {
    waiting = null;
    const state = { ...given.state(), hadBrowser, clients: 0 };
    if (leavesWithBrowser(state)) given.quit();
    else if (leavesWithBrowser({ ...state, busy: false })) waiting = later(look, given.after);
  };
  return (clients) => {
    if (waiting !== null) cancel(waiting);
    waiting = null;
    if (clients > 0) hadBrowser = true;
    else if (hadBrowser) waiting = later(look, given.after);
  };
}

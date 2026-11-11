/**
 * Cortex started to stay out of sight: only its icon in the notification area, the window when asked for. So it
 * starts with Windows (services/tray.ts writes `--gizli` into the start-up entry), and so Cortex Browser starts it
 * when it has a question and finds Cortex closed (services/browserLink.ts).
 *
 * The rules, as plain functions the app follows (electron/main.ts):
 *
 * - A second launch brings the window of the one that runs to the front, unless it too asked to stay hidden: the
 *   browser starting a Cortex that is already running puts nothing on the screen.
 * - With `background` off the person has said Cortex is not to stay behind once its window is closed. A Cortex the
 *   browser started hidden is there for the browser alone: it stays while a browser is connected and leaves once the
 *   last has gone, the setting itself left as the person keeps it. Not one the person has opened since (its window's
 *   closing decides, as ever), nor one no browser ever reached (as before the link was there), nor in the middle of an
 *   answer or a setup.
 */

export const HIDDEN_FLAG = '--gizli';

/** Whether these arguments ask for a start out of sight. */
export const startedHidden = (argv: readonly string[]): boolean => argv.includes(HIDDEN_FLAG);

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

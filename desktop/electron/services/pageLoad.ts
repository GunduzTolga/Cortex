/**
 * What is done when the app's own page will not load (K7, 10 November): a file an antivirus held for a moment, a
 * half-written update, a dev server not up yet. Before, nothing listened: the window stayed a blank sheet of paper, or,
 * where its first frame never came, was never shown at all, with Cortex running and nothing to see.
 *
 * Loaded once more by itself; failing again, the person is told and asked (electron/main.ts). A window whose first
 * frame has not come after a while is shown anyway, so that whatever is said is said on something.
 */

/** Chromium's code for a load given up on purpose (another navigation took its place, the window closed): not a failure. */
const ERR_ABORTED = -3;

/** The first frame not there after this long, the window is shown as it is. */
export const SHOW_ANYWAY_MS = 8_000;

/**
 * The step after a load failed, given how many failed before it without one going through in between: nothing for a
 * frame inside the page or a load given up, one more try by itself, then the person's turn.
 */
export function failedLoadStep(failedBefore: number, errorCode: number, isMainFrame: boolean): 'ignore' | 'reload' | 'tell' {
  if (!isMainFrame || errorCode === ERR_ABORTED) return 'ignore';
  return failedBefore < 1 ? 'reload' : 'tell';
}

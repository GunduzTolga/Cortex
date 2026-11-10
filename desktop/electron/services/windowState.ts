import fs from 'node:fs';
import path from 'node:path';
import { type BrowserWindow, type Rectangle, app, screen } from 'electron';

/**
 * Where the window was left and how large, for the next opening (`window.json` beside the
 * settings). The first opening fills the screen: the brain's office, the graph and the notes want
 * the room, and at 1440x900 the office's log took the brain's (29 October). A place on a screen no
 * longer there - a monitor unplugged, a laptop off its dock - is not reused: the window would open
 * where nobody sees it.
 */

export interface WindowState {
  /** Its size and place when it is not maximized; null: the default, centred. */
  bounds: Rectangle | null;
  maximized: boolean;
}

/** The least the window is made, where the screen has the room; see `minSizeOn`. */
export const WINDOW_MIN = { width: 1040, height: 680 };
/** The size of the first opening before it is maximized, and of a window whose kept place was not reused. */
export const WINDOW_DEFAULT = { width: 1440, height: 900 };
const FIRST: WindowState = { bounds: null, maximized: true };
/** How much of the window must be on a screen for its place to be kept: its title bar, to drag it by. */
const SEEN = { width: 160, height: 60 };
const SAVE_AFTER = 400;

const file = () => path.join(app.getPath('userData'), 'window.json');

/** Whether enough of `bounds` lies on one of these work areas to be seen and dragged. */
export function onAScreen(bounds: Rectangle, areas: Rectangle[]): boolean {
  return areas.some((area) => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return width >= SEEN.width && height >= SEEN.height;
  });
}

/**
 * The least size on a screen with this work area: WINDOW_MIN, cut to what the screen has. A 1366x768 laptop at
 * 125-150% scaling has a work area of about 1093x574 to 911x472 (Electron counts in scaled pixels), under the 1040x680
 * the window was held to: it could not be made to fit, and part of it lay off the screen (G8, 10 November).
 */
export function minSizeOn(area: Pick<Rectangle, 'width' | 'height'> | null | undefined): { width: number; height: number } {
  if (!area || !(area.width > 0) || !(area.height > 0)) return { ...WINDOW_MIN };
  return { width: Math.min(WINDOW_MIN.width, Math.floor(area.width)), height: Math.min(WINDOW_MIN.height, Math.floor(area.height)) };
}

/** The state as written, read back: anything that is not one is the first opening's. */
export function windowStateOf(kept: unknown, areas: Rectangle[]): WindowState {
  if (!kept || typeof kept !== 'object') return FIRST;
  const { bounds, maximized } = kept as { bounds?: Partial<Rectangle> | null; maximized?: unknown };
  const sized =
    bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every((one) => typeof one === 'number' && Number.isFinite(one))
      ? { x: Math.round(bounds.x!), y: Math.round(bounds.y!), width: Math.max(WINDOW_MIN.width, Math.round(bounds.width!)), height: Math.max(WINDOW_MIN.height, Math.round(bounds.height!)) }
      : null;
  // The screen it lies on, and the least size there: on a small screen a size kept under WINDOW_MIN is not raised past the screen.
  const area = sized ? areas.find((one) => onAScreen(sized, [one])) : undefined;
  if (!sized || !area) return { bounds: null, maximized: maximized !== false };
  const least = minSizeOn(area);
  return {
    bounds: { x: sized.x, y: sized.y, width: Math.max(least.width, Math.round(bounds!.width!)), height: Math.max(least.height, Math.round(bounds!.height!)) },
    maximized: maximized !== false,
  };
}

const workAreas = (): Rectangle[] => screen.getAllDisplays().map((display) => display.workArea);

/**
 * The least size, and the size to open at, for a window about to be made: on the screen its kept place lies on, or
 * the main one. Neither is larger than that screen's work area.
 */
export function windowSizesFor(bounds: Rectangle | null): { min: { width: number; height: number }; open: { width: number; height: number } } {
  let area: Rectangle | null = null;
  try {
    area = (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
  } catch {
    /* no screen to ask (a test, a session without one): the defaults */
  }
  return { min: minSizeOn(area), open: openSizeOn(area) };
}

/** The size a window opens at where none was kept: the default, cut to the screen. */
export function openSizeOn(area: Pick<Rectangle, 'width' | 'height'> | null | undefined): { width: number; height: number } {
  if (!area || !(area.width > 0) || !(area.height > 0)) return { ...WINDOW_DEFAULT };
  return { width: Math.min(WINDOW_DEFAULT.width, Math.floor(area.width)), height: Math.min(WINDOW_DEFAULT.height, Math.floor(area.height)) };
}

export function readWindowState(): WindowState {
  try {
    return windowStateOf(JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')), workAreas());
  } catch {
    return FIRST;
  }
}

/** The window's size, place and maximized state written as they change, and as it closes. */
export function keepWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (window.isDestroyed() || window.isMinimized()) return;
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    try {
      fs.writeFileSync(file(), JSON.stringify(state));
    } catch {
      /* the next opening is the default's */
    }
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_AFTER);
  };
  window.on('resize', soon);
  window.on('move', soon);
  window.on('maximize', save);
  window.on('unmaximize', save);
  window.on('close', save);
}

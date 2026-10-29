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

export const WINDOW_MIN = { width: 1040, height: 680 };
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

/** The state as written, read back: anything that is not one is the first opening's. */
export function windowStateOf(kept: unknown, areas: Rectangle[]): WindowState {
  if (!kept || typeof kept !== 'object') return FIRST;
  const { bounds, maximized } = kept as { bounds?: Partial<Rectangle> | null; maximized?: unknown };
  const sized =
    bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every((one) => typeof one === 'number' && Number.isFinite(one))
      ? { x: Math.round(bounds.x!), y: Math.round(bounds.y!), width: Math.max(WINDOW_MIN.width, Math.round(bounds.width!)), height: Math.max(WINDOW_MIN.height, Math.round(bounds.height!)) }
      : null;
  return { bounds: sized && onAScreen(sized, areas) ? sized : null, maximized: maximized !== false };
}

const workAreas = (): Rectangle[] => screen.getAllDisplays().map((display) => display.workArea);

export function readWindowState(): WindowState {
  try {
    return windowStateOf(JSON.parse(fs.readFileSync(file(), 'utf8')), workAreas());
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

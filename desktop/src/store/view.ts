import { create } from 'zustand';

/**
 * Which of the vault's views is in front: Pyn, where the person talks to their
 * AI, first; the notes; the graph. Each is drawn from the first time it is
 * shown and kept after (App.tsx), so the graph is not laid out again at every
 * switch. A note opened from the chat brings the notes to the front.
 *
 * Which one is in front is this window's storage, a convenience. The key is
 * new with Pyn: everybody opens on Pyn once, whatever was in front before.
 */

export type View = 'pyn' | 'notes' | 'graph';
const KEY = 'cortex.view.v2';
const VIEWS: readonly View[] = ['pyn', 'notes', 'graph'];

function saved(): View {
  try {
    const value = localStorage.getItem(KEY) as View | null;
    return value && VIEWS.includes(value) ? value : 'pyn';
  } catch {
    return 'pyn';
  }
}

interface ViewState {
  view: View;
  /** The views drawn so far, kept drawn. */
  shown: ReadonlySet<View>;
  setView(view: View): void;
}

export const useView = create<ViewState>((set) => {
  const first = saved();
  return {
    view: first,
    shown: new Set([first]),
    setView(view) {
      set((state) => ({ view, shown: state.shown.has(view) ? state.shown : new Set([...state.shown, view]) }));
      try {
        localStorage.setItem(KEY, view);
      } catch {
        /* for this run */
      }
    },
  };
});

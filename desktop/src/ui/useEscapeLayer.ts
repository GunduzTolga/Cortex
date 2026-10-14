import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { WAITING_ON_THE_PERSON, escapeLayers, focusFellOff, wrapTarget } from './escapeLayers';
import type { Layer, LayerNode } from './escapeLayers';

/**
 * Escape for a layer that is up: only the topmost one reacts.
 *
 * `active` is whether the layer is on screen. It goes on the stack when that
 * becomes true, leaves when it becomes false or the component goes, and keeps
 * its place through any number of re-renders with a new `onEscape`: the callback
 * is read at the moment of the key press, so an inline arrow costs nothing.
 *
 * With a `root` the layer is also modal - see `useDialogLayer`.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void, root?: RefObject<HTMLElement | null>): Layer {
  const layer = useRef<Layer>({
    onEscape,
    // An element is a `LayerNode` in everything the stack asks of it; `children`
    // is typed `Element` in the DOM's own typings and `inert` only on HTMLElement.
    modalRoot: root ? () => root.current as unknown as LayerNode | null : undefined,
  }).current;

  // After every render, so the next key press runs this render's callback. Not
  // written while rendering: a render that is thrown away would have changed
  // what Escape does.
  useEffect(() => {
    layer.onEscape = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    return escapeLayers.enter(layer);
  }, [active, layer]);

  return layer;
}

const TABBABLE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `root` right now: not disabled, not hidden, not under an inert ancestor. */
function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) =>
      !(element as HTMLButtonElement).disabled &&
      element.tabIndex >= 0 &&
      !element.closest('[inert]') &&
      element.getClientRects().length > 0,
  );
}

/**
 * A dialog: Escape for the top layer, and the three things a dialog owes the
 * keyboard.
 *
 * - Focus goes in when it opens: to the element marked `data-autofocus`, else
 *   to the dialog itself, which has to be `tabIndex={-1}`. Focus that is already
 *   inside is left where it is - something with `autoFocus` has chosen.
 * - Tab does not leave it. The page behind is `inert` while this is the top
 *   layer (see `inertOutside`), so the browser cannot walk out; this wraps the
 *   two ends instead of leaving them to the browser's own idea of "the end of
 *   the page". It does not while something above every layer is on screen: a
 *   tool waiting for approval has to be reachable, and the wrap would stand
 *   between the keyboard and it (`WAITING_ON_THE_PERSON`; a toast does not count).
 * - Focus goes back when it closes, to what had it when it opened, and only if
 *   focus fell off the page when this went (`focusFellOff`).
 *
 * The page is made inert by the stack and not here, because what is inert has to
 * follow whichever layer is the top one, and a layer closing is when the one
 * under it must come back.
 */
export function useDialogLayer(active: boolean, onEscape: () => void, root: RefObject<HTMLElement | null>): void {
  const layer = useEscapeLayer(active, onEscape, root);
  const opener = useRef<HTMLElement | null>(null);

  // Before the stack makes the page inert: an inert opener is blurred, and the
  // focus would be gone before there was anything to remember. A layout effect
  // runs before the passive one that enters the stack.
  useLayoutEffect(() => {
    if (!active) return;
    const had = document.activeElement;
    // Something inside the dialog that took focus as it mounted is not the opener.
    opener.current = had instanceof HTMLElement && !root.current?.contains(had) ? had : null;
  }, [active, root]);

  useEffect(() => {
    const element = root.current;
    if (!active || !element) return;

    if (!element.contains(document.activeElement)) {
      const target = element.querySelector<HTMLElement>('[data-autofocus]') ?? element;
      target.focus({ preventScroll: true });
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || escapeLayers.top() !== layer) return;
      if (document.querySelector(WAITING_ON_THE_PERSON)) return;
      const tabbables = tabbablesIn(element);
      if (tabbables.length === 0) {
        // Nothing to move to, and the browser would move on to something behind.
        event.preventDefault();
        return;
      }
      const to = wrapTarget(tabbables, document.activeElement, event.shiftKey);
      if (to) {
        event.preventDefault();
        to.focus();
      }
    };
    element.addEventListener('keydown', onKey);

    const from = opener.current;
    return () => {
      element.removeEventListener('keydown', onKey);
      // The layer leaves the stack in its own effect's cleanup, which has run
      // first (it is declared first), so what was inert is reachable again
      // here - a focus() on an inert opener would do nothing.
      if (focusFellOff(document.activeElement, document.body) && from?.isConnected) from.focus();
    };
  }, [active, root, layer]);
}

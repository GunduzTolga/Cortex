/**
 * Which layer Escape belongs to, and what the layers underneath it are told.
 * Krewgent's (src/shell/escapeLayers.ts), as it was: the notes screen's
 * dialogs, menus, the quick switcher and the template picker each stand on it.
 *
 * A window listener per layer is not aware of any other, and with two layers
 * up one key press reached both: a dialog opened over another closed itself
 * and the one under it. So there is one listener and a stack. A layer that
 * opens goes on top; Escape goes to the top layer and no further; a layer
 * that closes, or whose component is gone, leaves wherever it is. The focus
 * and background rules are the same mechanism and live here for the same
 * reason: a layer's keyboard is decided by what is above it.
 *
 * Plain TypeScript with no React and no `window` at import time, so a test can
 * drive it with stand-ins. `useEscapeLayer.ts` ties it to components.
 */

/** What the stack needs of an element - the DOM's own shape, so the real one fits. */
export interface LayerNode {
  parentElement: LayerNode | null;
  children: ArrayLike<LayerNode>;
  inert: boolean;
  hasAttribute(name: string): boolean;
}

export interface Layer {
  /**
   * What Escape does here. Mutable on purpose: a component re-renders with a
   * new callback every time, and the layer is the same object throughout, so a
   * new callback is an assignment and the layer keeps its place in the stack.
   * Leaving and re-entering for it would put an older layer back on top of a
   * newer one.
   */
  onEscape: () => void;
  /**
   * The element of a modal layer. Present means everything else on the page is
   * made inert while this layer is the top one; absent means the layer is only
   * a keyboard claim (the office's fullscreen is the page itself, and there is
   * nothing to hold the rest of it back from).
   */
  modalRoot?: () => LayerNode | null;
}

export interface KeyTarget {
  addEventListener(type: 'keydown', listener: (event: { key: string }) => void): void;
  removeEventListener(type: 'keydown', listener: (event: { key: string }) => void): void;
}

/**
 * Carried by whatever is above every layer, and so stays reachable while a modal
 * layer is open. Two kinds, said by the value:
 *
 * - `waiting`: a dialog that is waiting on the person - a tool to approve, a
 *   finished output, a model that failed. Not a layer and no part of Escape (an
 *   approval is not something Escape should answer for the person), but it has
 *   to be reachable by Tab, or a tool waiting for a yes could not be given one
 *   without a mouse. A dialog layer's Tab trap stands aside while one is up.
 * - `toast`: seen, announced and clickable, and not worth a trap standing
 *   aside for: if it did, every dialog would have a way out in its toast. Its
 *   dismiss button is not reached by keyboard while a modal is up.
 */
export const ABOVE_LAYERS = 'data-above-layers';
export const WAITING_ON_THE_PERSON = `[${ABOVE_LAYERS}="waiting"]`;

export function createLayerStack(target: KeyTarget) {
  const layers: Layer[] = [];
  const watchers = new Set<() => void>();
  let listening = false;

  // One function for the life of the stack, so that removing it removes the one
  // that was added.
  const onKey = (event: { key: string }) => {
    if (event.key !== 'Escape') return;
    layers[layers.length - 1]?.onEscape();
  };

  const changed = () => {
    for (const watcher of [...watchers]) watcher();
  };

  const leave = (layer: Layer) => {
    const at = layers.indexOf(layer);
    if (at < 0) return;
    layers.splice(at, 1);
    // The window has one listener while anything is up and none while nothing is.
    if (layers.length === 0 && listening) {
      target.removeEventListener('keydown', onKey);
      listening = false;
    }
    changed();
  };

  return {
    /**
     * Put a layer on top. Entering a layer that is already in the stack moves it
     * to the top rather than adding it twice: a layer that opened, was covered,
     * and opens again is the newest thing on screen. Returns the way out.
     */
    enter(layer: Layer): () => void {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      // A flag and not `layers.length === 0`: moving the only layer to the top
      // empties the list for an instant, and that is not a reason to add again.
      if (!listening) {
        target.addEventListener('keydown', onKey);
        listening = true;
      }
      layers.push(layer);
      changed();
      return () => leave(layer);
    },
    leave,
    top: (): Layer | undefined => layers[layers.length - 1],
    size: () => layers.length,
    /** Called after every change to the stack. Returns how to stop. */
    watch(watcher: () => void): () => void {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
  };
}

/**
 * Make everything outside `root` unreachable by Tab and by a screen reader,
 * except what is marked as above every layer. Returns the way to put it back,
 * which touches only what this call changed.
 *
 * It walks up from the layer and marks each ancestor's other children, rather
 * than marking one container for the app and drawing the layer outside it. The
 * layers are not drawn in one place - the picker is inside the coding side,
 * Settings is beside both sides, a dialog over Settings is inside Settings - and
 * moving them into a portal would have meant moving every one of them and the
 * always-mounted sides along with it, to buy what a walk of a dozen nodes does
 * where they already are. Anything already inert stays as it was and is not
 * undone: the two sides mark their own columns that way for reasons of their own.
 */
export function inertOutside(root: LayerNode, exempt: (node: LayerNode) => boolean): () => void {
  const marked: LayerNode[] = [];
  // Stops below the document element: `body`'s sibling is `head`, which nothing
  // can focus.
  for (let node: LayerNode = root; node.parentElement?.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.inert || exempt(sibling)) continue;
      sibling.inert = true;
      marked.push(sibling);
    }
  }
  return () => {
    for (const node of marked) node.inert = false;
  };
}

/**
 * Keeps the page's inertness equal to what the top layer asks for, and
 * recomputes it whenever the stack changes - which is what lets the picker come
 * back to life the moment the Drive dialog over it closes.
 */
export function holdBackground(stack: ReturnType<typeof createLayerStack>) {
  let release: (() => void) | null = null;
  return stack.watch(() => {
    release?.();
    release = null;
    const root = stack.top()?.modalRoot?.();
    if (root) release = inertOutside(root, (node) => node.hasAttribute(ABOVE_LAYERS));
  });
}

/**
 * Whether closing a layer should put focus back on what opened it.
 *
 * Only when focus has nowhere else: the layer's own element was removed with
 * focus inside it, and the page is left with nothing focused. Anything else is
 * a decision somebody made - a higher layer took the focus, or the person moved
 * on to the header - and pulling it back to the opener undoes that. This used
 * to be unconditional in Settings.
 */
export function focusFellOff(active: unknown, body: unknown): boolean {
  return !active || active === body;
}

/**
 * Where Tab should be sent instead of where it would go, or null to let it go.
 *
 * Only at the two ends: Tab on the last element goes back to the first and
 * Shift+Tab on the first goes to the last. In between the browser knows best,
 * and so it does for focus that is on the layer itself or on something that is
 * not tabbable (the scroller is `tabindex=-1`): sending that to the first
 * element would skip everything between it and the next one.
 */
export function wrapTarget<T>(tabbables: readonly T[], active: unknown, shift: boolean): T | null {
  if (tabbables.length === 0) return null;
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (shift) return active === first ? last : null;
  return active === last ? first : null;
}

/*
  The window's one stack. The target forwards to `window` when it is used and
  not before, so that importing this from node - the tests do - touches nothing.
*/
export const escapeLayers = createLayerStack({
  addEventListener: (type, listener) => window.addEventListener(type, listener as unknown as EventListener),
  removeEventListener: (type, listener) => window.removeEventListener(type, listener as unknown as EventListener),
});

// Installed once, at import. The stack is empty until a layer enters, and an
// empty stack asks for no inertness.
holdBackground(escapeLayers);

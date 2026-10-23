/**
 * Whether an Enter answers the card Pyn waits on with "once" (Composer.tsx,
 * PermissionCard).
 *
 * The card used to hear every Enter in the window and stood aside only for a
 * textarea or an input. The notes' editor is neither (CodeMirror writes into a
 * contenteditable), the chat stays drawn, hidden, behind the other views
 * (App.tsx), and an Enter on a focused button was taken from the button. So a
 * newline typed in a note approved a step the person never saw, and "Reddet"
 * pressed from the keyboard allowed it (desktop-ui-2).
 *
 * Enter answers now only where it means nothing else and the card is seen: the
 * chat in front, no dialog or menu over it, a plain Enter, pressed on the page
 * itself (nothing has the focus) or on the card - never on a control or in
 * anything written in, which keep their own Enter. What is allowed is listed,
 * not what is not: an editor or a dialog added next year is not on the list.
 *
 * Plain TypeScript with the event and the elements passed in, so a test can
 * drive it with stand-ins.
 */

/** What is read of a key press: the DOM's `KeyboardEvent` fits. */
export interface EnterPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

/** What is read of the element pressed on: the DOM's `HTMLElement` fits. */
interface Pressed {
  closest(selector: string): unknown;
  isContentEditable?: boolean;
}

/** Where the press was: whether the chat is in front, how many layers are over the page (src/ui/escapeLayers.ts), the card, the page. */
export interface EnterPlace {
  visible: boolean;
  layers: number;
  card: { contains(node: never): boolean } | null;
  body: unknown;
}

/** Everything on the card or near it that answers Enter itself: a button, a link, a field, a written-in element. */
const CONTROLS =
  'button, a, input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="tab"], [role="textbox"]';

export function enterAnswers(press: EnterPress, place: EnterPlace): boolean {
  if (press.key !== 'Enter' || press.shiftKey || press.ctrlKey || press.altKey || press.metaKey) return false;
  // Held down, the key would answer the next card too; while an input method composes a word, Enter ends the word.
  if (press.repeat || press.isComposing || press.defaultPrevented) return false;
  if (!place.visible || place.layers > 0) return false;
  const target = press.target;
  if (target === place.body) return true;
  if (!target || !place.card?.contains(target as never)) return false;
  const pressed = target as Pressed;
  return !pressed.isContentEditable && !pressed.closest(CONTROLS);
}

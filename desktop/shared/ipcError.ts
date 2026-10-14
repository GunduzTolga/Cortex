/**
 * The sentence a handler threw, without the wrapping Electron puts round it.
 *
 * A rejected `ipcRenderer.invoke` does not carry what its handler threw. It
 * carries `Error invoking remote method 'notes:save': Error: <message>` - the
 * channel, and the name of the class - and a screen that shows `err.message`
 * would show all of it: somebody whose note was refused would read the name of
 * an IPC channel before they read why.
 *
 * This takes off exactly that and nothing else: the envelope at the very start,
 * then one class prefix (`Error: `, `TypeError: `, ...). A message that does not
 * begin with the envelope comes back as it is. A message that would be empty
 * without its envelope keeps it, because a channel name is a better thing to
 * show than a blank.
 *
 * Here rather than in the preload because the preload cannot be imported by a
 * test, and this is the part of it that can be wrong.
 */
const ENVELOPE = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

export function plainIpcMessage(message: string): string {
  const plain = message.replace(ENVELOPE, '');
  return plain.trim() === '' ? message : plain;
}

/**
 * What a rejected call says, for a toast or a line of detail.
 *
 * Not `String(err)`: an `Error` stringifies as `Error: <message>`, which puts the
 * class name back in front of the sentence the preload took it off. Whatever is
 * not an `Error` is said the way `String` says it.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The text of whatever `ipcRenderer.invoke` rejected with, for `plainIpcMessage`
 * to take the envelope off: by having a string `message`, not by being an
 * `Error`, because an error that crossed a context boundary is not an instance
 * of this realm's `Error`. Only for the preload.
 */
export function rejectionText(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(err);
}

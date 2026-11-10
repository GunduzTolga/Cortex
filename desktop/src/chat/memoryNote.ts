import type { CliId } from '@shared/chat';
import type { SetupStatus } from '@shared/setup';

/**
 * Whether the chat answers without the vault's memory, and the person is not told (S8): a vault is chosen, and its
 * engine is not installed or no Python runs it - the hooks that give a tool the vault's memory are then not there, or
 * do nothing. Read from the setup's status the window already holds (store/setup.ts), asked at the app's start and
 * after every setup job: nothing is asked again for it. Not said before the status is known, nor of Pyn on a server,
 * whose memory is the server's.
 */
export function memoryOff(status: (Pick<SetupStatus, 'python' | 'vault' | 'engine'> & Partial<Pick<SetupStatus, 'job'>>) | null, cli: CliId | null): boolean {
  if (!status || !status.vault || cli === 'hermes') return false;
  // Being set up now (the app brings the engine up to date by itself): "finish the setup" would send the person to do what is being done.
  if (status.job) return false;
  return !status.python || status.engine.installed === null;
}

const CLOSED = 'cortex.chat.memoryOffClosed';

/** Closed by the person: not said again while the window is open. A storage that will not answer says it again, no worse. */
export function memoryNoteClosed(): boolean {
  try {
    return sessionStorage.getItem(CLOSED) === '1';
  } catch {
    return false;
  }
}

export function closeMemoryNote(): void {
  try {
    sessionStorage.setItem(CLOSED, '1');
  } catch {
    /* said again at the next drawing */
  }
}

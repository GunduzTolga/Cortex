import type { IndexedNote, SearchHit } from '../core/vaultNotes';

/**
 * What the notes screen is told of the vault
 * (electron/services/vaultNotes.ts). Paths are inside the vault, with `/`
 * between the parts; the vault's own place on disk is never sent.
 */
export interface VaultIndex {
  /** The vault by its folder's name; null before one is chosen. */
  vault: { name: string } | null;
  /** Why the vault could not be read now: gone, or reached through a link. */
  missing?: string;
  folders: string[];
  /** Files that are not notes: attachments, images, PDFs. */
  files: Array<{ path: string; size: number; modified: number }>;
  notes: IndexedNote[];
  /** More than the screen lists was there: the first part is shown. */
  truncated: boolean;
  /**
   * Why nothing in the vault is written from here, or null. Krewgent set it for
   * Hermes's vault; this app has no such vault and leaves it null, and the
   * screen still honours it, so a reason added later needs no second path.
   */
  readOnly: string | null;
}

export interface NoteRead {
  path: string;
  /** Null for a note larger than the screen opens. */
  text: string | null;
  /** The bytes read, which a save is held to. */
  hash: string | null;
  modified: number;
  tooLarge: boolean;
  /** Shown, not saved: `encoding` for bytes that are not UTF-8. */
  readOnly: 'encoding' | null;
}

/** Saved; or not, because the note on disk is not the one that was read, which is handed back. */
export type NoteSaved =
  | { saved: true; hash: string; modified: number }
  | { saved: false; current: { text: string; hash: string; modified: number } };

export interface NoteBacklinks {
  linked: Array<{ from: string; lines: Array<{ line: number; text: string }> }>;
  /** Notes that name it, by title or alias, without a link. */
  unlinked: Array<{ from: string; lines: Array<{ line: number; text: string }> }>;
}

export type { IndexedNote, SearchHit };

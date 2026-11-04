import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { ChatAttachment } from '../../shared/chat';
import { ChatRefusal } from './chatKit';

/**
 * What is added to a chat message (2 November notes: "chate resim ve dosya ekleme"): kept on this computer, in the
 * app's data beside the chats, never in the vault (the four-surface roadmap: attachments stay on the device). The window
 * hands the file's bytes; it is copied here once, so the chat can name it again after the original moves.
 */

/** The largest file taken: what a person attaches to a message, not a folder's worth. */
export const ATTACH_MAX = 20 * 1024 * 1024;
/** Images a model is shown as pictures (Claude's and Codex's inputs); anything else goes as a file it may read. */
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** The largest picture sent inline: the Messages API's limit for one image. A larger one goes as a file. */
export const IMAGE_INLINE_MAX = 5 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HeldAttachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  /** Where it is kept on this computer. */
  path: string;
  /** For an image, its type; null for a file. */
  mime: string | null;
  size: number;
}

export const attachmentsFolder = () => path.join(app.getPath('userData'), 'chats', 'ekler');

/** A name as it may be kept on disk: the person's own, without what Windows forbids or a path in it. */
export function safeName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'ek';
}

const kindOf = (name: string): { kind: 'image' | 'file'; mime: string | null } => {
  const mime = IMAGES[path.extname(name).toLowerCase()] ?? null;
  return mime ? { kind: 'image', mime } : { kind: 'file', mime: null };
};

/** The window's file kept: its bytes (base64), under its own name. */
export function keepAttachment(name: unknown, data: unknown): ChatAttachment {
  if (typeof name !== 'string' || typeof data !== 'string') throw new ChatRefusal('That file could not be read.');
  // Base64 is four characters for three bytes: refused before it is decoded, not after.
  if (data.length > Math.ceil(ATTACH_MAX / 3) * 4 + 4) throw new ChatRefusal('That file is too large (at most 20 MB).');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new ChatRefusal('That file is empty.');
  if (bytes.length > ATTACH_MAX) throw new ChatRefusal('That file is too large (at most 20 MB).');
  const id = randomUUID();
  const kept = safeName(name);
  fs.mkdirSync(attachmentsFolder(), { recursive: true });
  fs.writeFileSync(path.join(attachmentsFolder(), `${id}__${kept}`), bytes);
  return { id, name: kept, kind: kindOf(kept).kind };
}

/** The attachments a message names, by their ids, as kept here; one gone since (or never made here) is refused by name. */
export function heldAttachments(ids: unknown): HeldAttachment[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 10) throw new ChatRefusal('At most ten files go with one message.');
  let names: string[];
  try {
    names = fs.readdirSync(attachmentsFolder());
  } catch {
    names = [];
  }
  return ids.map((id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new ChatRefusal('That attachment is not one of the chat’s.');
    const file = names.find((one) => one.startsWith(`${id}__`));
    if (!file) throw new ChatRefusal('An attached file was not found; add it again.');
    const full = path.join(attachmentsFolder(), file);
    const name = file.slice(id.length + 2);
    return { id, name, ...kindOf(name), path: full, size: fs.statSync(full).size };
  });
}

/**
 * The words that tell a model about files it is not shown as pictures: their names and where they are, to read with its
 * own tools. Said in the message's language-neutral form, after what the person wrote.
 */
export function fileLines(files: readonly HeldAttachment[]): string {
  if (!files.length) return '';
  return `\n\n[Attached files - read them from these paths]\n${files.map((one) => `- ${one.name}: ${one.path}`).join('\n')}`;
}

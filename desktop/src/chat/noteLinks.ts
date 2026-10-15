import { useNotes } from '../notes/notesStore';
import { useView } from '../store/view';
import { useChat } from './chatStore';

/**
 * A note opened from the chat: beside it, in the panel, so the conversation
 * stays in view; with Ctrl (Cmd), in the notes, where it can be written.
 */
export function openNote(path: string, inNotes: boolean): void {
  if (inNotes) {
    useNotes.getState().open(path);
    useView.getState().setView('notes');
  } else {
    useChat.getState().showSide(path);
  }
}

/**
 * A click on a link in an answer or in the panel's note, taken before the
 * link's own: a note it finds (`data-note-path`, src/notes/NoteMarkdown.tsx)
 * opens by `openNote`; one not written yet is not made from the chat.
 */
export function captureNoteLinks(event: React.MouseEvent): void {
  const link = (event.target as Element).closest('.kg-wikilink');
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  const path = link.getAttribute('data-note-path');
  if (path) openNote(path, event.ctrlKey || event.metaKey);
}

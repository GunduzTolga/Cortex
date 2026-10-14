import { useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { VaultIndex } from '@shared/notes';
import { folderOf, isTemplatesFolder, noteTitle, pathKey } from '../../core/vaultNotes';
import { foldForMatch } from '../../core/titles';
import { useT } from '../i18n/useT';
import { useDialogLayer } from '../ui/useEscapeLayer';

/**
 * The vault's templates: the notes in a folder named for them - Cortex's
 * `📋 Templates`, Obsidian's `Templates` - put into a note as Obsidian's
 * Templates plugin puts them (`insertTemplate`, `fillTemplate` in
 * core/vaultNotes.ts). Cortex's own `Note.md` is what a new note starts as,
 * which is how Cortex's CLAUDE.md says a note is made.
 */

/** Every note under a templates folder, by name. */
export function templatesIn(index: VaultIndex | null): string[] {
  return (index?.notes ?? [])
    .map((note) => note.path)
    .filter((path) => {
      const parts = folderOf(path).split('/');
      return parts.some((_part, at) => isTemplatesFolder(parts.slice(0, at + 1).join('/')));
    })
    .sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)));
}

/** Cortex's template for a new note, `Note.md` in a templates folder, or null where the vault has none. */
export function noteTemplateOf(index: VaultIndex | null): string | null {
  return templatesIn(index).find((path) => pathKey(noteTitle(path)) === 'note') ?? null;
}

/** A template's text, or null when it cannot be read. */
export async function templateText(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    return (await window.cortex.notes.read(path)).text;
  } catch {
    return null;
  }
}

export function TemplatePicker({ index, open, onClose, onPick }: { index: VaultIndex | null; open: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const t = useT();
  const sheet = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  useDialogLayer(open, onClose, sheet);
  const all = useMemo(() => templatesIn(index), [index]);
  const shown = all.filter((path) => foldForMatch(noteTitle(path)).includes(foldForMatch(query.trim())));
  if (!open) return null;
  return (
    <div className="below-titlebar z-[85] flex items-start justify-center bg-black/25 px-6 pt-[14vh]" onMouseDown={onClose}>
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.template.title')}
        tabIndex={-1}
        className="kg-sheet animate-rise w-full max-w-md overflow-hidden bg-white outline-none"
        onMouseDown={(event) => event.stopPropagation()}
        data-notes-templates
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) onPick(shown[0]);
          }}
          placeholder={t('notes.template.placeholder')}
          className="h-11 w-full border-b border-zinc-100 bg-transparent px-4 text-[14px] text-darkDelegation outline-none placeholder:text-zinc-400"
        />
        <ul className="max-h-[45vh] overflow-y-auto py-1.5">
          {shown.map((path) => (
            <li key={path}>
              <button type="button" onClick={() => onPick(path)} data-template={path} className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-[13.5px] text-zinc-600 hover:bg-zinc-50">
                <FileText size={14} className="shrink-0 text-zinc-400" />
                {noteTitle(path)}
              </button>
            </li>
          ))}
          {!all.length ? <li className="px-4 py-3 text-[13px] leading-relaxed text-zinc-400">{t('notes.template.none')}</li> : null}
        </ul>
      </div>
    </div>
  );
}

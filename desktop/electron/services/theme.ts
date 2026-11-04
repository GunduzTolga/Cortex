import { nativeTheme } from 'electron';
import type { ThemeChoice } from '../../shared/api';

/**
 * Light, dark, or the system's (Settings › General; 2 November notes: "koyu mod yok"). Electron's own switch is the one
 * place it is set: `themeSource` turns the page's `prefers-color-scheme` (the dark palette in src/index.css follows it)
 * and the window's frame together, so the page needs no word of its own and a frame never stays light on a dark page.
 */
export function applyTheme(choice: ThemeChoice): void {
  // The tests' stand-in Electron has no nativeTheme.
  if (nativeTheme) nativeTheme.themeSource = choice;
}

import { useCallback } from 'react';
import { useApp } from '../store/app';
import { DEFAULT_LANGUAGE, translate, type Key, type Language } from './index';
import { appLanguage } from '../../shared/language';

/**
 * The last language this window drew in, remembered for the next start: the
 * settings in the main process are the answer, and this only decides what to
 * draw for the one round trip before they arrive, so a window does not draw in
 * Turkish and then switch to the chosen English (Krewgent's `useT`).
 */
const REMEMBERED = 'cortex.language';

function lastKnown(): Language | null {
  try {
    const saved = localStorage.getItem(REMEMBERED);
    return saved === 'en' || saved === 'tr' ? saved : null;
  } catch {
    return null;
  }
}

function remember(language: Language): void {
  try {
    if (localStorage.getItem(REMEMBERED) !== language) localStorage.setItem(REMEMBERED, language);
  } catch {
    /* storage switched off; the window still works, it just guesses again */
  }
}

/**
 * Tell the document which language it is in, so CSS cases Turkish properly:
 * `text-transform: uppercase` sends `i` to `İ` only under `lang="tr"`, and this
 * design leans on uppercase labels.
 */
function reflect(language: Language): void {
  if (typeof document === 'undefined') return;
  if (document.documentElement.lang !== language) document.documentElement.lang = language;
}

/** The language the window is drawing in: the setting once read, the last one drawn before that, Turkish on a first run. */
export function useLanguage(): Language {
  const ready = useApp((state) => state.ready);
  const chosen = useApp((state) => state.settings.language);
  const language = ready ? appLanguage(chosen) : (lastKnown() ?? DEFAULT_LANGUAGE);
  if (ready) remember(language);
  reflect(language);
  return language;
}

/** `t('some.key')`, and `t('some.key', { name })` where a sentence has a hole. */
export function useT(): (key: Key, values?: Record<string, string | number>) => string {
  const language = useLanguage();
  return useCallback((key, values) => translate(language, key, values), [language]);
}

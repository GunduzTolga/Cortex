import { en } from './en';
import { tr } from './tr';
import { DEFAULT_APP_LANGUAGE, type AppLanguage } from '../../shared/language';

/**
 * The window in two languages, as Krewgent holds it: a lookup and a
 * substitution, hand-rolled because that is the whole of what is needed.
 * `keyof typeof en` is the contract, so a Turkish string never written is a
 * compile error. What the main process says - a refusal's sentence - is
 * English, as in Krewgent, and shown as it was written.
 */

export type Language = AppLanguage;
export type Key = keyof typeof en;

/** Each language named in its own language, so no casing rule of the other gets it wrong. */
export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'tr', label: 'Türkçe' },
  { id: 'en', label: 'English' },
];

const DICTIONARIES: Record<Language, Record<Key, string>> = { en, tr };

export const DEFAULT_LANGUAGE: Language = DEFAULT_APP_LANGUAGE;

/** Look one up, filling `{name}`-shaped holes; a missing key shows itself, which is a bug anybody can see and name. */
export function translate(language: Language, key: Key, values?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[language] ?? en;
  let text: string = dictionary[key] ?? en[key] ?? key;
  if (values) {
    for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

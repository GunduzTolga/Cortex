/**
 * The language the app speaks, from the setting both processes read.
 *
 * Null until somebody picks one, and then the default, Turkish: the app is
 * written for its owner first, and English is one choice away. Every reader of
 * the setting asks this, so a value that is neither is read the same way in the
 * window and in the main process.
 */

export type AppLanguage = 'en' | 'tr';

export const DEFAULT_APP_LANGUAGE: AppLanguage = 'tr';

export function appLanguage(setting: unknown): AppLanguage {
  return setting === 'en' || setting === 'tr' ? setting : DEFAULT_APP_LANGUAGE;
}

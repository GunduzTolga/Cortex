/**
 * When two titles are the same title.
 *
 * A `[[wiki link]]`, a path compared in a rename, the quick switcher and the
 * search all compare names, and they have to agree: where they did not in
 * Krewgent, a second note of the same name was written beside the first with
 * nothing reporting a problem.
 *
 * Lowercasing is not enough, because lowercasing does not agree with itself
 * across languages. Turkish turns `I` into `ı` and `İ` into `i`; the invariant
 * rule does neither, and a vault has both kinds of name in it - an `Iceberg`
 * folder next to a note called `İşlem`. Whichever locale is picked, the other
 * kind of name stops matching, and it stops matching silently.
 *
 * So both dotted and dotless forms fold onto a plain `i` before anything is
 * lowercased, and a lookup finds the note under any of the four. That also
 * makes `ışık` and `isik` the same title, which is the failure worth having:
 * you find the note you meant instead of quietly getting a duplicate of it.
 */

/** The form two titles are compared in. Never shown - titles keep their case. */
export function titleKey(value: string): string {
  return value
    .trim()
    // Before lowercasing, which is the step the locales disagree about.
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    // A title that was already lowered somewhere else arrives as `i` plus a
    // combining dot rather than as `İ`, and reads identically.
    .replace(/\u0307/g, '')
    // "status ·  atlas" and "status · atlas" are one title typed twice.
    .replace(/\s+/g, ' ');
}

export function sameTitle(a: string, b: string): boolean {
  return titleKey(a) === titleKey(b);
}

/**
 * The same fold, for text that is matched rather than titled.
 *
 * Every character folds 1:1, so a position found in the folded copy is the
 * same position in the original - the search finds where a term starts and
 * then slices the snippet out of the line it came from, and a fold that
 * changed lengths would cut the wrong window. The combining-dot strip
 * `titleKey` does is left out for that reason: it shortens `i` + U+0307 by
 * one, and the pre-replace above already handles the capital that produced
 * that sequence in the first place.
 */
export function foldForMatch(value: string): string {
  return value.replace(/[İIı]/g, 'i').toLowerCase();
}

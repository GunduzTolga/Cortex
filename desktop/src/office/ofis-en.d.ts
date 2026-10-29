/** The office's own words in English, looked up by their Turkish (ofis-en.js). */
export const EN: Record<string, string>;
export const BIO_EN: Record<string, string>;
export const EN_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]>;
/** The English of an office sentence, or the sentence as it came where there is none. */
export function enOf(text: string): string;

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { en } from '../src/i18n/en';
import { tr } from '../src/i18n/tr';

/**
 * A sentence with a hole (`{phrase}`) is never shown without what fills it. The
 * first-run screen showed "Sürekli dinle: {phrase} deyince aç" for a call that
 * gave no values (windows-e2e-4): translate() fills only what it is given, and
 * nothing types the holes. Every `t(...)` in the window's code given one
 * argument is read here, and each key it can name is held to having no hole,
 * in either language.
 */

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
const withHoles = new Set(Object.keys(en).filter((key) => holes(en[key as keyof typeof en]).length || holes(tr[key as keyof typeof tr]).length));

/** The source files of the window, outside the dictionaries. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sources(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Each `t(` call's arguments, as written: up to its closing parenthesis, split at its own commas. */
function calls(text: string): string[][] {
  const found: string[][] = [];
  for (const match of text.matchAll(/(?<![\w.])t\(/g)) {
    let depth = 0;
    let quote: string | null = null;
    let part = '';
    const parts: string[] = [];
    for (let i = (match.index ?? 0) + 2; i < text.length; i += 1) {
      const char = text[i];
      if (quote) {
        part += char;
        if (char === '\\') part += text[++i] ?? '';
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      if ('([{'.includes(char)) depth += 1;
      if (')]}'.includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      }
      if (char === ',' && depth === 0) {
        parts.push(part);
        part = '';
        continue;
      }
      part += char;
    }
    parts.push(part);
    found.push(parts.map((one) => one.trim()).filter(Boolean));
  }
  return found;
}

test('no sentence with a hole is asked for without what fills it', () => {
  const missing: string[] = [];
  let looked = 0;
  for (const file of sources(path.resolve('src'))) {
    for (const args of calls(fs.readFileSync(file, 'utf8'))) {
      looked += 1;
      if (args.length !== 1) continue;
      for (const literal of args[0].matchAll(/'([\w.]+)'/g)) {
        if (withHoles.has(literal[1])) missing.push(`${path.relative(path.resolve('src'), file)}: t('${literal[1]}')`);
      }
    }
  }
  assert.ok(looked > 200, 'the window’s calls were found');
  assert.ok(withHoles.has('setup.voice.wake') && withHoles.has('setup.voice.helper.hint'), 'the sentences with holes were found');
  assert.deepEqual(missing, []);
});

test('a sentence has the same holes in both languages', () => {
  const differ = Object.keys(en).filter((key) => holes(en[key as keyof typeof en]).sort().join() !== holes(tr[key as keyof typeof tr]).sort().join());
  assert.deepEqual(differ, []);
});

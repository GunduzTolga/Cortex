import { useId } from 'react';
import type { Language } from '../i18n';

/**
 * The flags the language switch shows. Drawn here, not as emoji: Windows has
 * no flag emoji and writes 🇹🇷 as the letters "TR". Both are the public-domain
 * drawings (Wikimedia Commons), cut to one 3:2 box so the two sit as a pair;
 * the Union Flag is 2:1 and loses a little of each side. English is shown by
 * the Union Flag, as the language's own country.
 */

function Turkey() {
  return (
    <svg viewBox="0 -30000 90000 60000" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <path fill="#e30a17" d="M0-30000h90000v60000H0z" />
      <path fill="#fff" d="m41750 0 13568-4408-8386 11541V-7133l8386 11541zm925 8021a15000 15000 0 1 1 0-16042 12000 12000 0 1 0 0 16042z" />
    </svg>
  );
}

function UnitedKingdom() {
  // Ids in a page are one namespace: two switches on one page would share a clip path written as a constant.
  const id = useId();
  return (
    <svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <clipPath id={`${id}t`}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#${id}t)`} stroke="#c8102e" strokeWidth="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#c8102e" strokeWidth="6" />
    </svg>
  );
}

const FLAGS: Record<Language, () => React.ReactElement> = { tr: Turkey, en: UnitedKingdom };

/** A language's flag, 18 by 12, its corners rounded and edged so the white of a flag does not run into the paper. */
export function Flag({ language }: { language: Language }) {
  const Drawing = FLAGS[language];
  return (
    <span aria-hidden className="inline-block h-3 w-[18px] shrink-0 overflow-hidden rounded-[2px] shadow-[0_0_0_0.5px_rgba(27,23,18,0.35)]">
      <Drawing />
    </span>
  );
}

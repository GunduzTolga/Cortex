import { LANGUAGES } from '../i18n';
import { useLanguage, useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Flag } from './flags';

/**
 * The language, one press away: a flag and its code for each, the one in use
 * raised on the paper and the other greyed until it is pointed at. Each is
 * named in its own language for a screen reader, as LANGUAGES names them.
 */
export function LanguageSwitch() {
  const t = useT();
  const language = useLanguage();
  return (
    <div role="group" aria-label={t('app.language')} className="flex items-center rounded-lg bg-zinc-100 p-0.5">
      {LANGUAGES.map((one) => {
        const current = one.id === language;
        return (
          <button
            key={one.id}
            type="button"
            lang={one.id}
            aria-label={one.label}
            title={one.label}
            aria-pressed={current}
            data-language={one.id}
            onClick={() => {
              if (!current) void useApp.getState().setLanguage(one.id);
            }}
            className={`group flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] font-semibold tracking-widest transition-colors ${
              current ? 'bg-paper-2 text-darkDelegation shadow-[0_1px_2px_rgba(27,23,18,0.12)]' : 'text-zinc-400 hover:text-darkDelegation'
            }`}
          >
            <span className={current ? '' : 'opacity-60 grayscale transition group-hover:opacity-100 group-hover:grayscale-0'}>
              <Flag language={one.id} />
            </span>
            {one.id.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { appLanguage, type AppLanguage } from '../../shared/language';
import { translate } from '../i18n';

/**
 * What the window shows when drawing it threw (K7, 10 November): without this, an error in any component's render
 * took the whole tree down and left a blank sheet of paper, with nothing to press. The person is told, in a sentence,
 * and given the one thing to do about it there: load the page again.
 *
 * It leans on nothing that may be what broke: no store, no hook. The language is the one the page last drew in
 * (`<html lang>`, src/i18n/useT.ts), Turkish before any was.
 */

/** How long the page is given to save what it holds before it is loaded again anyway. */
const SAVE_WAIT_MS = 1500;

export function CrashScreen({ language, onReload }: { language: AppLanguage; onReload: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" data-app-crash>
      <p className="text-[15px] font-semibold text-darkDelegation">{translate(language, 'app.crash.title')}</p>
      <p className="max-w-md text-[13px] leading-relaxed text-zinc-600">{translate(language, 'app.crash.detail')}</p>
      <button
        type="button"
        onClick={onReload}
        className="kg-press inline-flex h-9 items-center justify-center rounded-lg border-[1.5px] border-darkDelegation bg-gold px-3.5 text-[10px] font-black uppercase tracking-widest text-onGold shadow-[3px_3px_0_0_var(--color-shadow)] hover:bg-signal"
        data-app-crash-reload
      >
        {translate(language, 'app.crash.reload')}
      </button>
    </div>
  );
}

function drawnLanguage(): AppLanguage {
  return appLanguage(typeof document === 'undefined' ? null : document.documentElement.lang);
}

export class RenderGuard extends Component<{ children: ReactNode; beforeReload?: () => Promise<unknown> }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // For the developer's console; the person reads the sentence on the screen.
    console.error('[render]', error, info.componentStack);
  }

  /** Loaded again, once what the page holds unsaved has been given a moment to be saved (a note being typed). */
  reload = (): void => {
    const go = () => window.location.reload();
    const saved = (async () => this.props.beforeReload?.())().catch(() => undefined);
    void Promise.race([saved, new Promise((done) => setTimeout(done, SAVE_WAIT_MS))]).then(go, go);
  };

  render(): ReactNode {
    return this.state.failed ? <CrashScreen language={drawnLanguage()} onReload={this.reload} /> : this.props.children;
  }
}

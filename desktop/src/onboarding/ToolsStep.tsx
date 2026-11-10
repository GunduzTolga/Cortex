import { Download, KeyRound, LogIn } from 'lucide-react';
import type { CliAuth, CliId } from '@shared/chat';
import { InstallProgressLine, LoginEnded, LoginSlow, TOOL_NAMES, installFailedKey } from '../chat/AuthDialog';
import { useChat } from '../chat/chatStore';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { Button, Spinner } from '../ui/ui';
import { Heading } from './Heading';

/**
 * The first-run screen's "Yapay zeka aracın" step (Onboarding.tsx): the tools this computer has, each with its sign-in,
 * and the ones that can be installed from here. In a file of its own so its rows can be drawn in a test: Onboarding.tsx
 * brings Pyn's pictures with it, which the tests' bundler does not read.
 */

/** A tool being installed from here (`failed`: its installer ended without it). */
/** A tool being installed; `why`, where the main process refused before any window opened. */
export type Installing = { id: CliId; failed: boolean; why?: string } | null;

/**
 * A model server with a model loaded is ready: it was just asked. A sign-in the tool keeps is
 * not proof - it may have run out - so a tool counts only once it is signed in to here.
 */
export const serving = (tool: CliAuth) => Boolean(tool.local && tool.signedIn && tool.local.loaded.length && !tool.local.shortContext);

export function ToolsStep({
  auth,
  fresh,
  signingIn,
  unfinished,
  installing,
  onLogin,
  onCancel,
  onInstall,
  slowAfter,
}: {
  auth: CliAuth[] | null;
  fresh: Set<CliId>;
  signingIn: Set<CliId>;
  unfinished: Set<CliId>;
  installing: Installing;
  onLogin: (id: CliId) => void;
  /** "Vazgeç" on a sign-in going on. */
  onCancel: (id: CliId) => void;
  onInstall: (id: CliId) => void;
  /** After how long a sign-in going on is said to be slow (AuthDialog's LOGIN_SLOW_AFTER; the tests'). */
  slowAfter?: number;
}) {
  const t = useT();
  const refused = useChat((s) => s.authFailed);
  const tools = (auth ?? []).filter((tool) => tool.installed);
  // The tools missing here and installable from here (Windows): Claude Code first, by Anthropic's installer, then the
  // others by npm, each with its sign-in after. Only Claude Code was offered, and OpenCode could not be had (1 November).
  const installable = (auth ?? []).filter((tool) => !tool.installed && tool.canInstall);
  const state = (tool: CliAuth): [Key, string] =>
    tool.local
      ? // A server that is not running is off, as the AI tools window says; "no model" is one running with none loaded.
        !tool.signedIn
        ? ['auth.status.off', 'bg-bad/10 text-bad']
        : tool.local.shortContext
          ? ['onboarding.tools.short', 'bg-gold/25 text-darkDelegation']
          : serving(tool)
            ? ['onboarding.tools.serving', 'bg-good/15 text-good']
            : ['onboarding.tools.noModel', 'bg-zinc-100 text-zinc-500']
      : fresh.has(tool.id)
        ? ['onboarding.tools.fresh', 'bg-good/15 text-good']
        : unfinished.has(tool.id) && tool.signedIn !== true
          ? ['onboarding.tools.unfinished', 'bg-bad/10 text-bad']
          : refused.includes(tool.id)
          ? ['auth.status.refused', 'bg-bad/10 text-bad']
          : tool.signedIn === true
            ? ['onboarding.tools.kept', 'bg-gold/25 text-darkDelegation']
            : tool.signedIn === false
              ? ['auth.status.out', 'bg-zinc-100 text-zinc-600']
              : ['auth.status.unknown', 'bg-zinc-100 text-zinc-500'];
  return (
    <div>
      <Heading title={t('onboarding.tools.title')}>
        <p>{t('onboarding.tools.body')}</p>
        <p className="text-[12.5px] text-zinc-500">{t('onboarding.tools.honest')}</p>
      </Heading>
      {installable.length ? (
        <div className="mt-5 rounded-xl border border-darkDelegation/25 bg-white px-4 py-3.5" data-onboarding-install={installable[0].id}>
          <p className="text-[13.5px] font-semibold text-darkDelegation">{t(tools.length ? 'onboarding.tools.install.more' : 'onboarding.tools.install.title')}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-600">{t('onboarding.tools.install.body')}</p>
          <ul className="mt-3 divide-y divide-zinc-100" data-onboarding-install-list>
            {installable.map((tool) => {
              const mine = installing?.id === tool.id ? installing : null;
              return (
                <li key={tool.id} className="py-2" data-onboarding-install-row={tool.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="min-w-[7rem] flex-1 text-[13px] font-semibold text-darkDelegation">
                      {TOOL_NAMES[tool.id] ?? tool.id}
                      <span className="mt-0.5 block text-[11.5px] font-normal text-zinc-500">{t(tool.id === 'claude' ? 'onboarding.tools.install.claudeNote' : 'onboarding.tools.install.packageNote')}</span>
                    </span>
                    <Button
                      tone={tool.id === installable[0].id ? 'primary' : 'ghost'}
                      className="h-8 shrink-0"
                      disabled={Boolean(installing && !installing.failed)}
                      onClick={() => onInstall(tool.id)}
                      data-onboarding-install-start={tool.id}
                    >
                      <Download size={13} />
                      {t('onboarding.tools.install')}
                    </Button>
                  </div>
                  {mine && !mine.failed ? (
                    <p className="mt-1.5 text-[12px] text-zinc-500" data-onboarding-installing>
                      {t('onboarding.tools.installing')}
                      <InstallProgressLine tool={tool.id} />
                    </p>
                  ) : null}
                  {mine?.failed ? (
                    <p className="mt-1.5 text-[12px] font-semibold text-bad" data-onboarding-install-failed={tool.installEnded ?? 'unknown'}>
                      {mine.why || t(installFailedKey(tool.installEnded), { name: TOOL_NAMES[tool.id] ?? tool.id })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {/* Not asked yet, or each tool still being asked how it is (seconds, where an antivirus reads every program started): said, not a blank step (K5). */}
      {auth === null ? (
        <p className="mt-5 flex items-center gap-2 text-[13px] text-zinc-500" data-onboarding-tools-looking>
          <Spinner size={12} />
          {t('onboarding.tools.looking')}
        </p>
      ) : null}
      {auth && !tools.length && !installable.length ? (
        <p className="mt-5 text-[13px] text-zinc-600">{t('onboarding.tools.none')}</p>
      ) : null}
      <ul className={`mt-5 divide-y divide-zinc-100 rounded-xl border border-darkDelegation/15 bg-white${tools.length ? '' : ' hidden'}`} data-onboarding-tool-list>
        {tools.map((tool) => {
          const [words, colours] = state(tool);
          const going = signingIn.has(tool.id) && !fresh.has(tool.id);
          return (
            <li key={tool.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5" data-onboarding-tool={tool.id}>
              {/* Wrapped, not run under the badge beside it, where the window is narrow or zoomed (29 October). */}
              <span className="min-w-[7rem] flex-1 break-words text-[13px] font-semibold text-darkDelegation">
                {TOOL_NAMES[tool.id] ?? tool.id}
                {going ? <span className="mt-0.5 block text-[11.5px] font-normal text-zinc-500">{t('onboarding.tools.signingIn.note')}</span> : null}
                {going ? <LoginSlow tool={tool.id} after={slowAfter} /> : null}
                {!going && tool.loginEnded && tool.signedIn !== true && !fresh.has(tool.id) ? <span className="block font-normal"><LoginEnded ended={tool.loginEnded} tool={tool.id} /></span> : null}
                {tool.local?.shortContext && tool.signedIn ? (
                  <span className="mt-0.5 block text-[11.5px] font-normal text-zinc-500" data-onboarding-tool-short>
                    {t('auth.local.short', { tokens: tool.local.shortContext })}
                  </span>
                ) : null}
              </span>
              {going ? (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-gold/25 px-2 py-0.5 text-[10.5px] font-semibold text-darkDelegation" data-onboarding-tool-signing-in>
                  <Spinner size={10} />
                  {t('onboarding.tools.signingIn')}
                </span>
              ) : (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${colours}`} data-onboarding-tool-state={words}>
                  {t(words)}
                </span>
              )}
              {tool.canLogin && !fresh.has(tool.id) && !going ? (
                <Button tone={tool.signedIn === true ? 'ghost' : 'primary'} className="h-8 shrink-0" onClick={() => onLogin(tool.id)} data-onboarding-tool-login={tool.id}>
                  <LogIn size={12} />
                  {t(tool.signedIn === true ? 'onboarding.tools.again' : 'onboarding.tools.signIn')}
                </Button>
              ) : null}
              {/* While its sign-in goes on: begun again (the browser opened once more), or given up. The row had no button
                  at all for the sign-in's ten minutes, whatever had happened to the browser (K2). */}
              {tool.canLogin && going ? (
                <>
                  <Button tone="ghost" className="h-8 shrink-0" onClick={() => onLogin(tool.id)} data-onboarding-tool-retry={tool.id}>
                    <LogIn size={12} />
                    {t('auth.login.retry')}
                  </Button>
                  <Button tone="quiet" className="h-8 shrink-0" onClick={() => onCancel(tool.id)} data-onboarding-tool-cancel={tool.id}>
                    {t('auth.cancel')}
                  </Button>
                </>
              ) : null}
              {/* A tool whose only way in is its key (OpenCode, Gemini CLI, Qwen Code): its field, a click away. */}
              {!tool.canLogin && tool.key === 'cortex' && tool.signedIn !== true ? (
                <Button tone="primary" className="h-8 shrink-0" onClick={() => useChat.getState().openAuth(tool.id)} data-onboarding-tool-key={tool.id}>
                  <KeyRound size={12} />
                  {t('auth.key')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button tone="quiet" className="mt-3" onClick={() => useChat.getState().openAuth()} data-onboarding-tools>
        <KeyRound size={13} />
        {t('onboarding.tools.keys')}
      </Button>
    </div>
  );
}

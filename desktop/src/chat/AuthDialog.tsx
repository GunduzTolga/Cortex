import { useEffect, useState } from 'react';
import { Check, Download, KeyRound, LogIn, MessageSquarePlus, RefreshCw, Trash2, X } from 'lucide-react';
import type { CliAuth, CliId } from '@shared/chat';
import { messageOf } from '@shared/ipcError';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { useApp } from '../store/app';
import { Button, Modal, Spinner, inputClass } from '../ui/ui';
import { useChat } from './chatStore';
import { HermesSection } from './HermesSection';

/**
 * Signing in to the AI tools Pyn talks through (electron/services/auth.ts):
 * each tool, whether it is signed in as it says itself, its own sign-in a
 * click away in a window of its own, and a key where the tool takes one. A
 * key is typed here and goes to the main process; it is never shown again,
 * only whether one is kept.
 */

export const TOOL_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code', lmstudio: 'LM Studio', ollama: 'Ollama' };
/** A tool by its own name; the server's Pyn by its name in the language shown (electron/services/hermesChat.ts, hermesName). */
export const toolName = (id: string, t: ReturnType<typeof useT>): string | undefined => (id === 'hermes' ? t('auth.tool.hermes') : TOOL_NAMES[id]);
const NOTES: Record<string, Key> = {
  claude: 'auth.note.claude',
  codex: 'auth.note.codex',
  opencode: 'auth.note.opencode',
  gemini: 'auth.note.gemini',
  qwen: 'auth.note.qwen',
  lmstudio: 'auth.note.lmstudio',
  ollama: 'auth.note.ollama',
};

/**
 * What the tool says of its own saved sign-in, for a tool the chat offers; one a chat was just refused for is said to be
 * refused, whatever the tool says. A tool the chat does not offer is said to be unused in Cortex, whatever sign-in it
 * keeps: Codex, signed in only in a terminal, said "Giriş kayıtlı" and was not in the chat (1 November).
 */
function Status({ tool, refused }: { tool: CliAuth; refused: boolean }) {
  const t = useT();
  const [words, colours]: [Key, string] = !tool.installed
    ? ['auth.status.missing', 'bg-zinc-100 text-zinc-400']
    : tool.local
      ? tool.signedIn
        ? ['auth.status.running', 'bg-good/15 text-good']
        : ['auth.status.off', 'bg-bad/10 text-bad']
      : tool.chosen === false
        ? ['auth.status.unused', 'bg-zinc-100 text-zinc-500']
        : refused && tool.signedIn !== false
          ? ['auth.status.refused', 'bg-bad/10 text-bad']
          : tool.signedIn === true
            ? ['auth.status.in', 'bg-good text-white']
            : tool.signedIn === false
              ? ['auth.status.out', 'bg-gold/25 text-darkDelegation']
              : ['auth.status.unknown', 'bg-zinc-100 text-zinc-500'];
  const signed = words === 'auth.status.in';
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${colours}`} data-auth-status={words}>
      {signed ? <Check size={11} strokeWidth={3} /> : null}
      {t(words)}
    </span>
  );
}

function ToolRow({ tool, focused, refused }: { tool: CliAuth; focused: boolean; refused: boolean }) {
  const t = useT();
  const name = toolName(tool.id, t) ?? tool.id;
  const toast = useApp((s) => s.toast);
  const [keying, setKeying] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // Its sign-in's window open. Its installer's is the window's (chatStore.ts), so the empty chat and this row say the same.
  const [signingIn, setSigningIn] = useState(false);
  const installing = useChat((state) => (state.installing?.id === tool.id ? state.installing : null));
  const failed = (err: unknown) => toast({ tone: 'error', title: t('auth.failed'), detail: messageOf(err) });

  // The sign-in's window closed, or the tool says it is signed in: "finish signing in" is no longer what goes on.
  // Only its own: another tool's sign-in ending left this one's still going on (as on the first-run screen, 30 October).
  useEffect(() => {
    if (!signingIn) return;
    return window.cortex.on.authChanged((cli) => {
      if (cli === tool.id) setSigningIn(false);
    });
  }, [signingIn, tool.id]);
  useEffect(() => {
    if (tool.signedIn) setSigningIn(false);
  }, [tool.signedIn]);

  const login = async () => {
    try {
      await window.cortex.chat.login(tool.id);
      setSigningIn(true);
    } catch (err) {
      failed(err);
    }
  };
  const install = async () => {
    try {
      await useChat.getState().install(tool.id);
    } catch (err) {
      failed(err);
    }
  };
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const auth = await window.cortex.chat.setKey(tool.id, key.trim(), tool.baseUrl && baseUrl.trim() ? baseUrl.trim() : undefined);
      useChat.setState({ auth });
      setKey('');
      setBaseUrl('');
      setKeying(false);
      toast({ tone: 'success', title: t('auth.key.saved', { name }) });
    } catch (err) {
      failed(err);
    }
    setBusy(false);
  };
  const forget = async () => {
    try {
      useChat.setState({ auth: await window.cortex.chat.forgetKey(tool.id) });
    } catch (err) {
      failed(err);
    }
  };
  // Added to the chat with the sign-in it keeps, or taken from it; the chat's tool chip follows.
  const choose = async (offered: boolean) => {
    try {
      useChat.setState({ auth: await window.cortex.chat.choose(tool.id, offered) });
      void useChat.getState().refreshClis();
    } catch (err) {
      failed(err);
    }
  };
  const unused = tool.installed && !tool.local && tool.chosen === false;

  return (
    <li className={`rounded-xl border px-4 py-3 ${focused ? 'border-darkDelegation/40 bg-paper-2' : 'border-zinc-100'}`} data-auth-tool={tool.id}>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[13.5px] font-semibold text-darkDelegation">{name}</p>
        <Status tool={tool} refused={refused} />
      </div>
      {tool.detail ? <p className="mt-0.5 truncate text-[11.5px] text-zinc-500" data-auth-detail>{tool.detail}</p> : null}
      {tool.local?.models ? (
        <p className="mt-0.5 truncate text-[11.5px] text-zinc-500" data-auth-detail>
          {tool.local.loaded.length ? t('auth.local.loaded', { count: tool.local.models, loaded: tool.local.loaded.join(', ') }) : t('auth.local.none', { count: tool.local.models })}
        </p>
      ) : null}
      {tool.local?.shortContext ? <p className="mt-1 text-[11.5px] font-semibold text-bad" data-auth-short>{t('auth.local.short', { tokens: tool.local.shortContext })}</p> : null}
      {refused && tool.signedIn && !unused ? <p className="mt-1 text-[11.5px] font-semibold text-bad" data-auth-expired>{t('auth.expired')}</p> : null}
      {unused ? (
        <p className="mt-1 text-[11.5px] text-zinc-600" data-auth-unused>
          {t(tool.signedIn ? 'auth.unused.signedIn' : 'auth.unused.note')}
        </p>
      ) : null}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-400">{t(NOTES[tool.id])}</p>
      {!tool.installed && tool.canInstall ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button tone="primary" onClick={() => void install()} disabled={Boolean(installing && !installing.failed)} data-auth-install>
            <Download size={13} />
            {t('auth.install')}
          </Button>
        </div>
      ) : null}
      {tool.installed ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {unused ? (
            <Button tone={tool.signedIn || !tool.canLogin ? 'primary' : 'ghost'} onClick={() => void choose(true)} data-auth-choose>
              <MessageSquarePlus size={13} />
              {t('auth.choose')}
            </Button>
          ) : null}
          {tool.canLogin && !(unused && tool.signedIn) ? (
            <Button tone={tool.signedIn ? 'ghost' : 'primary'} onClick={() => void login()} data-auth-login>
              <LogIn size={13} />
              {t(tool.signedIn ? 'auth.login.again' : 'auth.login')}
            </Button>
          ) : null}
          {tool.key ? (
            <Button tone="ghost" onClick={() => setKeying(!keying)} data-auth-key>
              <KeyRound size={13} />
              {t('auth.key')}
            </Button>
          ) : null}
          {/* One kept here, readable or not (kept on another computer, it is not signed in with): forgotten here (30 October). */}
          {tool.key === 'cortex' && tool.kept ? (
            <Button tone="danger" onClick={() => void forget()} data-auth-forget>
              <Trash2 size={13} />
              {t('auth.key.forget')}
            </Button>
          ) : null}
          {!tool.local && tool.chosen === true ? (
            <Button tone="quiet" onClick={() => void choose(false)} data-auth-unchoose>
              <X size={13} />
              {t('auth.unchoose')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {installing && !tool.installed ? (
        <p className={`mt-2 text-[11.5px] ${installing.failed ? 'text-bad' : 'text-zinc-500'}`} data-auth-install-state={installing.failed ? 'failed' : 'running'}>
          {t(installing.failed ? 'onboarding.tools.installFailed' : 'auth.install.waiting', { name: TOOL_NAMES[tool.id] ?? tool.id })}
        </p>
      ) : signingIn ? (
        <p className="mt-2 text-[11.5px] text-zinc-500">{t('auth.login.waiting')}</p>
      ) : null}
      {keying ? (
        <form
          className="mt-2.5 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={t('auth.key.placeholder')} aria-label={t('auth.key')} className={inputClass} data-auth-key-input autoFocus />
          {tool.baseUrl ? <input type="url" autoComplete="off" spellCheck={false} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" aria-label={t('auth.key.baseUrl')} className={inputClass} /> : null}
          <p className="text-[11px] leading-relaxed text-zinc-400">{t(tool.key === 'cli' ? 'auth.key.cli' : 'auth.key.cortex')}</p>
          <div className="flex gap-1.5">
            <Button tone="primary" type="submit" disabled={busy || !key.trim()} data-auth-key-save>
              {busy ? <Spinner size={12} /> : null}
              {t('auth.key.save')}
            </Button>
            <Button tone="quiet" onClick={() => setKeying(false)}>
              {t('auth.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export function AuthDialog() {
  const t = useT();
  const open = useChat((state) => state.authOpen);
  const auth = useChat((state) => state.auth);
  const failed = useChat((state) => state.authFailed);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await useChat.getState().loadAuth();
    setRefreshing(false);
  };
  return (
    <Modal
      open={open !== null}
      title={t('auth.title')}
      onClose={() => useChat.getState().closeAuth()}
      width="max-w-xl"
      footer={
        <Button tone="ghost" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          {t('auth.refresh')}
        </Button>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-zinc-500">{t('auth.intro')}</p>
      {auth === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <ul className="space-y-2" data-auth-list>
          {auth.map((tool) => (
            <ToolRow key={tool.id} tool={tool} focused={open === tool.id} refused={failed.includes(tool.id)} />
          ))}
          <HermesSection focused={open === 'hermes'} />
        </ul>
      )}
    </Modal>
  );
}

/** For the tool chip: a tool's sign-in as a dot - signed in, not, or not known. */
export function authDot(auth: CliAuth[] | null, id: CliId): 'on' | 'off' | null {
  const tool = auth?.find((one) => one.id === id);
  if (!tool || !tool.installed || tool.signedIn === null) return null;
  return tool.signedIn ? 'on' : 'off';
}

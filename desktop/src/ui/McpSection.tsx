import { useEffect, useState } from 'react';
import { Check, Copy, Plug } from 'lucide-react';
import type { McpAddOutcome, McpLines, McpStatus } from '@shared/mcp';
import type { Key } from '../i18n';
import { useT } from '../i18n/useT';
import { useSetup } from '../store/setup';
import { copyText } from './copyText';
import { Section } from './settingsParts';
import { Button, Spinner } from './ui';

/**
 * Settings › "Yapay zeka araçlarına bağla" (shared/mcp.ts, electron/services/mcp.ts): the vault's MCP gate given to
 * the person's AI tools. A line for Claude Code, Codex and OpenCode, each with "Kopyala", built in the main process for
 * the vault open now and the Python its engine runs on; where Claude Code is installed, "Claude Code'a ekle" runs its own
 * `claude mcp add` once the person says yes here. What Claude Code has is said only as it says it (`claude mcp get`).
 * An engine without the gate, or none, gets the sentence that says what to do instead of the lines.
 */

function Note({ children, tone = 'muted', data }: { children: React.ReactNode; tone?: 'muted' | 'error' | 'ok'; data: string }) {
  const colour = tone === 'error' ? 'text-red-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-500';
  return (
    <p className={`px-3 text-[11.5px] leading-relaxed ${colour}`} data-mcp-note={data}>
      {children}
    </p>
  );
}

const LABELS: Record<keyof McpLines, Key> = { claude: 'mcp.claude.label', codex: 'mcp.codex.label', opencode: 'mcp.opencode.label' };

/** One tool's line, shown as it is to be typed, and copied whole. */
function Line({ tool, text }: { tool: keyof McpLines; text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-2.5 px-3" data-mcp-line={tool}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] font-semibold text-darkDelegation">{t(LABELS[tool])}</span>
        <Button
          tone="ghost"
          className="h-7 shrink-0"
          onClick={() => {
            copyText(text);
            setCopied(true);
          }}
          data-mcp-copy={tool}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('mcp.copied') : t('mcp.copy')}
        </Button>
      </div>
      <pre className="mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-darkDelegation" data-mcp-text={tool}>
        {text}
      </pre>
    </div>
  );
}

/** What "Claude Code'a ekle" came to, said in one sentence; nothing where the section itself now says it (blocked, Claude Code gone). */
const OUTCOMES: Partial<Record<McpAddOutcome, { key: Key; tone: 'ok' | 'error' | 'muted' }>> = {
  added: { key: 'mcp.claude.added', tone: 'ok' },
  already: { key: 'mcp.claude.already', tone: 'ok' },
  other: { key: 'mcp.claude.other', tone: 'muted' },
  unverified: { key: 'mcp.claude.unverified', tone: 'error' },
  failed: { key: 'mcp.claude.failed', tone: 'error' },
  timeout: { key: 'mcp.claude.timeout', tone: 'error' },
};

/** Claude Code's part: what it has under `cortex`, and the button where it has not this vault. */
function ClaudeRow({ status, onStatus }: { status: McpStatus; onStatus: (status: McpStatus) => void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<McpAddOutcome | null>(null);
  const link = status.claude?.link;
  if (!link) return null;
  const add = async () => {
    setAsking(false);
    setAdding(true);
    setOutcome(null);
    try {
      const result = await window.cortex.mcp.addToClaude();
      onStatus(result.status);
      setOutcome(result.outcome);
    } catch {
      setOutcome('failed');
    } finally {
      setAdding(false);
    }
  };
  const said = outcome ? OUTCOMES[outcome] : undefined;
  const offered = !adding && !asking && (link === 'none' || link === 'unknown');
  return (
    <div className="mt-3" data-mcp-claude={link}>
      {said ? (
        <Note tone={said.tone} data={outcome ?? ''}>
          {t(said.key)}
        </Note>
      ) : link === 'this' ? (
        <Note tone="ok" data="this">
          {t('mcp.claude.this')}
        </Note>
      ) : link === 'other' ? (
        <Note data="other">{t('mcp.claude.other')}</Note>
      ) : link === 'unknown' ? (
        <Note data="unknown">{t('mcp.claude.unknown')}</Note>
      ) : null}
      {offered ? (
        <div className="mt-2 px-3">
          <Button tone="ghost" onClick={() => setAsking(true)} data-mcp-claude-add>
            <Plug size={13} />
            {t('mcp.claude.add')}
          </Button>
        </div>
      ) : null}
      {asking ? (
        <div className="mx-3 mt-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5" data-mcp-confirm>
          <p className="text-[12px] leading-relaxed text-darkDelegation">{t('mcp.claude.confirm')}</p>
          <div className="mt-2 flex gap-2">
            <Button tone="primary" className="h-8" onClick={() => void add()} data-mcp-confirm-yes>
              {t('mcp.claude.confirm.yes')}
            </Button>
            <Button tone="ghost" className="h-8" onClick={() => setAsking(false)} data-mcp-confirm-no>
              {t('mcp.claude.confirm.no')}
            </Button>
          </div>
        </div>
      ) : null}
      {adding ? (
        <div className="mt-2 flex items-center gap-2 px-3 text-[11.5px] text-zinc-500" data-mcp-adding>
          <Spinner size={11} label={t('mcp.claude.adding')} />
          {t('mcp.claude.adding')}
        </div>
      ) : null}
    </div>
  );
}

export function McpSection({ open }: { open: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // Asked again as the dialog opens, and when the engine or Python is set up or updated from the section above.
  const engine = useSetup((s) => s.status?.engine.installed ?? null);
  const python = useSetup((s) => s.status?.python ?? null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFailed(false);
    window.cortex.mcp.status().then(
      (next) => {
        if (live) setStatus(next);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, engine, python]);

  if (status && !status.vault) return null;
  return (
    <Section title={t('mcp.title')} data="mcp">
      {failed ? (
        <Note tone="error" data="error">
          {t('mcp.error')}
        </Note>
      ) : !status ? (
        <div className="flex items-center gap-2 px-3 text-[11.5px] text-zinc-500" data-mcp-note="loading">
          <Spinner size={11} label={t('mcp.loading')} />
          {t('mcp.loading')}
        </div>
      ) : status.blocked ? (
        <Note tone="error" data={status.blocked}>
          {t(status.blocked === 'engine' ? 'mcp.engine' : status.blocked === 'old' ? 'mcp.old' : 'mcp.python')}
        </Note>
      ) : status.lines ? (
        <>
          <Note data="intro">{t('mcp.intro')}</Note>
          <Line tool="claude" text={status.lines.claude} />
          <ClaudeRow key={status.lines.claude} status={status} onStatus={setStatus} />
          <Line tool="codex" text={status.lines.codex} />
          <Line tool="opencode" text={status.lines.opencode} />
          <div className="mt-3 space-y-1.5">
            <Note data="ask">{t('mcp.ask')}</Note>
            <Note data="privacy">{t('mcp.privacy')}</Note>
          </div>
        </>
      ) : null}
    </Section>
  );
}

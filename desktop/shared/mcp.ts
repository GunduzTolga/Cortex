/**
 * The vault connected to the person's AI tools through its MCP gate, `beyin.py mcp` (docs/v3/MCP.md), from
 * Settings › "Yapay zeka araçlarına bağla" (src/ui/McpSection.tsx, electron/services/mcp.ts): the lines to give
 * Claude Code, Codex and OpenCode, each to be copied, and Claude Code's own `claude mcp add` run for the person once
 * they say so. The window names nothing: the vault, its Python and Claude Code are the main process's to find.
 */

/** The engine from which `beyin.py mcp` has its four tools (search, context, capture, note_create). */
export const MCP_SINCE = '1.0.58';

/** The name the vault is given in the tools' settings (`claude mcp add cortex`, `[mcp_servers.cortex]`). */
export const MCP_NAME = 'cortex';

/**
 * Why there is nothing to connect yet: the vault has no engine; it has one older than MCP_SINCE, the predecessor
 * project's, or one without the gate; or no Python the engine runs on was found.
 */
export type McpBlocked = 'engine' | 'old' | 'python';

/**
 * What Claude Code has under the name `cortex` (`claude mcp get cortex`): this vault's gate, something else, nothing,
 * or it could not be told (no answer in time, an answer not understood).
 */
export type ClaudeLink = 'this' | 'other' | 'none' | 'unknown';

/** What to give each tool: a command for Claude Code, a TOML table for Codex, a JSON file for OpenCode. */
export interface McpLines {
  claude: string;
  codex: string;
  opencode: string;
}

export interface McpStatus {
  /** A vault is chosen; without one there is nothing to show. */
  vault: boolean;
  blocked: McpBlocked | null;
  /** The vault's engine as its stamp says (`.beyin-version`), where it has one. */
  engine: string | null;
  /** Null while blocked. */
  lines: McpLines | null;
  /** Claude Code on this machine and what it has under `cortex`; null where it is not installed, or while blocked. */
  claude: { link: ClaudeLink } | null;
}

/**
 * What "Claude Code'a ekle" came to: added (and seen added), there already, another server under the name, run but
 * not seen afterwards, refused, not answered in time; or nothing run, the vault being blocked or Claude Code gone.
 */
export type McpAddOutcome = 'added' | 'already' | 'other' | 'unverified' | 'failed' | 'timeout' | 'blocked' | 'missing';

export interface McpAdded {
  outcome: McpAddOutcome;
  status: McpStatus;
}

export interface McpApi {
  status(): Promise<McpStatus>;
  /** `claude mcp add --scope user cortex -- <python> <vault>/beyin.py mcp`, for the vault open now; asked first in the window. */
  addToClaude(): Promise<McpAdded>;
}

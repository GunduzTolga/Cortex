import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Launch } from './clis';

/**
 * One CLI speaking the Agent Client Protocol (agentclientprotocol.com):
 * JSON-RPC 2.0, one message a line, over the program's standard input and
 * output. Written here rather than taken from the SDK, whose interface has
 * changed eleven times in three months: what Cortex uses is a few methods,
 * and every message from the program is read as data, never trusted.
 *
 * The program is started without a shell, in the vault, with the person's
 * environment less what is Electron's. Its errors on standard error are kept
 * (the last few kilobytes) to say why it stopped. Closed, it is ended with
 * everything it started.
 */

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

export interface AcpHandlers {
  /** A notification from the program: `session/update`. */
  notify(method: string, params: unknown): void;
  /** A request from the program - asking leave for a step - answered by what this resolves to; a refusal is thrown as an AcpError. */
  request(method: string, params: unknown): Promise<unknown>;
  /** It stopped: its exit code, and the last of what it wrote to standard error. */
  exited(code: number | null, stderr: string): void;
}

/** A line longer than this is not a message: the program is stopped rather than let fill the memory. */
const LINE_MAX = 16 * 1024 * 1024;
const STDERR_KEPT = 8 * 1024;

/** A Claude Code session's own variables: what ties a program started inside it to that session's host and sign-in. */
const HOST_SESSION = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+)$/i;

/**
 * The person's environment, less what would make a node program start as
 * Electron or carry Electron's options. Started from inside a Claude Code
 * session - Cortex run from one while it is being built - that session's own
 * variables are left out too, with the host's address for the API: with them
 * a CLI talks to that session's host and is refused (14 October).
 */
export function childEnv(extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...from };
  const inSession = Boolean(from.CLAUDECODE);
  for (const key of Object.keys(env)) {
    if (/^ELECTRON_/i.test(key) || key === 'NODE_OPTIONS') delete env[key];
    else if (inSession && (HOST_SESSION.test(key) || key === 'ANTHROPIC_BASE_URL')) delete env[key];
  }
  return { ...env, ...extra };
}

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: AcpError) => void }>();
  private stderr = '';
  private ended = false;

  constructor(launch: Launch, cwd: string, private readonly handlers: AcpHandlers) {
    this.child = spawn(launch.command, launch.args, { cwd, env: childEnv(launch.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT);
    });
    // A pipe closed under a write (the program gone) is said by its exit, not thrown here.
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (err) => this.end(null, `${this.stderr}\n${err.message}`.trim()));
    this.child.on('exit', (code) => this.end(code, this.stderr.trim()));
  }

  get alive(): boolean {
    return !this.ended;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new AcpError('The program is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.ended) this.write({ jsonrpc: '2.0', method, params });
  }

  /** Ended with everything it started: on Windows a program's children outlive it unless the tree is ended. */
  close(): void {
    if (this.ended) return;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    else this.child.kill();
    this.end(null, '');
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > LINE_MAX && !this.buffer.includes('\n')) {
      this.stderr = `${this.stderr}\nA message longer than ${LINE_MAX} bytes: the program was stopped.`.slice(-STDERR_KEPT);
      this.close();
      return;
    }
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.receive(line);
    }
  }

  private receive(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON - a log a program printed to the wrong stream - is not a message.
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const { id, method } = message;
    if (typeof method === 'string' && id === undefined) {
      this.handlers.notify(method, message.params);
      return;
    }
    if (typeof method === 'string') {
      this.handlers.request(method, message.params).then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: unknown) => {
          const error = err instanceof AcpError ? err : new AcpError(err instanceof Error ? err.message : String(err), -32603);
          this.write({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message } });
        },
      );
      return;
    }
    if (typeof id !== 'number') return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (message.error) {
      const text = typeof message.error.message === 'string' ? message.error.message : 'The program refused.';
      waiting.reject(new AcpError(text, typeof message.error.code === 'number' ? message.error.code : null, message.error.data ?? null));
    } else {
      waiting.resolve(message.result);
    }
  }

  private end(code: number | null, stderr: string): void {
    if (this.ended) return;
    this.ended = true;
    const why = new AcpError(stderr ? `The program stopped: ${stderr.split('\n').slice(-3).join(' ').slice(0, 500)}` : 'The program stopped.');
    for (const waiting of this.pending.values()) waiting.reject(why);
    this.pending.clear();
    this.handlers.exited(code, stderr);
  }
}

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import type { CliAuth, CliId } from '../../shared/chat';
import { childEnv } from './acp';
import { LOCAL_IDS, onPathAny, powerShellExe, programOf, refreshPath } from './clis';
import { LOCAL, type LocalId, findLocal, localModel, shortContext } from './localModels';
import { KEY_ENV, KeyRefusal, forgetKey, hasKey, keptHere, keptReadable, saveKey } from './keys';
import { readSettings } from './settings';

/**
 * Signing in to the person's AI tools, from the chat: each one asked, with
 * its own command, whether it is signed in; each one's own sign-in opened in a
 * window of its own (a console, where its browser sign-in or its menu runs as
 * it would in a terminal); a key given where the tool takes one.
 *
 * Recorded on 14 October:
 * - Claude Code: `claude auth status --json` ({ loggedIn, authMethod, email }),
 *   `claude auth login` (the Claude subscription, in the browser). It can say
 *   loggedIn while its token has expired: the chat's "not signed in" card is
 *   then the one that says so, and signing in again mends it.
 * - Codex: `codex login status` ("Logged in using ChatGPT"), `codex login`,
 *   and `codex login --with-api-key`, which reads the key on its input and
 *   keeps it itself.
 * - OpenCode: `opencode auth list` (one line a connection, "stored"),
 *   `opencode auth login` (its menu of providers).
 * - Gemini CLI: the personal Google sign-in is refused now; a key
 *   (GEMINI_API_KEY) is the way in.
 * - Qwen Code: its own sign-in was removed; an OpenAI-compatible key, with its
 *   address.
 *
 * - LM Studio and Ollama: no sign-in; whether their server is up, and with
 *   which models, asked over HTTP on 127.0.0.1 (localModels.ts).
 *
 * Claude Code, where it is not installed, is installed from here on Windows by
 * Anthropic's own installer (`irm https://claude.ai/install.ps1 | iex`,
 * code.claude.com/docs/en/setup, 21 October) in a console window, and its
 * sign-in opened when that ends: nobody has to find a terminal first. A
 * sign-in going on is asked after every few seconds, so the window updates when
 * it is done, not only when its console is closed.
 *
 * Nothing here runs through a shell, and no key is written anywhere but the
 * system's own encrypted store (keys.ts) or, for Codex, Codex's.
 */

const TOOLS: Array<{ id: CliId; login: string[] | null; key: CliAuth['key'] }> = [
  { id: 'claude', login: ['auth', 'login'], key: 'cortex' },
  { id: 'codex', login: ['login'], key: 'cli' },
  { id: 'opencode', login: ['auth', 'login'], key: null },
  { id: 'gemini', login: null, key: 'cortex' },
  { id: 'qwen', login: null, key: 'cortex' },
];

const STATUS_TIMEOUT = 20_000;
/** The e2e run (CORTEX_HIDDEN=1, electron/main.ts) signs in to stand-ins: their console is not put in front of the person at the machine. */
const SHOW_CONSOLE = process.env.CORTEX_HIDDEN !== '1';
/** While a sign-in window is open: asked this often whether it is done, for at most this long. */
const LOGIN_POLL = 4_000;
const LOGIN_WATCH = 10 * 60_000;

/**
 * The tools installed from here, each by its maker's own installer run by Windows' PowerShell, and where it puts the
 * program. Claude Code has an installer of its own; the others are npm packages (their makers' Windows instructions),
 * and npm comes with Node.js: where there is none, the console sets Node.js up first (nodeStep). 1 November: Node.js
 * was left to the person ("opencode node.js ne alaka… tarayıcıdan oturumunu açacak, bu kadar"); signing in is the
 * browser's, but the program has to be on the computer, and these four run on Node.js.
 */
const npm = (pkg: string, bin: string) => ({
  run: `npm install -g ${pkg}`,
  puts: `(Join-Path $env:APPDATA 'npm\\${bin}.cmd')`,
  from: `npm: ${pkg}`,
  node: true,
});
const INSTALLERS: Partial<Record<CliId, { run: string; puts: string; from: string; node?: boolean }>> = {
  claude: { run: 'irm https://claude.ai/install.ps1 | iex', puts: "(Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')", from: 'Anthropic: claude.ai/install.ps1' },
  opencode: npm('opencode-ai', 'opencode'),
  codex: npm('@openai/codex', 'codex'),
  gemini: npm('@google/gemini-cli', 'gemini'),
  qwen: npm('@qwen-code/qwen-code', 'qwen'),
};
const TOOL_NAMES: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code' } as Record<CliId, string>;

/** Told with the tool whose sign-in ended or was done; null for an install ended. */
let changed: (cli: CliId | null) => void = () => undefined;

/** Where the window hears that a sign-in window was closed: its statuses are asked again. */
export function onAuthChanged(listener: (cli: CliId | null) => void): void {
  changed = listener;
}

/** What `claude auth status --json` says. */
export function claudeStatus(text: string): { signedIn: boolean | null; detail: string | null } {
  try {
    const status = JSON.parse(text) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (typeof status.loggedIn !== 'boolean') return { signedIn: null, detail: null };
    const how = status.authMethod === 'claude.ai' ? 'Claude' : typeof status.authMethod === 'string' ? status.authMethod : null;
    const who = typeof status.email === 'string' && status.email ? status.email : null;
    return { signedIn: status.loggedIn, detail: status.loggedIn ? [how, who].filter(Boolean).join(' · ') || null : null };
  } catch {
    return { signedIn: null, detail: null };
  }
}

/** What `codex login status` says. */
export function codexStatus(text: string): { signedIn: boolean | null; detail: string | null } {
  if (/not logged in/i.test(text)) return { signedIn: false, detail: null };
  if (/logged in using chatgpt/i.test(text)) return { signedIn: true, detail: 'ChatGPT' };
  if (/logged in using an? api key/i.test(text)) return { signedIn: true, detail: 'API key' };
  if (/logged in/i.test(text)) return { signedIn: true, detail: null };
  return { signedIn: null, detail: null };
}

/** What `opencode auth list` says: the connections it keeps, by name. */
export function opencodeStatus(text: string): { signedIn: boolean | null; detail: string | null; names: string[] } {
  const names = text
    .split(/\r?\n/)
    .filter((line) => /\bstored\b/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0]?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 20);
  return { signedIn: names.length > 0, detail: names.length ? names.join(', ') : null, names };
}

/** One of the tool's own commands, its output, or null when it would not answer in time. */
function ask(id: CliId, args: string[]): Promise<string | null> {
  const program = programOf(id);
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(program.command, [...program.args, ...args], { cwd: os.homedir(), env: childEnv(program.env), timeout: STATUS_TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      resolve(err && !text ? null : text);
    });
  });
}

async function statusOf(tool: (typeof TOOLS)[number]): Promise<CliAuth> {
  const installed = programOf(tool.id) !== null;
  const base: CliAuth = {
    id: tool.id,
    installed,
    signedIn: null,
    detail: null,
    canLogin: installed && tool.login !== null && process.platform === 'win32',
    canInstall: !installed && Boolean(INSTALLERS[tool.id]) && process.platform === 'win32',
    key: installed ? tool.key : null,
    baseUrl: Boolean(KEY_ENV[tool.id]?.baseUrl),
    hasKey: hasKey(tool.id),
    kept: keptHere(tool.id),
  };
  if (!installed) return base;
  // A key kept here that this computer cannot read back (kept on another one, or under another Windows account) is not
  // one the tool starts with: said as set, the window called the tool signed in and it went without it (30 October).
  const variable = KEY_ENV[tool.id]?.variable;
  const keyUsable = keptReadable(tool.id) || Boolean(variable && process.env[variable]);
  // A key kept here is what the chat starts the tool with: said first.
  if (tool.key === 'cortex' && keptHere(tool.id) && keptReadable(tool.id)) return { ...base, signedIn: true, detail: 'API key' };
  if (tool.id === 'claude') return { ...base, ...claudeStatus((await ask('claude', ['auth', 'status', '--json'])) ?? '') };
  if (tool.id === 'codex') return { ...base, ...codexStatus((await ask('codex', ['login', 'status'])) ?? '') };
  if (tool.id === 'opencode') {
    const { signedIn, detail } = opencodeStatus((await ask('opencode', ['auth', 'list'])) ?? '');
    return { ...base, signedIn, detail };
  }
  return { ...base, signedIn: keyUsable, detail: keyUsable ? 'API key' : null };
}

/** A model server on this machine: up with its models, or installed and off, or not here; nothing to sign in to. */
async function localStatus(id: LocalId): Promise<CliAuth> {
  const found = await findLocal(id);
  const up = found.models.length > 0;
  const model = localModel(found, null);
  return {
    id,
    installed: up || onPathAny(LOCAL[id].tools),
    signedIn: up,
    detail: null,
    canLogin: false,
    canInstall: false,
    key: null,
    baseUrl: false,
    hasKey: false,
    kept: false,
    local: { models: found.models.length, loaded: found.loaded, shortContext: model && found.loaded.includes(model) ? shortContext(found, model) : null },
  };
}

/** Every tool, and whether it is signed in. Asked in parallel: a tool started for its status takes a second or two. A tool installed since the app started is found. */
export async function authStatuses(): Promise<CliAuth[]> {
  await refreshPath();
  return Promise.all([...TOOLS.map(statusOf), ...LOCAL_IDS.map(localStatus)]);
}

const toolOf = (id: unknown) => {
  const tool = TOOLS.find((one) => one.id === id);
  if (!tool) throw new KeyRefusal('Not a tool Cortex signs in to.');
  return tool;
};

/**
 * The tool's own sign-in, in a console window of its own: a program started
 * detached on Windows gets one, where a browser sign-in or a menu runs as it
 * would in a terminal. When the window is closed, the window is told, and
 * asks every status again.
 */
export function startLogin(id: unknown): void {
  const tool = toolOf(id);
  const program = programOf(tool.id);
  if (!tool.login || !program) throw new KeyRefusal('This tool is not signed in to from here.');
  if (process.platform !== 'win32') throw new KeyRefusal('Signing in from Cortex opens a console window, which only Windows does here.');
  const child = spawn(program.command, [...program.args, ...tool.login], { cwd: os.homedir(), env: childEnv(program.env), detached: true, stdio: 'ignore', windowsHide: !SHOW_CONSOLE, shell: false });
  let open = true;
  child.on('error', () => {
    open = false;
    changed(tool.id);
  });
  child.on('exit', () => {
    open = false;
    changed(tool.id);
  });
  child.unref();
  void watchLogin(tool, () => open);
}

/**
 * A sign-in going on, asked after until it is done: the browser's sign-in can end with its
 * console still open, or the person back in the app before closing it - and the window said
 * nothing changed until the app was opened again (21 October). Watched only from signed out.
 */
async function watchLogin(tool: (typeof TOOLS)[number], open: () => boolean): Promise<void> {
  if ((await statusOf(tool)).signedIn === true) return;
  const until = Date.now() + LOGIN_WATCH;
  while (open() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL));
    if (!open()) return;
    if ((await statusOf(tool)).signedIn === true) {
      changed(tool.id);
      return;
    }
  }
}

/**
 * What the installer's console runs: the installer as its maker gives it, and, where the
 * program is not where it puts it after, the console kept open until Enter so what went wrong
 * can be read. Single quotes only: a double quote does not survive Windows' command line.
 */
export function installScript(id: CliId, turkish: boolean): string {
  const installer = INSTALLERS[id];
  if (!installer) throw new KeyRefusal('Cortex does not install this tool.');
  const name = TOOL_NAMES[id] ?? id;
  const [going, failed] = turkish
    ? [`${name} kuruluyor (${installer.from})...`, `${name} kurulamadı. Yukarıda ne yazdığına bak; kapatmak için Enter`]
    : [`Installing ${name} (${installer.from})...`, `${name} was not installed. See what is written above; press Enter to close`];
  const run = installer.node ? `${nodeStep(turkish)}; ${installer.run}` : installer.run;
  return `Write-Host '${going}'; try { ${run} } catch { Write-Host $_ -ForegroundColor Red }; if (-not (Test-Path ${installer.puts})) { Read-Host '${failed}' }`;
}

const block = (head: string, body: string[]) => `${head} { ${body.join('; ')} }`;

/**
 * Node.js, where npm is not found, set up the way its own Windows installer would, without asking for an administrator:
 * the newest LTS release's Windows zip from nodejs.org, checked against the release's SHA-256 list, unpacked into
 * %LOCALAPPDATA%\Programs\nodejs; npm's global folder %APPDATA%\npm, as the installer's npmrc says (the zip has none, and
 * its npm would put the tools beside node.exe); both folders added to the person's PATH (the registry's own value, its
 * %…% names kept) and to this console's. One already unpacked there is taken as it is. The same single-quoted
 * PowerShell as the rest of the console's script, and only what Windows PowerShell has without a module.
 */
export function nodeStep(turkish: boolean): string {
  const going = turkish ? 'Önce Node.js kuruluyor (nodejs.org, LTS)...' : 'Setting up Node.js first (nodejs.org, LTS)...';
  const download = [
    `Write-Host '${going}'`,
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072',
    "$ProgressPreference = 'SilentlyContinue'",
    "$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }",
    // Parenthesised: Windows PowerShell hands a JSON array down the pipeline as one object.
    "$release = (Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -and ($_.files -contains ('win-' + $arch + '-zip')) } | Select-Object -First 1",
    "$name = 'node-' + $release.version + '-win-' + $arch",
    "$url = 'https://nodejs.org/dist/' + $release.version + '/'",
    "$zip = Join-Path $env:TEMP ($name + '.zip')",
    "$sums = Join-Path $env:TEMP ($name + '.SHASUMS256.txt')",
    "Invoke-WebRequest -UseBasicParsing ($url + $name + '.zip') -OutFile $zip",
    "Invoke-WebRequest -UseBasicParsing ($url + 'SHASUMS256.txt') -OutFile $sums",
    "$sum = Get-Content $sums | Where-Object { $_ -like ('*  ' + $name + '.zip') } | Select-Object -First 1",
    // .NET's own SHA-256, not Get-FileHash: a module command, missing where the PowerShell 7 modules come first on the
    // module path (a console started from PowerShell 7; the Windows CI runner).
    '$stream = [IO.File]::OpenRead($zip)',
    "$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-', '')",
    '$stream.Close()',
    block("if (-not $sum -or ($sum -split '\\s+')[0] -ne $hash)", ["throw ($name + '.zip: SHA-256')"]),
    // Unpacked beside where it goes, so it is moved within one drive.
    "$part = $node + '-indiriliyor'",
    block('if (Test-Path $part)', ['Remove-Item $part -Recurse -Force']),
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[IO.Compression.ZipFile]::ExtractToDirectory($zip, $part)',
    block('if (Test-Path $node)', ['Remove-Item $node -Recurse -Force']),
    'Move-Item (Join-Path $part $name) $node',
    'Remove-Item $part, $zip, $sums -Recurse -Force -ErrorAction SilentlyContinue',
    "Set-Content -Path (Join-Path $node 'node_modules\\npm\\npmrc') -Value 'prefix=${APPDATA}\\npm' -Encoding ASCII",
  ];
  const onPath = [
    'New-Item -ItemType Directory -Force $npmDir | Out-Null',
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    "$path = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "$kind = if ($path) { $key.GetValueKind('Path') } else { 'ExpandString' }",
    "$dirs = @($path -split ';' | Where-Object { $_ })",
    block('foreach ($dir in @($node, $npmDir))', [block('if ($dirs -notcontains $dir)', ['$dirs += $dir'])]),
    "$key.SetValue('Path', ($dirs -join ';'), $kind)",
    '$key.Close()',
    // Writing nothing, it tells the open windows that the environment changed, as an installer does.
    "[Environment]::SetEnvironmentVariable('CORTEX_PATH', $null, 'User')",
    "$env:Path = $node + ';' + $npmDir + ';' + $env:Path",
  ];
  // Any failure ends the step, and the console's catch says it: a download that failed went on to unpack nothing.
  return block('if (-not (Get-Command npm -ErrorAction SilentlyContinue))', [
    "$ErrorActionPreference = 'Stop'",
    "$node = Join-Path $env:LOCALAPPDATA 'Programs\\nodejs'",
    "$npmDir = Join-Path $env:APPDATA 'npm'",
    block("if (-not (Test-Path (Join-Path $node 'npm.cmd')))", download),
    ...onPath,
    "$ErrorActionPreference = 'Continue'",
  ]);
}

/**
 * A tool installed by its maker's own installer, in a console window of its own: Claude Code
 * by Anthropic's, the others by npm. When it ends, the PATH is read again, the window told, and the tool's
 * sign-in opened where it is not signed in yet.
 */
export async function installTool(id: unknown): Promise<void> {
  const tool = toolOf(id);
  if (!INSTALLERS[tool.id]) throw new KeyRefusal('Cortex does not install this tool.');
  if (process.platform !== 'win32') throw new KeyRefusal('Installing from Cortex opens a console window, which only Windows does here.');
  if (programOf(tool.id)) throw new KeyRefusal('This tool is installed already.');
  const script = installScript(tool.id, readSettings().language !== 'en');
  const child = spawn(powerShellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { cwd: os.homedir(), env: childEnv(), detached: true, stdio: 'ignore', windowsHide: !SHOW_CONSOLE, shell: false });
  let ended = false;
  const after = () => {
    if (ended) return;
    ended = true;
    void afterInstall(tool);
  };
  child.on('error', after);
  child.on('exit', after);
  child.unref();
}

async function afterInstall(tool: (typeof TOOLS)[number]): Promise<void> {
  await refreshPath(true);
  changed(null);
  if (!programOf(tool.id) || !tool.login) return;
  if ((await statusOf(tool)).signedIn === true) return;
  try {
    startLogin(tool.id);
  } catch {
    /* Its sign-in is still a button away. */
  }
}

/** A key for a tool: given to Codex itself, kept here for the others. */
export async function setToolKey(id: unknown, key: unknown, baseUrl: unknown): Promise<void> {
  const tool = toolOf(id);
  if (tool.key === 'cortex') {
    saveKey(tool.id, key, baseUrl);
    return;
  }
  if (tool.key !== 'cli') throw new KeyRefusal('This tool keeps its keys in its own sign-in.');
  if (typeof key !== 'string' || !key.trim() || key.length > 500 || /[\r\n]/.test(key)) throw new KeyRefusal('That is not a key.');
  const program = programOf(tool.id);
  if (!program) throw new KeyRefusal('Codex is not installed on this machine.');
  // On its input, never as an argument: an argument is seen by anything that lists processes.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program.command, [...program.args, 'login', '--with-api-key'], { cwd: os.homedir(), env: childEnv(program.env), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new KeyRefusal(stderr.trim().split('\n').pop() || 'Codex did not take the key.'))));
    child.stdin.end(`${key.trim()}\n`);
  });
}

export function forgetToolKey(id: unknown): void {
  const tool = toolOf(id);
  if (tool.key === 'cortex') forgetKey(tool.id);
}

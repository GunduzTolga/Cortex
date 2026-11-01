import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app } from 'electron';
import { authStatuses, claudeStatus, codexStatus, installScript, installTool, nodeStep, opencodeStatus, setToolKey, startLogin } from '../electron/services/auth';
import { READ_PATH, pathOutput, powerShellExe, withDirs } from '../electron/services/clis';
import { forgetKey, hasKey, keyEnv, saveKey } from '../electron/services/keys';

/**
 * Signing in to the AI tools from the chat (electron/services/auth.ts) and
 * the keys kept for those that take one from their environment
 * (electron/services/keys.ts). The tools' answers are as they were recorded
 * on 14 October.
 */

test('each tool’s own word on its sign-in is read: Claude Code’s JSON, Codex’s sentence, OpenCode’s list of connections', () => {
  assert.deepEqual(claudeStatus('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "kisi@example.com"}'), { signedIn: true, detail: 'Claude · kisi@example.com' });
  assert.deepEqual(claudeStatus('{"loggedIn": false}'), { signedIn: false, detail: null });
  assert.deepEqual(claudeStatus('error: something'), { signedIn: null, detail: null }, 'what cannot be read is not known');
  assert.deepEqual(codexStatus('Logged in using ChatGPT'), { signedIn: true, detail: 'ChatGPT' });
  assert.deepEqual(codexStatus('Logged in using an API key - sk-***'), { signedIn: true, detail: 'API key' });
  assert.deepEqual(codexStatus('Not logged in'), { signedIn: false, detail: null });
  const listed = opencodeStatus('OpenCode Go       API key                     stored\nLMStudio          API key                     stored\n\n');
  assert.deepEqual(listed, { signedIn: true, detail: 'OpenCode Go, LMStudio', names: ['OpenCode Go', 'LMStudio'] });
  assert.equal(opencodeStatus('').signedIn, false);
});

test('a key is kept encrypted, never as written; it becomes its tool’s environment, with its address; a key that is not one is refused', () => {
  const file = path.join(app.getPath('userData'), 'keys.json');
  saveKey('gemini', 'AIza-secret-key', undefined);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('AIza-secret-key'), 'not on disk as written');
  assert.deepEqual(keyEnv('gemini'), { GEMINI_API_KEY: 'AIza-secret-key' });
  assert.equal(hasKey('gemini', {}), true);
  saveKey('qwen', 'sk-qwen', 'https://dashscope.example.com/compatible-mode/v1');
  assert.deepEqual(keyEnv('qwen'), { OPENAI_API_KEY: 'sk-qwen', OPENAI_BASE_URL: 'https://dashscope.example.com/compatible-mode/v1' });
  assert.throws(() => saveKey('qwen', 'sk', 'javascript:alert(1)'), /not an address/);
  assert.throws(() => saveKey('gemini', 'two\nlines', undefined), /not a key/);
  assert.throws(() => saveKey('gemini', '   ', undefined), /not a key/);
  assert.throws(() => saveKey('codex', 'sk', undefined), /does not take a key here/, 'Codex keeps its own');
  forgetKey('gemini');
  assert.deepEqual(keyEnv('gemini'), {});
  assert.equal(hasKey('gemini', {}), false);
  assert.equal(hasKey('gemini', { GEMINI_API_KEY: 'theirs' }), true, 'a key already in the person’s environment counts');
});

test('a keys file Windows says is busy is not written over: a new key never takes the other tools’ keys with it', () => {
  const file = path.join(app.getPath('userData'), 'keys.json');
  saveKey('qwen', 'sk-qwen', undefined);
  const before = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  // A scanner holding the file just written: the read fails, as Windows fails it.
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (target === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return (read as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => saveKey('gemini', 'AIza-new', undefined), /could not be read just now/);
    assert.throws(() => forgetKey('qwen'), /could not be read just now/);
    assert.deepEqual(keyEnv('qwen'), {}, 'a reader takes it as none for now, and starts the tool without');
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = read;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file as it was');
  assert.deepEqual(keyEnv('qwen'), { OPENAI_API_KEY: 'sk-qwen' });
  forgetKey('qwen');
});

test('with no tool installed, each is said to be missing and nothing is offered; a sign-in or a key for one is refused', async () => {
  const kept = { PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot };
  process.env.PATH = '';
  /*
    On Windows the PATH is read again from the machine's and the person's (clis.ts refreshPath), with
    Claude Code's installer's folder beside it: a machine with the tools installed saw them all here
    (29 October, the owner's PC). Its PowerShell not found and a home with nothing in it, nothing is added.
  */
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-home-'));
  process.env.USERPROFILE = emptyHome;
  process.env.HOME = emptyHome;
  process.env.SystemRoot = emptyHome;
  // The model servers asked where nothing answers.
  process.env.CORTEX_TEST_LMSTUDIO = 'http://127.0.0.1:9';
  process.env.CORTEX_TEST_OLLAMA = 'http://127.0.0.1:9';
  try {
    const statuses = await authStatuses();
    assert.deepEqual(statuses.map((one) => one.id), ['claude', 'codex', 'opencode', 'gemini', 'qwen', 'lmstudio', 'ollama']);
    const [tools, servers] = [statuses.slice(0, 5), statuses.slice(5)];
    assert.ok(tools.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === null && !one.local));
    // Installed from the app in a console window, Windows only: Claude Code by Anthropic's installer, the others by npm
    // (1 November: a fresh install offered only Claude Code; OpenCode could not be had from the app).
    assert.deepEqual(tools.filter((one) => one.canInstall).map((one) => one.id), process.platform === 'win32' ? ['claude', 'codex', 'opencode', 'gemini', 'qwen'] : []);
    assert.ok(servers.every((one) => !one.canInstall));
    if (process.platform !== 'win32') await assert.rejects(installTool('claude'), /only Windows/);
    if (process.platform !== 'win32') await assert.rejects(installTool('opencode'), /only Windows/);
    await assert.rejects(installTool('nope'), /Not a tool/);
    assert.ok(servers.every((one) => !one.installed && !one.canLogin && one.key === null && one.signedIn === false && one.local?.models === 0), 'a model server off and not installed: nothing to sign in to');
    assert.throws(() => startLogin('claude'), /not signed in to from here/);
    assert.throws(() => startLogin('nope'), /Not a tool/);
    await assert.rejects(setToolKey('codex', 'sk-test', undefined), /not installed/);
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(emptyHome, { recursive: true, force: true });
    delete process.env.CORTEX_TEST_LMSTUDIO;
    delete process.env.CORTEX_TEST_OLLAMA;
  }
});

test('Claude Code is installed by Anthropic’s own installer, its window kept open only when the program is not where it puts it', () => {
  const script = installScript('claude', true);
  assert.ok(script.includes('irm https://claude.ai/install.ps1 | iex'), 'the command code.claude.com gives for PowerShell');
  assert.ok(script.includes("Test-Path (Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')"), 'checked where the installer puts it');
  assert.ok(script.includes("Read-Host 'Claude Code kurulamadı."), 'in the window’s language');
  assert.ok(installScript('claude', false).includes('Claude Code was not installed.'));
  // Windows' command line keeps single quotes as they are; a double quote, or a quote inside a quoted sentence, would break it.
  for (const one of [installScript('claude', true), installScript('claude', false)]) {
    assert.ok(!one.includes('"'), 'no double quote');
    for (const said of one.match(/'[^']*'/g) ?? []) assert.ok(!said.slice(1, -1).includes("'"), said);
  }
  assert.throws(() => installScript('nope' as never, true), /does not install/);
});

test('OpenCode, Codex, Gemini CLI and Qwen Code are installed by npm, Node.js set up first where npm is missing', () => {
  const expected = { opencode: 'opencode-ai', codex: '@openai/codex', gemini: '@google/gemini-cli', qwen: '@qwen-code/qwen-code' } as const;
  for (const [id, pkg] of Object.entries(expected)) {
    for (const turkish of [true, false]) {
      const script = installScript(id as keyof typeof expected, turkish);
      assert.ok(script.includes(`npm install -g ${pkg}`), `${id}: its npm package`);
      assert.ok(script.indexOf(nodeStep(turkish)) >= 0 && script.indexOf(nodeStep(turkish)) < script.indexOf('npm install'), `${id}: Node.js before npm`);
      assert.ok(script.includes(`'npm\\${id}.cmd'`), `${id}: checked where npm puts it`);
      assert.ok(!script.includes('"'), 'no double quote');
      for (const said of script.match(/'[^']*'/g) ?? []) assert.ok(!said.slice(1, -1).includes("'"), said);
    }
  }
  assert.ok(!installScript('claude', true).includes('nodejs'), 'Claude Code needs no Node.js');
  assert.ok(installScript('opencode', true).includes('OpenCode kuruluyor'), 'named in the window’s language');
  const step = nodeStep(true);
  assert.ok(step.startsWith('if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {'), 'only where npm is not found');
  assert.ok(step.includes("'https://nodejs.org/dist/index.json'") && step.includes("'SHASUMS256.txt'") && step.includes('SHA256]::Create().ComputeHash($stream)') && !step.includes('Get-FileHash'), 'from nodejs.org, checked');
  assert.ok(step.includes("Join-Path $env:LOCALAPPDATA 'Programs\\nodejs'"), 'for this person, no administrator');
  assert.ok(step.includes("'prefix=${APPDATA}\\npm'"), 'npm’s global folder where its installer would have it');
  assert.ok(step.includes("'DoNotExpandEnvironmentNames'"), 'the PATH’s %…% names kept');
  assert.ok(step.includes('Önce Node.js kuruluyor') && nodeStep(false).includes('Setting up Node.js first'));
  assert.ok(!/[{;]\s*;|;\s*}/.test(step), 'no empty statement');
});

/** Windows' own PowerShell, given what a script would be given: the console's script as one argument, as installTool does. */
function powerShell(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(powerShellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env, timeout: 600_000, windowsHide: true });
}

test('every install console’s script is PowerShell without a fault (Windows)', { skip: process.platform !== 'win32' }, () => {
  for (const id of ['claude', 'opencode', 'codex', 'gemini', 'qwen'] as const) {
    for (const turkish of [true, false]) {
      const parse = '$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:CORTEX_SCRIPT, [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.Message }';
      assert.equal(powerShell(['-Command', parse], { ...process.env, CORTEX_SCRIPT: installScript(id, turkish) }).trim(), '', `${id} ${turkish ? 'tr' : 'en'}`);
    }
  }
});

// Downloads Node.js and writes the person's PATH: on a CI runner only, whose PATH is put back after.
test('Node.js is set up where npm is missing: unpacked for the person, npm’s global folder in %APPDATA%, both on the PATH (Windows CI)', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true', timeout: 600_000 }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-node-'));
  const [local, roaming, temp] = ['Yerel', 'Dolaşan', 'Geçici'].map((name) => path.join(base, name));
  for (const dir of [local, roaming, temp]) fs.mkdirSync(dir, { recursive: true });
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const env = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, TEMP: temp, TMP: temp, PATH: [path.join(system, 'System32'), system, path.dirname(powerShellExe())].join(';') };
  delete env.Path;
  // Run under `npm test`, npm's own settings are in the environment (npm_config_*): a prefix there would hide the one set up.
  for (const key of Object.keys(env)) if (/^npm_/i.test(key)) delete env[key];
  const readPath = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [string](Get-Item 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')";
  const before = powerShell(['-Command', readPath]).trim();
  try {
    const said = powerShell(['-Command', `${nodeStep(false)}; Write-Host ('NPM=' + (Get-Command npm).Source)`], env);
    const node = path.join(local, 'Programs', 'nodejs');
    assert.ok(fs.existsSync(path.join(node, 'node.exe')) && fs.existsSync(path.join(node, 'npm.cmd')), said);
    // A folder said by its short name (RUNNER~1) or its long one is the same folder.
    const real = (dir: string) => {
      try {
        return fs.realpathSync.native(dir).toLowerCase();
      } catch {
        return dir.toLowerCase();
      }
    };
    const npmSaid = /NPM=(.+)/.exec(said)?.[1]?.trim() ?? '';
    assert.equal(real(path.dirname(npmSaid)), real(node), `this console's npm is the one set up: ${said}`);
    assert.ok(!fs.existsSync(`${node}-indiriliyor`), 'nothing half-unpacked left');
    const prefix = execFileSync(path.join(node, 'node.exe'), [path.join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'prefix', '-g'], { encoding: 'utf8', env: { ...env, PATH: `${node};${env.PATH}` } }).trim();
    assert.equal(real(prefix), real(path.join(roaming, 'npm')), 'npm -g puts the tools in %APPDATA%\\npm, where Cortex looks');
    const after = powerShell(['-Command', readPath]).trim().split(';').map(real);
    for (const dir of [node, path.join(roaming, 'npm')]) assert.ok(after.includes(real(dir)), `${dir} on the person's PATH`);
    // Set up already: taken as it is, nothing downloaded again.
    const again = powerShell(['-Command', nodeStep(false)], env);
    assert.ok(!again.includes('Setting up Node.js'), again);
  } finally {
    powerShell(['-Command', "[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment').SetValue('Path', $env:CORTEX_PATH_BEFORE, 'ExpandString')"], { ...process.env, CORTEX_PATH_BEFORE: before });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the PATH is read again for a tool installed while the app was open: what it lacks is added after it, once, whatever its case', () => {
  assert.equal(withDirs('C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm', ['c:\\windows\\', 'C:\\Users\\Tolga\\.local\\bin', '', 'C:\\Users\\Tolga\\.local\\bin'], ';'), 'C:\\Windows;C:\\Users\\Tolga\\AppData\\Roaming\\npm;C:\\Users\\Tolga\\.local\\bin');
  assert.equal(withDirs('', ['C:\\a'], ';'), 'C:\\a');
  // PowerShell writes the machine's PATH and the person's, one a line, as UTF-8 (a BOM dropped): a Turkish folder comes back whole.
  assert.deepEqual(pathOutput('\uFEFFC:\\Windows\\system32;C:\\Windows;\r\nC:\\Users\\Tolga Gündüz\\.local\\bin;\r\n'), ['C:\\Windows\\system32', 'C:\\Windows', 'C:\\Users\\Tolga Gündüz\\.local\\bin']);
  assert.ok(READ_PATH.includes("GetEnvironmentVariable('Path', 'User')") && READ_PATH.includes('UTF8Encoding $false'));
});

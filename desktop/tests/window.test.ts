import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The window's rules, read from the source: each of them is a line that a
 * later change could drop without any other test noticing, and each one is
 * the difference between a page that can only ask the main process and one
 * that can reach the disk or the network itself.
 */

const main = fs.readFileSync('electron/main.ts', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

test('the page is isolated: no node, a sandboxed preload, no webview', () => {
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /webviewTag: false/);
  assert.doesNotMatch(main, /sandbox: false|contextIsolation: false|nodeIntegration: true|webSecurity: false/);
});

test('no new window, no navigation away, and every permission refused', () => {
  assert.match(main, /setWindowOpenHandler\([\s\S]*?action: 'deny'/);
  assert.match(main, /'will-navigate'[\s\S]*?preventDefault\(\)/);
  assert.match(main, /'will-attach-webview'/);
  assert.match(main, /setPermissionRequestHandler\(\(_contents, _permission, answer\) => answer\(false\)\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /onBeforeRequest/);
});

test("the spellchecker's dictionaries are never fetched from Google: their address is this machine", () => {
  const url = main.match(/setSpellCheckerDictionaryDownloadURL\('([^']+)'\)/)?.[1] ?? '';
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('the page’s policy loads nothing from the network: no image, no script, no connection', () => {
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
  assert.ok(policy, 'a policy is there');
  const rule = (name: string) => policy.match(new RegExp(`${name} ([^;]+)`))?.[1].trim() ?? '';
  assert.equal(rule('default-src'), "'none'");
  assert.equal(rule('script-src'), "'self'");
  assert.equal(rule('img-src'), "'self' data:");
  assert.equal(rule('connect-src'), "'self'");
  assert.doesNotMatch(policy, /https?:|\*/, 'no host and no wildcard anywhere in it');
});

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test('a command is run with execFile and its arguments, never through a shell', () => {
  for (const file of ['core', 'electron', 'shared', 'src'].flatMap(sources)) {
    const text = fs.readFileSync(file, 'utf8');
    // `exec` as a function of child_process, not a regular expression's method (`HEADING.exec(line)`).
    assert.doesNotMatch(text, /(?<![.\w])exec(Sync)?\(|shell: true|\bspawn\([^)]*shell/, file);
  }
});

test('nothing is opened by its own program: a file is shown in its folder', () => {
  for (const file of ['electron'].flatMap(sources)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /shell\.openPath\(/, file);
});

test("on Windows the window's icon is the seal's .ico, every small size in it smoothed, and it ships with the app", () => {
  // A 200px PNG shrunk to the title bar's 16-20px by the frame showed every pixel.
  assert.match(main, /process\.platform === 'win32' \? 'pyn\.ico'/);
  const packaged = JSON.parse(fs.readFileSync('package.json', 'utf8')).build.extraResources as { from: string; to: string }[];
  assert.ok(packaged.some((one) => one.from.endsWith('/pyn.ico') && one.to === 'pyn.ico'), 'pyn.ico is beside the packaged bundle');
  // The ICONDIR: a count at byte 4, then 16-byte entries whose first byte is the width (0 for 256).
  const ico = fs.readFileSync(path.join('..', 'tema', 'ananas', 'marka', 'pyn.ico'));
  const widths = Array.from({ length: ico.readUInt16LE(4) }, (_, n) => ico[6 + n * 16] || 256);
  for (const size of [16, 20, 24, 32]) assert.ok(widths.includes(size), `the .ico holds ${size}px`);
});

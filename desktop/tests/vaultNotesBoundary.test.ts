import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The whole-vault reader (electron/services/vaultNotes.ts) is the person's: it
 * reads every note of the vault but the hidden ones, and what it reads goes to
 * the notes screen and stops there. Krewgent's boundary test, cut to this app:
 * the one module that may import the reader is the IPC module, and there only
 * in its notes channels and where a vault is chosen. When the later stages
 * bring a terminal and Cortex's installer, what they hand a CLI must not come
 * from this reader; this test is where that is held.
 */

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('only the IPC module imports the whole-vault reader', () => {
  const importers = ['core', 'electron', 'shared', 'src']
    .flatMap(sources)
    .filter((file) => /services\/vaultNotes['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => file.split(path.sep).join('/'));
  assert.deepEqual(importers, ['electron/ipc.ts']);
});

test('and uses it in the notes channels and where a vault is chosen, nowhere else', () => {
  const lines = fs.readFileSync('electron/ipc.ts', 'utf8').split('\n');
  const uses = lines.map((line, at) => ({ line, at })).filter(({ line }) => !line.trim().startsWith('//') && /\bvaultNotes\.\w+\(/.test(line));
  assert.ok(uses.length >= 12);
  for (const { line, at } of uses) {
    const around = lines.slice(Math.max(0, at - 3), at + 1).join('\n');
    assert.ok(/handle\('notes:/.test(around) || /stopWatchingVault/.test(line), `electron/ipc.ts:${at + 1} ${line.trim()}`);
  }
});

test('the window reaches the disk through the bridge alone: no node, no electron, no path of its own', () => {
  for (const file of sources('src')) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/from ['"](node:|electron|fs|path|child_process)/.test(text), file);
    assert.ok(!/\brequire\(/.test(text), file);
    assert.ok(!/window\.krewgent/.test(text), `${file} still calls Krewgent's bridge`);
  }
});

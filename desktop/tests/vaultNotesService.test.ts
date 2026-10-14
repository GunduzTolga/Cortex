import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app, shellCalls } from 'electron';
import { updateSettings } from '../electron/services/settings';
import {
  createVaultFolder,
  createVaultNote,
  openVaultEntry,
  readVaultNote,
  moveVaultEntry,
  renameVaultEntry,
  saveVaultNote,
  searchVault,
  trashVaultEntry,
  vaultAsset,
  vaultBacklinks,
  vaultIndex,
} from '../electron/services/vaultNotes';

/**
 * The whole vault, for the person's own notes screen
 * (electron/services/vaultNotes.ts): read as Obsidian shows it less what is
 * hidden, never through a link, and written only as the person saved it over
 * the version they read. Krewgent's tests of the same reader, carried with it
 * (desktop/KAYNAK.md); its Hermes test is not, as this app has no Hermes.
 */

const links = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-probe-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  }
})();

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

function vault(): string {
  // By the real path the disk gives, as the app keeps a chosen vault (electron/services/vault.ts): on Windows the temporary folder can come by its 8.3 short name.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-vault-')));
  const write = (relative: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text);
  };
  write('Proje planı.md', '---\ntags: [plan]\n---\n# Plan\n\nSee [[Tadilat#Mutfak|mutfak]] and [[Yazılacak]].\n');
  write('Ev/Tadilat.md', '# Tadilat\n\n## Mutfak\n\nBack to [[Proje planı]]. ![[çizim.png]]\n');
  write('Ev/Liste.md', 'Bu hafta tadilat bitmeli. [plan](../Proje%20plan%C4%B1.md)\n');
  write('ekler/çizim.png', PNG);
  write('ekler/run.bat', 'echo hi');
  write('Latin1.md', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  write('.obsidian/workspace.json', '{}');
  write('.git/HEAD', 'ref: refs/heads/main\n');
  write('Ev/.gizli.md', '# hidden\n');
  write('.beyin/state.md', '# state\n');
  return dir;
}

function useVault(dir: string | null): void {
  updateSettings((settings) => {
    settings.vault = dir;
  });
}

const hashOf = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('the index lists the notes and files Obsidian would show, hidden ones never, with links resolved and the missing ones named', async () => {
  const dir = vault();
  if (links) fs.symlinkSync(os.tmpdir(), path.join(dir, 'Dışarı'), 'dir');
  useVault(dir);
  const index = await vaultIndex();
  assert.deepEqual(index.vault, { name: path.basename(dir) });
  assert.deepEqual(index.notes.map((one) => one.path).sort(), ['Ev/Liste.md', 'Ev/Tadilat.md', 'Latin1.md', 'Proje planı.md']);
  assert.deepEqual(index.files.map((one) => one.path).sort(), ['ekler/run.bat', 'ekler/çizim.png']);
  assert.deepEqual(index.folders.sort(), ['Ev', 'ekler'], 'no hidden folder, and a link is not a folder of the vault');
  const plan = index.notes.find((one) => one.path === 'Proje planı.md')!;
  assert.deepEqual(plan.links, ['Ev/Tadilat.md']);
  assert.deepEqual(plan.unresolved, ['Yazılacak']);
  assert.deepEqual(plan.tags, ['plan']);
  assert.deepEqual(index.notes.find((one) => one.path === 'Ev/Tadilat.md')!.links.sort(), ['Proje planı.md', 'ekler/çizim.png']);
  assert.deepEqual(index.notes.find((one) => one.path === 'Ev/Liste.md')!.links, ['Proje planı.md'], 'a Markdown link, decoded, from its own folder');
  assert.equal(index.readOnly, null);

  fs.writeFileSync(path.join(dir, 'Yazılacak.md'), '# now written\n');
  const again = await vaultIndex();
  assert.deepEqual(again.notes.find((one) => one.path === 'Proje planı.md')!.unresolved, [], 'read again where a file changed');
});

test('a note is read inside the vault only: not hidden, not up and out, not through a link', async () => {
  const dir = vault();
  useVault(dir);
  const read = await readVaultNote('Ev/Tadilat.md');
  assert.equal(read.text, fs.readFileSync(path.join(dir, 'Ev/Tadilat.md'), 'utf8'));
  assert.equal(read.hash, hashOf(fs.readFileSync(path.join(dir, 'Ev/Tadilat.md'))));
  assert.equal(read.readOnly, null);
  for (const bad of ['../outside.md', 'Ev/../../x.md', '.obsidian/workspace.json', 'Ev/.gizli.md', '/etc/passwd', 'ekler/run.bat', 'Ev\\..\\..\\x.md']) {
    await assert.rejects(readVaultNote(bad), undefined, bad);
  }
  if (links) {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'Özel.md'), '# private\n');
    fs.symlinkSync(outside, path.join(dir, 'Bağ'), 'dir');
    await assert.rejects(readVaultNote('Bağ/Özel.md'), /link/);
  }
  const latin = await readVaultNote('Latin1.md');
  assert.equal(latin.readOnly, 'encoding', 'shown, and never saved over bytes that are not UTF-8');
  await assert.rejects(saveVaultNote('Latin1.md', 'x', latin.hash), undefined);
});

test('a save is written over the version read and no other; a note changed meanwhile is handed back', async () => {
  const dir = vault();
  useVault(dir);
  const file = path.join(dir, 'Ev/Tadilat.md');
  const read = await readVaultNote('Ev/Tadilat.md');
  const saved = await saveVaultNote('Ev/Tadilat.md', '# Tadilat\n\nYeni.\n', read.hash);
  assert.equal(saved.saved, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Tadilat\n\nYeni.\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Ev')).filter((one) => one.endsWith('.tmp')), [], 'no temporary left');

  fs.writeFileSync(file, '# Tadilat\n\nObsidian wrote this.\n');
  const stale = await saveVaultNote('Ev/Tadilat.md', '# Mine\n', read.hash);
  assert.equal(stale.saved, false);
  assert.ok(!stale.saved && stale.current.text.includes('Obsidian wrote this.'));
  assert.equal(fs.readFileSync(file, 'utf8'), '# Tadilat\n\nObsidian wrote this.\n', 'nothing written over it');
  await assert.rejects(saveVaultNote('Ev/Yok.md', 'x', 'h'), undefined, 'a save is of a note that is there');
});

test('a new note is made exclusively, under a free name when asked, and a name a wiki link or Windows would not take is refused', async () => {
  const dir = vault();
  useVault(dir);
  assert.deepEqual(await createVaultNote('Ev', 'Adsız', { unique: true }), { path: 'Ev/Adsız.md' });
  assert.deepEqual(await createVaultNote('Ev', 'Adsız', { unique: true }), { path: 'Ev/Adsız 1.md' });
  await assert.rejects(createVaultNote('Ev', 'Tadilat'), /already/);
  assert.equal(fs.readFileSync(path.join(dir, 'Ev/Tadilat.md'), 'utf8').startsWith('# Tadilat'), true, 'not written over');
  for (const bad of ['a/b', '../x', '.gizli', 'a#b', 'CON']) await assert.rejects(createVaultNote('', bad), undefined, bad);
  await assert.rejects(createVaultNote('.obsidian', 'x'), undefined, 'not into a hidden folder');
  assert.deepEqual(await createVaultNote('', 'Kök', { text: '# Kök\n' }), { path: 'Kök.md' });
  assert.equal(fs.readFileSync(path.join(dir, 'Kök.md'), 'utf8'), '# Kök\n');
  assert.deepEqual(await createVaultFolder('Ev', 'Bahçe'), { path: 'Ev/Bahçe' });
  assert.ok(fs.statSync(path.join(dir, 'Ev/Bahçe')).isDirectory());
});

test('a rename points every link to the note at its new name, and refuses a name another file has', async () => {
  const dir = vault();
  useVault(dir);
  await vaultIndex();
  await assert.rejects(renameVaultEntry('Ev/Tadilat.md', 'Liste'), /already/);
  const renamed = await renameVaultEntry('Ev/Tadilat.md', 'Yenileme');
  assert.equal(renamed.path, 'Ev/Yenileme.md');
  assert.deepEqual(renamed.updated, ['Proje planı.md']);
  assert.deepEqual(renamed.skipped, []);
  assert.ok(!fs.existsSync(path.join(dir, 'Ev/Tadilat.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'Proje planı.md'), 'utf8'), '---\ntags: [plan]\n---\n# Plan\n\nSee [[Yenileme#Mutfak|mutfak]] and [[Yazılacak]].\n');
  const moved = await renameVaultEntry('Proje planı.md', 'Ana plan');
  assert.deepEqual(moved.updated.sort(), ['Ev/Liste.md', 'Ev/Yenileme.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'Ev/Liste.md'), 'utf8'), 'Bu hafta tadilat bitmeli. [plan](../Ana%20plan.md)\n');
  // Its first heading was its old name, and took the new one with the rename.
  assert.equal(fs.readFileSync(path.join(dir, 'Ev/Yenileme.md'), 'utf8'), '# Yenileme\n\n## Mutfak\n\nBack to [[Ana plan]]. ![[çizim.png]]\n');
});

test('a note moved into another folder keeps its links by name, and every link by path or Markdown follows it', async () => {
  const dir = vault();
  useVault(dir);
  fs.mkdirSync(path.join(dir, 'Arşiv'));
  fs.writeFileSync(path.join(dir, 'Yollar.md'), '[[Ev/Tadilat]] and [[Tadilat]]\n');
  await vaultIndex();
  const moved = await moveVaultEntry('Ev/Tadilat.md', 'Arşiv');
  assert.equal(moved.path, 'Arşiv/Tadilat.md');
  assert.deepEqual(moved.updated.sort(), ['Yollar.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'Yollar.md'), 'utf8'), '[[Tadilat]] and [[Tadilat]]\n');
  assert.equal(fs.readFileSync(path.join(dir, 'Proje planı.md'), 'utf8').includes('[[Tadilat#Mutfak|mutfak]]'), true, 'a link by name is not churned');
  await assert.rejects(moveVaultEntry('Arşiv/Tadilat.md', '.obsidian'), undefined, 'not into what is hidden');
  await assert.rejects(moveVaultEntry('Arşiv/Tadilat.md', 'Yok'), undefined, 'not into a folder that is not there');
});

test('a folder renamed or moved takes everything in it, but never into itself, and a name taken is refused', async () => {
  const dir = vault();
  useVault(dir);
  fs.mkdirSync(path.join(dir, 'Arşiv'));
  fs.writeFileSync(path.join(dir, 'Arşiv', 'Liste.md'), '# başka\n');
  await vaultIndex();
  await assert.rejects(moveVaultEntry('Ev', 'Ev'), /inside itself/);
  await assert.rejects(renameVaultEntry('Ev', 'Arşiv'), /already/);
  const renamed = await renameVaultEntry('Ev', 'Konut');
  assert.equal(renamed.path, 'Konut');
  assert.ok(fs.existsSync(path.join(dir, 'Konut', 'Tadilat.md')) && !fs.existsSync(path.join(dir, 'Ev')));
  // Liste.md links to the plan by a Markdown path from its folder, which moved with it and still finds it one level up.
  assert.equal(fs.readFileSync(path.join(dir, 'Konut', 'Liste.md'), 'utf8'), 'Bu hafta tadilat bitmeli. [plan](../Proje%20plan%C4%B1.md)\n');
  await assert.rejects(moveVaultEntry('Konut/Liste.md', 'Arşiv'), /already/);
  const image = await renameVaultEntry('ekler/çizim.png', 'kroki.png');
  assert.equal(image.path, 'ekler/kroki.png');
  assert.equal(fs.readFileSync(path.join(dir, 'Konut', 'Tadilat.md'), 'utf8'), '# Tadilat\n\n## Mutfak\n\nBack to [[Proje planı]]. ![[kroki.png]]\n', 'an embed follows a renamed image');
});

test('backlinks name the lines that link, and unlinked mentions the notes that name it as a whole word', async () => {
  const dir = vault();
  useVault(dir);
  const back = await vaultBacklinks('Ev/Tadilat.md');
  assert.deepEqual(back.linked, [{ from: 'Proje planı.md', lines: [{ line: 5, text: 'See [[Tadilat#Mutfak|mutfak]] and [[Yazılacak]].' }] }]);
  assert.deepEqual(back.unlinked, [{ from: 'Ev/Liste.md', lines: [{ line: 0, text: 'Bu hafta tadilat bitmeli. [plan](../Proje%20plan%C4%B1.md)' }] }]);
});

test('search finds every word, in title or body, and a tag', async () => {
  const dir = vault();
  useVault(dir);
  const found = await searchVault('mutfak');
  assert.deepEqual(found.hits.map((one) => one.path).sort(), ['Ev/Tadilat.md', 'Proje planı.md']);
  assert.deepEqual((await searchVault('tag:plan')).hits.map((one) => one.path), ['Proje planı.md']);
  assert.deepEqual((await searchVault('tadilat')).hits[0].path, 'Ev/Tadilat.md', 'the title first');
  assert.deepEqual((await searchVault('   ')).hits, []);
});

test('an image is a data URL; what is not an image, or is hidden, is not sent', async () => {
  const dir = vault();
  useVault(dir);
  assert.equal(await vaultAsset('ekler/çizim.png'), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(await vaultAsset('ekler/run.bat'), null);
  await assert.rejects(vaultAsset('.obsidian/workspace.json'));
});

test('outside the app a note opens in Obsidian or its folder, never by its own program, and the bin is the system’s', async () => {
  const dir = vault();
  useVault(dir);
  shellCalls.length = 0;
  (app as unknown as { protocolApps: Record<string, string> }).protocolApps = {};
  assert.deepEqual(await openVaultEntry('Ev/Tadilat.md', 'obsidian'), { opened: false, reason: 'no-obsidian' });
  (app as unknown as { protocolApps: Record<string, string> }).protocolApps = { 'obsidian://': 'Obsidian' };
  assert.deepEqual(await openVaultEntry('Ev/Tadilat.md', 'obsidian'), { opened: true });
  assert.deepEqual(shellCalls[0], ['openExternal', `obsidian://open?path=${encodeURIComponent(path.join(dir, 'Ev', 'Tadilat.md'))}`]);
  await openVaultEntry('ekler/run.bat', 'folder');
  assert.deepEqual(shellCalls[1], ['showItemInFolder', path.join(dir, 'ekler', 'run.bat')]);
  await assert.rejects(openVaultEntry('ekler/run.bat', 'program'));
  await trashVaultEntry('Ev/Liste.md');
  assert.deepEqual(shellCalls[2], ['trashItem', path.join(dir, 'Ev', 'Liste.md')]);
  await assert.rejects(trashVaultEntry(''), /vault itself/);
});

test("a new note made from Cortex's template is filled for the free name it got, and a rename brings its title along", async () => {
  const dir = vault();
  useVault(dir);
  const template = '---\ntitle:\ncreated: {{TODAY}}\ntype: note\n---\n# \n';
  const made = await createVaultNote('', 'Adsız', { unique: true, template });
  assert.equal(made.path, 'Adsız.md');
  const again = await createVaultNote('', 'Adsız', { unique: true, template });
  assert.equal(again.path, 'Adsız 1.md');
  assert.match(fs.readFileSync(path.join(dir, 'Adsız 1.md'), 'utf8'), /^---\ntitle: "Adsız 1"\ncreated: \d{4}-\d{2}-\d{2}\ntype: note\n---\n# Adsız 1\n$/);
  await renameVaultEntry('Adsız 1.md', 'Toplantı');
  assert.match(fs.readFileSync(path.join(dir, 'Toplantı.md'), 'utf8'), /^---\ntitle: "Toplantı"\ncreated: [\d-]+\ntype: note\n---\n# Toplantı\n$/);
});

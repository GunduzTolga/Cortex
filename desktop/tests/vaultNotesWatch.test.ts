import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateSettings } from '../electron/services/settings';
import * as service from '../electron/services/vaultNotes';
import { createVaultNote, readVaultNote, renameVaultEntry, saveVaultNote, stopWatchingVault, trashVaultEntry, vaultIndex, watchVault } from '../electron/services/vaultNotes';

/**
 * The vault's listing kept between two readings of the index, and its watcher
 * (electron/services/vaultNotes.ts): one note changed on disk is one file asked
 * about, not the vault walked again (N10), and a watcher that failed is put up
 * again (N12). What the disk is asked is counted, not timed: a count is the
 * same on every machine.
 *
 * The watcher here is a false one, put in node's place: what it tells is what
 * the test says, when it says it, in the words Windows or Linux would use.
 */

interface FalseWatcher extends EventEmitter {
  closed: boolean;
  tell(name: string | null, event?: string): void;
  close(): void;
}

const realWatch = fs.watch;
let opened: FalseWatcher[] = [];
/** Whether the next watcher can be put up; false is node throwing as it does for a folder that is gone. */
let canWatch = true;

function falseWatch(): void {
  opened = [];
  canWatch = true;
  (fs as { watch: unknown }).watch = (_dir: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
    if (!canWatch) throw Object.assign(new Error('ENOENT: no such file or directory, watch'), { code: 'ENOENT' });
    const watcher = new EventEmitter() as FalseWatcher;
    watcher.closed = false;
    watcher.tell = (name, event = 'change') => listener(event, name);
    watcher.close = () => {
      watcher.closed = true;
    };
    opened.push(watcher);
    return watcher;
  };
  syncBuiltinESMExports();
}

function realWatchAgain(): void {
  stopWatchingVault();
  (fs as { watch: unknown }).watch = realWatch;
  syncBuiltinESMExports();
}

/** What the disk was asked while `work` ran: folders read, and files asked about. */
async function asked<T>(work: () => Promise<T>): Promise<{ result: T; readdir: number; lstat: number; peak: number }> {
  const real = { readdir: fsp.readdir, lstat: fsp.lstat };
  const count = { readdir: 0, lstat: 0, peak: 0 };
  let open = 0;
  (fsp as { readdir: unknown }).readdir = (...args: unknown[]) => {
    count.readdir += 1;
    return (real.readdir as (...a: unknown[]) => unknown)(...args);
  };
  (fsp as { lstat: unknown }).lstat = async (...args: unknown[]) => {
    count.lstat += 1;
    open += 1;
    count.peak = Math.max(count.peak, open);
    try {
      // A turn of the loop, as a disk takes: what is asked at once is seen as asked at once.
      await new Promise((done) => setImmediate(done));
      return await (real.lstat as (...a: unknown[]) => unknown)(...args);
    } finally {
      open -= 1;
    }
  };
  try {
    return { result: await work(), ...count };
  } finally {
    fsp.readdir = real.readdir;
    fsp.lstat = real.lstat;
  }
}

function vault(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-watch-')));
  const write = (relative: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), text);
  };
  write('Proje planı.md', '# Plan\n\nSee [[Tadilat]] and [[Yazılacak]].\n');
  write('Ev/Tadilat.md', '# Tadilat\n\nBack to [[Proje planı]].\n');
  write('Ev/Liste.md', 'Bu hafta tadilat bitmeli.\n');
  write('Ev/Oda/Mutfak.md', '# Mutfak\n');
  write('ekler/run.bat', 'echo hi');
  write('.obsidian/workspace.json', '{}');
  return dir;
}

function useVault(dir: string | null): void {
  updateSettings((settings) => {
    settings.vault = dir;
  });
}

const notesOf = (index: Awaited<ReturnType<typeof vaultIndex>>) => index.notes.map((one) => one.path).sort();

/** A vault watched and read once, as the notes screen does at its first reading. */
async function watched(): Promise<{ dir: string; watcher: FalseWatcher; write: (relative: string, text: string) => void }> {
  const dir = vault();
  useVault(dir);
  falseWatch();
  watchVault(() => undefined);
  await vaultIndex();
  return {
    dir,
    watcher: opened[0],
    write: (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), text);
    },
  };
}

test("a folder's files are asked about a few at a time, and listed as before", async () => {
  const dir = vault();
  for (let n = 0; n < 60; n += 1) fs.writeFileSync(path.join(dir, 'Ev', `Not ${String(n).padStart(2, '0')}.md`), `# ${n}\n`);
  useVault(dir);
  const first = await asked(() => vaultIndex());
  // One after another, each waited on the disk and on an antivirus looking at it (N10).
  assert.ok(first.peak > 1, `asked one at a time (${first.peak})`);
  assert.ok(first.peak <= 16, `no more than sixteen at once (${first.peak})`);
  assert.equal(first.lstat, 65, 'each file asked about once');
  assert.equal(first.result.notes.length, 64);
  assert.deepEqual(first.result.files.map((one) => one.path), ['ekler/run.bat']);
  assert.deepEqual(first.result.folders.sort(), ['Ev', 'Ev/Oda', 'ekler']);
  // In the order the folders were read, files and folders as they came: nothing is listed out of its place.
  const order = (at: string, relative: string): string[] =>
    fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.')) return [];
      const inside = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? order(path.join(at, entry.name), inside) : [inside];
    });
  assert.deepEqual([...first.result.notes.map((one) => one.path), ...first.result.files.map((one) => one.path)].sort(), order(dir, '').sort());
  assert.deepEqual(first.result.notes.map((one) => one.path), order(dir, '').filter((one) => one.endsWith('.md')));
});

test('a note the watcher says changed is asked about alone: the vault is not walked again', async () => {
  const { watcher, write } = await watched();
  try {
    write('Ev/Tadilat.md', '# Tadilat\n\nBack to [[Proje planı]] and on to [[Liste]].\n');
    // As Windows says it.
    watcher.tell('Ev\\Tadilat.md');
    const changed = await asked(() => vaultIndex());
    assert.equal(changed.readdir, 0, 'no folder read again');
    assert.equal(changed.lstat, 1, 'one file asked about');
    assert.deepEqual(changed.result.notes.find((one) => one.path === 'Ev/Tadilat.md')!.links.sort(), ['Ev/Liste.md', 'Proje planı.md']);
    assert.deepEqual(notesOf(changed.result), ['Ev/Liste.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);
    assert.deepEqual(changed.result.folders.sort(), ['Ev', 'Ev/Oda', 'ekler']);
    assert.equal(changed.result.truncated, false);

    // Nothing said: nothing asked.
    const still = await asked(() => vaultIndex());
    assert.deepEqual([still.readdir, still.lstat], [0, 0]);
    assert.deepEqual(notesOf(still.result), notesOf(changed.result));
  } finally {
    realWatchAgain();
  }
});

test('a note made, a note deleted and a note that names one not written are each taken from what the watcher said', async () => {
  const { dir, watcher, write } = await watched();
  try {
    write('Yazılacak.md', '# now written\n');
    watcher.tell('Yazılacak.md', 'rename');
    const made = await asked(() => vaultIndex());
    assert.equal(made.readdir, 0);
    assert.ok(notesOf(made.result).includes('Yazılacak.md'));
    assert.deepEqual(made.result.notes.find((one) => one.path === 'Proje planı.md')!.unresolved, [], 'the link to it is found now');

    fs.rmSync(path.join(dir, 'Ev', 'Liste.md'));
    watcher.tell('Ev/Liste.md', 'rename');
    const gone = await asked(() => vaultIndex());
    assert.equal(gone.readdir, 0);
    assert.ok(!notesOf(gone.result).includes('Ev/Liste.md'));

    // A file that is not a note, changed: listed with its new size.
    write('ekler/run.bat', 'echo hello there');
    watcher.tell('ekler/run.bat');
    assert.equal((await vaultIndex()).files.find((one) => one.path === 'ekler/run.bat')!.size, 16);
  } finally {
    realWatchAgain();
  }
});

test('a folder made, moved in with its notes, renamed or deleted is listed as it is now', async () => {
  const { dir, watcher, write } = await watched();
  try {
    // A note in a folder not listed yet, said before its folder is, or without it.
    write('Arşiv/2026/Not.md', '# Not\n');
    watcher.tell('Arşiv/2026/Not.md', 'rename');
    const made = await asked(() => vaultIndex());
    assert.equal(made.readdir, 2, 'the new folder is walked, and it alone');
    assert.ok(notesOf(made.result).includes('Arşiv/2026/Not.md'));
    assert.deepEqual(made.result.folders.sort(), ['Arşiv', 'Arşiv/2026', 'Ev', 'Ev/Oda', 'ekler']);

    // Renamed: Windows says the old name and the new one, and nothing of what is in it.
    fs.renameSync(path.join(dir, 'Ev'), path.join(dir, 'Konut'));
    watcher.tell('Ev', 'rename');
    watcher.tell('Konut', 'rename');
    const renamed = await vaultIndex();
    assert.deepEqual(notesOf(renamed), ['Arşiv/2026/Not.md', 'Konut/Liste.md', 'Konut/Oda/Mutfak.md', 'Konut/Tadilat.md', 'Proje planı.md']);
    assert.deepEqual(renamed.folders.sort(), ['Arşiv', 'Arşiv/2026', 'Konut', 'Konut/Oda', 'ekler']);

    fs.rmSync(path.join(dir, 'Konut'), { recursive: true });
    watcher.tell('Konut', 'rename');
    const deleted = await asked(() => vaultIndex());
    assert.equal(deleted.readdir, 0);
    assert.deepEqual(notesOf(deleted.result), ['Arşiv/2026/Not.md', 'Proje planı.md']);
    assert.deepEqual(deleted.result.folders.sort(), ['Arşiv', 'Arşiv/2026', 'ekler']);

    // A file where a folder was, under its name.
    fs.rmSync(path.join(dir, 'Arşiv'), { recursive: true });
    write('Arşiv', 'not a folder now');
    watcher.tell('Arşiv', 'rename');
    const replaced = await vaultIndex();
    assert.deepEqual(notesOf(replaced), ['Proje planı.md']);
    assert.deepEqual(replaced.folders, ['ekler']);
    assert.deepEqual(replaced.files.map((one) => one.path).sort(), ['Arşiv', 'ekler/run.bat']);
  } finally {
    realWatchAgain();
  }
});

test("a folder said changed has its names read again, without asking about each file in it; so has the folder of a name that is not there", async () => {
  const { dir, watcher, write } = await watched();
  try {
    // Windows says the folder changed when a file is made in it; the file's own word may come later.
    write('Ev/Ek.md', '# Ek\n');
    fs.rmSync(path.join(dir, 'Ev', 'Liste.md'));
    watcher.tell('Ev');
    const folder = await asked(() => vaultIndex());
    assert.equal(folder.readdir, 1, 'its names, and no folder under it');
    assert.equal(folder.lstat, 2, 'the folder and the one new file');
    assert.deepEqual(notesOf(folder.result), ['Ev/Ek.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);

    // A name that is not there and never was listed: a temporary made and gone at once, or the name Windows said in
    // its short form for a file listed under its long one. The folder's names settle both.
    write('Ev/Uzun adlı bir not.md', '# Uzun\n');
    watcher.tell('Ev/~geçici 7f3a.tmp', 'rename');
    const short = await asked(() => vaultIndex());
    assert.equal(short.readdir, 1);
    assert.deepEqual(notesOf(short.result), ['Ev/Ek.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Ev/Uzun adlı bir not.md', 'Proje planı.md']);
    fs.rmSync(path.join(dir, 'Ev', 'Uzun adlı bir not.md'));
    watcher.tell('Ev/~geçici 7f3a.tmp', 'rename');
    assert.deepEqual(notesOf(await vaultIndex()), ['Ev/Ek.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);
  } finally {
    realWatchAgain();
  }
});

test('what is hidden or reached through a link is never listed from what the watcher said', async (t) => {
  const { dir, watcher, write } = await watched();
  try {
    write('Ev/.gizli.md', '# hidden\n');
    write('.beyin/state.md', '# state\n');
    watcher.tell('Ev/.gizli.md', 'rename');
    watcher.tell('.beyin\\state.md', 'rename');
    assert.deepEqual(notesOf(await vaultIndex()), ['Ev/Liste.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'Özel.md'), '# private\n');
    try {
      fs.symlinkSync(outside, path.join(dir, 'Bağ'), 'dir');
      fs.symlinkSync(path.join(outside, 'Özel.md'), path.join(dir, 'Ev', 'Bağlı.md'), 'file');
    } catch {
      t.skip('no links can be made here');
      return;
    }
    watcher.tell('Bağ', 'rename');
    watcher.tell('Bağ/Özel.md', 'rename');
    watcher.tell('Ev/Bağlı.md', 'rename');
    const index = await vaultIndex();
    assert.deepEqual(notesOf(index), ['Ev/Liste.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);
    assert.deepEqual(index.folders.sort(), ['Ev', 'Ev/Oda', 'ekler']);

    // A folder of the vault put aside and a link left in its place: what was listed under it goes.
    fs.renameSync(path.join(dir, 'Ev', 'Oda'), path.join(outside, 'Oda'));
    fs.symlinkSync(path.join(outside, 'Oda'), path.join(dir, 'Ev', 'Oda'), 'dir');
    watcher.tell('Ev/Oda/Mutfak.md');
    const linked = await vaultIndex();
    assert.deepEqual(notesOf(linked), ['Ev/Liste.md', 'Ev/Tadilat.md', 'Proje planı.md']);
    assert.deepEqual(linked.folders.sort(), ['Ev', 'ekler']);
  } finally {
    realWatchAgain();
  }
});

test('the vault is walked whole again where what the watcher said cannot be trusted: no path, too many at once, a minute gone, no watcher', async (t) => {
  const { dir, watcher, write } = await watched();
  try {
    // A change without its path (Windows, when more changed than it could keep): anything may have.
    write('Ev/Söylenmedi.md', '# not told\n');
    watcher.tell(null);
    const unnamed = await asked(() => vaultIndex());
    assert.equal(unnamed.readdir, 4, 'every folder read');
    assert.ok(notesOf(unnamed.result).includes('Ev/Söylenmedi.md'));

    // A sync or a checkout: one walk, not three hundred questions.
    write('Ev/Toplu.md', '# many\n');
    for (let n = 0; n < 300; n += 1) watcher.tell(`Ev/yok ${n}.md`, 'rename');
    const many = await asked(() => vaultIndex());
    assert.equal(many.readdir, 4);
    assert.ok(many.lstat < 20, `the paths said are not each asked about (${many.lstat})`);
    assert.ok(notesOf(many.result).includes('Ev/Toplu.md'));

    // A watcher on a cloud or network folder can miss a change and say nothing: a minute on, the vault is walked whatever it said.
    write('Ev/Kaçan.md', '# missed\n');
    assert.ok(!notesOf(await vaultIndex()).includes('Ev/Kaçan.md'), 'not told, and not yet looked for');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(61_000);
    const later = await asked(() => vaultIndex());
    t.mock.timers.reset();
    assert.equal(later.readdir, 4);
    assert.ok(notesOf(later.result).includes('Ev/Kaçan.md'));

    // The watcher stopped (the vault changed, the app closing): every reading walks, as it did before there was a listing.
    stopWatchingVault();
    write('Ev/Sonra.md', '# after\n');
    const unwatched = await asked(() => vaultIndex());
    assert.equal(unwatched.readdir, 4);
    assert.ok(notesOf(unwatched.result).includes('Ev/Sonra.md'));
    assert.ok(fs.existsSync(dir));
  } finally {
    realWatchAgain();
  }
});

test('what the notes screen itself writes is in the next reading without waiting for the watcher to say it', async () => {
  const { dir } = await watched();
  try {
    const made = await createVaultNote('Ev', 'Yeni');
    const afterMade = await asked(() => vaultIndex());
    assert.equal(afterMade.readdir, 0);
    assert.ok(notesOf(afterMade.result).includes(made.path));

    const read = await readVaultNote('Ev/Yeni.md');
    await saveVaultNote('Ev/Yeni.md', 'On to [[Liste]].\n', read.hash);
    assert.deepEqual((await vaultIndex()).notes.find((one) => one.path === 'Ev/Yeni.md')!.links, ['Ev/Liste.md']);

    await renameVaultEntry('Ev/Yeni.md', 'Eski');
    const renamed = await asked(() => vaultIndex());
    assert.equal(renamed.readdir, 0);
    assert.deepEqual(notesOf(renamed.result), ['Ev/Eski.md', 'Ev/Liste.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md']);

    await trashVaultEntry('Ev/Oda');
    const binned = await vaultIndex();
    assert.deepEqual(notesOf(binned), ['Ev/Eski.md', 'Ev/Liste.md', 'Ev/Tadilat.md', 'Proje planı.md']);
    assert.deepEqual(binned.folders.sort(), ['Ev', 'ekler']);
    assert.ok(fs.existsSync(path.join(dir, '.trash', 'Oda', 'Mutfak.md')));
  } finally {
    realWatchAgain();
  }
});

test('a vault larger than the screen lists is listed to its limit and said cut short, at every reading', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-large-')));
  // 20 020 entries: just past the 20 000 the screen lists.
  for (let folder = 0; folder < 20; folder += 1) {
    fs.mkdirSync(path.join(dir, `k${folder}`));
    for (let n = 0; n < 1000; n += 1) fs.writeFileSync(path.join(dir, `k${folder}`, `${n}.txt`), '');
  }
  useVault(dir);
  falseWatch();
  try {
    watchVault(() => undefined);
    const first = await vaultIndex();
    assert.equal(first.truncated, true);
    assert.equal(first.folders.length + first.files.length + first.notes.length, 20_000);
    // Told of a change, such a vault is walked again to the same limit: which twenty thousand are "the first part" is the walk's to say.
    opened[0].tell('k0/0.txt');
    const again = await asked(() => vaultIndex());
    assert.ok(again.readdir > 1);
    assert.ok(again.lstat <= 20_000, `no file past the limit asked about (${again.lstat})`);
    assert.equal(again.result.truncated, true);
    assert.equal(again.result.folders.length + again.result.files.length, 20_000);
  } finally {
    realWatchAgain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a watcher that fails is put up again, after a wait that doubles with each failure in a row and has a longest', async (t) => {
  const dir = vault();
  useVault(dir);
  falseWatch();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let told = 0;
    watchVault(() => {
      told += 1;
    });
    await vaultIndex();
    assert.equal(opened.length, 1);

    // OneDrive pausing, a network folder gone for a moment: it was closed and never tried again (N12).
    opened[0].emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
    assert.equal(opened[0].closed, true);
    t.mock.timers.tick(1_999);
    assert.equal(opened.length, 1, 'not at once');
    t.mock.timers.tick(1);
    assert.equal(opened.length, 2, 'put up again');
    // The window reads the vault again: what changed while nothing watched was not told.
    t.mock.timers.tick(400);
    assert.equal(told, 1);

    // While none was up nothing was told, so the next reading walks the vault.
    fs.writeFileSync(path.join(dir, 'Ev', 'Arada.md'), '# meanwhile\n');
    const after = await asked(() => vaultIndex());
    assert.ok(after.readdir >= 4);
    assert.ok(notesOf(after.result).includes('Ev/Arada.md'));

    // Failing again before it told anything: twice as long.
    opened[1].emit('error', new Error('again'));
    t.mock.timers.tick(3_999);
    assert.equal(opened.length, 2);
    t.mock.timers.tick(1);
    assert.equal(opened.length, 3);

    // One that cannot be put up at all is a failure like the others.
    canWatch = false;
    opened[2].emit('error', new Error('gone'));
    t.mock.timers.tick(8_000);
    assert.equal(opened.length, 3, 'tried, and not put up');
    canWatch = true;
    t.mock.timers.tick(15_999);
    assert.equal(opened.length, 3);
    t.mock.timers.tick(1);
    assert.equal(opened.length, 4);

    // Once it tells of a change it works: the next failure waits the first wait again.
    opened[3].tell('Ev/Arada.md');
    opened[3].emit('error', new Error('later'));
    t.mock.timers.tick(2_000);
    assert.equal(opened.length, 5);

    // A watcher closed and replaced says nothing more.
    const before = told;
    opened[0].tell('Ev/Arada.md');
    opened[0].emit('error', new Error('late'));
    t.mock.timers.tick(60_000);
    assert.equal(opened.length, 5);
    assert.equal(told, before + 1, 'only the word that it is watched again');

    // The waits, said whole: two seconds, doubling, never longer than five minutes.
    const { rewatchDelay } = service;
    assert.deepEqual([0, 1, 2, 3].map(rewatchDelay), [2_000, 4_000, 8_000, 16_000]);
    assert.equal(rewatchDelay(8), 5 * 60_000);
    assert.equal(rewatchDelay(1_000), 5 * 60_000);
  } finally {
    realWatchAgain();
  }
});

test('no watcher is put up again once the vault is left or the app closes', async (t) => {
  const dir = vault();
  useVault(dir);
  falseWatch();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let told = 0;
    watchVault(() => {
      told += 1;
    });
    opened[0].emit('error', new Error('gone'));
    stopWatchingVault();
    t.mock.timers.tick(10 * 60_000);
    assert.equal(opened.length, 1);
    assert.equal(told, 0);

    // Another vault chosen while the wait runs: the new one is watched, the old never again.
    watchVault(() => undefined);
    assert.equal(opened.length, 2);
    opened[1].emit('error', new Error('gone'));
    const other = vault();
    useVault(other);
    watchVault(() => undefined);
    assert.equal(opened.length, 3);
    t.mock.timers.tick(10 * 60_000);
    assert.equal(opened.length, 3, 'the wait of the vault left was dropped');
    assert.equal(opened[2].closed, false);
  } finally {
    realWatchAgain();
  }
});

test("the system's own watcher: a note written in the vault is told, and is in the index read after", async (t) => {
  // The one test here with node's watcher and not the false one: the words a real system says a change in.
  const dir = vault();
  try {
    fs.watch(dir, { recursive: true }).close();
  } catch {
    t.skip('no folder is watched whole on this platform');
    return;
  }
  useVault(dir);
  let told = 0;
  try {
    watchVault(() => {
      told += 1;
    });
    await vaultIndex();
    const written: string[] = [];
    const until = Date.now() + 20_000;
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    // Written until one is told: a watcher just put up may not see the first.
    while (!told && Date.now() < until) {
      const name = `Ev/Gerçek ${written.length}.md`;
      fs.writeFileSync(path.join(dir, ...name.split('/')), `# ${written.length}\n`);
      written.push(name);
      for (let waited = 0; !told && waited < 1_000; waited += 20) await wait(20);
    }
    assert.ok(told > 0, 'a change in the vault was told');
    // Each is in the index once the watcher has said it, or a walk has found it.
    let index = await asked(() => vaultIndex());
    while (!written.every((one) => index.result.notes.some((note) => note.path === one)) && Date.now() < until) {
      await wait(50);
      index = await asked(() => vaultIndex());
    }
    t.diagnostic(`after a real change: ${index.readdir} folders read, ${index.lstat} files asked about`);
    assert.deepEqual(notesOf(index.result), [...written, 'Ev/Liste.md', 'Ev/Oda/Mutfak.md', 'Ev/Tadilat.md', 'Proje planı.md'].sort());
    assert.deepEqual(index.result.folders.sort(), ['Ev', 'Ev/Oda', 'ekler']);
  } finally {
    stopWatchingVault();
  }
});

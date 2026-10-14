import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Boots the built app in a real Electron process and walks it: the first
 * opening, the vault chosen, and the notes read and written as in Obsidian.
 * A build that typechecks can still die on a bad preload path, a sandbox the
 * preload does not fit, or a policy that blocks the page's own script; this
 * catches that before it reaches the owner.
 *
 * The Notes section is Krewgent's (e2e/smoke.mjs there, desktop/KAYNAK.md),
 * on a vault in the shape the owner's is: this repository's own template,
 * Cortex's folders, its `📋 Templates/Note.md` and `📥 000-Inbox/Dump`, with
 * an `.obsidian` and a `.git` beside them as Obsidian and Obsidian Git leave.
 *
 * Run with CORTEX_HIDDEN=1 (scripts/e2e.mjs sets it) the window is never shown
 * and is drawn offscreen; the pictures go through `capturePage` (`shoot`),
 * because a hidden window does not answer `page.screenshot`.
 */
const shots = path.resolve('e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (label, condition) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-'));
const vaultDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-vault-')));
const vaultNote = (relative) => path.join(vaultDir, ...relative.split('/'));
const write = (relative, text) => {
  fs.mkdirSync(path.dirname(vaultNote(relative)), { recursive: true });
  fs.writeFileSync(vaultNote(relative), text);
};

/*
  The vault: Cortex's template as the installer lays it out, the hidden parts
  Obsidian, git and Cortex keep, and a few notes of the person's.
*/
fs.cpSync(path.resolve('..', 'template'), vaultDir, { recursive: true });
write('.obsidian/workspace.json', '{"main":{}}\n');
write('.git/HEAD', 'ref: refs/heads/main\n');
write('.hidden/Secret.md', '# Secret\n');
write('Personal/Health.md', '# Health\n\nWalk every day.\n');
write('Notes/Plan.md', '---\ntags: [plan]\n---\n# Plan\n\nSee [[Health]] and [[Missing note]].\n\n- [ ] first task\n\n> [!warning] Careful\n> The body.\n');
write('Notes/Ideas.md', '# Ideas\n\nThe plan is here: [[Plan#Plan|the plan]]. #idea\n');
fs.writeFileSync(vaultNote('Latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
// What Cortex's engine keeps, as it writes it: a receipt under the hash of its event_id, and the day's page generated from it.
const receipt = `receipts/${createHash('sha256').update('cortex-ad-karari-20261013').digest('hex')}.md`;
write(receipt, '---\n{\n  "kind": "receipt",\n  "event_id": "cortex-ad-karari-20261013"\n}\n---\nAd kararı verildi.\n');
write('daily/v3/2026-10-13.md', `---\n{"generated": true, "kind": "receipt-index"}\n---\n# Recorded outcomes\n\nSource: [[${receipt}]]\n`);
write('Notes/settings.json', '{\n  "theme": "ananas",\n  "count": 3\n}\n');
const receiptBefore = fs.readFileSync(vaultNote(receipt), 'utf8');

/*
  A stand-in for LM Studio's server: its model list and a streamed answer,
  as LM Studio's OpenAI-compatible endpoint gives them. The chat talks to it
  directly, as it talks to the person's own LM Studio.
*/
const lmBodies = [];
const lmStudio = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    if (request.url === '/api/v0/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'qwen-e2e', type: 'llm', state: 'loaded', loaded_context_length: 16384 }] }));
    } else if (request.url === '/v1/chat/completions') {
      lmBodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const content of ['Yerel model ', 'burada.']) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
});
await new Promise((done) => lmStudio.listen(0, '127.0.0.1', done));
const lmStudioBase = `http://127.0.0.1:${lmStudio.address().port}`;
const hiddenBefore = fs.readFileSync(vaultNote('.hidden/Secret.md'), 'utf8');
const obsidianBefore = fs.readFileSync(vaultNote('.obsidian/workspace.json'), 'utf8');

/*
  Linux in a container has no GPU, and there an offscreen window's frame is
  not handed to `capturePage` (UnknownVizError) unless Chromium draws in
  software. Windows, where CI runs, draws offscreen as it is.
*/
/*
  CORTEX_SOFTWARE=1 draws in software on Windows too: there a hidden window's
  frames are not handed to `capturePage` either (UnknownVizError), and the
  pictures are wanted without a window put in front of the person.
*/
const software = process.platform === 'linux' || process.env.CORTEX_SOFTWARE === '1';
const launchArgs = ['.', `--user-data-dir=${userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(software ? ['--disable-gpu'] : [])];
const launch = () =>
  electron.launch({
    args: launchArgs,
    env: {
      ...process.env,
      // Electron refuses to be Electron with this set, and Playwright waits out its timeout on a launch that technically succeeded.
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_ENV: 'production',
      // Pyn's chat talks to a stand-in for an AI CLI (tests/fixtures/fake-acp-agent.mjs), never to one of the machine's.
      CORTEX_TEST_AGENT: path.resolve('tests/fixtures/fake-acp-agent.mjs'),
      CORTEX_TEST_CLAUDE: path.resolve('tests/fixtures/fake-claude.mjs'),
      CORTEX_TEST_CODEX: path.resolve('tests/fixtures/fake-codex.mjs'),
      // The model servers: LM Studio's stand-in, and Ollama where nothing answers; never the machine's own.
      CORTEX_TEST_LMSTUDIO: lmStudioBase,
      CORTEX_TEST_OLLAMA: 'http://127.0.0.1:9',
    },
  });

/*
  A run never opens the system's browser. The app hands an address the page
  asks for (a new window, a navigation away) to the system's browser, which is
  right for the person and wrong for a test: every run left example.com tabs
  open on the machine (14 October). The main process's way to the browser is
  stood in for, and what it was asked to open is read back and checked.
*/
async function holdBrowser() {
  await app.evaluate(({ shell }) => {
    globalThis.cortexOpened = [];
    shell.openExternal = async (url) => {
      globalThis.cortexOpened.push(url);
    };
  });
}
const openedOutside = () => app.evaluate(() => globalThis.cortexOpened ?? []);

let app = await launch();

/** A picture of the window, from the main process. A picture is not a check, so one that cannot be taken is said and the run goes on. */
async function shoot(name) {
  try {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      return image.toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(shots, name), Buffer.from(png, 'base64'));
  } catch (error) {
    console.log(`       note: no picture for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const consoleErrors = [];
function listen(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.stack ?? String(error)));
}
let page = await app.firstWindow();
listen(page);
await page.waitForLoadState('domcontentloaded');
// Once the window is there: asked of the main process before it, an evaluation can be lost while the app starts.
await holdBrowser();
const shownSoon = (locator, timeout = 10_000) => locator.first().waitFor({ timeout }).then(() => true, () => false);

console.log('\nFirst opening');
check('a first run opens on choosing the vault', await shownSoon(page.locator('[data-welcome]'), 30_000));
check(
  'in Turkish, unless chosen otherwise, cased as Turkish',
  (await page.locator('[data-welcome-choose]').textContent())?.trim() === 'Kasayı seç' && (await page.evaluate(() => document.documentElement.lang)) === 'tr',
);
await shoot('01-welcome-tr.png');
await page.locator('[data-language="en"]').click();
check(
  'English is one choice away, and the choice is kept by the main process',
  (await shownSoon(page.getByRole('button', { name: 'Choose the vault' }))) &&
    (await page.evaluate(() => document.documentElement.lang)) === 'en' &&
    (await page.evaluate(() => window.cortex.bootstrap())).settings.language === 'en',
);

console.log('\nThe window');
const windowAlone = await page.evaluate(async () => {
  const fetched = await fetch('https://example.com/').then(() => 'reached', () => 'blocked');
  const image = await new Promise((done) => {
    const img = new Image();
    img.onload = () => done('loaded');
    img.onerror = () => done('blocked');
    img.src = 'https://example.com/pixel.png';
  });
  return { node: typeof require + typeof process, bridge: Object.keys(window.cortex).sort(), fetched, image, opened: window.open('https://example.com/') === null };
});
check('the page has no node in it, and only the bridge', windowAlone.node === 'undefinedundefined' && windowAlone.bridge.join(',') === 'bootstrap,chat,notes,on,settings,vault');
check('it reaches nothing on the network: no request, no image', windowAlone.fetched === 'blocked' && windowAlone.image === 'blocked');
check('and opens no window of its own', windowAlone.opened && app.windows().length === 1);

console.log('\nThe vault');
// The system's dialog answers with the vault for this run; the window names no folder.
await app.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
}, vaultDir);
await page.locator('[data-welcome-choose]').click();
check('a vault chosen, Pyn opens first, where the person talks to their AI', await shownSoon(page.locator('[data-chat-view]'), 15_000));
await page.locator('[data-app-view="notes"]').click();
check('and the notes are one press away', await shownSoon(page.locator('[data-notes-view]'), 15_000));
check('the window is told the vault by its name', (await page.locator('[data-vault-name]').textContent())?.trim() === path.basename(vaultDir));
const indexNow = await page.evaluate(() => window.cortex.notes.index());
// The folder the vault is in, as written and as JSON writes it (a Windows path's backslashes doubled).
const around = [path.dirname(vaultDir), JSON.stringify(path.dirname(vaultDir)).slice(1, -1)];
const namesWhere = (text) => around.some((one) => text.includes(one));
check(
  'and never where it is: no absolute path in what it is sent, nor on the page',
  !namesWhere(JSON.stringify(indexNow)) && !namesWhere(JSON.stringify(await page.evaluate(() => window.cortex.bootstrap()))) && !namesWhere(await page.evaluate(() => document.body.innerHTML)),
);

/*
  The notes screen (src/notes/, electron/services/vaultNotes.ts): the vault
  read and written as in Obsidian. Its reader reads the whole vault but what
  is hidden; what it writes is the person's press, over the version read.
*/
console.log('\nNotes');
/** Whether the disk comes to say something within a few seconds: a save happens a moment after the last key, not at once. */
const onDiskSoon = async (test, ms = 6_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) if (test()) return true;
  return test();
};
const notesView = page.locator('[data-notes-view]');
check(
  'the tree is the vault as Obsidian shows it, hidden folders left out',
  (await shownSoon(notesView.locator('[data-tree-path="Notes"]'))) &&
    (await notesView.locator('[data-tree-path="🎯 100-Command-Center"]').count()) === 1 &&
    (await notesView.locator('[data-tree-path^=".hidden"], [data-tree-path^=".claude"], [data-tree-path^=".obsidian"], [data-tree-path^=".git"], [data-tree-path^=".agents"]').count()) === 0 &&
    !indexNow.notes.some((note) => note.path.split('/').some((part) => part.startsWith('.'))) &&
    !indexNow.folders.some((folder) => folder.split('/').some((part) => part.startsWith('.'))),
);
// The left column keeps its own buttons: the fold button once crossed into the tabs beside it (14 October).
const navBox = await notesView.locator('[data-notes-nav]').boundingBox();
const foldBox = await notesView.locator('[data-notes-nav-fold]').boundingBox();
check('the left column’s header holds its buttons inside it', Boolean(navBox && foldBox && foldBox.x + foldBox.width <= navBox.x + navBox.width + 0.5));
check(
  'and the window cannot read past the vault or into what is hidden',
  (await page.evaluate(() => window.cortex.notes.read('../outside.md').then(() => 'read', () => 'refused'))) === 'refused' &&
    (await page.evaluate(() => window.cortex.notes.read('.hidden/Secret.md').then(() => 'read', () => 'refused'))) === 'refused' &&
    (await page.evaluate(() => window.cortex.notes.read('.obsidian/workspace.json').then(() => 'read', () => 'refused'))) === 'refused',
);
check(
  "the home names Cortex's own places where the vault has them",
  (await shownSoon(notesView.locator('[data-notes-places]'))) && (await notesView.locator('[data-notes-places] button', { hasText: 'Dashboard' }).count()) === 1,
);
await shoot('02-notes-home.png');
await notesView.locator('[data-tree-path="Notes"]').click();
await notesView.locator('[data-tree-path="Notes/Plan.md"]').click();
const reader = notesView.locator('[data-note-reader]');
check(
  'a note is read with its properties, its wiki links, the one not written yet marked, and its callout',
  (await shownSoon(reader.locator('[data-note-tag="plan"]'))) &&
    (await reader.locator('[data-note-link="Health"]:not([data-missing])').count()) === 1 &&
    (await reader.locator('[data-note-link="Missing note"][data-missing]').count()) === 1 &&
    (await reader.locator('[data-callout="warning"]').count()) === 1,
);
check('what links to it is beside it', await shownSoon(notesView.locator('[data-backlinks] [data-side-link="Notes/Ideas.md"]')));
await reader.locator('[data-note-link="Health"]').hover();
check('a link hovered shows the note it finds, over the page', await shownSoon(page.locator('[data-note-peek="Personal/Health.md"]')));
await page.mouse.move(2, 400);
await shoot('03-note-read.png');
await reader.locator('[data-task-line]').first().click();
check('a task ticked in the reading view is ticked in the file', await onDiskSoon(() => /- \[x\] first task/.test(fs.readFileSync(vaultNote('Notes/Plan.md'), 'utf8'))));
await notesView.locator('[data-note-mode="edit"]').click();
await notesView.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('\nWritten here.');
check(
  'what is written is saved a moment after the last key, through the reader, into the file',
  await onDiskSoon(() => fs.readFileSync(vaultNote('Notes/Plan.md'), 'utf8').endsWith('Written here.')),
);
check('and leaves no temporary behind', !fs.readdirSync(vaultNote('Notes')).some((name) => name.endsWith('.tmp')));
await page.waitForFunction(() => document.querySelector('[data-note-saving]')?.getAttribute('data-note-saving') === 'saved', null, { timeout: 5_000 }).catch(() => undefined);
await page.keyboard.type(' And more.');
fs.writeFileSync(vaultNote('Notes/Plan.md'), '# Plan\n\nObsidian wrote this meanwhile.\n');
await page.waitForTimeout(2_500);
check(
  'a note changed on disk while it is being written is not written over, and the screen says so',
  fs.readFileSync(vaultNote('Notes/Plan.md'), 'utf8') === '# Plan\n\nObsidian wrote this meanwhile.\n' &&
    (await notesView.locator('[data-note-banner="conflict"], [data-note-banner="changed"]').count()) === 1,
);
await shoot('04-conflict.png');
const takeDisk = notesView.locator('[data-note-take-disk]');
if (await takeDisk.count()) await takeDisk.click();
else await notesView.locator('[data-note-banner="changed"] button').click();
await page.waitForTimeout(500);
check(
  'and the version on disk can be taken',
  (await notesView.locator('[data-note-banner]').count()) === 0 && ((await notesView.locator('.cm-content').textContent()) ?? '').includes('Obsidian wrote this meanwhile.'),
);
fs.writeFileSync(vaultNote('Notes/Plan.md'), '---\ntags: [plan]\n---\n# Plan\n\nSee [[Health]].\n\n> [!warning] Careful\n> The body.\n');
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(800);
check(
  'writing is live preview: the lines away from the cursor are drawn, a callout as a callout',
  (await notesView.locator('.cm-line.cm-lp-callout').count()) === 2 && (await notesView.locator('.cm-editor').count()) === 1,
);
await shoot('05-note-edit.png');
await notesView.locator('[data-note-mode="read"]').click();
await notesView.locator('[data-note-title]').fill('Master plan');
await notesView.locator('[data-note-title]').press('Enter');
await page.waitForFunction(() => document.querySelector('[data-note-pane]')?.getAttribute('data-note-pane') === 'Notes/Master plan.md', null, { timeout: 5_000 }).catch(() => undefined);
check(
  'renamed by its title, every link to it follows, with its heading and its alias',
  fs.existsSync(vaultNote('Notes/Master plan.md')) &&
    !fs.existsSync(vaultNote('Notes/Plan.md')) &&
    fs.readFileSync(vaultNote('Notes/Ideas.md'), 'utf8') === '# Ideas\n\nThe plan is here: [[Master plan#Plan|the plan]]. #idea\n',
);
await notesView.locator('[data-tree-path="Latin1.md"]').click();
check('bytes that are not UTF-8 are shown and not saved', await shownSoon(notesView.locator('[data-note-banner="read-only"]')));
await notesView.locator('[data-tree-path="receipts"]').click();
const receiptRow = notesView.locator(`[data-tree-path="${receipt}"]`);
check('a receipt is shown by its event_id, not by the hash its file is named by', (await shownSoon(receiptRow)) && (await receiptRow.textContent())?.trim() === 'cortex-ad-karari-20261013');
await receiptRow.click();
check(
  'and is read, not written: the screen says Cortex keeps it',
  (await shownSoon(notesView.locator(`[data-note-pane="${receipt}"] [data-note-banner="read-only"]`))) &&
    (await notesView.locator('[data-note-crumbs]').textContent())?.includes('cortex-ad-karari-20261013') &&
    fs.readFileSync(vaultNote(receipt), 'utf8') === receiptBefore,
);
await shoot('07-receipt.png');
/*
  The settings (src/ui/SettingsDialog.tsx): what is not a note or what a note
  shows is out of the tree until every kind is asked for, and a name's leading
  emoji is left out of what is shown unless asked for; the disk is not touched.
*/
const commandCenter = notesView.locator('[data-tree-path="🎯 100-Command-Center"]');
check(
  'scripts, JSON and text files are out of the tree, and names are shown without the emoji they start with',
  (await notesView.locator('[data-tree-path="Notes/settings.json"]').count()) === 0 && (await commandCenter.textContent())?.trim() === '100-Command-Center',
);
await page.locator('[data-settings-open]').click();
check('the gear in the top bar opens the settings', await shownSoon(page.locator('[data-settings]')));
await page.waitForTimeout(400);
await shoot('07b-settings.png');
await page.locator('[data-settings-all-files]').click();
await page.locator('[data-settings-name-icons]').click();
check(
  'a setting changed is kept by the main process at once',
  await page.waitForFunction(async () => {
    const { settings } = await window.cortex.bootstrap();
    return settings.allFiles && settings.nameIcons;
  }, null, { timeout: 5_000 }).then(() => true, () => false),
);
await page.keyboard.press('Escape');
check(
  'and the tree follows it: every kind of file, the names as they are on disk',
  (await shownSoon(notesView.locator('[data-tree-path="Notes/settings.json"]'))) && (await commandCenter.textContent())?.trim() === '🎯 100-Command-Center' && fs.existsSync(vaultNote('🎯 100-Command-Center')),
);
await page.keyboard.press('Control+,');
check('Ctrl+, opens them too', await shownSoon(page.locator('[data-settings]')));
await page.locator('[data-settings-name-icons]').click();
await page.keyboard.press('Escape');
check('and the emoji go again', await page.waitForFunction(() => document.querySelector('[data-tree-path="🎯 100-Command-Center"]')?.textContent?.trim() === '100-Command-Center', null, { timeout: 5_000 }).then(() => true, () => false));
await notesView.locator('[data-tree-path="Notes/settings.json"]').click();
check(
  'a JSON file is shown as the text it is, read only',
  (await shownSoon(notesView.locator('[data-notes-file-text] [data-text-file="Notes/settings.json"]'))) &&
    (await notesView.locator('[data-text-file="Notes/settings.json"]').textContent())?.includes('"theme": "ananas"'),
);
await shoot('08-text-file.png');
await page.keyboard.press('Control+o');
await notesView.locator('[data-notes-switcher-input]').fill('heal');
await page.keyboard.press('Enter');
check('Ctrl+O finds a note by a few letters and opens it', await shownSoon(notesView.locator('[data-note-pane="Personal/Health.md"]')));
await notesView.locator('[data-notes-nav-tab="search"]').click();
await notesView.locator('[data-notes-search]').fill('careful');
check('a search finds a word in any note', await shownSoon(notesView.locator('[data-search-hit="Notes/Master plan.md"]')));
await notesView.locator('[data-notes-nav-tab="files"]').click();
check('back from the search, the tree’s folders are open as they were', await shownSoon(notesView.locator('[data-tree-path="Notes/Ideas.md"]')));
// Dragged onto a folder of the tree, a note moves there, and what linked to it by name still finds it.
await notesView.locator('[data-tree-path="Notes/Ideas.md"]').dragTo(notesView.locator('[data-tree-path="Personal"]'));
check(
  'a note dragged onto a folder moves into it',
  (await onDiskSoon(() => fs.existsSync(vaultNote('Personal/Ideas.md')) && !fs.existsSync(vaultNote('Notes/Ideas.md')))) &&
    (await shownSoon(notesView.locator('[data-tree-path="Personal/Ideas.md"]'))),
);
await notesView.locator('[data-notes-new]').click();
check(
  'a new note is made at the top of the vault, exclusively, from Cortex’s template, filled for its name, and opened to be written',
  (await shownSoon(notesView.locator('[data-note-pane="Untitled.md"]'))) && /^---\ntitle: "Untitled"\ncreated: \d{4}-\d{2}-\d{2}\n/.test(fs.readFileSync(vaultNote('Untitled.md'), 'utf8')),
);
const inboxBefore = fs.readdirSync(vaultNote('📥 000-Inbox/Dump')).filter((name) => name.endsWith('.md'));
await page.keyboard.press('Control+Shift+n');
check(
  'Ctrl+Shift+N captures a note into Cortex’s inbox',
  await onDiskSoon(() => fs.readdirSync(vaultNote('📥 000-Inbox/Dump')).filter((name) => name.endsWith('.md')).length === inboxBefore.length + 1),
);
// Deleted from the tree: into the vault's own bin, with an Undo; and from the bin's list, back where it was.
const healthText = fs.readFileSync(vaultNote('Personal/Health.md'), 'utf8');
await notesView.locator('[data-tree-path="Personal/Health.md"]').click({ button: 'right' });
await page.getByRole('menuitem', { name: 'Move to trash' }).click();
check(
  'a note deleted goes to the vault’s own bin, not away',
  (await onDiskSoon(() => !fs.existsSync(vaultNote('Personal/Health.md')) && fs.existsSync(vaultNote('.trash/Health.md')))) &&
    (await shownSoon(page.locator('[data-toast-action]'))),
);
await page.locator('[data-toast-action]').click();
check(
  'and Undo brings it back where it was, as it was',
  (await onDiskSoon(() => fs.existsSync(vaultNote('Personal/Health.md')) && !fs.existsSync(vaultNote('.trash/Health.md')))) &&
    fs.readFileSync(vaultNote('Personal/Health.md'), 'utf8') === healthText,
);
await notesView.locator('[data-tree-path="Personal/Health.md"]').click({ button: 'right' });
await page.getByRole('menuitem', { name: 'Move to trash' }).click();
await onDiskSoon(() => fs.existsSync(vaultNote('.trash/Health.md')));
await notesView.locator('[data-notes-nav-tab="trash"]').click();
check(
  'the bin lists it, with a count on its tab',
  (await shownSoon(notesView.locator('[data-bin-item="Health.md"]'))) && (await notesView.locator('[data-bin-count]').textContent())?.trim() === '1',
);
await shoot('09-bin.png');
await notesView.locator('[data-bin-item="Health.md"]').hover();
await notesView.locator('[data-bin-item="Health.md"] [data-bin-restore]').click();
check(
  'and restores it from there',
  (await onDiskSoon(() => fs.existsSync(vaultNote('Personal/Health.md')))) && fs.readFileSync(vaultNote('Personal/Health.md'), 'utf8') === healthText,
);
await notesView.locator('[data-notes-nav-tab="files"]').click();

/*
  Pyn (src/chat/, electron/services/chat.ts): the person writes, a CLI
  started in the vault answers over ACP. Here the CLI is the stand-in.
*/
console.log('\nPyn');
await page.locator('[data-app-view="pyn"]').click();
check('Pyn opens on a new chat: the greeting and the field', await shownSoon(page.locator('[data-chat-empty] [data-chat-input]')));
// The tools' sign-ins, from the tool chip: each tool listed with what it says of itself. Nothing is pressed in it: a sign-in opens a window.
await page.locator('[data-chat-chip="cli"]').click();
await page.locator('[data-chat-chip-footer]').click();
check(
  'the tools’ sign-ins open from the tool chip, every tool listed, the model servers with them',
  (await shownSoon(page.locator('[data-auth-list]'), 30_000)) && (await page.locator('[data-auth-tool]').count()) === 7 && (await page.locator('[data-auth-tool="lmstudio"]').count()) === 1,
);
await shoot('15-auth.png');
await page.keyboard.press('Escape');
await page.locator('[data-auth-list]').waitFor({ state: 'detached' });
await page.locator('[data-settings-open]').click();
await page.locator('[data-settings-auth]').click();
check('and from the settings', (await shownSoon(page.locator('[data-auth-list]'), 30_000)) && (await page.locator('[data-settings]').count()) === 0);
await page.keyboard.press('Escape');
await page.locator('[data-auth-list]').waitFor({ state: 'detached' });
await page.locator('[data-chat-chip="cli"]').click();
await page.locator('[data-chat-choice="test"]').click();
await page.locator('[data-chat-input]').fill('merhaba Pyn');
await page.keyboard.press('Enter');
check('a message gets its answer streamed in, its words first', await shownSoon(page.locator('[data-chat-text]', { hasText: 'Merhaba dünya' })));
check('the chat is listed, named by its first words', await shownSoon(page.locator('[data-chat-item]', { hasText: 'merhaba Pyn' })));
check(
  'its steps folded into one line of activity, its context as a ring',
  (await page.locator('[data-chat-fold="activity"]').count()) === 1 && (await page.locator('[data-chat-context]').count()) === 1,
);
check('and nothing on the page names where the vault is', !namesWhere(await page.evaluate(() => document.body.innerHTML)));
await shoot('10-pyn.png');
await page.locator('[data-chat-input]').fill('izin iste');
await page.keyboard.press('Enter');
check('a step the CLI asks leave for is a card over the field', await shownSoon(page.locator('[data-chat-permission]')));
await shoot('11-permission.png');
await page.locator('[data-chat-answer-option="allow_once"]').click();
check('and the answer reaches the CLI', await shownSoon(page.locator('[data-chat-text]', { hasText: 'izin: once' })));
await page.locator('[data-chat-send]').waitFor();
await page.locator('[data-chat-input]').fill('yavaş olsun');
await page.keyboard.press('Enter');
await page.locator('[data-chat-stop]').click();
check('Stop ends an answer, and says so', await shownSoon(page.locator('[data-chat-stopped="cancelled"]')));
await page.locator('[data-chat-send]').waitFor();
await page.locator('[data-chat-input]').fill('giriş yapmadım');
await page.keyboard.press('Enter');
await page.locator('[data-chat-sign-in]').click();
check('a tool not signed in says so, and its card opens the sign-ins', await shownSoon(page.locator('[data-auth-list]'), 30_000));
await page.keyboard.press('Escape');
await page.locator('[data-auth-list]').waitFor({ state: 'detached' });
// Claude Code, in its own stream of JSON: a new chat with its stand-in.
await page.locator('[data-chat-new]').click();
await page.locator('[data-chat-chip="cli"]').click();
await page.locator('[data-chat-choice="test-claude"]').click();
await page.locator('[data-chat-input]').fill('izin iste');
await page.keyboard.press('Enter');
check('Claude Code asks leave on the same card', await shownSoon(page.locator('[data-chat-permission]')));
await page.locator('[data-chat-answer-option="allow_once"]').click();
check(
  'and answers, with the models it named on its chip',
  (await shownSoon(page.locator('[data-chat-text]', { hasText: 'izin: allow' }))) && (await page.locator('[data-chat-chip="model"]').textContent())?.trim() === 'Default (recommended)',
);
await shoot('12-claude.png');
// Codex, through its app server: a command it asks to run, and its final answer, which comes whole.
await page.locator('[data-chat-new]').click();
await page.locator('[data-chat-chip="cli"]').click();
await page.locator('[data-chat-choice="test-codex"]').click();
await page.locator('[data-chat-input]').fill('izin iste');
await page.keyboard.press('Enter');
check('Codex asks to run a command on the same card', await shownSoon(page.locator('[data-chat-permission]')));
await page.locator('[data-chat-answer-option="allow_once"]').click();
check(
  'and its final answer comes, on the model the server marks',
  (await shownSoon(page.locator('[data-chat-text]', { hasText: 'komut: accept.' }))) && (await page.locator('[data-chat-chip="model"]').textContent())?.trim() === 'GPT-6-Luna',
);
await shoot('13-codex.png');
// A note an answer links to opens beside the chat; the panel lists what the chat touched; one opens in the notes from there.
await page.locator('[data-chat-text] .kg-wikilink', { hasText: 'Ideas' }).first().click();
check(
  'a note an answer links to opens beside the chat, and the chat stays',
  (await shownSoon(page.locator('[data-chat-side-note="Personal/Ideas.md"]'))) && (await page.locator('[data-app-view="pyn"]').getAttribute('aria-pressed')) === 'true',
);
await page.locator('[data-chat-side-back]').click();
check('the panel lists the notes the chat touched', await shownSoon(page.locator('[data-chat-side-item="Personal/Ideas.md"]')));
await shoot('14-side.png');
await page.locator('[data-chat-side-item="Personal/Ideas.md"]').click();
await page.locator('[data-chat-side-open]').click();
check(
  'and one opens in the notes from there, to be written',
  (await shownSoon(notesView.locator('[data-note-pane="Personal/Ideas.md"]'))) && (await page.locator('[data-app-view="notes"]').getAttribute('aria-pressed')) === 'true',
);
// LM Studio, talked to directly: the model loaded in its app answers, no other program between.
await page.locator('[data-app-view="pyn"]').click();
await page.locator('[data-chat-new]').click();
await page.locator('[data-chat-chip="cli"]').click();
await page.locator('[data-chat-choice="lmstudio"]').click();
await page.locator('[data-chat-input]').fill('merhaba yerel');
await page.keyboard.press('Enter');
check(
  'LM Studio answers in the chat, on the model loaded in its app, unasked',
  (await shownSoon(page.locator('[data-chat-text]', { hasText: 'Yerel model burada.' }))) &&
    lmBodies.length === 1 &&
    lmBodies[0].model === 'qwen-e2e' &&
    lmBodies[0].messages.at(-1)?.content === 'merhaba yerel' &&
    ((await page.locator('[data-chat-chip="model"]').textContent()) ?? '').includes('qwen-e2e'),
);
await shoot('13b-lmstudio.png');
await page.locator('[data-app-view="graph"]').click();
await page.waitForTimeout(1_500);
const graphSize = await page.locator('[data-notes-graph="vault"]').evaluate((element) => ({ nodes: Number(element.dataset.graphNodes), edges: Number(element.dataset.graphEdges) }));
check('the graph draws the vault’s notes and the links between them', graphSize.nodes >= 4 && graphSize.edges >= 2);
await page.locator('[data-notes-graph="vault"] [data-graph-toggle="receipts"]').click();
await page.waitForTimeout(500);
const withReceipts = await page.locator('[data-notes-graph="vault"]').evaluate((element) => Number(element.dataset.graphNodes));
check('receipts are left out of the vault’s graph until asked for', withReceipts === graphSize.nodes + 1);
await page.locator('[data-notes-graph="vault"] [data-graph-toggle="receipts"]').click();
await shoot('06-graph.png');

/*
  The office (src/office/): Claude Design's drawings and engine in their own
  tab. A room clicked shows what goes on in it with the vault's own counts; a
  character's chip opens its card; the gear, the office's settings.
*/
console.log('\nOffice');
await page.locator('[data-app-view="office"]').click();
check('the office opens in its own tab, its map drawn and its log begun', (await shownSoon(page.locator('[data-office-view] [data-ofis-canvas]'))) && (await page.locator('[data-ofis-line]').count()) >= 1);
await page.waitForTimeout(1_500);
await shoot('16-office.png');
// The map is fitted to the canvas and centred: the mailroom's middle (tile 7, 8) is found from the canvas's size.
const officeBox = await page.locator('[data-ofis-canvas]').boundingBox();
if (officeBox) {
  const zoom = Math.min(4, Math.min(officeBox.width / 976, officeBox.height / 672));
  await page.mouse.click(officeBox.x + officeBox.width / 2 + (7 * 16 + 8 - 488) * zoom, officeBox.y + officeBox.height / 2 + (8 * 16 + 8 - 336) * zoom);
}
check(
  'a room clicked says what goes on in it, counted from the vault',
  (await shownSoon(page.locator('[data-ofis-room="posta"]'))) && /\d+ notes changed today/.test((await page.locator('[data-ofis-room-status]').textContent()) ?? ''),
);
await page.locator('[data-ofis-chip="defne"]').click();
check(
  'a character’s chip opens its card, with the tool it works with',
  (await shownSoon(page.locator('[data-ofis-card="defne"]'))) && ((await page.locator('[data-ofis-card="defne"]').textContent()) ?? '').includes('Works with Claude'),
);
await page.waitForTimeout(800);
await shoot('17-office-card.png');
await page.locator('[data-ofis-gear]').click();
check('the gear opens the office’s settings, live conversations off', (await shownSoon(page.locator('[data-ofis-settings]'))) && (await page.locator('[data-ofis-live]').getAttribute('aria-checked')) === 'false');
await page.keyboard.press('Escape');
check('and Escape closes them', await page.locator('[data-ofis-settings]').waitFor({ state: 'detached', timeout: 3_000 }).then(() => true, () => false));
check(
  'nothing was written into what is hidden',
  fs.readFileSync(vaultNote('.hidden/Secret.md'), 'utf8') === hiddenBefore && fs.readFileSync(vaultNote('.obsidian/workspace.json'), 'utf8') === obsidianBefore,
);
await page.locator('[data-app-view="notes"]').click();

/*
  Last before the restart, because Playwright waits for a navigation it saw
  begin even when the app refused it: the page asks to go to the network, and
  the main process says where it still is.
*/
await page.evaluate(() => {
  window.location.href = 'https://example.com/';
});
await page.waitForTimeout(800);
const stillAt = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((one) => one.webContents.getURL()));
check('and the page does not navigate away', stillAt.length === 1 && stillAt[0].startsWith('file:') && stillAt[0].endsWith('/dist/index.html'));
check('what it asked for went to the system’s browser instead (stood in for: nothing was opened)', (await openedOutside()).filter((url) => url === 'https://example.com/').length === 2);

/*
  Closed and opened again: the vault and the language are the app's own
  settings, in its data folder, and the window opens where it was.
*/
console.log('\nOpened again');
await app.close();
app = await launch();
page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await holdBrowser();
listen(page);
check('the vault chosen is opened again, with nothing to choose', await shownSoon(page.locator('[data-notes-view]'), 30_000));
check('in the language chosen', (await page.evaluate(() => document.documentElement.lang)) === 'en');
check('and the settings file is in the app’s data, not in the vault', fs.existsSync(path.join(userData, 'settings.json')) && !fs.readdirSync(vaultDir).includes('settings.json'));

// The policy's refusals of the probes above are what was asked for; anything else the window logged is a fault.
const unexpected = consoleErrors.filter((text) => !text.includes('https://example.com/'));
check('the window logged no errors but the refusals asked for', unexpected.length === 0 && consoleErrors.length >= 2);
if (unexpected.length) console.log(unexpected.map((e) => `       ${e}`).join('\n'));

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(vaultDir, { recursive: true, force: true });

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'All smoke checks passed'}`);
process.exit(failures.length ? 1 : 0);

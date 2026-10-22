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
// The engine package the app came with, stood in for: the settings offer it, the run never installs it.
const enginePackages = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-paket-'));
fs.writeFileSync(path.join(enginePackages, 'beyin-v3-9.9.9.zip'), '');
// Where the chat's stand-in waits before it asks leave, for a message with "kapı" (tests/fixtures/fake-acp-agent.mjs): the run opens it from another view.
const agentGateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-gate-'));
const agentGate = path.join(agentGateDir, 'open');
/*
  Claude Code as installed, stood in for on the app's PATH: it says only that its sign-in is kept
  (`claude auth status --json`). The first-run screen lists the tools installed; without it the
  run saw whatever the machine had - a real `claude` here, none on GitHub's Windows runner (18 October).
  The chat's own Claude is CORTEX_TEST_CLAUDE's stand-in, as before.
*/
const toolBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-bin-'));
fs.writeFileSync(
  path.join(toolBin, 'claude-status.mjs'),
  "const [what, how] = process.argv.slice(2);\n" +
    "if (what === 'auth' && how === 'status') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'e2e@example.com' }));\n" +
    "else process.exit(1);\n",
);
// Windows spells it Path: one key, so the child gets one PATH.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
if (process.platform === 'win32') {
  // As npm writes a script's shim: the app reads the script it names and runs it with node.
  fs.writeFileSync(path.join(toolBin, 'claude.cmd'), '@ECHO off\r\nnode "%dp0%\\claude-status.mjs" %*\r\n');
} else {
  fs.writeFileSync(path.join(toolBin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(toolBin, 'claude-status.mjs')}" "$@"\n`, { mode: 0o755 });
}
const write = (relative, text) => {
  fs.mkdirSync(path.dirname(vaultNote(relative)), { recursive: true });
  fs.writeFileSync(vaultNote(relative), text);
};

/*
  The vault: this repository's template, in the shape the owner's vault has
  (its `📋 Templates/Note.md`, `📥 000-Inbox/Dump`, from the installer before
  v3; a vault the v3 installer starts has neither, and a new note there starts
  empty: misc-scripts-2), the hidden parts Obsidian, git and Cortex keep, and a
  few notes of the person's.
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
// Notes for the writing checks below (src/notes/NotePane.tsx, NoteEditor.tsx): typed while the disk is slow, left while in conflict, a Windows note's line endings.
write('Drafts/E2E Race.md', '# Race\n\nStart');
write('Drafts/E2E Slow.md', '# Slow\n\nStart');
write('Drafts/E2E Kept.md', '# Kept\n\nbase');
write('Drafts/E2E Gone.md', '# Gone\n\nbase');
write('Drafts/E2E Binned.md', '# Binned\n\nbase');
write('Drafts/E2E Windows.md', '# Windows\r\n\r\n- [ ] task\r\nline');
write('Drafts/E2E Mixed.md', 'one\r\ntwo\nthree\n');
write('Drafts/İstanbul Gezisi.md', '# İstanbul Gezisi\n\n## Işık\nGün ışığı.\n');
write('Drafts/E2E Embeds.md', '# Embeds\n\n![[İstanbul Gezisi#ışık]]\n');
write('Drafts/E2E Closing.md', '# Closing\n\nStart');
write('Drafts/E2E Switch.md', '# Switch\n\nbase');
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
    } else if (request.url === '/v1/chat/completions' && JSON.parse(body).stream === false) {
      // The office's live conversation: asked once, not streamed (electron/services/officeTalk.ts).
      lmBodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"lines":[{"who":"defne","text":"«Plan» notuna dipnot lazım."},{"who":"pyn","text":"Hmm."}]}' } }] }));
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
      FAKE_AGENT_GATE: agentGate,
      // The model servers: LM Studio's stand-in, and Ollama where nothing answers; never the machine's own.
      CORTEX_TEST_LMSTUDIO: lmStudioBase,
      CORTEX_TEST_OLLAMA: 'http://127.0.0.1:9',
      CORTEX_ENGINE_PACKAGES: enginePackages,
      [pathKey]: `${toolBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
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
/** Whether `test` comes true within a while: for what the run sees outside the window (a file). */
async function soon(test, timeout = 8_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) {
    if (test()) return true;
  }
  return false;
}
/** The vault's engine stood in for, for voice typing: installed, its commands kept in `folder`, what it is asked logged there. */
const voiceStandIn = (folder) => String.raw`
import json, os, sys
folder = ${JSON.stringify(folder)}
args = sys.argv[1:]
with open(os.path.join(folder, 'istenen.log'), 'a', encoding='utf-8') as log:
    log.write(' '.join(args) + '\n')
kept = os.path.join(folder, 'komutlar.json')
commands = json.load(open(kept, encoding='utf-8')) if os.path.exists(kept) else {
    'kaydet': ['kaydet'], 'sil': ['sil', 'temizle', 'hepsini sil'], 'kelime_sil': ['son kelimeyi sil'],
    'cumle_sil': ['son cümleyi sil'], 'iptal': ['iptal', 'vazgeç']}
if args[:2] == ['ses', 'ayar'] and '--komutlar' in args:
    commands.update(json.loads(args[args.index('--komutlar') + 1]))
    json.dump(commands, open(kept, 'w', encoding='utf-8'))
said = os.path.join(folder, 'soz.txt')
if args[:2] == ['ses', 'ayar'] and '--uyandirma-sozu' in args:
    open(said, 'w', encoding='utf-8').write(args[args.index('--uyandirma-sozu') + 1])
phrase = open(said, encoding='utf-8').read() if os.path.exists(said) else 'pyn not al'
if args[:2] == ['yakala', 'durum']:
    print(json.dumps({'status': 'tamam', 'kurulu': True}))
elif args[:1] == ['ses']:
    print(json.dumps({'kurulu': True, 'acik': True, 'uyandirma': False, 'otomatik_dinle': True, 'motor': 'vulkan',
                      'model': 'large-v3-turbo (ekran kartı, Vulkan)', 'komutlar': commands, 'adla_kaydet': ['gönder', 'tamam'], 'uyandirma_sozu': phrase}, ensure_ascii=False))
else:
    print('bilinmeyen komut', file=sys.stderr)
    sys.exit(2)
`;

console.log('\nFirst opening');
check('a first run opens on the first-run screen, Pyn asking how to address the person', await shownSoon(page.locator('[data-onboarding-step="name"]'), 30_000));
check(
  'in Turkish, unless chosen otherwise, cased as Turkish',
  (await page.locator('[data-onboarding-next]').textContent())?.trim() === 'Devam' && (await page.evaluate(() => document.documentElement.lang)) === 'tr',
);
await shoot('01-welcome-tr.png');
await page.locator('[data-language="en"]').click();
check(
  'English is one choice away, and the choice is kept by the main process',
  (await shownSoon(page.getByRole('button', { name: 'Next' }))) &&
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
check('the page has no node in it, and only the bridge', windowAlone.node === 'undefinedundefined' && windowAlone.bridge.join(',') === 'bootstrap,chat,notes,office,on,settings,setup,telegram,vault');
check('it reaches nothing on the network: no request, no image', windowAlone.fetched === 'blocked' && windowAlone.image === 'blocked');
check('and opens no window of its own', windowAlone.opened && app.windows().length === 1);

console.log('\nThe vault');
// The system's dialog answers with the vault for this run; the window names no folder.
await app.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
}, vaultDir);
/*
  The first-run screen (src/onboarding/): the name first, then each thing to
  set up in turn, each skippable but the vault; nothing is installed here.
*/
const onward = async () => {
  const skip = page.locator('[data-onboarding-skip]');
  await ((await skip.count()) ? skip : page.locator('[data-onboarding-next]')).click();
};
await page.locator('[data-onboarding-name]').fill('Tolga');
check('a name alone is offered with Bey and Hanım', await shownSoon(page.locator('[data-onboarding-name-chip="Tolga Bey"]')));
await page.locator('[data-onboarding-name-chip="Tolga Bey"]').click();
await page.locator('[data-onboarding-next]').click();
check(
  'how to address the person is kept by the main process',
  await page.waitForFunction(async () => (await window.cortex.bootstrap()).settings.userName === 'Tolga Bey', null, { timeout: 5_000 }).then(() => true, () => false),
);
check('and the next step says it', (await shownSoon(page.locator('[data-onboarding-step="vault"]'))) && (await page.locator('[data-onboarding] h1').textContent())?.includes('Tolga Bey'));
check('the vault cannot be skipped: Next waits for it', (await page.locator('[data-onboarding-skip]').count()) === 0 && (await page.locator('[data-onboarding-next]').isDisabled()));
await page.locator('[data-welcome-choose]').click();
check('a vault chosen there is said by its name', await shownSoon(page.locator('[data-onboarding-ready]')));
await shoot('01b-onboarding-vault.png');
await page.locator('[data-onboarding-next]').click();
if (await page.locator('[data-onboarding-step="python"]').count()) await onward();
check('Pyn’s memory comes next, each step said before it is done', await shownSoon(page.locator('[data-onboarding-step="engine"] [data-onboarding] h1, [data-onboarding-step="engine"] h1')));
await shoot('01c-onboarding-engine.png');
await onward();
check('then the AI tools', await shownSoon(page.locator('[data-onboarding-step="tools"]')));
{
  const kept = await shownSoon(page.locator('[data-onboarding-tool="claude"] [data-onboarding-tool-state="onboarding.tools.kept"]'));
  // Signing in opens the tool's own console window: offered on Windows only (electron/services/auth.ts, canLogin).
  const again = (await page.locator('[data-onboarding-tool="claude"] [data-onboarding-tool-login]').count()) === (process.platform === 'win32' ? 1 : 0);
  // A model server asked just now, its model loaded, is what counts as ready without a sign-in.
  const serving = await shownSoon(page.locator('[data-onboarding-tool="lmstudio"] [data-onboarding-tool-state="onboarding.tools.serving"]'));
  check('a sign-in the tool keeps is not called ready: it may have run out, and signing in again is offered', kept && again && serving);
  if (!(kept && again && serving)) {
    // Which part, and what the rows said: a hidden window's picture can be an earlier frame.
    const rows = await page.locator('[data-onboarding-tool]').evaluateAll((items) =>
      items.map((li) => `${li.getAttribute('data-onboarding-tool')}: ${li.querySelector('[data-onboarding-tool-state]')?.getAttribute('data-onboarding-tool-state')}${li.querySelector('[data-onboarding-tool-login]') ? ' + sign-in' : ''}`),
    );
    console.log(`       kept ${kept}, sign-in offered as expected ${again}, serving ${serving}; rows: ${rows.join(' | ') || 'none'}`);
  }
}
await shoot('01c2-onboarding-tools.png');
await onward();
if (process.platform === 'win32') {
  check('then voice typing', await shownSoon(page.locator('[data-onboarding-step="voice"]')));
  await onward();
}
check(
  'the last step lists what was left, to be set up later from the settings',
  (await shownSoon(page.locator('[data-onboarding-step="done"]'))) && (await page.locator('[data-onboarding-summary="engine"]').textContent())?.includes('skipped'),
);
await shoot('01d-onboarding-done.png');
await page.locator('[data-onboarding-finish]').click();
check('then Pyn opens, where the person talks to their AI', await shownSoon(page.locator('[data-chat-view]'), 15_000));
check('and the first-run screen is gone through for good', (await page.evaluate(() => window.cortex.bootstrap())).settings.onboarded === true);
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
  Nothing typed is lost (src/notes/NotePane.tsx). The main process's handlers
  are slowed or counted for these checks through Electron's own table of them
  (`ipcMain._invokeHandlers`, an internal: a check that cannot reach it fails,
  it does not pass by not running).
*/
const holdChannel = (channel, delay = 0) =>
  app.evaluate(
    ({ ipcMain }, { channel, delay }) => {
      const table = ipcMain._invokeHandlers;
      if (!(table instanceof Map) || !table.has(channel)) return false;
      globalThis.cortexHeld ??= {};
      globalThis.cortexCalls ??= {};
      const original = globalThis.cortexHeld[channel] ?? table.get(channel);
      globalThis.cortexHeld[channel] = original;
      globalThis.cortexCalls[channel] = 0;
      table.set(channel, async (...args) => {
        globalThis.cortexCalls[channel] += 1;
        if (delay) await new Promise((done) => setTimeout(done, delay));
        return original(...args);
      });
      return true;
    },
    { channel, delay },
  );
const releaseChannel = (channel) =>
  app.evaluate(({ ipcMain }, channel) => {
    const original = globalThis.cortexHeld?.[channel];
    if (original) ipcMain._invokeHandlers.set(channel, original);
    delete globalThis.cortexHeld?.[channel];
  }, channel);
const callsOf = (channel) => app.evaluate((_electron, channel) => globalThis.cortexCalls?.[channel] ?? 0, channel);
/** A note opened by its name with Ctrl+O, as the person would. */
const openNote = async (name, at) => {
  await page.keyboard.press('Control+o');
  await notesView.locator('[data-notes-switcher-input]').fill(name);
  // Enter once the note is the one offered first: pressed before, it chose nothing and left the switcher over the page.
  await shownSoon(notesView.locator(`[data-switch-at="0"][data-switch-path="${at}"]`), 5_000);
  await page.keyboard.press('Enter');
  return shownSoon(notesView.locator(`[data-note-pane="${at}"]`));
};
/** The note in front, written in at its end. */
const writeAtEnd = async (text, delay = 0) => {
  if ((await notesView.locator('[data-note-mode="edit"]').getAttribute('aria-pressed')) !== 'true') await notesView.locator('[data-note-mode="edit"]').click();
  await notesView.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay });
};
const savingIs = (state, timeout = 10_000) =>
  page.waitForFunction((state) => document.querySelector('[data-note-saving]')?.getAttribute('data-note-saving') === state, state, { timeout }).then(() => true, () => false);
const clearToasts = async () => {
  for (let left = await page.locator('[data-toast-close]').count(); left > 0; left = await page.locator('[data-toast-close]').count()) await page.locator('[data-toast-close]').first().click();
};
const draft = (name) => vaultNote(`Drafts/${name}`);
const keptAside = (title) => fs.readdirSync(vaultNote('Drafts')).find((name) => new RegExp(`^${title} \\((conflict|çakışma) \\d{4}-\\d\\d-\\d\\d \\d\\d\\.\\d\\d\\)\\.md$`).test(name));

// Typed just after a save, while the index is still built again with the time before it (desktop-ui-1).
await openNote('E2E Race', 'Drafts/E2E Race.md');
const held = (await holdChannel('notes:index', 900)) && (await holdChannel('notes:read'));
check('the main process’s handlers can be slowed and counted for the checks below', held);
await writeAtEnd(' one');
await onDiskSoon(() => fs.readFileSync(draft('E2E Race.md'), 'utf8') === '# Race\n\nStart one');
const readsBefore = await callsOf('notes:read');
await page.keyboard.type(' two three', { delay: 30 });
const raced = await onDiskSoon(() => fs.readFileSync(draft('E2E Race.md'), 'utf8') === '# Race\n\nStart one two three', 8_000);
await savingIs('saved');
check(
  'what is typed right after a save, while the vault is read again, all reaches the disk: the note is not read again over it, and nothing says it changed',
  raced &&
    (await callsOf('notes:read')) - readsBefore <= 1 &&
    (await notesView.locator('[data-note-banner]').count()) === 0 &&
    ((await notesView.locator('.cm-content').textContent()) ?? '').endsWith('Start one two three'),
);
await releaseChannel('notes:index');
await releaseChannel('notes:read');
fs.writeFileSync(draft('E2E Race.md'), '# Race\n\nFrom outside.');
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
check(
  'and a note written elsewhere, with nothing unsaved here, is still read again',
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('From outside.'), null, { timeout: 8_000 }).then(() => true, () => false),
);

// Typed while a slow save is running: saved once it ends (desktop-ui-5).
await openNote('E2E Slow', 'Drafts/E2E Slow.md');
await holdChannel('notes:save', 1_500);
await writeAtEnd(' a');
const wasSaving = await savingIs('saving', 5_000);
await page.keyboard.type(' b');
const slowSaved = await onDiskSoon(() => fs.readFileSync(draft('E2E Slow.md'), 'utf8') === '# Slow\n\nStart a b', 12_000);
check(
  'what is typed while a slow save runs is saved after it, with nothing more typed',
  wasSaving && slowSaved && (await savingIs('saved')) && (await notesView.locator('[data-note-banner]').count()) === 0,
);
await releaseChannel('notes:save');

// The window left: saved at once, not a second after the last key (desktop-ui-8).
await writeAtEnd(' c');
const blurred = await page.evaluate(() => {
  const label = document.querySelector('[data-note-saving]');
  const typed = performance.now();
  return new Promise((done) => {
    const seen = new MutationObserver(() => {
      if (label?.getAttribute('data-note-saving') !== 'saving') return;
      seen.disconnect();
      done(performance.now() - typed);
    });
    if (label) seen.observe(label, { attributes: true });
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => done(Infinity), 3_000);
  });
});
check(
  'the window left saves the note at once',
  blurred < 500 && (await onDiskSoon(() => fs.readFileSync(draft('E2E Slow.md'), 'utf8') === '# Slow\n\nStart a b c')),
);

// Left while it says it changed on disk: what was typed is kept beside it, and said (desktop-ui-3).
await openNote('E2E Kept', 'Drafts/E2E Kept.md');
await writeAtEnd(' mine');
fs.writeFileSync(draft('E2E Kept.md'), '# Kept\n\nfrom outside');
const inConflict = await shownSoon(notesView.locator('[data-note-banner="conflict"]'));
await openNote('E2E Race', 'Drafts/E2E Race.md');
const keptToast = page.locator('[data-toast="info"]', { hasText: 'kept in a note of its own' });
check(
  'a note left while it is in conflict keeps what was typed in a note beside it, and says which',
  inConflict &&
    (await onDiskSoon(() => Boolean(keptAside('E2E Kept')))) &&
    fs.readFileSync(draft(keptAside('E2E Kept')), 'utf8') === '# Kept\n\nbase mine' &&
    fs.readFileSync(draft('E2E Kept.md'), 'utf8') === '# Kept\n\nfrom outside' &&
    (await shownSoon(keptToast)),
);
check('a toast’s close button is named, for a screen reader', await shownSoon(keptToast.locator('[data-toast-close][aria-label="Close"]'), 3_000));
await shoot('04b-kept-aside.png');
await clearToasts();

// Gone from where it was while something was unsaved in it: kept beside where it was.
await openNote('E2E Gone', 'Drafts/E2E Gone.md');
await writeAtEnd(' kept');
fs.rmSync(draft('E2E Gone.md'));
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
check(
  'a note taken away while something in it is unsaved keeps that in a note where it was',
  (await onDiskSoon(() => Boolean(keptAside('E2E Gone')))) && fs.readFileSync(draft(keptAside('E2E Gone')), 'utf8') === '# Gone\n\nbase kept',
);
await shownSoon(page.locator('[data-toast="info"]', { hasText: 'kept in a note of its own' }));
await clearToasts();

// Deleted a moment after the last key: the bin has what was typed, and nothing fails after.
await openNote('E2E Binned', 'Drafts/E2E Binned.md');
await writeAtEnd(' last');
await notesView.locator('[data-note-pane="Drafts/E2E Binned.md"] button[aria-label="More"]').click();
await page.getByRole('menuitem', { name: 'Move to trash' }).click();
const binned = () => (fs.existsSync(vaultNote('.trash')) ? fs.readdirSync(vaultNote('.trash')).find((name) => name.startsWith('E2E Binned')) : undefined);
check(
  'a note deleted a moment after the last key goes to the bin with what was typed, and nothing says a save failed',
  (await onDiskSoon(() => Boolean(binned()) && !fs.existsSync(draft('E2E Binned.md')))) &&
    fs.readFileSync(vaultNote(`.trash/${binned()}`), 'utf8') === '# Binned\n\nbase last' &&
    (await shownSoon(page.locator('[data-toast="success"]', { hasText: 'in the trash' }))) &&
    (await page.locator('[data-toast="error"]').count()) === 0,
);
// Taken back, so the bin is as the checks further on expect it: empty but for what they put in it.
await page.locator('[data-toast="success"]', { hasText: 'in the trash' }).locator('[data-toast-action]').click();
await onDiskSoon(() => fs.existsSync(draft('E2E Binned.md')));
await clearToasts();

// A note written on Windows, with \r\n: opened to write in, it is not saved; written in, it keeps them (desktop-ui-6).
await holdChannel('notes:save');
await openNote('E2E Windows', 'Drafts/E2E Windows.md');
await notesView.locator('.cm-content').waitFor();
const openedQuiet = await page.evaluate(
  () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelector('[data-note-saving]')?.getAttribute('data-note-saving'))))),
);
check(
  'a Windows note opened to write in is not saved, nor said unsaved',
  openedQuiet === 'saved' && (await callsOf('notes:save')) === 0 && fs.readFileSync(draft('E2E Windows.md'), 'utf8') === '# Windows\r\n\r\n- [ ] task\r\nline',
);
check('its task box is named in the window’s language', await shownSoon(notesView.locator('.cm-lp-task[aria-label="To do"]'), 3_000));
await writeAtEnd('!');
check(
  'and written in, it is saved with \\r\\n on every line still',
  await onDiskSoon(() => fs.readFileSync(draft('E2E Windows.md'), 'utf8') === '# Windows\r\n\r\n- [ ] task\r\nline!'),
);
const savesBefore = await callsOf('notes:save');
await openNote('E2E Mixed', 'Drafts/E2E Mixed.md');
await notesView.locator('.cm-content').waitFor();
const mixedQuiet = await page.evaluate(
  () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelector('[data-note-saving]')?.getAttribute('data-note-saving'))))),
);
check(
  'a note with both kinds of line break is left as it is until written in',
  mixedQuiet === 'saved' && (await callsOf('notes:save')) === savesBefore && fs.readFileSync(draft('E2E Mixed.md'), 'utf8') === 'one\r\ntwo\nthree\n',
);
await releaseChannel('notes:save');

// A name with a dotted or dotless I is the same name in the switcher and in an embed (desktop-ui-12).
await page.keyboard.press('Control+o');
await notesView.locator('[data-notes-switcher-input]').fill('istanbul gezisi');
check(
  'Ctrl+O does not offer to make a note the vault has under a dotted İ',
  (await shownSoon(notesView.locator('[data-switch-at="0"]', { hasText: 'İstanbul Gezisi' }))) && (await notesView.locator('[data-switch-make]').count()) === 0,
);
await page.keyboard.press('Escape');
await openNote('E2E Embeds', 'Drafts/E2E Embeds.md');
await notesView.locator('[data-note-mode="read"]').click();
check(
  'and an embed finds the heading a link finds, Işık by ışık',
  await shownSoon(notesView.locator('[data-note-embed="Drafts/İstanbul Gezisi.md"]', { hasText: 'Gün ışığı.' })),
);
const menuRoles = await app.evaluate(({ Menu }) => {
  const roles = [];
  const walk = (items) => {
    for (const item of items) {
      roles.push(String(item.role ?? '').toLowerCase());
      if (item.submenu) walk(item.submenu.items);
    }
  };
  walk(Menu.getApplicationMenu()?.items ?? []);
  return roles;
});
check('the page cannot be reloaded from the menu, where a reload drops what a note holds unsaved', menuRoles.includes('zoomin') && !menuRoles.includes('reload') && !menuRoles.includes('forcereload'));
// The folder these notes are in closed again, as the tree was: the drag further on reaches its folder without scrolling.
if ((await notesView.locator('[data-tree-path="Drafts"]').getAttribute('aria-expanded')) === 'true') await notesView.locator('[data-tree-path="Drafts"]').click();
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
check('its close button is named, for a screen reader', (await page.locator('[role="dialog"] header button[aria-label="Close"]').count()) === 1);
check(
  'Cortex stays at the bottom right when the window is closed, unless told otherwise',
  (await page.locator('[data-settings-background]').getAttribute('aria-checked')) === 'true',
);
/*
  Cortex set up from the app (src/ui/SetupSections.tsx): this vault, a copy of
  the template, has no engine; the settings offer the one the app came with,
  and voice typing waits for it. Nothing is installed by the run.
*/
check(
  'a vault without Cortex’s memory is offered it, from the package the app came with (or told Python is needed)',
  (await shownSoon(page.locator('[data-settings-section="cortex"] [data-setup-note="none"], [data-settings-section="cortex"] [data-setup-note="no-python"]'))) &&
    ((await page.locator('[data-setup-note="no-python"]').count()) === 1 || (await page.locator('[data-setup-engine]').count()) === 1),
);
check(
  'opening a vault binds its engine to where the vault is now; this one has none, so nothing is done or said',
  (await page.evaluate(() => window.cortex.setup.settle())) === null && (await page.locator('[data-toast="error"]').count()) === 0,
);
check(
  'and voice typing waits for the memory',
  process.platform !== 'win32' || (await shownSoon(page.locator('[data-settings-section="voice"] [data-setup-note="needs-engine"]'))),
);
check('and Telegram is not offered before there is a memory to write into', (await page.locator('[data-settings-section="telegram"]').count()) === 0);
await page.waitForTimeout(400);
await shoot('07b-settings.png');
await page.locator('[data-settings-all-files]').click();
check('a setting changed says it was kept', await shownSoon(page.locator('[data-settings-saved="shown"]'), 3_000));
// A name being typed gets a Kaydet button beside it, gone once the field says what is kept.
await page.locator('[data-settings-name]').fill('Tolga');
check('a name being typed gets a save button', await shownSoon(page.locator('[data-settings-name-save]'), 3_000));
await page.locator('[data-settings-name]').fill('Tolga Bey');
check('and none once it is what is kept', (await page.locator('[data-settings-name-save]').count()) === 0);
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
/*
  The spoken commands, set from the settings (src/ui/SetupSections.tsx): a
  stand-in for the vault's engine says voice typing is installed and keeps what
  it is asked. Words changed in a command's field go to the engine's own
  setting, `ses ayar --komutlar`. Windows only, as voice typing is.
*/
if (process.platform === 'win32' && (await page.evaluate(() => window.cortex.setup.status())).python) {
  const askedLog = path.join(enginePackages, 'istenen.log');
  fs.writeFileSync(vaultNote('beyin.py'), voiceStandIn(enginePackages));
  fs.writeFileSync(vaultNote('.beyin-version'), '9.9.9\n');
  await page.keyboard.press('Control+,');
  const saveWords = page.locator('[data-setup-voice-command="kaydet"]');
  check(
    'installed voice typing shows the spoken commands, each one’s words there to change',
    (await shownSoon(saveWords, 15_000)) && (await saveWords.inputValue()) === 'kaydet' &&
      (await page.locator('[data-setup-voice-command="kelime_sil"]').inputValue()) === 'son kelimeyi sil',
  );
  await page.locator('[data-setup-voice-commands]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shoot('07c-voice-commands.png');
  await saveWords.fill('kaydet,  tamamdır ');
  check('words changed in a command’s field get a save button', await shownSoon(page.locator('[data-setup-voice-command-save]'), 3_000));
  await saveWords.press('Enter');
  check(
    'and words changed there are set with the engine’s own setting',
    await soon(() => fs.existsSync(askedLog) && fs.readFileSync(askedLog, 'utf8').includes('ses ayar --komutlar {"kaydet":["kaydet","tamamdır"]}')),
  );
  check('and shown as the engine kept them', await page.waitForFunction(() => document.querySelector('[data-setup-voice-command="kaydet"]')?.value === 'kaydet, tamamdır', null, { timeout: 5_000 }).then(() => true, () => false));
  // The wake phrase: "Pyn, not al" or "Hey Pyn", set with the engine's own setting.
  const hey = page.locator('[data-setup-voice-phrase="hey pyn"]');
  await hey.scrollIntoViewIfNeeded();
  await hey.click();
  check(
    'the wake phrase is chosen there: "Hey Pyn" set with the engine’s own setting, and shown chosen',
    (await soon(() => fs.readFileSync(askedLog, 'utf8').includes('ses ayar --uyandirma-sozu hey pyn'))) &&
      (await page.waitForFunction(() => document.querySelector('[data-setup-voice-phrase="hey pyn"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5_000 }).then(() => true, () => false)),
  );
  await page.locator('[data-setup-voice-phrase="ikisi"]').click();
  check(
    'or both at once',
    (await soon(() => fs.readFileSync(askedLog, 'utf8').includes('ses ayar --uyandirma-sozu ikisi'))) &&
      (await page.waitForFunction(() => document.querySelector('[data-setup-voice-phrase="ikisi"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5_000 }).then(() => true, () => false)),
  );
  await page.waitForTimeout(300);
  await shoot('07e-voice-phrase.png');
  // Listening all the time is asked for first, in the app's own words; "not now" leaves the engine unasked.
  const wake = page.locator('[data-setup-voice-wake]');
  await wake.scrollIntoViewIfNeeded();
  await wake.click();
  const asking = await shownSoon(page.locator('[data-consent="wake"]'));
  await shoot('07f-microphone-consent.png');
  await page.locator('[data-consent-no]').click();
  await page.waitForTimeout(500);
  check(
    'the microphone listens all the time only once allowed: asked first, and "not now" turns nothing on',
    asking && (await page.locator('[data-consent]').count()) === 0 && !fs.readFileSync(askedLog, 'utf8').includes('ses ayar --uyandirma ac'),
  );
  await wake.click();
  await page.locator('[data-consent-yes]').click();
  check(
    'allowed, it is turned on with the engine’s own setting, and the leave is kept',
    (await soon(() => fs.readFileSync(askedLog, 'utf8').includes('ses ayar --uyandirma ac'))) &&
      (await page.waitForFunction(async () => (await window.cortex.bootstrap()).settings.wakeConsent === true, null, { timeout: 5_000 }).then(() => true, () => false)),
  );
  await page.keyboard.press('Escape');
  fs.rmSync(vaultNote('beyin.py'));
  fs.rmSync(vaultNote('.beyin-version'));
}
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
/*
  The card and the keyboard (src/chat/permissionKey.ts). Asked while the person
  is in the notes - the stand-in holds its question until the gate opens - the
  card is said by a notice and a mark on Pyn's tab; Enter typed in a note writes
  a line and answers nothing; the notice leads back; Enter on "Reject" rejects.
  Had the note's Enter answered, the stand-in would have said "once".
*/
const waitingNotice = page.locator('[data-toast="info"]', { hasText: 'Pyn is waiting for you' });
await page.locator('[data-chat-input]').fill('izin iste, kapıda bekle');
await page.keyboard.press('Enter');
await page.locator('[data-chat-stop]').waitFor();
await page.locator('[data-app-view="notes"]').click();
fs.writeFileSync(agentGate, '');
check(
  'a step asked while the chat is not in front is said by a notice and a mark on Pyn’s tab',
  (await shownSoon(waitingNotice)) && (await shownSoon(page.locator('[data-app-view="pyn"] [data-app-view-waiting]'))),
);
await shoot('11b-waiting.png');
await notesView.locator('[data-tree-path="Untitled.md"]').click();
await notesView.locator('[data-note-mode="edit"]').click();
await notesView.locator('.cm-content').click();
await page.keyboard.press('Control+End');
const enterInNote = await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-content')));
await page.keyboard.press('Enter');
await notesView.locator('[data-note-mode="read"]').click();
// An Enter that had answered would have taken the notice and the card with it: then the run goes on to say so, not stop.
const ledBack = await waitingNotice
  .locator('[data-toast-action]')
  .click({ timeout: 5_000 })
  .then(
    () => true,
    () => page.locator('[data-app-view="pyn"]').click().then(() => false),
  );
check(
  'and the notice leads back to the chat and its card, and goes; the chat is marked in the list',
  ledBack &&
    (await page.locator('[data-app-view="pyn"]').getAttribute('aria-pressed')) === 'true' &&
    (await shownSoon(page.locator('[data-chat-permission]'), 3_000)) &&
    (await waitingNotice.count()) === 0 &&
    (await page.locator('[data-chat-item] [data-chat-waiting]').count()) === 1,
);
if (await page.locator('[data-chat-permission]').count()) {
  await page.locator('[data-chat-answer-option="reject_once"]').focus();
  await page.keyboard.press('Enter');
}
check(
  'Enter in a note answered nothing, and Enter on “Reject” rejects',
  enterInNote && (await shownSoon(page.locator('[data-chat-text]', { hasText: 'izin: reject' }))) && (await page.locator('[data-chat-text]', { hasText: 'izin: once' }).count()) === 1,
);
check('the mark on Pyn’s tab goes with the card', await page.locator('[data-app-view-waiting]').waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false));
await page.locator('[data-chat-send]').waitFor();
// With the chat in front and nothing focused, Enter is "once", as the card says.
await page.locator('[data-chat-input]').fill('izin iste');
await page.keyboard.press('Enter');
await page.locator('[data-chat-permission]').waitFor();
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Enter');
check('with the chat in front and nothing focused, Enter allows once', await shownSoon(page.locator('[data-chat-text]', { hasText: 'izin: once' }).nth(1)));
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
// Changed on disk with the chat in front, as the AI writes a note: read again beside the chat, the notes never opened.
fs.appendFileSync(vaultNote('Personal/Ideas.md'), '\nPyn added this line.\n');
check(
  'a note changed on disk is read again beside the chat, with the notes not in front',
  await shownSoon(page.locator('[data-chat-side-note="Personal/Ideas.md"]', { hasText: 'Pyn added this line.' })),
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
check('and it is offered its one tool, which only saves to the inbox', JSON.stringify(lmBodies[0].tools ?? []).includes('save_to_inbox'));
// Kept for later from the field, beside Send: Ctrl+Enter asks the model nothing. This vault has no engine, so the inbox says why it cannot.
const askedBefore = lmBodies.length;
await page.locator('[data-chat-input]').fill('sonra bakılacak https://example.com/yazi');
await page.keyboard.press('Control+Enter');
check(
  'Ctrl+Enter keeps what is written for the inbox instead, and the model is not asked',
  (await page.locator('[data-chat-inbox]').count()) === 1 &&
    (await shownSoon(page.locator('[data-toast="error"]', { hasText: 'Could not add it to the inbox' }))) &&
    lmBodies.length === askedBefore &&
    (await page.locator('[data-chat-input]').inputValue()) === 'sonra bakılacak https://example.com/yazi',
);
await page.locator('[data-toast="error"]', { hasText: 'Could not add it to the inbox' }).locator('button').last().click();
await page.locator('[data-chat-input]').fill('');
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
check('and greets the person as they asked to be addressed', (await page.locator('[data-ofis-line]').allTextContents()).some((line) => line.includes('Tolga Bey')));
await page.waitForTimeout(1_500);
await shoot('16-office.png');
// The brain around the map is fitted to the canvas and centred (the frame is 1168 by 832, the map
// 976 by 672 inside it at 96, 48): Pyn's room's middle (tile 7, 8) is found from the canvas's size.
const officeBox = await page.locator('[data-ofis-canvas]').boundingBox();
if (officeBox) {
  const zoom = Math.min(4, Math.min(officeBox.width / 1168, officeBox.height / 832));
  await page.mouse.click(officeBox.x + officeBox.width / 2 + (7 * 16 + 8 - 488) * zoom, officeBox.y + officeBox.height / 2 + (8 * 16 + 8 - 368) * zoom);
}
check(
  'a room clicked says what goes on in it, counted from the vault',
  (await shownSoon(page.locator('[data-ofis-room="pyn"]'))) && /\d+ notes changed today/.test((await page.locator('[data-ofis-room-status]').textContent()) ?? ''),
);
// The manager is the vault's owner, and Tolga, who wrote Cortex, has a desk of his own.
check(
  'the office and its manager carry the name the person gave, Tolga is at his desk',
  ((await page.locator('[data-ofis-name]').textContent()) ?? '').includes("Tolga Bey's brain") &&
    ((await page.locator('[data-ofis-chip="mudur"]').textContent()) ?? '').includes('Tolga Bey') &&
    ((await page.locator('[data-ofis-chip="tolga"]').textContent()) ?? '').includes('Tolga'),
);
await page.locator('[data-ofis-chip="tolga"]').click();
await page.waitForTimeout(900);
await shoot('16b-office-tolga.png');
await page.locator('[data-ofis-chip="defne"]').click();
check(
  'a character’s chip opens its card, with the tool it works with',
  (await shownSoon(page.locator('[data-ofis-card="defne"]'))) && ((await page.locator('[data-ofis-card="defne"]').textContent()) ?? '').includes('Works with Claude'),
);
await page.waitForTimeout(800);
await shoot('17-office-card.png');
await page.locator('[data-ofis-gear]').click();
check('the gear opens the office’s settings, live conversations off', (await shownSoon(page.locator('[data-ofis-settings]'))) && (await page.locator('[data-ofis-live]').getAttribute('aria-checked')) === 'false');
// Live conversations by a model chosen here: LM Studio's stand-in writes one about the vault's notes, and the team says it.
await page.locator('[data-ofis-live]').click();
await page.locator('[data-ofis-tool="lmstudio"]').click();
check('the tool’s models are offered, the loaded one marked', await shownSoon(page.locator('[data-ofis-model="qwen-e2e"]')));
await page.locator('[data-ofis-model="qwen-e2e"]').click();
await page.locator('[data-ofis-talk]').click();
check(
  'and the model chosen writes the team a conversation, said in the office and logged',
  (await shownSoon(page.locator('[data-ofis-line]', { hasText: '«Plan» notuna dipnot lazım.' }), 15_000)) &&
    lmBodies.some((one) => one.stream === false && one.model === 'qwen-e2e' && JSON.stringify(one.messages).includes('Defne')),
);
await shoot('18-office-settings.png');
// The same choice in the app's settings (Settings → Office): one choice, changed in either place.
await page.keyboard.press('Escape');
await page.keyboard.press('Control+,');
const officeSection = page.locator('[data-settings-section="office"]');
check(
  'the app’s settings show the office’s choice: live, LM Studio, the model chosen',
  (await shownSoon(officeSection.locator('[data-settings-office-model]'))) &&
    (await officeSection.locator('[data-settings-office-live]').getAttribute('aria-checked')) === 'true' &&
    (await officeSection.locator('[data-settings-office-tool="lmstudio"]').getAttribute('aria-pressed')) === 'true' &&
    (await officeSection.locator('[data-settings-office-model]').inputValue()) === 'qwen-e2e',
);
await officeSection.locator('[data-settings-office-every="30"]').click();
await officeSection.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await shoot('07d-settings-office.png');
await page.keyboard.press('Escape');
await page.locator('[data-ofis-gear]').click();
check('and a change made there is the office’s too', ((await page.locator('.ofis-segments button[aria-pressed="true"]').textContent()) ?? '').includes('30'));
await page.locator('[data-ofis-live]').click();
await page.keyboard.press('Escape');
check('and Escape closes them', await page.locator('[data-ofis-settings]').waitFor({ state: 'detached', timeout: 3_000 }).then(() => true, () => false));
check(
  'nothing was written into what is hidden',
  fs.readFileSync(vaultNote('.hidden/Secret.md'), 'utf8') === hiddenBefore && fs.readFileSync(vaultNote('.obsidian/workspace.json'), 'utf8') === obsidianBefore,
);
// The graph left in front: the app opens on it again, with neither the notes nor the chat drawn to read the vault for it.
await page.locator('[data-app-view="graph"]').click();

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
check('the vault chosen is opened again, with nothing to choose', await shownSoon(page.locator('[data-vault-screen]'), 30_000));
check(
  'on the graph, as it was left, and it draws the vault’s notes with nothing else opened to read them',
  (await page.locator('[data-app-view="graph"]').getAttribute('aria-pressed')) === 'true' &&
    (await page
      .waitForFunction(() => Number(document.querySelector('[data-notes-graph="vault"]')?.getAttribute('data-graph-nodes')) >= 4, null, { timeout: 10_000 })
      .then(
        () => true,
        () => false,
      )) &&
    (await page.locator('[data-notes-view]').count()) === 0 &&
    (await page.locator('[data-chat-view]').count()) === 0,
);
check('in the language chosen', (await page.evaluate(() => document.documentElement.lang)) === 'en');
check('and the settings file is in the app’s data, not in the vault', fs.existsSync(path.join(userData, 'settings.json')) && !fs.readdirSync(vaultDir).includes('settings.json'));

// The policy's refusals of the probes above are what was asked for; anything else the window logged is a fault.
const unexpected = consoleErrors.filter((text) => !text.includes('https://example.com/'));
check('the window logged no errors but the refusals asked for', unexpected.length === 0 && consoleErrors.length >= 2);
if (unexpected.length) console.log(unexpected.map((e) => `       ${e}`).join('\n'));

await page.locator('[data-app-view="notes"]').click();
const notesAgain = page.locator('[data-notes-view]');
await notesAgain.waitFor();

/*
  Another vault chosen while the note open is in conflict (src/notes/NotePane.tsx):
  what was typed is kept beside the note in the vault it was read from, and the
  pane left writes nothing into the vault chosen - here a copy of this one, its
  note at the same path as this one was read, which a save over that version
  would have gone through.
*/
const otherVault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-other-')));
fs.mkdirSync(path.join(otherVault, 'Drafts'));
fs.writeFileSync(path.join(otherVault, 'Drafts', 'E2E Switch.md'), '# Switch\n\nbase');
const chooseVaultTo = async (dir) => {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, dir);
  await page.locator('[data-settings-open]').click();
  await page.locator('[data-settings-vault-change]').click();
  const named = await page
    .waitForFunction((name) => document.querySelector('[data-settings-vault]')?.textContent === name, path.basename(dir), { timeout: 10_000 })
    .then(() => true, () => false);
  await page.keyboard.press('Escape');
  return named;
};
await page.keyboard.press('Control+o');
await notesAgain.locator('[data-notes-switcher-input]').fill('E2E Switch');
await page.keyboard.press('Enter');
await shownSoon(notesAgain.locator('[data-note-pane="Drafts/E2E Switch.md"]'));
if ((await notesAgain.locator('[data-note-mode="edit"]').getAttribute('aria-pressed')) !== 'true') await notesAgain.locator('[data-note-mode="edit"]').click();
await notesAgain.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' mine');
fs.writeFileSync(vaultNote('Drafts/E2E Switch.md'), '# Switch\n\nfrom outside');
const switchConflict = await shownSoon(notesAgain.locator('[data-note-banner="conflict"]'));
const counted = (await holdChannel('notes:save')) && (await holdChannel('notes:read'));
const switched = await chooseVaultTo(otherVault);
/*
  The pane left goes before the one for the vault chosen reads its note, and
  the window's calls reach the main process in order: once that read is asked,
  a save from the pane left would have been asked too. The one save counted is
  the one made before the vault was chosen.
*/
for (const end = Date.now() + 8_000; Date.now() < end && (await callsOf('notes:read')) === 0; ) await new Promise((done) => setTimeout(done, 100));
check(
  'another vault chosen while a note is in conflict: what was typed is kept beside it in the vault it was read from, and nothing is written into the vault chosen',
  switchConflict &&
    counted &&
    switched &&
    (await callsOf('notes:read')) >= 1 &&
    (await callsOf('notes:save')) === 1 &&
    fs.readFileSync(path.join(otherVault, 'Drafts', 'E2E Switch.md'), 'utf8') === '# Switch\n\nbase' &&
    Boolean(keptAside('E2E Switch')) &&
    fs.readFileSync(draft(keptAside('E2E Switch') ?? 'none'), 'utf8') === '# Switch\n\nbase mine' &&
    fs.readFileSync(vaultNote('Drafts/E2E Switch.md'), 'utf8') === '# Switch\n\nfrom outside',
);
await releaseChannel('notes:save');
await releaseChannel('notes:read');
check('and the vault left, chosen again, is open again', await chooseVaultTo(vaultDir));
await clearToasts();
fs.rmSync(otherVault, { recursive: true, force: true });

// Quit a moment after the last key: what was typed is saved before the window goes (electron/main.ts, desktop-ui-8).
await page.keyboard.press('Control+o');
await notesAgain.locator('[data-notes-switcher-input]').fill('E2E Closing');
await page.keyboard.press('Enter');
const closingOpen = await shownSoon(notesAgain.locator('[data-note-pane="Drafts/E2E Closing.md"]'));
if ((await notesAgain.locator('[data-note-mode="edit"]').getAttribute('aria-pressed')) !== 'true') await notesAgain.locator('[data-note-mode="edit"]').click();
await notesAgain.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' closed');
await app.close();
check(
  'a note written a moment before Cortex quits is saved before the window goes',
  closingOpen && fs.readFileSync(vaultNote('Drafts/E2E Closing.md'), 'utf8') === '# Closing\n\nStart closed',
);

/*
  The page dying - out of memory on a large vault, the GPU process gone on a laptop - is loaded again by itself
  (electron/main.ts, desktop-shell-9): before, the window stayed a blank sheet, and the icon's "Cortex'i aç" brought
  the same blank page back. Opened again for it: a page that crashed cannot be driven further.
*/
console.log('\nThe page dying');
app = await launch();
page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
const beforeCrash = await shownSoon(page.locator('[data-vault-screen]'), 30_000);
// Its end and the page loaded after it are heard in the main process: a question put to the dying page is never answered.
await app.evaluate(({ BrowserWindow }) => {
  const contents = BrowserWindow.getAllWindows()[0].webContents;
  globalThis.cortexPage = { gone: null, loaded: 0 };
  contents.on('render-process-gone', (_event, details) => {
    globalThis.cortexPage.gone = details.reason;
  });
  contents.on('did-finish-load', () => {
    if (globalThis.cortexPage.gone) globalThis.cortexPage.loaded += 1;
  });
  contents.forcefullyCrashRenderer();
});
const answered = (promise, ms = 5_000) => Promise.race([promise.catch(() => null), new Promise((done) => setTimeout(() => done(null), ms))]);
let backAfterCrash = false;
for (const end = Date.now() + 30_000; Date.now() < end && !backAfterCrash; await new Promise((done) => setTimeout(done, 250))) {
  const seen = await answered(app.evaluate(() => globalThis.cortexPage));
  if (!seen?.gone || !seen.loaded) continue;
  backAfterCrash = Boolean(
    await answered(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('Boolean(document.querySelector("[data-vault-screen]"))'))),
  );
}
check('a page that dies is loaded again by itself, the vault on screen again', beforeCrash && backAfterCrash);
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(vaultDir, { recursive: true, force: true });
fs.rmSync(agentGateDir, { recursive: true, force: true });

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : 'All smoke checks passed'}`);
process.exit(failures.length ? 1 : 0);

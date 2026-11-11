import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { app, dialogAnswer, handlers, nativeTheme, sent } from 'electron';
import net from 'node:net';
import { quietInstallAllowed, registerIpc, startAppUpdates, trustPagesWhere } from '../electron/ipc';
import { startBrowserLink, stopBrowserLink } from '../electron/services/browserLink';
import { forgetUpdates, startUpdates, type Updater } from '../electron/services/updater';
import { forgetSettings, readSettings, settingsPath, settingsUnsaved, updateSettings } from '../electron/services/settings';
import { pythonOf } from '../electron/services/localChat';
import { listenerRestarting } from '../electron/services/microphone';
import { repointYakala, setYakalaPlatform } from '../electron/services/setup';

/**
 * What the window can ask (electron/ipc.ts): the channels the preload names
 * and no others, answered for the app's own page alone, with the vault coming
 * through the system's dialog and never from the window.
 */

const PAGE = 'file:///app/dist/index.html';
trustPagesWhere((url) => url === PAGE);
registerIpc();

/** Each test from a first run: no settings file, nothing remembered. */
function firstRun(): void {
  fs.rmSync(settingsPath(), { force: true });
  forgetSettings();
}

type Call = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mainFrame = { url: PAGE };
const ownEvent = { sender: { mainFrame }, senderFrame: mainFrame };
const call = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Call)(ownEvent, ...args);

test('the channels are the ones the preload names, no more and no fewer', () => {
  const preload = fs.readFileSync('electron/preload.ts', 'utf8');
  const named = [...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual([...handlers.keys()].sort(), named);
  assert.deepEqual(named.filter((channel) => channel.startsWith('chat:')), ['chat:addTool', 'chat:answer', 'chat:attach', 'chat:auth', 'chat:begin', 'chat:cancel', 'chat:cancelLogin', 'chat:clis', 'chat:install', 'chat:installProgress', 'chat:list', 'chat:login', 'chat:offer', 'chat:open', 'chat:remove', 'chat:removeTool', 'chat:rename', 'chat:send', 'chat:setKey', 'chat:setOption', 'chat:toInbox']);
  assert.deepEqual(named.filter((channel) => channel.startsWith('hermes:')), ['hermes:forget', 'hermes:save', 'hermes:status', 'hermes:test']);
  // Cortex Browser's link (services/browserLink.ts): how it is, the person's answer to a browser waiting, the leave taken back.
  assert.deepEqual(named.filter((channel) => channel.startsWith('browserLink:')), ['browserLink:allow', 'browserLink:decide', 'browserLink:setOn', 'browserLink:status', 'browserLink:unpair']);
  // The vault given to the AI tools (services/mcp.ts): its lines, and Claude Code's add; neither takes anything.
  assert.deepEqual(named.filter((channel) => channel.startsWith('mcp:')), ['mcp:addToClaude', 'mcp:status']);
  assert.match(preload, /addToClaude: \(\) => invoke\('mcp:addToClaude'\)/);
  const notes = named.filter((channel) => channel.startsWith('notes:'));
  assert.deepEqual(notes, ['notes:asset', 'notes:backlinks', 'notes:binDelete', 'notes:binEmpty', 'notes:binList', 'notes:binRestore', 'notes:create', 'notes:createFolder', 'notes:index', 'notes:move', 'notes:open', 'notes:read', 'notes:rename', 'notes:save', 'notes:search', 'notes:text', 'notes:trash']);
});

test('a frame that is not the page, or a page that is not the app’s, is refused before anything is read', async () => {
  const listener = handlers.get('app:bootstrap') as Call;
  const child = { url: PAGE };
  await assert.throws(() => listener({ sender: { mainFrame }, senderFrame: child }), /not the app/);
  const elsewhere = { url: 'https://example.com/' };
  await assert.throws(() => listener({ sender: { mainFrame: elsewhere }, senderFrame: elsewhere }), /not the app/);
  await assert.throws(() => listener({ sender: { mainFrame }, senderFrame: null }), /not the app/);
});

test('the window may set the language and how the tree shows the vault, and never the vault', async () => {
  firstRun();
  const off = { theme: 'system', allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, autoUpdate: true };
  assert.deepEqual(await call('settings:set', { language: 'en', vault: '/etc' }), { language: 'en', ...off });
  assert.equal(readSettings().vault, null);
  assert.deepEqual(await call('settings:set', { language: 'de' }), { language: 'en', ...off }, 'a language the app does not have changes nothing');
  assert.deepEqual(await call('settings:set', { language: null }), { language: null, ...off });
  assert.deepEqual(await call('settings:set', { allFiles: true }), { theme: 'system', language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, autoUpdate: true }, 'one setting changed leaves the others');
  assert.deepEqual(await call('settings:set', { nameIcons: 'yes', allFiles: 0 }), { theme: 'system', language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, autoUpdate: true }, 'what is not a yes or a no changes nothing');
  assert.deepEqual(await call('settings:set', null), { theme: 'system', language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false, autoUpdate: true });
  // How Pyn addresses the person, and the first-run screen gone through: from the window, as values they can be.
  const named = (await call('settings:set', { userName: '  Tolga   Bey ', onboarded: true })) as { userName: string | null; onboarded: boolean };
  assert.deepEqual([named.userName, named.onboarded], ['Tolga Bey', true]);
  const cleared = (await call('settings:set', { userName: '', onboarded: 'no' })) as { userName: string | null; onboarded: boolean };
  assert.deepEqual([cleared.userName, cleared.onboarded], [null, true], 'an empty name is none; what is not a yes or a no changes nothing');
  // Leave for the microphone, given in the window's own question (src/ui/MicConsent.tsx), and taken back.
  const allowed = (await call('settings:set', { voiceConsent: true, wakeConsent: 'yes' })) as { voiceConsent: boolean; wakeConsent: boolean };
  assert.deepEqual([allowed.voiceConsent, allowed.wakeConsent], [true, false], 'only a yes or a no');
  assert.equal(((await call('settings:set', { wakeConsent: true })) as { wakeConsent: boolean }).wakeConsent, true);
  assert.equal(readSettings().wakeConsent, true);
});

test('the vault comes through the dialog, and what the window is told of it holds no path', async () => {
  firstRun();
  dialogAnswer.value = { canceled: true, filePaths: [] };
  assert.equal(await call('vault:choose'), null, 'closed without a choice');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
  dialogAnswer.value = { canceled: false, filePaths: [dir] };
  sent.length = 0;
  const chosen = await call('vault:choose');
  assert.deepEqual(chosen, { vault: { name: path.basename(dir) }, missing: false });
  assert.deepEqual(sent, [['notes:changed', null]], 'the notes screen is told to read the vault now chosen');
  const boot = await call('app:bootstrap');
  assert.ok(!JSON.stringify(boot).includes(path.dirname(dir)), 'no path in the bootstrap either');
  assert.equal(readSettings().vault, dir);
});

test('the first run makes its vault in Documents without a dialog, and the window is told its name alone', async () => {
  firstRun();
  sent.length = 0;
  const made = (await call('vault:createDefault')) as { vault: { name: string } | null; missing: boolean };
  assert.deepEqual(made, { vault: { name: 'Cortex' }, missing: false });
  assert.equal(readSettings().vault, fs.realpathSync.native(path.join(app.getPath('documents'), 'Cortex')));
  assert.deepEqual(sent, [['notes:changed', null]], 'the notes screen is told to read it');
});

/** A vault with an engine that answers `relocate` and `yakala kur` as beyin.py does, and logs what it was asked. */
const ENGINE = String.raw`import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8').write(' '.join(args) + '\n')
if args[:1] == ['relocate']:
    print(json.dumps({'status': 'unchanged', 'vault': here, 'state': os.path.join(here, 'durum')}))
elif args[:2] == ['yakala', 'kur']:
    folder = os.path.join(os.environ['LOCALAPPDATA'], 'beyin-v3')
    os.makedirs(folder, exist_ok=True)
    json.dump({'surum': 1, 'vault': here, 'state': os.path.join(here, 'durum'), 'tus': args[args.index('--tus') + 1], 'at': 1},
              open(os.path.join(folder, 'yakala-sahip.json'), 'w', encoding='utf-8'))
    print(json.dumps({'status': 'kuruldu', 'dinleyici': True}))
else:
    sys.exit(2)
`;

// Before any test here starts or moves yakala's listener: the time it is given is the engine install's own.
test('the engine installed or updated, yakala’s listener, starting itself again on the new files, is given time to come up', async () => {
  firstRun();
  assert.equal(listenerRestarting(), false, 'nothing started it yet');
  await assert.rejects(call('setup:installEngine'), /kasa/);
  // Not "Dinleyici çalışmıyor" over a listener still coming up on a slow laptop (services/tray.ts).
  assert.equal(listenerRestarting(), true);
});

test('another vault chosen, yakala follows it from the vault that had it, and the window is told (yakala-3)', { skip: pythonOf() === null }, async () => {
  firstRun();
  const before = process.env.LOCALAPPDATA;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'yerel-'));
  process.env.LOCALAPPDATA = local;
  setYakalaPlatform('win32');
  try {
    const left = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-onceki-')));
    fs.mkdirSync(path.join(local, 'beyin-v3'));
    fs.writeFileSync(path.join(local, 'beyin-v3', 'yakala-sahip.json'), JSON.stringify({ surum: 1, vault: left, state: path.join(left, 'durum'), tus: 'ctrl+alt+n', at: 1 }));
    const chosen = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
    fs.writeFileSync(path.join(chosen, 'beyin.py'), ENGINE);
    fs.writeFileSync(path.join(chosen, '.beyin-version'), '1.0.33\n');
    dialogAnswer.value = { canceled: false, filePaths: [chosen] };
    sent.length = 0;
    await call('vault:choose');
    const told = async () => {
      for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((done) => setTimeout(done, 50))) {
        const notice = sent.find(([channel]) => channel === 'app:notice');
        if (notice) return notice[1] as { tone: string; title: string; detail: string };
      }
      return null;
    };
    const notice = await told();
    assert.equal(notice?.tone, 'success');
    assert.match(notice?.detail ?? '', /Ctrl\+Alt\+N/);
    const asked = fs.readFileSync(path.join(chosen, 'istenen.log'), 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(asked, ['relocate', 'yakala kur --tus ctrl+alt+n'], 'bound first, then yakala moved with its key');
  } finally {
    setYakalaPlatform(process.platform);
    if (before === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = before;
  }
});

/** The same engine, its `relocate` held until the test lets it go (a file `devam` beside it), and saying when it ends. */
const HELD = ENGINE.replace(
  "if args[:1] == ['relocate']:\n",
  "if args[:1] == ['relocate']:\n    import time\n    for _ in range(1500):\n        if os.path.exists(os.path.join(here, 'devam')): break\n        time.sleep(0.02)\n    open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8').write('relocate bitti\\n')\n",
);

test('two vaults chosen one after the other: yakala goes to the second once it is bound, not while it is being bound', { skip: pythonOf() === null }, async () => {
  firstRun();
  const before = process.env.LOCALAPPDATA;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'yerel-'));
  process.env.LOCALAPPDATA = local;
  setYakalaPlatform('win32');
  try {
    const left = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-onceki-')));
    fs.mkdirSync(path.join(local, 'beyin-v3'));
    fs.writeFileSync(path.join(local, 'beyin-v3', 'yakala-sahip.json'), JSON.stringify({ surum: 1, vault: left, state: path.join(left, 'durum'), tus: 'ctrl+alt+y', at: 1 }));
    const held = () => {
      const vault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
      fs.writeFileSync(path.join(vault, 'beyin.py'), HELD);
      fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.33\n');
      return vault;
    };
    const asked = (vault: string) => (fs.existsSync(path.join(vault, 'istenen.log')) ? fs.readFileSync(path.join(vault, 'istenen.log'), 'utf8').trim().split(/\r?\n/) : []);
    const until = async (done: () => boolean, ms = 20_000) => {
      for (const end = Date.now() + ms; Date.now() < end && !done(); ) await new Promise((wait) => setTimeout(wait, 20));
      return done();
    };
    const first = held();
    const second = held();
    sent.length = 0;
    // Chosen, then another before the first was bound: both bindings going on, the second vault the one open.
    dialogAnswer.value = { canceled: false, filePaths: [first] };
    await call('vault:choose');
    dialogAnswer.value = { canceled: false, filePaths: [second] };
    await call('vault:choose');
    assert.ok(await until(() => asked(first).includes('relocate') && asked(second).includes('relocate')), 'both being bound');
    // The first bound: what its opening asked for yakala goes on, in the vault open now, the second, still being bound.
    fs.writeFileSync(path.join(first, 'devam'), '');
    assert.ok(await until(() => asked(first).includes('relocate bitti')));
    // Given the moment a run of the engine takes to start: yakala kur in the second vault before it is bound gave its
    // listener a vault whose engine still named the folder it was set up in.
    await until(() => asked(second).some((one) => one.startsWith('yakala')), 1_000);
    assert.deepEqual(asked(second), ['relocate'], 'nothing else run in the second vault while it is being bound');
    fs.writeFileSync(path.join(second, 'devam'), '');
    assert.ok(await until(() => sent.some(([channel]) => channel === 'app:notice')));
    const notice = sent.find(([channel]) => channel === 'app:notice')?.[1] as { tone: string; detail: string };
    assert.equal(notice.tone, 'success');
    assert.match(notice.detail, /Ctrl\+Alt\+Y/);
    assert.deepEqual(asked(second), ['relocate', 'relocate bitti', 'yakala kur --tus ctrl+alt+y'], 'bound first, then yakala moved, once');
    assert.ok(!asked(first).some((one) => one.startsWith('yakala')), 'nothing moved into the vault left');
    // Each opening's yakala work is done, one after the other: the second vault's own finds yakala there already.
    assert.equal(await repointYakala(), null);
    assert.equal(sent.filter(([channel]) => channel === 'app:notice').length, 1, 'said once');
  } finally {
    setYakalaPlatform(process.platform);
    if (before === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = before;
  }
});

/** A vault's engine that could not bind it where it is now: `relocate` ends with its error line, as beyin.py does. */
const UNBOUND = String.raw`import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
open(os.path.join(here, 'istenen.log'), 'a', encoding='utf-8').write(' '.join(args) + '\n')
if args[:1] == ['relocate']:
    print(json.dumps({'error': 'ValueError', 'message': 'Kasa taşınmış ama eski yerindeki durum klasörü okunamadı.', 'code': 'vault_moved'}), file=sys.stderr)
    sys.exit(1)
sys.exit(2)
`;

// On Windows only: the Python is the app's to install there, and one already fit is all a run can stand in for it with.
test('a vault opened while there was no Python is bound once the setup has installed one, its failure said once', { skip: process.platform !== 'win32' || pythonOf() === null }, async () => {
  firstRun();
  const vault = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kasa-')));
  fs.writeFileSync(path.join(vault, 'beyin.py'), UNBOUND);
  fs.writeFileSync(path.join(vault, '.beyin-version'), '1.0.33\n');
  // Opened, and not bound: there was no Python to bind it with (services/setup.ts, settleVault).
  updateSettings((settings) => {
    settings.vault = vault;
  });
  sent.length = 0;
  await call('setup:installPython');
  const said = async () => {
    for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((done) => setTimeout(done, 50))) {
      const notice = sent.find(([channel]) => channel === 'app:notice');
      if (notice) return notice[1] as { tone: string; title: string; detail: string };
    }
    return null;
  };
  const notice = await said();
  assert.deepEqual(notice, { tone: 'error', title: 'Pyn\'in hafızası bu kasaya bağlanamadı', detail: 'Kasa taşınmış ama eski yerindeki durum klasörü okunamadı.' });
  const asked = fs.readFileSync(path.join(vault, 'istenen.log'), 'utf8').trim().split(/\r?\n/);
  assert.equal(asked.filter((one) => one === 'relocate').length, 1);
  assert.equal(sent.filter(([channel]) => channel === 'app:notice').length, 1, 'said once');
});

test('the theme is set from the window as one of its three values, and turned at once (2 November notes)', async () => {
  firstRun();
  assert.equal(((await call('settings:set', { theme: 'dark' })) as { theme: string }).theme, 'dark');
  assert.equal(nativeTheme.themeSource, 'dark', 'the window and its frame follow at once');
  assert.equal(((await call('settings:set', { theme: 'blue' })) as { theme: string }).theme, 'dark', 'a theme the app does not have changes nothing');
  assert.equal(((await call('settings:set', { theme: 'system' })) as { theme: string }).theme, 'system');
  assert.equal(nativeTheme.themeSource, 'system');
  fs.rmSync(settingsPath(), { recursive: true, force: true });
});


test('downloading updates unasked is switched from the window, as a yes or a no and nothing else (G2)', async () => {
  firstRun();
  assert.equal(((await call('app:bootstrap')) as { settings: { autoUpdate: boolean } }).settings.autoUpdate, true, 'on until the person turns it off');
  assert.equal(((await call('settings:set', { autoUpdate: false })) as { autoUpdate: boolean }).autoUpdate, false);
  assert.equal(readSettings().autoUpdate, false);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).autoUpdate, false, 'kept for the next start');
  assert.equal(((await call('settings:set', { autoUpdate: 'yes' })) as { autoUpdate: boolean }).autoUpdate, false, 'what is not a yes or a no changes nothing');
  assert.equal(((await call('settings:set', { autoUpdate: true })) as { autoUpdate: boolean }).autoUpdate, true);
});

test('settings that cannot be written are said to the window once, with the folder, and again to a page that starts after (K10)', async () => {
  firstRun();
  await call('app:bootstrap');
  const notices = () => sent.filter(([channel, word]) => channel === 'app:notice' && (word as { title?: string }).title === 'Ayarlar kaydedilemedi') as Array<[string, { tone: string; detail: string }]>;
  const before = notices().length;
  const folder = path.dirname(settingsPath());
  // The temporary's name taken by a folder: the write fails on any system.
  fs.mkdirSync(`${settingsPath()}.tmp`, { recursive: true });
  try {
    // The first-run screen gone through: before, this was lost at the next start without a word.
    assert.equal(((await call('settings:set', { onboarded: true })) as { onboarded: boolean }).onboarded, true);
    assert.equal(settingsUnsaved(), folder);
    assert.equal(notices().length, before + 1);
    const [, word] = notices().at(-1)!;
    assert.equal(word.tone, 'error');
    assert.ok(word.detail.includes(folder), word.detail);
    assert.match(word.detail, /klasörüne yazılamıyor/);
    await call('settings:set', { allFiles: true });
    assert.equal(notices().length, before + 1, 'once, not at every change');
    // The page loaded again (or a window made after): it is told too, since the toast went with the old page.
    await call('app:bootstrap');
    assert.equal(notices().length, before + 2);
  } finally {
    fs.rmSync(`${settingsPath()}.tmp`, { recursive: true, force: true });
  }
  // Writable again: a page starting now hears nothing.
  await call('settings:set', { allFiles: false });
  assert.equal(settingsUnsaved(), null);
  await call('app:bootstrap');
  assert.equal(notices().length, before + 2);
});

test('an update that will not come down is said in the window and the notification area, with what to do, in the person’s language (G4)', async () => {
  // Before, only the console heard: a person never learnt why Cortex stayed on the version it was.
  firstRun();
  forgetUpdates();
  const tray: string[][] = [];
  startAppUpdates((title, body) => void tray.push([title, body]), () => false);
  const listeners = new Map<string, (arg: unknown) => void>();
  const updater = { autoDownload: false, autoInstallOnAppQuit: false, logger: undefined, on: (event: string, listener: (arg: unknown) => void) => listeners.set(event, listener), checkForUpdates: async () => null, quitAndInstall: () => undefined } as unknown as Updater;
  await startUpdates(() => undefined, null, async () => updater, { after: () => undefined, every: () => undefined });
  const notices = () => sent.filter(([channel]) => channel === 'app:notice').map(([, word]) => word as { tone: string; title: string; detail: string });
  const before = notices().length;
  try {
    for (let round = 0; round < 2; round += 1) {
      listeners.get('update-available')!({ version: '1.0.62' });
      listeners.get('error')!(new Error('net::ERR_INTERNET_DISCONNECTED at C:\\Users\\x'));
    }
    assert.equal(notices().length, before + 1);
    const word = notices().at(-1)!;
    assert.deepEqual([word.tone, word.title], ['error', 'Cortex 1.0.62 indirilemedi']);
    assert.match(word.detail, /bağlantını kontrol et ya da kurulum dosyasını .*sürümler sayfasından elle indir/);
    assert.doesNotMatch(`${word.title} ${word.detail}`, /ERR_|net::|C:\\/, 'the library’s own words stay in the console');
    assert.deepEqual(tray, [[word.title, word.detail]]);
    // In English where that is the language chosen.
    await call('settings:set', { language: 'en' });
    for (let round = 0; round < 2; round += 1) {
      listeners.get('update-available')!({ version: '1.0.63' });
      listeners.get('error')!(new Error('sha512 checksum mismatch'));
    }
    assert.equal(notices().at(-1)!.title, 'Cortex 1.0.63 could not be downloaded');
  } finally {
    forgetUpdates();
    firstRun();
  }
});

test('Cortex Browser’s link from the window: the switch, how it is, and leave taken back; a token never crosses', async () => {
  firstRun();
  stopBrowserLink();
  const off = { on: false, listening: false, allowed: false, connected: false, asking: false, code: null, locked: false };
  assert.deepEqual(await call('browserLink:status'), off, 'closed until the person opens it');
  // No browser waits: an answer is an answer to nothing, whatever it says, and "allow" lets nobody in.
  assert.deepEqual(await call('browserLink:decide', true), off);
  assert.deepEqual(await call('browserLink:allow'), off);
  assert.equal(readSettings().browserLinkToken, null);
  // The switch: only a yes or a no; on, the listener is open and the setting kept.
  assert.deepEqual(await call('browserLink:setOn', 'yes'), off);
  sent.length = 0;
  assert.deepEqual(await call('browserLink:setOn', true), { ...off, on: true, listening: true });
  assert.equal(readSettings().browserLink, true);
  assert.deepEqual(sent.filter(([channel]) => channel === 'browserLink:status').at(-1), ['browserLink:status', { ...off, on: true, listening: true }], 'every window is told');
  updateSettings((settings) => {
    settings.browserLinkToken = 'a'.repeat(64);
  });
  const allowed = await call('browserLink:status');
  assert.deepEqual(allowed, { ...off, on: true, listening: true, allowed: true });
  assert.ok(!JSON.stringify(allowed).includes('aaaa'), 'not even its digest');
  assert.deepEqual(await call('browserLink:unpair'), { ...off, on: true, listening: true });
  assert.equal(readSettings().browserLinkToken, null);
  assert.deepEqual(await call('browserLink:setOn', false), off);
  assert.equal(readSettings().browserLink, false);
  assert.ok(!JSON.stringify(await call('app:bootstrap')).includes('browserLink'), 'the settings the window is given hold nothing of the link');
});

test('an update is not installed unasked - Cortex closed for it - while a browser is connected', async () => {
  firstRun();
  stopBrowserLink();
  assert.equal(quietInstallAllowed(() => true), true, 'nobody has seen Cortex, nothing runs: as before');
  assert.equal(quietInstallAllowed(() => false), false);
  assert.equal(await startBrowserLink({ asked: true }), true);
  const pipe = (JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'browser-link.json'), 'utf8')) as { pipe: string }).pipe;
  const socket = net.connect(pipe);
  try {
    await new Promise<void>((done, failed) => {
      socket.once('connect', done);
      socket.once('error', failed);
    });
    socket.write('{"type":"hello","protocol":1,"token":null}\n');
    // Its hello read (it is told to wait): a browser is there.
    await new Promise<void>((done) => socket.once('data', () => done()));
    assert.equal(quietInstallAllowed(() => true), false);
  } finally {
    socket.destroy();
    stopBrowserLink();
    firstRun();
  }
});

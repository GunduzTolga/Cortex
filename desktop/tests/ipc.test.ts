import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dialogAnswer, handlers, sent } from 'electron';
import { registerIpc, trustPagesWhere } from '../electron/ipc';
import { forgetSettings, readSettings, settingsPath, updateSettings } from '../electron/services/settings';
import { pythonOf } from '../electron/services/localChat';
import { listenerRestarting } from '../electron/services/microphone';
import { setYakalaPlatform } from '../electron/services/setup';

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
  assert.deepEqual(named.filter((channel) => channel.startsWith('chat:')), ['chat:answer', 'chat:auth', 'chat:cancel', 'chat:clis', 'chat:forgetKey', 'chat:install', 'chat:list', 'chat:login', 'chat:open', 'chat:remove', 'chat:rename', 'chat:send', 'chat:setKey', 'chat:setOption', 'chat:toInbox']);
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
  const off = { allFiles: false, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false };
  assert.deepEqual(await call('settings:set', { language: 'en', vault: '/etc' }), { language: 'en', ...off });
  assert.equal(readSettings().vault, null);
  assert.deepEqual(await call('settings:set', { language: 'de' }), { language: 'en', ...off }, 'a language the app does not have changes nothing');
  assert.deepEqual(await call('settings:set', { language: null }), { language: null, ...off });
  assert.deepEqual(await call('settings:set', { allFiles: true }), { language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false }, 'one setting changed leaves the others');
  assert.deepEqual(await call('settings:set', { nameIcons: 'yes', allFiles: 0 }), { language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false }, 'what is not a yes or a no changes nothing');
  assert.deepEqual(await call('settings:set', null), { language: null, allFiles: true, nameIcons: false, userName: null, onboarded: false, background: true, voiceConsent: false, wakeConsent: false });
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

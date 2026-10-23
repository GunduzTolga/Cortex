import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from 'electron';
import type { VoiceStatus } from '../shared/setup';
import type { ListenerWord } from '../shared/setup';
import { keepStartWithWindows, listensAlways, startWithWindows, trayItems, trayTooltip } from '../electron/services/tray';

const voice = (change: Partial<VoiceStatus>): VoiceStatus => ({
  installed: true,
  on: true,
  wake: false,
  auto: true,
  engine: 'vulkan',
  model: 'large-v3-turbo',
  commands: null,
  wakePhrase: 'pyn not al',
  ...change,
});

const hearing: ListenerWord = { ses: 'hazir', model: '', mesaj: '', uyandirma: true, mb: null, toplam: null, uyandirma_sorun: null, uyandirma_mesaj: '', kisayol: 'tamam' };

test('the icon’s menu says whether the microphone listens and switches it, opens a note, the window, the settings, and quits', () => {
  const items = trayItems(voice({ wake: true }), false, false, true, { word: hearing });
  assert.deepEqual(
    items.map((item) => [item.label, item.action ?? null, item.icon ?? null, item.enabled ?? true]),
    [
      ['Mikrofon dinliyor: “Pyn, not al”', null, 'mikrofon-acik', false],
      ['Sürekli dinlemeyi kapat', 'wake', 'mikrofon-kapali', true],
      ['', null, null, true],
      ['Not al', 'note', 'not', true],
      ["Cortex'i aç", 'open', 'pyn', true],
      ['Ayarlar', 'settings', 'ayarlar', true],
      ['', null, null, true],
      ['Çık', 'quit', 'cik', true],
    ],
  );
  assert.ok(items.filter((item) => item.type !== 'separator').every((item) => item.icon), 'every item has an icon: nothing looks pushed aside');
  const off = trayItems(voice({}), false, false, true);
  assert.deepEqual([off[0].label, off[1].label, off[1].icon], ['Mikrofon kapalı', 'Sürekli dinle (“Pyn, not al”)', 'mikrofon-acik']);
  assert.equal(trayItems(voice({ wake: true }), false, true, true)[1].enabled, false, 'not while a switch is under way');
  assert.equal(trayItems(voice({}), true, false, true)[1].label, 'Listen all the time (“Pyn, not al”)', 'in the window’s language');
  assert.equal(trayItems(voice({}), false, false, false)[3].enabled, false, 'no vault: no note to take');
  assert.equal(trayItems(voice({ wakePhrase: 'hey pyn' }), false, false, true)[1].label, 'Sürekli dinle (“Hey Pyn”)', 'the phrase chosen');
  assert.equal(trayItems(voice({ wakePhrase: 'ikisi', wake: true }), false, false, true, { word: hearing })[0].label, 'Mikrofon dinliyor: “Hey Pyn” ya da “Pyn, not al”', 'both');
  // On in the settings, and no listener says it hears (none runs yet): the microphone is not said to listen (windows-e2e-5).
  assert.equal(trayItems(voice({ wake: true }), false, false, true)[0].icon, 'mikrofon-kapali');
});

test('without voice typing set up, or switched off, there is no microphone to switch', () => {
  for (const status of [null, voice({ installed: false, wake: true }), voice({ on: false, wake: true })]) {
    const items = trayItems(status, false, false, true);
    assert.equal(items.some((item) => item.action === 'wake'), false, 'nothing to switch');
    assert.equal(items[0].icon, 'mikrofon-kapali', 'the microphone does not listen');
    assert.equal(listensAlways(status), false);
  }
  assert.equal(trayItems(null, false, false, true)[0].label, 'Sesle yazma kurulu değil');
});

test('the icon says whether the microphone listens', () => {
  assert.equal(trayTooltip(voice({ wake: true }), false, { word: hearing }), 'Cortex · mikrofon “Pyn, not al” için dinliyor');
  assert.equal(trayTooltip(voice({ wake: true }), false), 'Cortex · mikrofon kapalı', 'on, but nothing says it hears');
  assert.equal(trayTooltip(voice({ wake: false }), false), 'Cortex · mikrofon kapalı');
  assert.equal(trayTooltip(null, true), 'Cortex · the microphone is off');
});

test('at its start, Cortex writes its start-up entry only where it is missing or left behind: turned off in Windows, it stays off (desktop-shell-6)', () => {
  const stub = app as unknown as { isPackaged: boolean; loginItems: unknown[]; loginEntry: boolean };
  stub.isPackaged = true;
  stub.loginItems.length = 0;
  try {
    // The entry there (Task Manager may hold it turned off; it reads as there all the same): nothing written.
    stub.loginEntry = true;
    keepStartWithWindows(true, 'win32');
    assert.deepEqual(stub.loginItems, []);
    // The first run: written.
    stub.loginEntry = false;
    keepStartWithWindows(true, 'win32');
    assert.deepEqual(stub.loginItems, [{ openAtLogin: true, args: ['--gizli'] }]);
    // The setting off and the entry left behind: taken away; off and none, nothing.
    keepStartWithWindows(false, 'win32');
    keepStartWithWindows(false, 'win32');
    assert.deepEqual(stub.loginItems, [{ openAtLogin: true, args: ['--gizli'] }, { openAtLogin: false, args: ['--gizli'] }]);
    // The person's own choice in the settings is written as it is.
    startWithWindows(true, 'win32');
    assert.equal(stub.loginItems.length, 3);
    // Not on another system.
    keepStartWithWindows(true, 'darwin');
    assert.equal(stub.loginItems.length, 3);
  } finally {
    stub.isPackaged = false;
    stub.loginItems.length = 0;
    stub.loginEntry = false;
  }
});

test('Cortex starts with Windows only as the installed app', () => {
  const stub = app as unknown as { isPackaged: boolean; loginItems: unknown[] };
  startWithWindows(true);
  assert.deepEqual(stub.loginItems, [], 'run from the source tree: nothing is registered');
  stub.isPackaged = true;
  try {
    startWithWindows(false);
    assert.deepEqual(stub.loginItems, process.platform === 'win32' ? [{ openAtLogin: false, args: ['--gizli'] }] : []);
  } finally {
    stub.isPackaged = false;
  }
});

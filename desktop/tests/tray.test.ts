import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from 'electron';
import type { VoiceStatus } from '../shared/setup';
import { listensAlways, startWithWindows, trayItems, trayTooltip } from '../electron/services/tray';

const voice = (change: Partial<VoiceStatus>): VoiceStatus => ({
  installed: true,
  on: true,
  wake: false,
  auto: true,
  engine: 'vulkan',
  model: 'large-v3-turbo',
  commands: null,
  ...change,
});

test('the icon’s menu says whether the microphone listens and switches it, opens a note, the window, the settings, and quits', () => {
  const items = trayItems(voice({ wake: true }), false, false, true);
  assert.deepEqual(
    items.map((item) => [item.label, item.action ?? null, item.icon ?? null, item.enabled ?? true]),
    [
      ['Mikrofon dinliyor: "Pyn, not al"', null, 'mikrofon-acik', false],
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
  assert.deepEqual([off[0].label, off[1].label, off[1].icon], ['Mikrofon kapalı', 'Sürekli dinle ("Pyn, not al")', 'mikrofon-acik']);
  assert.equal(trayItems(voice({ wake: true }), false, true, true)[1].enabled, false, 'not while a switch is under way');
  assert.equal(trayItems(voice({}), true, false, true)[1].label, 'Listen all the time ("Pyn, not al")', 'in the window’s language');
  assert.equal(trayItems(voice({}), false, false, false)[3].enabled, false, 'no vault: no note to take');
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
  assert.equal(trayTooltip(voice({ wake: true }), false), 'Cortex · mikrofon "Pyn, not al" için dinliyor');
  assert.equal(trayTooltip(voice({ wake: false }), false), 'Cortex · mikrofon kapalı');
  assert.equal(trayTooltip(null, true), 'Cortex · the microphone is off');
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

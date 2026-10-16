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

test('the icon’s menu switches the always-on microphone, opens the window and quits', () => {
  const items = trayItems(voice({ wake: true }), false, false);
  assert.deepEqual(
    items.map((item) => [item.label, item.type, item.action]),
    [
      ['Sürekli dinle ("Pyn, not al")', 'checkbox', 'wake'],
      ['', 'separator', undefined],
      ["Cortex'i aç", 'normal', 'open'],
      ['Çık', 'normal', 'quit'],
    ],
  );
  assert.equal(items[0].checked, true);
  assert.equal(items[0].enabled, true);
  assert.equal(trayItems(voice({ wake: true }), false, true)[0].enabled, false, 'not while a switch is under way');
  assert.equal(trayItems(voice({}), true, false)[0].label, 'Always listen ("Pyn, not al")', 'in the window’s language');
});

test('without voice typing set up, or switched off, there is no microphone to switch', () => {
  for (const status of [null, voice({ installed: false, wake: true }), voice({ on: false, wake: true })]) {
    const [first] = trayItems(status, false, false);
    assert.equal(first.enabled, false);
    assert.equal(first.checked, false, 'the microphone does not listen');
    assert.equal(listensAlways(status), false);
  }
  assert.equal(trayItems(null, false, false)[0].label, 'Sürekli dinle · sesle yazma kurulu değil');
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

import { app, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { VoiceStatus } from '../../shared/setup';
import { readSettings } from './settings';
import { onVoiceStatus, setupStatus, setVoice } from './setup';

/**
 * Cortex in the notification area, at the bottom right on Windows: Pyn's seal,
 * with a red dot while the microphone listens all the time for "Pyn, not al".
 * Its menu turns that listening on and off without opening the window, so the
 * microphone is not open by itself; it also opens the window and quits. With
 * the `background` setting on, the window closed leaves Cortex here, and
 * Cortex starts here with Windows.
 */

export type TrayAction = 'wake' | 'open' | 'quit';

export interface TrayItem {
  label: string;
  type: 'normal' | 'checkbox' | 'separator';
  checked?: boolean;
  enabled?: boolean;
  action?: TrayAction;
}

/** Whether the microphone listens all the time: voice typing set up and on, the wake phrase on. */
export function listensAlways(voice: VoiceStatus | null): boolean {
  return Boolean(voice?.installed && voice.on && voice.wake);
}

/** The menu, as plain items: what it says and does for this voice status, in the window's language. */
export function trayItems(voice: VoiceStatus | null, english: boolean, busy: boolean): TrayItem[] {
  const say = (tr: string, en: string) => (english ? en : tr);
  const usable = Boolean(voice?.installed && voice.on);
  return [
    {
      label: usable
        ? say('Sürekli dinle ("Pyn, not al")', 'Always listen ("Pyn, not al")')
        : say('Sürekli dinle · sesle yazma kurulu değil', 'Always listen · voice typing is not set up'),
      type: 'checkbox',
      checked: listensAlways(voice),
      enabled: usable && !busy,
      action: 'wake',
    },
    { label: '', type: 'separator' },
    { label: say("Cortex'i aç", 'Open Cortex'), type: 'normal', action: 'open' },
    { label: say('Çık', 'Quit'), type: 'normal', action: 'quit' },
  ];
}

/** What the icon says when the pointer rests on it. */
export function trayTooltip(voice: VoiceStatus | null, english: boolean): string {
  if (listensAlways(voice)) return english ? 'Cortex · the microphone listens for "Pyn, not al"' : 'Cortex · mikrofon "Pyn, not al" için dinliyor';
  return english ? 'Cortex · the microphone is off' : 'Cortex · mikrofon kapalı';
}

let tray: Tray | null = null;
let voice: VoiceStatus | null = null;
let busy = false;
let handlers: { open(): void; quit(): void } | null = null;

/** The icon's pictures (tema/ananas/marka/tepsi, from scripts/marka_uret.py tepsi), beside the bundle when packaged. */
function iconFile(name: string): string | undefined {
  const candidates = [path.join(process.resourcesPath ?? '', 'tepsi', name), path.join(__dirname, '..', '..', 'tema', 'ananas', 'marka', 'tepsi', name)];
  return candidates.find((one) => fs.existsSync(one));
}

function icon(listening: boolean): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [
    [16, 1],
    [24, 1.5],
    [32, 2],
  ] as const) {
    const file = iconFile(`pyn-${listening ? 'dinliyor' : 'kapali'}-${size}.png`);
    if (file) image.addRepresentation({ scaleFactor, buffer: fs.readFileSync(file) });
  }
  return image;
}

const english = () => readSettings().language === 'en';

function menu(): Electron.Menu {
  return Menu.buildFromTemplate(
    trayItems(voice, english(), busy).map((item): Electron.MenuItemConstructorOptions =>
      item.type === 'separator'
        ? { type: 'separator' }
        : { label: item.label, type: item.type, checked: item.checked, enabled: item.enabled ?? true, click: () => void act(item.action) },
    ),
  );
}

function show(): void {
  if (!tray) return;
  tray.setImage(icon(listensAlways(voice)));
  tray.setToolTip(trayTooltip(voice, english()));
}

async function act(action: TrayAction | undefined): Promise<void> {
  if (action === 'open') handlers?.open();
  else if (action === 'quit') handlers?.quit();
  else if (action === 'wake' && voice) {
    busy = true;
    try {
      await setVoice({ wake: !voice.wake });
    } catch {
      await setupStatus().catch(() => null); // refused (another setup going on): the status says how it is
    } finally {
      busy = false;
      show();
    }
  }
}

/** The icon put in the notification area, told of every voice status the app reads from then on. */
export function startTray(given: { open(): void; quit(): void }): void {
  if (tray) return;
  handlers = given;
  tray = new Tray(icon(false));
  // Either click shows the menu, built anew so it says how things are now; a double click opens the window.
  const popUp = () => tray?.popUpContextMenu(menu());
  tray.on('click', popUp);
  tray.on('right-click', popUp);
  tray.on('double-click', () => handlers?.open());
  onVoiceStatus((next) => {
    voice = next;
    show();
  });
  show();
  void setupStatus().catch(() => null); // how the microphone is at start
}

/** A short word from the icon (Windows: a notification beside it). */
export function trayNotice(title: string, content: string): void {
  tray?.displayBalloon({ title, content, icon: icon(false) });
}

/**
 * Cortex starts with Windows, in the notification area, while `background` is
 * on. Only the installed app: one run from the source tree is a developer's.
 */
export function startWithWindows(on: boolean): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: on, args: ['--gizli'] });
}

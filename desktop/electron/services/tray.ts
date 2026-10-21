import { app, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { wakePhraseLabel, type VoiceStatus } from '../../shared/setup';
import { readSettings } from './settings';
import { onVoiceStatus, openNoteWindow, setupStatus, setVoice } from './setup';

/**
 * Cortex in the notification area, at the bottom right on Windows: Pyn's seal,
 * with a red dot while the microphone listens all the time for "Pyn, not al".
 * Its menu says whether the microphone listens and turns that on and off
 * without opening the window, so the microphone is not open by itself; it
 * opens yakala's window, Cortex, its settings, and quits. With the
 * `background` setting on, the window closed leaves Cortex here, and Cortex
 * starts here with Windows.
 *
 * Every item has an icon: a Windows menu keeps a column at the left for them
 * whether there are any or not, and empty it made the words look pushed aside.
 */

export type TrayAction = 'wake' | 'note' | 'open' | 'settings' | 'quit';
export type TrayIcon = 'mikrofon-acik' | 'mikrofon-kapali' | 'not' | 'pyn' | 'ayarlar' | 'cik';

export interface TrayItem {
  label: string;
  type: 'normal' | 'separator';
  enabled?: boolean;
  icon?: TrayIcon;
  action?: TrayAction;
}

/** Whether the microphone listens all the time: voice typing set up and on, the wake phrase on. */
export function listensAlways(voice: VoiceStatus | null): boolean {
  return Boolean(voice?.installed && voice.on && voice.wake);
}

/** The menu, as plain items: what it says and does for this voice status, in the window's language. */
export function trayItems(voice: VoiceStatus | null, english: boolean, busy: boolean, canNote: boolean): TrayItem[] {
  const say = (tr: string, en: string) => (english ? en : tr);
  const usable = Boolean(voice?.installed && voice.on);
  const listening = listensAlways(voice);
  const phrase = wakePhraseLabel(voice?.wakePhrase, english);
  const separator: TrayItem = { label: '', type: 'separator' };
  return [
    {
      label: !usable
        ? say('Sesle yazma kurulu değil', 'Voice typing is not set up')
        : listening
          ? say(`Mikrofon dinliyor: ${phrase}`, `The microphone listens: ${phrase}`)
          : say('Mikrofon kapalı', 'The microphone is off'),
      type: 'normal',
      enabled: false,
      icon: listening ? 'mikrofon-acik' : 'mikrofon-kapali',
    },
    ...(usable
      ? [
          {
            label: listening ? say('Sürekli dinlemeyi kapat', 'Stop listening all the time') : say(`Sürekli dinle (${phrase})`, `Listen all the time (${phrase})`),
            type: 'normal' as const,
            enabled: !busy,
            icon: listening ? ('mikrofon-kapali' as const) : ('mikrofon-acik' as const),
            action: 'wake' as const,
          },
        ]
      : []),
    separator,
    { label: say('Not al', 'Take a note'), type: 'normal', enabled: canNote, icon: 'not', action: 'note' },
    { label: say("Cortex'i aç", 'Open Cortex'), type: 'normal', icon: 'pyn', action: 'open' },
    { label: say('Ayarlar', 'Settings'), type: 'normal', icon: 'ayarlar', action: 'settings' },
    separator,
    { label: say('Çık', 'Quit'), type: 'normal', icon: 'cik', action: 'quit' },
  ];
}

/** What the icon says when the pointer rests on it. */
export function trayTooltip(voice: VoiceStatus | null, english: boolean): string {
  const phrase = wakePhraseLabel(voice?.wakePhrase, english);
  if (listensAlways(voice)) return english ? `Cortex · the microphone listens for ${phrase}` : `Cortex · mikrofon ${phrase} için dinliyor`;
  return english ? 'Cortex · the microphone is off' : 'Cortex · mikrofon kapalı';
}

let tray: Tray | null = null;
let voice: VoiceStatus | null = null;
let busy = false;
let handlers: { open(): void; settings(): void; askWake(): void; quit(): void } | null = null;
const icons = new Map<string, Electron.NativeImage>();

/** The icons' pictures (tema/ananas/marka/tepsi, from scripts/marka_uret.py tepsi), beside the bundle when packaged. */
function iconFile(name: string): string | undefined {
  const candidates = [path.join(process.resourcesPath ?? '', 'tepsi', name), path.join(__dirname, '..', '..', 'tema', 'ananas', 'marka', 'tepsi', name)];
  return candidates.find((one) => fs.existsSync(one));
}

/** A picture at each scale it has: `<stem>-16.png` for 1x, and the larger ones for screens set larger. */
function picture(stem: string, sizes: Array<[number, number]>): Electron.NativeImage {
  const kept = icons.get(stem);
  if (kept) return kept;
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of sizes) {
    const file = iconFile(`${stem}-${size}.png`);
    if (file) image.addRepresentation({ scaleFactor, buffer: fs.readFileSync(file) });
  }
  icons.set(stem, image);
  return image;
}

const trayPicture = (listening: boolean) =>
  picture(`pyn-${listening ? 'dinliyor' : 'kapali'}`, [
    [16, 1],
    [24, 1.5],
    [32, 2],
  ]);
const menuPicture = (icon: TrayIcon) =>
  picture(icon === 'pyn' ? 'pyn-kapali' : `menu-${icon}`, [
    [16, 1],
    [32, 2],
  ]);

const english = () => readSettings().language === 'en';
const canNote = () => process.platform === 'win32' && Boolean(readSettings().vault);

function menu(): Electron.Menu {
  return Menu.buildFromTemplate(
    trayItems(lived(voice), english(), busy, canNote()).map((item): Electron.MenuItemConstructorOptions =>
      item.type === 'separator'
        ? { type: 'separator' }
        : {
            label: item.label,
            enabled: item.enabled ?? true,
            icon: item.icon ? menuPicture(item.icon) : undefined,
            click: () => void act(item.action),
          },
    ),
  );
}

/** The voice status as it is lived: the wake phrase on in the engine counts only once the person allowed it here (services/microphone.ts). */
function lived(status: VoiceStatus | null): VoiceStatus | null {
  return status && status.wake && !readSettings().wakeConsent ? { ...status, wake: false } : status;
}

/** Whether the microphone listens all the time now: the window closed says so, every time. */
export function listeningNow(): boolean {
  return listensAlways(lived(voice));
}

function show(): void {
  if (!tray) return;
  tray.setImage(trayPicture(listeningNow()));
  tray.setToolTip(trayTooltip(lived(voice), english()));
}

/** Leave for the microphone given or taken back in the window: the icon says it at once. */
export const trayChanged = show;

async function act(action: TrayAction | undefined): Promise<void> {
  if (action === 'open') handlers?.open();
  else if (action === 'settings') handlers?.settings();
  else if (action === 'quit') handlers?.quit();
  else if (action === 'note') openNoteWindow();
  else if (action === 'wake' && voice) {
    const on = !lived(voice)?.wake;
    if (on && !readSettings().wakeConsent) {
      handlers?.askWake();
      return;
    }
    busy = true;
    try {
      await setVoice({ wake: on });
    } catch {
      await setupStatus().catch(() => null); // refused (another setup going on): the status says how it is
    } finally {
      busy = false;
      show();
    }
  }
}

/** The icon put in the notification area, told of every voice status the app reads from then on. */
export function startTray(given: { open(): void; settings(): void; askWake(): void; quit(): void }): void {
  if (tray) return;
  handlers = given;
  tray = new Tray(trayPicture(false));
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
  tray?.displayBalloon({ title, content, icon: trayPicture(false) });
}

/**
 * Cortex starts with Windows, in the notification area, while `background` is
 * on. Only the installed app: one run from the source tree is a developer's.
 */
export function startWithWindows(on: boolean): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: on, args: ['--gizli'] });
}

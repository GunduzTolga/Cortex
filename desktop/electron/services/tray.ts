import { app, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { hotkeyLabel, HOTKEYS, type ListenerSeen, wakePhraseLabel, type VoiceStatus, type WakeTrouble } from '../../shared/setup';
import { readSettings } from './settings';
import { type ListenerWord, listenerHasSpoken, listenerRestarting, readListener, readOwner } from './microphone';
import { onVoiceStatus, openNoteWindow, restartListener, setupStatus, setVoice } from './setup';

/**
 * Cortex in the notification area, at the bottom right on Windows: Pyn's seal,
 * with a red dot while the microphone listens all the time for "Pyn, not al".
 * Its menu says whether the microphone listens and turns that on and off
 * without opening the window, so the microphone is not open by itself; it
 * opens yakala's window, Cortex, its settings, and quits. With the
 * `background` setting on, the window closed leaves Cortex here, and Cortex
 * starts here with Windows.
 *
 * It says only what yakala's listener says (dinleyici.json): the microphone
 * listens when the wake listener really hears it, not when the setting is on.
 * A wake phrase that cannot hear (no microphone, Windows' privacy switch, its
 * model), a key another app holds, and a listener that does not run at all
 * are said here and in the settings, where before the red dot and "Mikrofon
 * dinliyor" stood over nothing that listened (voice-4, yakala-6,
 * windows-e2e-5).
 *
 * Every item has an icon: a Windows menu keeps a column at the left for them
 * whether there are any or not, and empty it made the words look pushed aside.
 */

export type TrayAction = 'wake' | 'note' | 'open' | 'settings' | 'quit' | 'listener';
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

/** Why the wake phrase cannot hear, in a few words for the menu (the settings say what to do). */
export function wakeTroubleShort(trouble: WakeTrouble, english: boolean): string {
  const said: Record<WakeTrouble, [string, string]> = {
    mikrofon: ['mikrofondan ses gelmiyor', 'no sound from the microphone'],
    sessiz: ['mikrofon yalnız sessizlik veriyor', 'the microphone gives only silence'],
    model: ['uyandırma modeli açılamadı', 'its model did not load'],
  };
  return said[trouble][english ? 1 : 0];
}

/**
 * Whether the microphone really listens for the wake phrase now: on, allowed, and the listener says it hears. A listener
 * that never says (`quiet`: an engine from before its word) listens as the settings say, and is taken at them, as before:
 * read as off, the window closed did not say the microphone still listened.
 */
export function hearsNow(voice: VoiceStatus | null, word: ListenerWord | null | undefined, quiet = false): boolean {
  return listensAlways(voice) && (word?.uyandirma === true || (quiet && !word));
}

/**
 * The menu, as plain items: what it says and does for this voice status, in the window's language; `seen`, how
 * yakala's listener is (its word: loading, failed, hearing or not, its key; or found not running), where it says.
 */
export function trayItems(voice: VoiceStatus | null, english: boolean, busy: boolean, canNote: boolean, seen: Partial<ListenerSeen> = {}): TrayItem[] {
  const say = (tr: string, en: string) => (english ? en : tr);
  const usable = Boolean(voice?.installed && voice.on);
  const listening = listensAlways(voice);
  const word = seen.word ?? null;
  const missing = usable && seen.missing === true;
  const hears = hearsNow(voice, word, seen.quiet);
  const phrase = wakePhraseLabel(voice?.wakePhrase, english);
  const key = seen.hotkey ?? hotkeyLabel(HOTKEYS[0]);
  const separator: TrayItem = { label: '', type: 'separator' };
  return [
    {
      label: !usable
        ? say('Sesle yazma kurulu değil', 'Voice typing is not set up')
        : missing
          ? say('Dinleyici çalışmıyor', 'The listener is not running')
          : word?.ses === 'yukleniyor'
            ? say('Ses hazırlanıyor…', 'Voice is getting ready…')
            : word?.ses === 'hata'
              ? say('Ses açılamadı, yeniden deneniyor', 'Voice could not start; trying again')
              : !listening
                ? say('Mikrofon kapalı', 'The microphone is off')
                : hears
                  ? say(`Mikrofon dinliyor: ${phrase}`, `The microphone listens: ${phrase}`)
                  : word?.uyandirma_sorun
                    ? say(`Uyandırma açılamadı: ${wakeTroubleShort(word.uyandirma_sorun, false)}`, `The wake phrase could not start: ${wakeTroubleShort(word.uyandirma_sorun, true)}`)
                    : word
                      ? say('Uyandırma açılıyor…', 'The wake phrase is starting…')
                      : say('Dinleyici başlıyor…', 'The listener is starting…'),
      type: 'normal',
      enabled: false,
      icon: !missing && hears ? 'mikrofon-acik' : 'mikrofon-kapali',
    },
    // Nothing listens: the key, the phrase and the microphone are yakala's listener's. Set up again, it starts.
    ...(missing ? [{ label: say('Dinleyiciyi başlat', 'Start the listener'), type: 'normal' as const, enabled: !busy, icon: 'pyn' as const, action: 'listener' as const }] : []),
    // Another app holds the key: yakala's listener runs on without it, and the settings move it to another key. Said
    // with voice typing or without it: the key is most people's way to take a note, voice or not.
    ...(!missing && word?.kisayol === 'mesgul'
      ? [{ label: say(`${key} başka bir uygulamada: kısayolu değiştir…`, `${key} is held by another app: change the key…`), type: 'normal' as const, icon: 'ayarlar' as const, action: 'settings' as const }]
      : []),
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

/** What the icon says when the pointer rests on it; `percent`, how much of a model being fetched has come. */
export function trayTooltip(voice: VoiceStatus | null, english: boolean, seen: Partial<ListenerSeen> = {}, percent: number | null = null): string {
  const phrase = wakePhraseLabel(voice?.wakePhrase, english);
  const usable = Boolean(voice?.installed && voice.on);
  if (usable && seen.missing) return english ? 'Cortex · the listener is not running' : 'Cortex · dinleyici çalışmıyor';
  if (usable && seen.word?.ses === 'yukleniyor') {
    const far = percent === null ? '' : english ? ` ${percent}%` : ` %${percent}`;
    return english ? `Cortex · voice is getting ready…${far}` : `Cortex · Pyn hazırlanıyor…${far}`;
  }
  if (hearsNow(voice, seen.word, seen.quiet)) return english ? `Cortex · the microphone listens for ${phrase}` : `Cortex · mikrofon ${phrase} için dinliyor`;
  if (listensAlways(voice) && seen.word?.uyandirma_sorun) return english ? 'Cortex · the wake phrase could not start' : 'Cortex · uyandırma açılamadı';
  return english ? 'Cortex · the microphone is off' : 'Cortex · mikrofon kapalı';
}

/**
 * How long no listener may be seen, with voice typing set up and on, before that is said: longer than the listener
 * takes to start again after a setting is changed. At the app's own start, longer: started with Windows, the listener
 * starts beside it, cold, a scanner looking at every file it opens.
 */
export const MISSING_AFTER = 10_000;
export const MISSING_AT_START = 60_000;

/**
 * Since when no listener has been seen where one should run: voice set up and on, nothing starting it again now; null
 * while one is, or none should, or none would be seen: one that never says a word (`quiet`, an engine from before it)
 * was said not to run a minute after every start, over a listener that listened, until the vault's engine was updated.
 */
export function missingSince(before: number | null, voice: VoiceStatus | null, word: ListenerWord | null, restarting: boolean, now: number, quiet = false): number | null {
  if (!voice?.installed || !voice.on || word !== null || restarting || quiet) return null;
  return before ?? now;
}

/** Whether a listener missing since then is said to be: past the grace, and past the app's own start. */
export function isMissing(since: number | null, now: number, started: number): boolean {
  return since !== null && now - since >= MISSING_AFTER && now - started >= MISSING_AT_START;
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
    trayItems(lived(voice), english(), busy, canNote(), currentListener()).map((item): Electron.MenuItemConstructorOptions =>
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

/** Whether the microphone listens all the time now - the listener says it hears - and the window closed says so, every time. */
export function listeningNow(): boolean {
  return !missing && hearsNow(lived(voice), helper, quiet);
}

function show(): void {
  if (!tray) return;
  tray.setImage(trayPicture(listeningNow()));
  tray.setToolTip(trayTooltip(lived(voice), english(), currentListener(), percentOf(helper)));
}

/** How much of a model being fetched has come, in percent; null when none is. */
export function percentOf(word: ListenerWord | null): number | null {
  return word?.mb !== null && word?.mb !== undefined && word.toplam ? Math.min(100, Math.floor((word.mb * 100) / word.toplam)) : null;
}

const helperListeners = new Set<(seen: ListenerSeen) => void>();

/** Who is told every change of the listener's word, or of its being found not running (the settings' bar, through the window). */
export function onHelperChange(listener: (seen: ListenerSeen) => void): () => void {
  helperListeners.add(listener);
  return () => helperListeners.delete(listener);
}

/** The key yakala was set up with, as its record says (`yakala-sahip.json`); null where none does. */
function ownKey(): string | null {
  const owner = readOwner();
  return owner ? hotkeyLabel(owner.tus ?? HOTKEYS[0]) : null;
}

/** How the listener is as last read: its word, whether it was found not running, its key, and whether it says anything at all. */
export const currentListener = (): ListenerSeen => ({ word: helper, missing, hotkey: ownKey(), quiet });

/** What the listener said of its voice last, read every two seconds while the icon is there (services/microphone.ts). */
let helper: ListenerWord | null = null;
/** No listener where one should run, since then (`missingSince`), and whether that is said now (`isMissing`). */
let missingFrom: number | null = null;
let missing = false;
/** No listener here has ever said a word (`listenerHasSpoken`): the vault's engine is from before it. */
let quiet = false;
const trayStarted = Date.now();
/** A load said to be going on (it took longer than a moment): its end is said too. */
let toldLoading = false;
let loadingTimer: NodeJS.Timeout | null = null;
let toldError = '';
/** The listener's last trouble said (`listenerTurn`): not said again when its listener starts again with it. */
let toldListener = '';
const LOADING_SAID_AFTER = 4_000;
/**
 * The voice asked for in this run - set up, switched, its listener started again - so its getting ready is worth a
 * word. Otherwise only where the wake phrase listens: at every Windows sign-in, "Pyn hazırlanıyor…" and "Pyn hazır"
 * came to someone who only uses the key (windows-e2e-6). A failure is always said.
 */
let asked = false;

/** The voice was asked for now (electron/ipc.ts): its loading and its being ready are said. */
export function expectVoiceTurn(): void {
  asked = true;
}

/**
 * The voice helper's turns said where the person sees them: a model that takes a while to load
 * (a processor: half a minute and more) says "Pyn hazırlanıyor…" and, when it is done, "Pyn hazır";
 * one that would not load says so. Before, the wake phrase only seemed not to work until then,
 * and Cortex was closed and opened again (21 October).
 */
export function helperTurn(before: ListenerWord | null, now: ListenerWord | null, english: boolean, phrase: string, toldLoad: boolean): { title: string; body: string } | null {
  const say = (tr: string, en: string) => (english ? en : tr);
  if (!now || before?.ses === now.ses) return null;
  if (now.ses === 'hazir' && (toldLoad || before?.ses === 'hata')) {
    return {
      title: say('Pyn hazır', 'Pyn is ready'),
      body: now.uyandirma
        ? say(`${phrase} de; not penceresi seni dinleyerek açılır.`, `Say ${phrase}; the note window opens, listening.`)
        : say('Not penceresinde konuşabilirsin.', 'You can speak into the note window.'),
    };
  }
  if (now.ses === 'hata') {
    return {
      title: say('Ses açılamadı', 'Voice could not start'),
      body: say(`${now.mesaj || 'Ses modeli yüklenemedi.'} Birazdan yeniden denenecek.`, `${now.mesaj || 'The voice model did not load.'} It will be tried again shortly.`),
    };
  }
  return null;
}

/**
 * The listener's other turns said where the person sees them: the wake phrase that cannot hear (its microphone silent,
 * Windows' privacy switch, its model) and why, a key another app took, and no listener running at all. Each once,
 * when it begins.
 */
export function listenerTurn(
  before: ListenerSeen,
  now: ListenerSeen,
  english: boolean,
): { title: string; body: string } | null {
  const say = (tr: string, en: string) => (english ? en : tr);
  if (now.missing && !before.missing) {
    return {
      title: say('Dinleyici çalışmıyor', 'The listener is not running'),
      body: say(
        'Kısayol, uyandırma sözü ve sesle yazma şu an çalışmıyor. Simgeden "Dinleyiciyi başlat"a bas.',
        'The key, the wake phrase and voice typing do not work now. Choose "Start the listener" from the icon.',
      ),
    };
  }
  const trouble = now.word?.uyandirma_sorun ?? null;
  if (trouble && trouble !== (before.word?.uyandirma_sorun ?? null)) {
    // The engine's sentence says what to do (Windows' privacy switch by name); it is Turkish, and follows "Uyandırma açılamadı: ".
    const why = english ? `${wakeTroubleShort(trouble, true)}; Settings → Voice typing says what to do.` : now.word?.uyandirma_mesaj || `${wakeTroubleShort(trouble, false)}.`;
    return {
      title: say('Uyandırma açılamadı', 'The wake phrase could not start'),
      body: `${why.charAt(0).toLocaleUpperCase(english ? 'en' : 'tr')}${why.slice(1)}`,
    };
  }
  if (now.word?.kisayol === 'mesgul' && before.word?.kisayol !== 'mesgul') {
    const key = now.hotkey ?? hotkeyLabel(HOTKEYS[0]);
    return {
      title: say(`${key} başka bir uygulamada`, `${key} is held by another app`),
      body: say(
        'Not alma kısayolu şu an çalışmıyor; simgedeki "Not al" çalışıyor. Ayarlar → Sesle yazma\'dan başka bir kısayol seç.',
        'The note key does not work now; the icon’s "Take a note" does. Choose another key in Settings → Voice typing.',
      ),
    };
  }
  return null;
}

function listenToHelper(): void {
  const next = readListener();
  const now = Date.now();
  quiet = !next && !listenerHasSpoken();
  missingFrom = missingSince(missingFrom, voice, next, listenerRestarting(now), now, quiet);
  const before: ListenerSeen = { word: helper, missing, hotkey: null };
  helper = next;
  missing = isMissing(missingFrom, now, trayStarted);
  if (JSON.stringify(before.word) === JSON.stringify(next) && before.missing === missing) return;
  const seen = currentListener();
  for (const listener of helperListeners) listener(seen);
  const other = listenerTurn(before, seen, english());
  if (other && other.body !== toldListener) {
    trayNotice(other.title, other.body);
    toldListener = other.body;
  }
  if (next && !missing && !next.uyandirma_sorun && next.kisayol !== 'mesgul') toldListener = '';
  // How much has come changes every second while a model is fetched: the tooltip follows, nothing more is said.
  if (before.word?.ses === next?.ses && before.word?.uyandirma === next?.uyandirma) {
    show();
    return;
  }
  const phrase = wakePhraseLabel(voice?.wakePhrase, english());
  // Its loading said only where it matters: the wake phrase listens, or the voice was asked for now.
  if (next?.ses === 'yukleniyor' && before.word?.ses !== 'yukleniyor' && (asked || listensAlways(lived(voice)))) {
    // Said only when it takes longer than a moment: a card loads in a few seconds, and nothing need be said.
    if (loadingTimer) clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      loadingTimer = null;
      if (helper?.ses !== 'yukleniyor') return;
      toldLoading = true;
      trayNotice(
        english() ? 'Pyn is getting ready…' : 'Pyn hazırlanıyor…',
        english() ? 'The voice model is loading; on this computer it can take a while. I will say when it is ready.' : 'Ses modeli yükleniyor; bu bilgisayarda biraz sürebilir. Hazır olunca haber vereceğim.',
      );
    }, LOADING_SAID_AFTER);
  }
  const turn = helperTurn(before.word, next, english(), phrase, toldLoading);
  if (turn && !(next?.ses === 'hata' && next.mesaj === toldError)) trayNotice(turn.title, turn.body);
  if (next?.ses === 'hata') toldError = next.mesaj;
  if (next?.ses === 'hazir') {
    toldLoading = false;
    toldError = '';
    asked = false;
  }
  show();
}

/** Leave for the microphone given or taken back in the window: the icon says it at once. */
export const trayChanged = show;

async function act(action: TrayAction | undefined): Promise<void> {
  if (action === 'open') handlers?.open();
  else if (action === 'settings') handlers?.settings();
  else if (action === 'quit') handlers?.quit();
  else if (action === 'note') openNoteWindow();
  else if (action === 'listener') {
    busy = true;
    expectVoiceTurn();
    try {
      await restartListener();
    } catch (err) {
      trayNotice(english() ? 'The listener did not start' : 'Dinleyici başlamadı', err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      show();
    }
  } else if (action === 'wake' && voice) {
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
  // The listener's voice helper: loading, ready, failed; its word read every two seconds.
  if (process.platform === 'win32') {
    listenToHelper();
    setInterval(listenToHelper, 2_000).unref();
  }
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
 * Written when the person changes the setting here.
 */
export function startWithWindows(on: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!app.isPackaged || platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: on, args: ['--gizli'] });
}

/**
 * At the app's start, the entry written only where it is missing (the first run) or left behind (the setting off).
 * Written at every start, it was enabled again each time: Electron's `enabled`, true unless given, sets Windows'
 * own switch, and a person who had turned Cortex off in Task Manager's or Settings' start-up list found it on again
 * the next time they opened it (desktop-shell-6). An entry Windows holds turned off still reads as there, and stays so.
 */
export function keepStartWithWindows(on: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!app.isPackaged || platform !== 'win32') return;
  if (app.getLoginItemSettings({ args: ['--gizli'] }).openAtLogin !== on) startWithWindows(on, platform);
}

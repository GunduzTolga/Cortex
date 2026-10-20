import { useEffect, useMemo, useRef, useState } from 'react';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/vt323/400.css';
import './office.css';
import * as art from './office-art.js';
import type { ToolId } from './office-art.js';
import { OfficeEngine, clockText, lightForHour, nameTheManager, possessive, type AgentSnapshot, type Led, type LogEntry } from './ofis-engine.js';
import { useChat } from '../chat/chatStore';
import { TALK_EVERY, TALK_TOOL_NAME, useTalk, useTalkModels, useTalkTools, type TalkToolState } from './talkPrefs';
import { refusal, useApp } from '../store/app';
import { type TalkTool } from '@shared/office';
import { useNotes } from '../notes/notesStore';
import { useLanguage, useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { useEscapeLayer } from '../ui/useEscapeLayer';

/**
 * The office: a pixel-art newsroom where the vault's agents work and talk,
 * as Claude Design drew it (office-art.js, the engine in ofis-engine.js, its
 * panel in office.css). Click a character for its card, a room for what goes
 * on in it; the wheel zooms, a drag looks around.
 *
 * What is real already: the server room's lights are the tools' own sign-ins,
 * the rooms count the vault's notes, links and receipts, the light follows
 * the clock. What the agents do is still the prototype's script.
 */

const TOOLS: ToolId[] = ['claude', 'codex', 'opencode', 'gemini', 'qwen'];
const TOOL_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen', lmstudio: 'LM Studio', ollama: 'Ollama' };
const LED_COLOR: Record<Led, string> = { ok: '#5BD77A', wait: '#F2C14E', off: '#8A93A3' };
const TALK_STATE_WORD: Record<TalkToolState, Key> = { ready: 'office.talk.ready', off: 'office.talk.off', signedOut: 'office.talk.signedOut' };
const PREFS_KEY = 'cortex.office.v1';

/** How the office looks; its live conversations are a choice of their own (talkPrefs.ts), the app's settings show it too. */
interface Prefs {
  followClock: boolean;
  pixel: boolean;
  logHeight: number;
}
const DEFAULTS: Prefs = { followClock: true, pixel: true, logHeight: 150 };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { followClock: saved.followClock ?? DEFAULTS.followClock, pixel: saved.pixel ?? DEFAULTS.pixel, logHeight: saved.logHeight ?? DEFAULTS.logHeight };
  } catch {
    return DEFAULTS;
  }
}

interface Line {
  id: number;
  time: string;
  icon: string;
  name: string;
  nameColor: string;
  text: string;
  textColor: string;
}

/**
 * A colour drawn for the dark monitor, made readable on the paper the office
 * now sits on: a light one is taken toward the ink until it reads (the
 * characters' name colours, the engine's gold and green). A dark one is left.
 */
export function onPaper(color: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return color;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const light = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  if (light <= 0.2) return color;
  // Mixed with the ink (#1b1712): the lighter the colour, the more of the ink.
  const k = Math.min(0.75, (light - 0.2) / (light + 0.05) + 0.15);
  const mix = (v: number, ink: number) => Math.round(v * (1 - k) + ink * k).toString(16).padStart(2, '0');
  return `#${mix(r, 0x1b)}${mix(g, 0x17)}${mix(b, 0x12)}`;
}

let lineSeq = 0;
function lineOf(entry: LogEntry): Line {
  const who = entry.who ? art.CHARACTERS[entry.who] : undefined;
  return {
    id: ++lineSeq,
    time: entry.time,
    icon: entry.icon ?? '',
    name: who ? who.name : '',
    nameColor: who ? onPaper(who.color) : 'var(--ofis-yazi)',
    text: who ? `: ${entry.text}` : entry.text,
    textColor: who ? 'var(--ofis-yazi)' : entry.color ? onPaper(entry.color) : 'var(--ofis-yazi-ikincil)',
  };
}

const sameDay = (at: number, now: Date) => {
  const d = new Date(at);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/** A 12×12 icon of the drawings, for the card's counters. */
function Icon({ name, title }: { name: string; title: string }) {
  const draw = (canvas: HTMLCanvasElement | null) => {
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 12, 12);
    art.ICONS[name]?.paint(ctx, 0, {});
  };
  return <canvas ref={draw} width={12} height={12} title={title} className="ofis-pixel" style={{ width: 18, height: 18 }} />;
}

export function OfficeView({ visible }: { visible: boolean }) {
  const t = useT();
  const language = useLanguage();
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const portraitRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<OfficeEngine | null>(null);
  const stick = useRef(true);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [snapshot, setSnapshot] = useState<AgentSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>(() => [lineOf({ time: clockText(), icon: '🏢', text: t('office.log.opened'), color: null })]);
  const [full, setFull] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hint, setHint] = useState(true);
  const [tip, setTip] = useState<string | null>(null);
  const [newPill, setNewPill] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [lastTalk, setLastTalk] = useState<string | null>(null);

  const auth = useChat((state) => state.auth);
  const index = useNotes((state) => state.index);

  const change = (patch: Partial<Prefs>) =>
    setPrefs((was) => {
      const next = { ...was, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* for this run */
      }
      return next;
    });

  // The engine, made once with the panel and ended with it.
  useEffect(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;
    const engine = new OfficeEngine(canvas, art, {
      onSnapshot: setSnapshot,
      onLog: (entry) => setLines((was) => [...was, lineOf(entry)].slice(-200)),
      onSelect: (id) => {
        setSelected(id);
        if (id) setRoom(null);
      },
      onRoom: (id) => {
        setRoom(id);
        setSelected(null);
      },
      onHover: setHover,
      onInteract: () => setHint(false),
    });
    engineRef.current = engine;
    // Greeted in the window's language, before its own effect below has set it.
    engine.lang = useApp.getState().settings.language === 'en' ? 'en' : 'tr';
    engine.setUserName(useApp.getState().settings.userName);
    engine.greet();
    setSnapshot(engine.snapshot());
    const resized = new ResizeObserver(() => engine.resize());
    resized.observe(map);
    // The pixel face, once loaded, for what the canvas writes.
    void document.fonts?.load("600 12px 'Pixelify Sans'").catch(() => undefined);
    return () => {
      resized.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Drawn only while it is in front: a hidden tab costs nothing.
  useEffect(() => {
    engineRef.current?.setActive(visible);
  }, [visible]);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 5000);
    const fade = setTimeout(() => setHint(false), 8000);
    return () => {
      clearInterval(clock);
      clearTimeout(fade);
    };
  }, []);

  // Escape closes what is open over the map - the settings, a card, a room - one layer at a time with any dialog above.
  useEscapeLayer(visible && settingsOpen, () => setSettingsOpen(false));
  useEscapeLayer(visible && Boolean(selected || room), () => {
    engineRef.current?.select(null);
    if (engineRef.current) engineRef.current.room = null;
    setSelected(null);
    setRoom(null);
  });

  // The server room's lights: each tool's own sign-in, asked once if not yet.
  useEffect(() => {
    if (auth === null) void useChat.getState().loadAuth();
  }, [auth]);
  const leds = useMemo(() => {
    const out = {} as Record<ToolId, Led>;
    for (const id of TOOLS) {
      const tool = auth?.find((one) => one.id === id);
      out[id] = !tool ? 'wait' : !tool.installed ? 'off' : tool.signedIn ? 'ok' : 'wait';
    }
    return out;
  }, [auth]);
  useEffect(() => engineRef.current?.setLeds(leds), [leds]);
  // Addressed as the person asked, from the first-run screen or the settings.
  const userName = useApp((s) => s.settings.userName);
  // The manager is named after the vault's owner: set before the chips and the card read the name.
  useMemo(() => nameTheManager(art, userName, language === 'en' ? 'en' : 'tr'), [userName, language]);
  useEffect(() => engineRef.current?.setUserName(userName), [userName]);

  // The light by the hour, or day all day; the face the canvas writes in.
  const night = prefs.followClock && (now.getHours() >= 20 || now.getHours() < 8);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.mode = prefs.followClock ? lightForHour(now.getHours()) : 'ogle';
    engine.font = prefs.pixel ? "'Pixelify Sans'" : "'Segoe UI', system-ui";
    engine.lang = language === 'en' ? 'en' : 'tr';
  }, [prefs.followClock, prefs.pixel, now, language]);

  // The log follows its newest line unless it was scrolled up, and says so then.
  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    if (stick.current || full) element.scrollTop = element.scrollHeight;
    else setNewPill(true);
  }, [lines, full]);

  useEffect(() => {
    requestAnimationFrame(() => engineRef.current?.resize());
  }, [full]);

  // The card's portrait: the character's first standing frame, three times its size.
  useEffect(() => {
    const canvas = portraitRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !selected) return;
    const cell = art.cellOf(selected);
    const off = document.createElement('canvas');
    off.width = cell.w;
    off.height = cell.h;
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    art.paintCharacter(offCtx, selected, 'idle', 'down', 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#EAE4D6';
    ctx.fillRect(0, 0, 56, 80);
    ctx.fillStyle = '#E4E0D5';
    ctx.fillRect(0, 62, 56, 18);
    if (cell.h === 16) ctx.drawImage(off, 4, 22, 48, 48);
    else ctx.drawImage(off, 4, -(art.anchors(selected, 'idle', 'down', 0).head[1] - 3) * 3, 48, 96);
  }, [selected]);

  useEffect(() => {
    engineRef.current?.setPreview(room ? previewRef.current : null, room);
  }, [room]);

  const byId = useMemo(() => Object.fromEntries(snapshot.map((one) => [one.id, one])), [snapshot]);

  // What the rooms say of the vault: its notes, links, receipts and the pages the engine signed off.
  const stats = useMemo(() => {
    const notes = index?.notes ?? [];
    return {
      notes: notes.length,
      links: notes.reduce((sum, note) => sum + note.links.length, 0),
      receipts: notes.filter((note) => note.keeper === 'receipt').length,
      generated: notes.filter((note) => note.keeper === 'generated').length,
      today: notes.filter((note) => sameDay(note.modified, now)).length,
    };
  }, [index, now]);

  const roomStatus = (id: string, people: number): string => {
    const ok = Object.values(leds).filter((one) => one === 'ok').length;
    const wait = Object.values(leds).filter((one) => one === 'wait').length;
    switch (id) {
      case 'harita':
        return t('office.room.harita', { notes: stats.notes, links: stats.links });
      case 'arsiv':
        return t('office.room.arsiv', { count: stats.receipts });
      case 'pyn':
        // Pyn's room is where notes come in (the old mailroom) and are signed off.
        return `${t('office.room.posta', { count: stats.today })} · ${t('office.room.pyn', { count: stats.generated })}`;
      case 'mudur':
        return t('office.room.mudur', { count: stats.notes });
      case 'salon':
        return t('office.room.salon', { count: people });
      case 'mutfak':
        return t('office.room.mutfak');
      case 'toplanti':
        return people >= 2 ? t('office.room.toplanti', { count: people }) : t('office.room.toplanti.none');
      case 'sunucu':
        return t('office.room.sunucu', { ok, wait });
      case 'dinlenme':
        return t('office.room.dinlenme');
      default:
        return '';
    }
  };

  const ledWord: Record<Led, Key> = { ok: 'office.tool.ok', wait: 'office.tool.wait', off: 'office.tool.off' };
  const card = selected ? art.CHARACTERS[selected] : null;
  const agent = selected ? byId[selected] : undefined;
  const CARD_LABEL: Record<string, Key> = { pyn: 'office.card.boss', cat: 'office.card.cat', mudur: 'office.card.manager', dev: 'office.card.dev' };
  const cardLabel = !card ? '' : t(CARD_LABEL[card.kind ?? ''] ?? 'office.card.agent');
  const roomDef = room ? art.MAP.rooms.find((one) => one.id === room) : undefined;
  // The cat drinks no tea.
  const bars: Array<[Key, number, string]> = [
    ...(card?.kind === 'cat' ? [] : [['office.bar.tea', agent?.needs.tea ?? 50, '#E6A83D'] as [Key, number, string]]),
    ['office.bar.food', agent?.needs.food ?? 50, '#5BD77A'],
    ['office.bar.energy', agent?.needs.energy ?? 50, '#6FA8DC'],
  ];
  const people = room ? snapshot.filter((one) => one.room === room) : [];

  // The tools a live conversation can be written by, each with whether it can now (a model server up, Claude Code signed in).
  const talk = useTalk();
  const talkTools = useTalkTools();
  const toolReady = talkTools.some((one) => one.id === talk.tool && one.state === 'ready');
  // The chosen tool's models, its loaded ones first: a different model can write the office's talk than the one chatting.
  const models = useTalkModels(talk.live ? talk.tool : null, toolReady);

  // A conversation written by the chosen model, about the notes worked on last, said in the office.
  const [writing, setWriting] = useState(false);
  const writeTalk = async () => {
    const tool: TalkTool | null = talk.tool;
    if (!tool || !toolReady || writing) return;
    setWriting(true);
    setLastTalk(t('office.settings.writing'));
    // Not the cat, and not the manager: that is the person, who speaks for themselves.
    const cast = Object.entries(art.CHARACTERS)
      .filter(([, one]) => one.kind !== 'cat' && one.kind !== 'mudur')
      .map(([id, one]) => {
        const person = one as { name: string; role: string; roleEn: string; bio?: string };
        return { id, name: person.name, role: language === 'en' ? person.roleEn : person.role, bio: person.bio ?? '' };
      });
    try {
      const lines = await window.cortex.office.talk({ tool, model: talk.model, cast, language: language === 'en' ? 'en' : 'tr' });
      engineRef.current?.speak(lines);
      setLastTalk(t('office.settings.lastNow', { tool: TALK_TOOL_NAME[tool] + (talk.model ? ` · ${talk.model}` : '') }));
    } catch (err) {
      setLastTalk(t('office.settings.failed', { reason: refusal(err instanceof Error ? err.message : String(err)) }));
    } finally {
      setWriting(false);
    }
  };
  const writeRef = useRef(writeTalk);
  writeRef.current = writeTalk;
  // Every few minutes while the office is in front; a hidden tab spends no tokens.
  useEffect(() => {
    if (!talk.live || !talk.tool || !visible) return;
    const timer = setInterval(() => void writeRef.current(), talk.every * 60_000);
    return () => clearInterval(timer);
  }, [talk.live, talk.tool, talk.every, visible]);

  const pickCharacter = (id: string) => {
    engineRef.current?.focus(id);
    setSelected(id);
    setRoom(null);
    setHint(false);
  };

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const from = event.clientY;
    const height = prefs.logHeight;
    const move = (moved: MouseEvent) => change({ logHeight: Math.max(90, Math.min(420, height - (moved.clientY - from))) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const log = (
    <div className={`ofis-log${full ? ' is-floating' : ''}`} style={full ? undefined : { height: prefs.logHeight }} data-ofis-log>
      <div className="ofis-log-title ofis-label">{t('office.log')}</div>
      <div
        ref={logRef}
        className="ofis-log-lines"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 6;
          stick.current = atEnd;
          if (atEnd && newPill) setNewPill(false);
        }}
      >
        {lines.map((line, at) => (
          <div key={line.id} className={`ofis-line${at === lines.length - 1 && lines.length > 1 ? ' is-new' : ''}`} data-ofis-line>
            <span>{line.time}</span>
            <span>{line.icon}</span>
            <span>
              <span style={{ fontWeight: 700, color: line.nameColor }}>{line.name}</span>
              <span style={{ color: line.textColor }}>{line.text}</span>
            </span>
          </div>
        ))}
      </div>
      {newPill && !full ? (
        <button
          type="button"
          className="ofis-new-pill"
          onClick={() => {
            const element = logRef.current;
            if (element) element.scrollTop = element.scrollHeight;
            stick.current = true;
            setNewPill(false);
          }}
        >
          {t('office.log.new')}
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="ofis" data-ofis-font={prefs.pixel ? 'piksel' : 'okunakli'} data-office-view>
      <div ref={mapRef} className="ofis-map">
        <canvas ref={canvasRef} className="ofis-world" style={{ cursor: hover ? 'pointer' : 'grab' }} aria-label={t('app.view.office')} role="img" data-ofis-canvas />

        <div className="ofis-hud ofis-box" data-ofis-hud>
          <span className="ofis-hud-dot" />
          {userName ? (
            <>
              <span lang={language === 'en' ? 'en' : 'tr'} style={{ fontWeight: 700 }} data-ofis-name>
                {t('office.name', { owner: possessive(userName, language === 'en' ? 'en' : 'tr') })}
              </span>
              <span className="ofis-dim">·</span>
            </>
          ) : null}
          <span style={{ fontWeight: 700 }}>{t('office.live')}</span>
          <span className="ofis-dim">·</span>
          <span style={{ fontWeight: 600, color: night ? 'var(--ofis-altin)' : 'var(--ofis-yesil)' }}>{t(night ? 'office.night' : 'office.open')}</span>
          <span className="ofis-dim">·</span>
          <span className="ofis-num">{clockText(now)}</span>
        </div>

        <button type="button" className="ofis-gear ofis-box" title={t('office.settings')} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)} data-ofis-gear>
          ⚙︎
        </button>

        {settingsOpen ? (
          <div className="ofis-panel ofis-settings" data-ofis-settings>
            <div className="ofis-label">{t('office.settings')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="ofis-row">
                <span style={{ fontWeight: 700 }}>{t('office.settings.live')}</span>
                <button type="button" role="switch" aria-checked={talk.live} className="ofis-switch" onClick={() => talk.change({ live: !talk.live })} data-ofis-live>
                  <span />
                </button>
              </div>
              <div className="ofis-hint-text">{t('office.settings.live.hint')}</div>
            </div>
            {talk.live ? (
              <div className="ofis-sep" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span className="ofis-small-label">{t('office.settings.tool')}</span>
                  <div className="ofis-tools">
                    {talkTools.map(({ id, state }) => (
                      <button
                        key={id}
                        type="button"
                        className="ofis-tool"
                        aria-pressed={talk.tool === id}
                        title={t(TALK_STATE_WORD[state])}
                        onClick={() => talk.change({ tool: id, model: null })}
                        data-ofis-tool={id}
                        data-ofis-tool-state={state}
                      >
                        <i style={{ background: state === 'ready' ? '#5BD77A' : '#8A93A3' }} />
                        {TALK_TOOL_NAME[id]}
                      </button>
                    ))}
                  </div>
                  {talk.tool && !toolReady ? <div className="ofis-hint-text">{t(talk.tool === 'claude' ? 'office.settings.tool.signedOut' : 'office.settings.tool.off', { tool: TALK_TOOL_NAME[talk.tool] })}</div> : null}
                </div>
                {talk.tool && toolReady ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }} data-ofis-models>
                    <span className="ofis-small-label">{t('office.settings.model')}</span>
                    {!models ? (
                      <div className="ofis-hint-text">{t('office.settings.model.loading')}</div>
                    ) : models.models.length ? (
                      <div className="ofis-tools">
                        <button type="button" className="ofis-tool" aria-pressed={talk.model === null} onClick={() => talk.change({ model: null })} data-ofis-model="">
                          {t(talk.tool === 'claude' ? 'office.settings.model.quick' : 'office.settings.model.loaded')}
                        </button>
                        {models.models.map((name) => (
                          <button key={name} type="button" className="ofis-tool" aria-pressed={talk.model === name} onClick={() => talk.change({ model: name })} title={name} data-ofis-model={name}>
                            {models.loaded.includes(name) ? <i style={{ background: '#5BD77A' }} /> : null}
                            <span className="ofis-model-name">{name}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="ofis-hint-text">{t('office.settings.model.none')}</div>
                    )}
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span className="ofis-small-label">{t('office.settings.every')}</span>
                  <div className="ofis-segments">
                    {TALK_EVERY.map((minutes) => (
                      <button key={minutes} type="button" aria-pressed={talk.every === minutes} onClick={() => talk.change({ every: minutes })}>
                        {t('office.settings.minutes', { count: minutes })}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" className="ofis-cta" disabled={writing || !toolReady} onClick={() => void writeTalk()} data-ofis-talk>
                  {t(writing ? 'office.settings.writing' : 'office.settings.now')}
                </button>
                {lastTalk ? <div className="ofis-hint-text">{lastTalk}</div> : null}
              </div>
            ) : null}
            <div className="ofis-row ofis-sep">
              <span style={{ fontWeight: 700 }}>{t('office.settings.light')}</span>
              <button type="button" role="switch" aria-checked={prefs.followClock} className="ofis-switch" onClick={() => change({ followClock: !prefs.followClock })}>
                <span />
              </button>
            </div>
          </div>
        ) : null}

        {card ? (
          <div className="ofis-panel ofis-card" data-ofis-card={selected}>
            <div className="ofis-row">
              <span className="ofis-label">{cardLabel}</span>
              <button
                type="button"
                className="ofis-close"
                title={t('office.close')}
                onClick={() => {
                  engineRef.current?.select(null);
                  setSelected(null);
                }}
              >
                ×
              </button>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div className="ofis-portrait">
                <canvas ref={portraitRef} width={56} height={80} style={{ width: 56, height: 80 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                <div className="ofis-name" style={{ color: onPaper(card.color) }}>
                  {card.name}
                </div>
                <div className="ofis-dim" style={{ fontSize: 13 }}>
                  {language === 'en' ? card.roleEn : card.role}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.35, textWrap: 'pretty' }}>
                  {agent?.mood ?? '🙂'} {agent?.act ?? ''}
                </div>
              </div>
            </div>
            {card.tool ? (
              <div className="ofis-tool-line">
                <i style={{ background: LED_COLOR[leds[card.tool]] }} />
                <span>{t('office.card.tool', { tool: TOOL_NAME[card.tool], status: t(ledWord[leds[card.tool]]) })}</span>
              </div>
            ) : null}
            <div className="ofis-bio">{card.bio}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bars.map(([label, value, color]) => (
                <div key={label} className="ofis-bar">
                  <span>{t(label)}</span>
                  <div className="ofis-bar-track">
                    <div style={{ width: `${value}%`, background: color }} />
                  </div>
                  <span>{value}</span>
                </div>
              ))}
            </div>
            <div className="ofis-today">
              <span className="ofis-dim" style={{ fontSize: 10, letterSpacing: '0.16em' }}>
                {t('office.today')}
              </span>
              <div>
                <Icon name="note" title={t('office.today.notes')} />
                <span>{agent?.cnt.notes ?? 0}</span>
              </div>
              <div>
                <Icon name="speech" title={t('office.today.talks')} />
                <span>{agent?.cnt.talks ?? 0}</span>
              </div>
              <div>
                <Icon name="file" title={t('office.today.files')} />
                <span>{agent?.cnt.files ?? 0}</span>
              </div>
            </div>
          </div>
        ) : null}

        {room && roomDef ? (
          <div className="ofis-panel ofis-room" data-ofis-room={room}>
            <div className="ofis-row">
              <span className="ofis-room-title">{language === 'en' ? roomDef.en : roomDef.tr}</span>
              <button
                type="button"
                className="ofis-close"
                title={t('office.close')}
                onClick={() => {
                  if (engineRef.current) engineRef.current.room = null;
                  setRoom(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="ofis-preview">
              <canvas
                ref={(canvas) => {
                  if (canvas === previewRef.current) return;
                  previewRef.current = canvas;
                  engineRef.current?.setPreview(canvas && room ? canvas : null, room);
                }}
                width={544}
                height={300}
                className="ofis-pixel"
              />
            </div>
            <div style={{ fontSize: 13, fontWeight: 700 }} data-ofis-room-status>
              {roomStatus(room, people.length)}
            </div>
            <div className="ofis-dim" style={{ fontSize: 11, letterSpacing: '0.16em' }}>
              {t('office.room.inside', { count: people.length })}
            </div>
            {people.length ? null : <div className="ofis-dim" style={{ fontSize: 12 }}>{t('office.room.empty')}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {people.map((one) => (
                <div key={one.id} className="ofis-person">
                  <i style={{ background: art.CHARACTERS[one.id].color }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 700 }}>{art.CHARACTERS[one.id].name}</span> <span className="ofis-dim">{one.act}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="ofis-hint" style={{ opacity: hint ? 1 : 0 }}>
          {t('office.hint')}
        </div>

        <div className="ofis-zoom">
          {tip ? <div className="ofis-tip">{tip}</div> : null}
          <div className="ofis-zoom-buttons">
            {(
              [
                ['+', 'office.zoom.in', () => engineRef.current?.zoomAt(1.25)],
                ['−', 'office.zoom.out', () => engineRef.current?.zoomAt(0.8)],
                ['⤢', full ? 'office.zoom.fullOff' : 'office.zoom.full', () => setFull(!full)],
                ['Aa', prefs.pixel ? 'office.font.readable' : 'office.font.pixel', () => change({ pixel: !prefs.pixel })],
              ] as const
            ).map(([glyph, words, run]) => (
              <button
                key={glyph}
                type="button"
                aria-label={t(words)}
                onMouseEnter={() => setTip(t(words))}
                onMouseLeave={() => setTip(null)}
                onClick={() => {
                  run();
                  setHint(false);
                  setTip(null);
                }}
                style={glyph === 'Aa' ? { fontSize: 11 } : glyph === '⤢' ? { fontSize: 13 } : undefined}
              >
                {glyph}
              </button>
            ))}
          </div>
        </div>

        {full ? log : null}
      </div>

      {full ? null : (
        <>
          <div className="ofis-chips" data-ofis-chips>
            {Object.entries(art.CHARACTERS).map(([id, character]) => {
              const act = byId[id]?.act ?? '';
              return (
                <button key={id} type="button" className="ofis-chip" aria-pressed={selected === id} onClick={() => pickCharacter(id)} data-ofis-chip={id}>
                  <i style={{ background: character.color }} />
                  <span style={{ fontWeight: 700 }}>{character.name}</span>
                  <span className="ofis-chip-mood">{byId[id]?.mood ?? '🙂'}</span>
                  <span className="ofis-dim" title={act}>{act.length > 12 ? `${act.slice(0, 11)}…` : act}</span>
                </button>
              );
            })}
          </div>
          <div className="ofis-grip" title={t('office.resize')} onMouseDown={startResize}>
            <span />
          </div>
          {log}
        </>
      )}
    </div>
  );
}

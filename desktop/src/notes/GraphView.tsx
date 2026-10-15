import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { foldForMatch, withoutIcon } from '../../core/titles';
import { vaultGraph, type GraphNode, type GraphOptions } from '../../core/vaultNotes';
import { useT } from '../i18n/useT';
import type { Key } from '../i18n';
import { useActiveTab, useNotes } from './notesStore';

/**
 * The vault as a graph, as Obsidian draws one: a note a point, a link a line,
 * the points pulled together by their links and apart by each other (d3-force,
 * ISC). Drawn on a canvas, which keeps a vault of thousands of notes moving;
 * dragged to pan, wheeled to zoom, a point dragged to place it, hovered to see
 * what it touches, clicked to open it. The whole vault on its own view, and
 * the notes around the one in front, a link or two away, beside it.
 *
 * Points take a colour from their top folder, so a vault's parts read as
 * regions; a name linked to and not yet written is hollow, a tag a small green
 * point, as the person chooses to show them.
 */

interface Point extends SimulationNodeDatum, GraphNode {
  r: number;
  color: string;
}

type Line = SimulationLinkDatum<Point>;

/** The colours the palette has, in an order where neighbours differ. */
const COLOURS = ['#3f6670', '#7a6a9e', '#a8761f', '#5c6b4a', '#b4472f', '#4f7d96', '#8c5a7a', '#6f7d3f', '#9a6b4f', '#56524c'];

function colourOf(node: GraphNode, folders: Map<string, string>): string {
  if (node.kind === 'tag') return '#5c6b4a';
  if (node.kind === 'missing') return '#a5a198';
  if (node.kind === 'file') return '#a5a198';
  const top = node.id.includes('/') ? node.id.slice(0, node.id.indexOf('/')) : '';
  return folders.get(top) ?? '#56524c';
}

export interface GraphSettings extends Omit<GraphOptions, 'around'> {
  labels: boolean;
}

// Receipts are many and each is linked only from its day: left out of the vault's graph until asked for, drawn around a note (a day shows its own).
const DEFAULTS: GraphSettings = { depth: 1, orphans: true, missing: false, tags: false, files: false, receipts: false, labels: true };
const LOCAL: Partial<GraphSettings> = { orphans: false, receipts: true };

function useSettings(local: boolean): [GraphSettings, (next: GraphSettings) => void] {
  const key = `cortex.notes.graph.${local ? 'local' : 'vault'}`;
  const [settings, setSettings] = useState<GraphSettings>(() => {
    try {
      return { ...DEFAULTS, ...(local ? LOCAL : {}), ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<GraphSettings>) };
    } catch {
      return { ...DEFAULTS, ...(local ? LOCAL : {}) };
    }
  });
  return [
    settings,
    (next) => {
      setSettings(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* for this run */
      }
    },
  ];
}

/** How far the view goes toward where it is headed in one frame: a zoom and a fit glide there; a pan follows the pointer as it is. */
const GLIDE = 0.24;
/** How much of the light a hovered point casts on what it touches comes or goes in one frame: about a tenth of a second either way. */
const FADE = 0.18;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 4;

interface View {
  x: number;
  y: number;
  k: number;
}

const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

/** A line's colour part of the way from the resting grey to the hovered violet. */
function lineColour(lit: number, alpha: number): string {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * lit);
  return `rgba(${mix(165, 122)},${mix(161, 106)},${mix(152, 158)},${alpha})`;
}

export function GraphView({ local = false, visible = true }: { local?: boolean; visible?: boolean }) {
  const t = useT();
  const index = useNotes((state) => state.index);
  const live = useNotes((state) => state.live);
  const front = useActiveTab().path;
  const [settings, setSettings] = useSettings(local);
  const [filter, setFilter] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Where the view is drawn, and where it is headed: a zoom or a fit moves the goal, and each frame takes the view part of the way.
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const goal = useRef<View>({ x: 0, y: 0, k: 1 });
  // The canvas's size in CSS pixels, read when its box changes and not at every frame: reading it makes the browser lay the page out again.
  const size = useRef({ width: 0, height: 0 });
  const hover = useRef<Point | null>(null);
  // The point whose neighbours are lit, kept while its light fades out, and how lit they are, from 0 to 1.
  const light = useRef<{ point: Point | null; amount: number }>({ point: null, amount: 0 });
  const sim = useRef<Simulation<Point, Line> | null>(null);
  const frame = useRef(0);
  const shown = useRef(visible);
  shown.current = visible;
  /** Draws the graph as it is now; true while something is still on its way (the view to its goal, a light coming or going). */
  const paint = useRef<() => boolean>(() => false);
  const touched = useRef(false);

  /**
   * One drawing in the next frame, however often it is asked for before it:
   * the simulation's tick, a wheel and a pointer moving in the same frame are
   * drawn once, at the screen's own pace. Asked again while something moves.
   */
  const redraw = useRef(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (paint.current()) redraw();
    });
  }).current;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const measure = () => {
    const element = canvas.current;
    if (!element) return size.current;
    const { width, height } = element.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    size.current = { width, height };
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
    }
    return size.current;
  };

  const around = local ? live?.path ?? front ?? null : null;
  const nameIcons = useNotes((state) => state.nameIcons);
  const graph = useMemo(() => {
    if (!index) return { nodes: [], edges: [] };
    const built = vaultGraph(index.notes, index.files.map((file) => file.path), { ...settings, around });
    // Names as the tree shows them: without the emoji they start with, unless those are asked for.
    return nameIcons ? built : { ...built, nodes: built.nodes.map((node) => (node.kind === 'tag' ? node : { ...node, label: withoutIcon(node.label) })) };
  }, [index, settings, around, nameIcons]);

  // The graph's shape, so that a save which changed no link does not stir the drawing.
  const shape = useMemo(() => `${graph.nodes.map((node) => `${node.id}:${node.degree}`).join('\n')}|${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join('\n')}`, [graph]);
  const current = useRef(graph);
  current.current = graph;

  const folders = useMemo(() => {
    const tops = [...new Set((index?.notes ?? []).map((note) => (note.path.includes('/') ? note.path.slice(0, note.path.indexOf('/')) : '')))].sort();
    return new Map(tops.map((top, at) => [top, COLOURS[at % COLOURS.length]]));
  }, [index]);

  /** The view that shows every point, with a margin around them. */
  const fitted = (): View | null => {
    const nodes = sim.current?.nodes() ?? [];
    const { width, height } = size.current.width ? size.current : measure();
    if (!nodes.length || !width || !height) return null;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const w = Math.max(...xs) - Math.min(...xs) + 80;
    const h = Math.max(...ys) - Math.min(...ys) + 80;
    const k = clampZoom(Math.min(2, Math.min(width / w, height / h)));
    return { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k };
  };

  // The simulation, made again when what is drawn changes; points already placed keep their place.
  useEffect(() => {
    const graph = current.current;
    const before = new Map((sim.current?.nodes() ?? []).map((node) => [node.id, node]));
    sim.current?.stop();
    const nodes: Point[] = graph.nodes.map((node) => {
      const had = before.get(node.id);
      return { ...node, x: had?.x, y: had?.y, vx: had?.vx, vy: had?.vy, r: (node.kind === 'tag' ? 2.5 : 3.2) + Math.sqrt(node.degree) * 1.6, color: colourOf(node, folders) };
    });
    const lines: Line[] = graph.edges.map((edge) => ({ source: edge.source, target: edge.target }));
    const simulation = forceSimulation<Point, Line>(nodes)
      .force('link', forceLink<Point, Line>(lines).id((node) => node.id).distance(local ? 46 : 60).strength(0.5))
      .force('charge', forceManyBody<Point>().strength(local ? -140 : -110).distanceMax(420))
      .force('collide', forceCollide<Point>((node) => node.r + 3))
      .force('x', forceX<Point>(0).strength(0.04))
      .force('y', forceY<Point>(0).strength(0.04))
      .force('center', forceCenter(0, 0))
      .alphaDecay(0.045)
      .stop();
    sim.current = simulation;
    if (before.size) {
      simulation.alpha(0.4);
    } else {
      /*
        The first layout is worked out before anything is drawn, and the view
        fitted to it at once: the points do not burst out of the middle, and
        the view does not jump after them once they settle. Fewer steps for a
        large vault, where each step costs more; it settles on screen from there.
      */
      simulation.tick(Math.min(160, Math.max(30, Math.round(40_000 / Math.max(1, nodes.length)))));
      const fit = touched.current ? null : fitted();
      if (fit) {
        view.current = { ...fit };
        goal.current = { ...fit };
      }
    }
    // Made again around points already placed (a filter, another note in front): the view glides to the new layout once it has mostly settled, unless the person has moved it.
    let refit = before.size > 0 && !touched.current;
    simulation
      .on('tick', () => {
        if (refit && simulation.alpha() < 0.08) {
          refit = false;
          const to = touched.current ? null : fitted();
          if (to) goal.current = to;
        }
        redraw();
      })
      .restart();
    redraw();
    return () => {
      simulation.stop();
    };
    // `fitted` and `redraw` read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, folders, local]);

  // What is drawn: lines, points, names. Made again when what it shows changes; called by `redraw`, never straight from an event.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const query = foldForMatch(filter.trim());
    paint.current = () => {
      // Behind the notes, nothing is drawn; shown again, it is drawn whole (see `visible` below).
      if (!shown.current) return false;
      const ratio = window.devicePixelRatio || 1;
      // Measured again only when the canvas does not fit its box at this density: the window moved to another screen.
      const { width, height } = size.current.width && element.width === Math.round(size.current.width * ratio) ? size.current : measure();
      const v = view.current;
      const g = goal.current;
      const gliding = Math.abs(g.k - v.k) > 0.0005 || Math.abs(g.x - v.x) > 0.25 || Math.abs(g.y - v.y) > 0.25;
      if (gliding) {
        v.k += (g.k - v.k) * GLIDE;
        v.x += (g.x - v.x) * GLIDE;
        v.y += (g.y - v.y) * GLIDE;
      } else {
        view.current = { ...g };
      }
      const lit = light.current;
      if (hover.current) {
        lit.point = hover.current;
        lit.amount = Math.min(1, lit.amount + FADE);
      } else {
        lit.amount = Math.max(0, lit.amount - FADE);
        if (!lit.amount) lit.point = null;
      }
      const fading = hover.current ? lit.amount < 1 : lit.amount > 0;
      const { x, y, k } = view.current;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(width / 2 + x, height / 2 + y);
      context.scale(k, k);
      const nodes = sim.current?.nodes() ?? [];
      const lines = (sim.current?.force('link') as ReturnType<typeof forceLink<Point, Line>> | undefined)?.links() ?? [];
      const focus = lit.point;
      const amount = lit.amount;
      const near = new Set<string>();
      if (focus) {
        near.add(focus.id);
        for (const line of lines) {
          const a = line.source as Point;
          const b = line.target as Point;
          if (a.id === focus.id) near.add(b.id);
          if (b.id === focus.id) near.add(a.id);
        }
      }
      // Matched once a drawing, not once a point and a line.
      const matches = query ? new Set(nodes.filter((node) => foldForMatch(node.label).includes(query)).map((node) => node.id)) : null;
      const filtered = (id: string) => matches !== null && !matches.has(id);
      const towards = (from: number, to: number) => from + (to - from) * amount;
      context.lineWidth = 1 / k;
      for (const line of lines) {
        const a = line.source as Point;
        const b = line.target as Point;
        const onFocus = focus !== null && (a.id === focus.id || b.id === focus.id);
        context.strokeStyle = onFocus ? lineColour(amount, towards(0.45, 0.85)) : lineColour(0, focus ? towards(0.45, 0.15) : 0.45);
        context.beginPath();
        context.moveTo(a.x ?? 0, a.y ?? 0);
        context.lineTo(b.x ?? 0, b.y ?? 0);
        context.stroke();
      }
      for (const node of nodes) {
        const isFront = node.id === around || node.id === front;
        context.globalAlpha = filtered(node.id) ? 0.18 : focus && !near.has(node.id) ? towards(1, 0.18) : 1;
        context.beginPath();
        context.arc(node.x ?? 0, node.y ?? 0, node.r, 0, Math.PI * 2);
        if (node.kind === 'missing') {
          context.strokeStyle = node.color;
          context.lineWidth = 1.2 / k;
          context.stroke();
        } else {
          context.fillStyle = isFront ? '#1b1712' : node.color;
          context.fill();
        }
        if (isFront) {
          context.strokeStyle = '#1b1712';
          context.lineWidth = 2 / k;
          context.beginPath();
          context.arc(node.x ?? 0, node.y ?? 0, node.r + 3 / k, 0, Math.PI * 2);
          context.stroke();
        }
      }
      // Names where there is room for them: everything zoomed in, the hovered and its neighbours always.
      if (settings.labels) {
        context.textAlign = 'center';
        context.textBaseline = 'top';
        const fontSize = 11 / Math.max(k, 0.6);
        context.font = `${fontSize}px "Schibsted Grotesk Variable", system-ui, sans-serif`;
        context.fillStyle = '#433f39';
        for (const node of nodes) {
          const touching = focus !== null && near.has(node.id);
          const show = k > 1.1 || touching || node.id === around || (k > 0.7 && node.degree > 3) || nodes.length < 40;
          if (!show || filtered(node.id)) continue;
          context.globalAlpha = focus && !touching ? towards(0.9, 0.2) : 0.9;
          context.fillText(node.label.length > 40 ? `${node.label.slice(0, 38)}…` : node.label, node.x ?? 0, (node.y ?? 0) + node.r + 3);
        }
      }
      context.globalAlpha = 1;
      return gliding || fading;
    };
    redraw();
    // `redraw` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, settings.labels, around, front]);

  // Its box resized - a side panel folded, the window resized - it is measured again and drawn.
  useEffect(() => {
    if (!box.current) return;
    const watcher = new ResizeObserver(() => {
      measure();
      redraw();
    });
    watcher.observe(box.current);
    return () => watcher.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) redraw();
  }, [visible, redraw]);

  // The pointer: drag the background to pan, a point to move it, the wheel to zoom, a click to open.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const toWorld = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      const { x, y, k } = view.current;
      return { x: (event.clientX - rect.left - rect.width / 2 - x) / k, y: (event.clientY - rect.top - rect.height / 2 - y) / k };
    };
    const pick = (event: { clientX: number; clientY: number }) => {
      const at = toWorld(event);
      let best: Point | null = null;
      let distance = Infinity;
      for (const node of sim.current?.nodes() ?? []) {
        const d = Math.hypot((node.x ?? 0) - at.x, (node.y ?? 0) - at.y);
        if (d < node.r + 5 / view.current.k && d < distance) {
          best = node;
          distance = d;
        }
      }
      return best;
    };
    let drag: { node: Point | null; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null = null;
    const down = (event: PointerEvent) => {
      touched.current = true;
      element.setPointerCapture(event.pointerId);
      // A glide under way stops where it is: the pointer takes the view from there.
      goal.current = { ...view.current };
      const node = pick(event);
      drag = { node, startX: event.clientX, startY: event.clientY, moved: false, viewX: view.current.x, viewY: view.current.y };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
        sim.current?.alphaTarget(0.25).restart();
      }
    };
    const move = (event: PointerEvent) => {
      if (!drag) {
        const node = pick(event);
        if (node !== hover.current) {
          hover.current = node;
          element.style.cursor = node ? 'pointer' : 'grab';
          redraw();
        }
        return;
      }
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
      if (drag.node) {
        const at = toWorld(event);
        drag.node.fx = at.x;
        drag.node.fy = at.y;
      } else {
        const x = drag.viewX + event.clientX - drag.startX;
        const y = drag.viewY + event.clientY - drag.startY;
        view.current = { ...view.current, x, y };
        goal.current = { ...view.current };
        redraw();
      }
    };
    const up = (event: PointerEvent) => {
      if (!drag) return;
      const { node, moved } = drag;
      drag = null;
      if (node) {
        node.fx = null;
        node.fy = null;
        sim.current?.alphaTarget(0);
        if (!moved && node.kind !== 'tag' && node.kind !== 'missing') useNotes.getState().open(node.id, { newTab: event.ctrlKey || event.metaKey });
        if (!moved && node.kind === 'tag') useNotes.getState().search(`tag:${node.label}`);
      }
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      touched.current = true;
      const rect = element.getBoundingClientRect();
      // A wheel's notch, a touchpad's stroke and a page all as pixels.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * rect.height : event.deltaY;
      const g = goal.current;
      const k = clampZoom(g.k * Math.exp(-delta * 0.0018));
      // Toward the pointer: the point under it stays under it once the glide is done.
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      goal.current = { k, x: px - ((px - g.x) * k) / g.k, y: py - ((py - g.y) * k) / g.k };
      redraw();
    };
    const leave = () => {
      hover.current = null;
      redraw();
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('wheel', wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Zoomed about the middle of the view, gliding there. */
  const zoom = (by: number) => {
    const g = goal.current;
    const k = clampZoom(g.k * by);
    goal.current = { k, x: (g.x * k) / g.k, y: (g.y * k) / g.k };
    redraw();
  };
  const fit = () => {
    const to = fitted();
    if (!to) return;
    goal.current = to;
    redraw();
  };

  const toggles: Array<[keyof GraphSettings, Key]> = local
    ? [
        ['missing', 'notes.graph.missing'],
        ['tags', 'notes.graph.tags'],
        ['files', 'notes.graph.files'],
        ['receipts', 'notes.graph.receipts'],
      ]
    : [
        ['orphans', 'notes.graph.orphans'],
        ['missing', 'notes.graph.missing'],
        ['tags', 'notes.graph.tags'],
        ['files', 'notes.graph.files'],
        ['receipts', 'notes.graph.receipts'],
        ['labels', 'notes.graph.labels'],
      ];

  return (
    <div ref={box} className="relative h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_center,_var(--color-white),_var(--color-zinc-50))]" data-notes-graph={local ? 'local' : 'vault'} data-graph-nodes={graph.nodes.length} data-graph-edges={graph.edges.length}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full cursor-grab touch-none" aria-label={t(local ? 'notes.graph.local' : 'notes.graph.title')} role="img" />
      <div className={`absolute ${local ? 'left-2 top-2' : 'left-4 top-4'} flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5`}>
        {!local ? (
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('notes.graph.filter')}
            className="h-7 w-44 rounded-md border border-zinc-200 bg-white/90 px-2 text-[12px] outline-none placeholder:text-zinc-400 focus:border-zinc-400"
          />
        ) : (
          <label className="flex items-center gap-1 rounded-md bg-white/90 px-1.5 py-0.5 text-[11px] text-zinc-500">
            {t('notes.graph.depth')}
            <select value={settings.depth} onChange={(event) => setSettings({ ...settings, depth: Number(event.target.value) })} className="bg-transparent text-[11px] outline-none">
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {toggles.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={Boolean(settings[key])}
            data-graph-toggle={key}
            onClick={() => setSettings({ ...settings, [key]: !settings[key] })}
            className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${settings[key] ? 'bg-darkDelegation text-white' : 'bg-white/90 text-zinc-500 hover:text-darkDelegation'}`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className={`absolute ${local ? 'bottom-2 right-2' : 'bottom-4 right-4'} flex flex-col gap-1`}>
        {[
          { icon: <Plus size={14} />, run: () => zoom(1.25), label: 'notes.graph.zoomIn' as Key },
          { icon: <Minus size={14} />, run: () => zoom(0.8), label: 'notes.graph.zoomOut' as Key },
          { icon: <Maximize2 size={13} />, run: fit, label: 'notes.graph.fit' as Key },
        ].map((one) => (
          <button key={one.label} type="button" onClick={one.run} title={t(one.label)} className="rounded-md border border-zinc-200 bg-white/90 p-1.5 text-zinc-500 hover:text-darkDelegation">
            {one.icon}
          </button>
        ))}
      </div>
      {!graph.nodes.length ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-zinc-400">{t(local ? 'notes.graph.localEmpty' : 'notes.graph.empty')}</p>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { foldForMatch } from '../../core/titles';
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

const DEFAULTS: GraphSettings = { depth: 1, orphans: true, missing: false, tags: false, files: false, labels: true };

function useSettings(local: boolean): [GraphSettings, (next: GraphSettings) => void] {
  const key = `cortex.notes.graph.${local ? 'local' : 'vault'}`;
  const [settings, setSettings] = useState<GraphSettings>(() => {
    try {
      return { ...DEFAULTS, ...(local ? { orphans: false } : {}), ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<GraphSettings>) };
    } catch {
      return { ...DEFAULTS, ...(local ? { orphans: false } : {}) };
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

export function GraphView({ local = false, visible = true }: { local?: boolean; visible?: boolean }) {
  const t = useT();
  const index = useNotes((state) => state.index);
  const live = useNotes((state) => state.live);
  const front = useActiveTab().path;
  const [settings, setSettings] = useSettings(local);
  const [filter, setFilter] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef<Point | null>(null);
  const sim = useRef<Simulation<Point, Line> | null>(null);
  const draw = useRef<() => void>(() => undefined);
  // Fitted to its box once the first layout has settled, unless the person moved the view first.
  const fitLater = useRef<() => void>(() => undefined);
  const touched = useRef(false);
  const fitted = useRef(false);
  const [tick, setTick] = useState(0);

  const around = local ? live?.path ?? front ?? null : null;
  const graph = useMemo(() => {
    if (!index) return { nodes: [], edges: [] };
    return vaultGraph(index.notes, index.files.map((file) => file.path), { ...settings, around });
  }, [index, settings, around]);

  // The graph's shape, so that a save which changed no link does not stir the drawing.
  const shape = useMemo(() => `${graph.nodes.map((node) => `${node.id}:${node.degree}`).join('\n')}|${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join('\n')}`, [graph]);
  const current = useRef(graph);
  current.current = graph;

  const folders = useMemo(() => {
    const tops = [...new Set((index?.notes ?? []).map((note) => (note.path.includes('/') ? note.path.slice(0, note.path.indexOf('/')) : '')))].sort();
    return new Map(tops.map((top, at) => [top, COLOURS[at % COLOURS.length]]));
  }, [index]);

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
      .on('tick', () => {
        // Fitted once, as the first layout settles, and left to the person after that.
        if (!fitted.current && !touched.current && simulation.alpha() < 0.08) {
          fitted.current = true;
          fitLater.current();
        }
        draw.current();
      });
    if (before.size) simulation.alpha(0.4);
    sim.current = simulation;
    return () => {
      simulation.stop();
    };
  }, [shape, folders, local]);

  // Drawn on every tick and every change of view; sized to its box at the screen's density.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;
    const query = foldForMatch(filter.trim());
    draw.current = () => {
      const ratio = window.devicePixelRatio || 1;
      const { width, height } = element.getBoundingClientRect();
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      const { x, y, k } = view.current;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(width / 2 + x, height / 2 + y);
      context.scale(k, k);
      const nodes = sim.current?.nodes() ?? [];
      const lines = (sim.current?.force('link') as ReturnType<typeof forceLink<Point, Line>> | undefined)?.links() ?? [];
      const focus = hover.current;
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
      const dim = (id: string) => (focus && !near.has(id)) || (query && !foldForMatch(nodes.find((n) => n.id === id)?.label ?? '').includes(query));
      context.lineWidth = 1 / k;
      for (const line of lines) {
        const a = line.source as Point;
        const b = line.target as Point;
        const lit = focus && (a.id === focus.id || b.id === focus.id);
        context.strokeStyle = lit ? 'rgba(122,106,158,0.85)' : focus ? 'rgba(165,161,152,0.15)' : 'rgba(165,161,152,0.45)';
        context.beginPath();
        context.moveTo(a.x ?? 0, a.y ?? 0);
        context.lineTo(b.x ?? 0, b.y ?? 0);
        context.stroke();
      }
      for (const node of nodes) {
        const faded = dim(node.id);
        const isFront = node.id === around || node.id === front;
        context.globalAlpha = faded ? 0.18 : 1;
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
        const size = 11 / Math.max(k, 0.6);
        context.font = `${size}px "Schibsted Grotesk Variable", system-ui, sans-serif`;
        for (const node of nodes) {
          const show = k > 1.1 || near.has(node.id) || node.id === around || (k > 0.7 && node.degree > 3) || nodes.length < 40;
          if (!show || dim(node.id)) continue;
          context.globalAlpha = focus && !near.has(node.id) ? 0.2 : 0.9;
          context.fillStyle = '#433f39';
          context.fillText(node.label.length > 40 ? `${node.label.slice(0, 38)}…` : node.label, node.x ?? 0, (node.y ?? 0) + node.r + 3);
        }
      }
      context.globalAlpha = 1;
    };
    draw.current();
  }, [filter, settings.labels, around, front, tick]);

  // Redrawn when its box changes size: a side panel folded, the window resized.
  useEffect(() => {
    if (!box.current) return;
    const watcher = new ResizeObserver(() => draw.current());
    watcher.observe(box.current);
    return () => watcher.disconnect();
  }, []);

  useEffect(() => {
    if (visible) setTick((n) => n + 1);
  }, [visible]);

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
          draw.current();
        }
        return;
      }
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
      if (drag.node) {
        const at = toWorld(event);
        drag.node.fx = at.x;
        drag.node.fy = at.y;
      } else {
        view.current.x = drag.viewX + event.clientX - drag.startX;
        view.current.y = drag.viewY + event.clientY - drag.startY;
        draw.current();
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
      const before = view.current.k;
      const k = Math.min(4, Math.max(0.15, before * Math.exp(-event.deltaY * 0.0015)));
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      view.current.x = px - ((px - view.current.x) * k) / before;
      view.current.y = py - ((py - view.current.y) * k) / before;
      view.current.k = k;
      draw.current();
    };
    const leave = () => {
      hover.current = null;
      draw.current();
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
  }, []);

  const zoom = (by: number) => {
    view.current.k = Math.min(4, Math.max(0.15, view.current.k * by));
    draw.current();
  };
  const fit = () => {
    const nodes = sim.current?.nodes() ?? [];
    const rect = canvas.current?.getBoundingClientRect();
    if (!nodes.length || !rect) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const w = Math.max(...xs) - Math.min(...xs) + 80;
    const h = Math.max(...ys) - Math.min(...ys) + 80;
    const k = Math.min(2, Math.max(0.15, Math.min(rect.width / w, rect.height / h)));
    view.current = { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k };
    draw.current();
  };
  fitLater.current = fit;

  const toggles: Array<[keyof GraphSettings, Key]> = local
    ? [
        ['missing', 'notes.graph.missing'],
        ['tags', 'notes.graph.tags'],
        ['files', 'notes.graph.files'],
      ]
    : [
        ['orphans', 'notes.graph.orphans'],
        ['missing', 'notes.graph.missing'],
        ['tags', 'notes.graph.tags'],
        ['files', 'notes.graph.files'],
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

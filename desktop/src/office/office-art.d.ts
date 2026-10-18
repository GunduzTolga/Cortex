/**
 * The types of office-art.js, the office's drawings as Claude Design made
 * them (docs/ofis/claude-design-brifi.md, section 9): what the window and the
 * engine read of it. The module itself is plain JavaScript, kept as it was
 * delivered so a new delivery can replace it whole.
 */

export type ToolId = 'claude' | 'codex' | 'opencode' | 'gemini' | 'qwen';

export interface Sprite {
  w: number;
  h: number;
  ax?: number;
  ay?: number;
  layer?: 'floor' | 'sorted' | 'wall' | 'top';
  solid?: [number, number, number, number] | null;
  frames?: number;
  fps?: number;
  light?: { x: number; y: number; r: number; color: string };
  paint(ctx: CanvasRenderingContext2D, frame: number, pal: Record<string, unknown>, ox?: number, oy?: number): void;
}

export interface Character {
  name: string;
  role: string;
  roleEn: string;
  tool: ToolId | null;
  /** The colour it is named in: its chip, its lines in the log. */
  color: string;
  /** Pyn, the manager (named after the vault's owner), Tolga the developer, the cat; an agent has none. */
  kind?: 'pyn' | 'cat' | 'mudur' | 'dev';
  /** CORTEX · AJAN, CORTEX · PATRON, CORTEX · OFİS KEDİSİ. */
  label: string;
  home?: string;
  bio: string;
  /** Tea, food and energy run down slowly and never low: Tolga's. */
  hardy?: boolean;
}

export interface Room {
  id: string;
  tr: string;
  en: string;
  x: number;
  y: number;
  w: number;
  h: number;
  face: string;
  faceY: number;
  doors: Array<[number, number]>;
}

export interface Placed {
  id: string;
  sprite: string;
  x: number;
  y: number;
  left: number;
  top: number;
  flip?: boolean;
  z?: number;
  tool?: ToolId;
}

export interface Seat {
  id: string;
  x: number;
  y: number;
  px: number;
  py: number;
  dir: 'down' | 'up' | 'side' | 'left';
  object?: string;
  from?: [number, number];
}

export interface Spot {
  id: string;
  x: number;
  y: number;
  dir?: string;
  room?: string;
}

export const TILE: number;
export const SPRITES: Record<string, Sprite>;
export const ICONS: Record<string, Sprite>;
export const ITEMS: Record<string, Sprite>;
export const CHARACTERS: Record<string, Character>;
export const POSES: Record<string, { frames: number; fps: number; dirs: string[] }>;
export const CAT_POSES: Record<string, { frames: number; fps: number; dirs: string[] }>;
export const TOOL_COLORS: Record<ToolId, string>;
export const LED: { ok: string; wait: string; off: string };

export function paintCharacter(ctx: CanvasRenderingContext2D, id: string, pose: string, dir: string, frame: number, ox?: number, oy?: number): void;
export function anchors(id: string, pose: string, dir: string, frame: number): { hand: [number, number]; head: [number, number] };
export function cellOf(id: string): { w: number; h: number; footX: number; footY: number };

export const MAP: {
  w: number;
  h: number;
  tile: number;
  floor: string[];
  walls: string[];
  rooms: Room[];
  objects: Placed[];
  seats: Seat[];
  spots: Spot[];
  lights: Array<{ x: number; y: number; r: number; color: string; kind?: string }>;
};

export function tileSprites(x: number, y: number): string[];
export function roomAt(tx: number, ty: number): string | null;
export function buildCollision(): { w: number; h: number; blocked: Uint8Array; isBlocked(x: number, y: number): boolean };
/** The seats and spots that cannot be walked to from the newsroom: empty when the map is right. */
export function checkReachability(): string[];

/** The brain around the map (docs/ofis: ek brif "Cortex Ofisi: beynin içindeki ofis"). */
export type LightMode = 'sabah' | 'ogle' | 'aksam' | 'gece';
export type RoomId = 'pyn' | 'harita' | 'arsiv' | 'mudur' | 'salon' | 'mutfak' | 'toplanti' | 'sunucu' | 'dinlenme';
export const BRAIN: {
  /** The frame around the map, in pixels, multiples of 16. */
  margin: { top: number; right: number; bottom: number; left: number };
  /** The framed world: the map and its margins. */
  w: number;
  h: number;
  /** Where the map sits in the framed world. */
  map: { x: number; y: number; w: number; h: number };
  /** Where a room's sparks leave from; each is the first point of one of NEURON_PATHS. */
  anchors: Record<RoomId, [number, number]>;
};
/** The brain's eight tones in each light: outline, sulcus, deep shade, shade, body, light, bright, cerebellum. */
export const BRAIN_PALETTES: Record<LightMode, string[]>;
/** Paints the frame from (0,0), BRAIN.w × BRAIN.h; the map's rectangle is left untouched. */
export function paintBrain(ctx: CanvasRenderingContext2D, mode: LightMode): void;
/** The sparks' paths along the folds' middles (hopping a groove where a fold ends), in the frame's coordinates, 4–12 points each, straight between points. */
export const NEURON_PATHS: Array<Array<[number, number]>>;

/**
 * The types of ofis-engine.js, the office's engine as Claude Design's
 * prototype wrote it, taken into the app (see its head): what the window
 * drives of it.
 */

import type * as Art from './office-art.js';

export type LightMode = 'sabah' | 'ogle' | 'aksam' | 'gece';
export type Led = 'ok' | 'wait' | 'off';

export const LIGHT_MODES: Array<[LightMode, string]>;
export function lightForHour(hour: number): LightMode;
export function clockText(date?: Date): string;
export function loopFrame(t: number, fps: number, frames: number, offset?: number): number;
export const TOOL_STATUS: Record<Art.ToolId, Led>;
export const TOOL_LABEL: Record<Led, string>;

export interface AgentSnapshot {
  id: string;
  act: string;
  mood: string;
  room: string | null;
  needs: { tea: number; food: number; energy: number };
  cnt: { notes: number; talks: number; files: number };
  walking: boolean;
}

export interface LogEntry {
  time: string;
  icon: string | null;
  text: string;
  color: string | null;
  /** The character who said it, for a line of talk. */
  who?: string;
}

export interface EngineCallbacks {
  onSnapshot?(snapshot: AgentSnapshot[]): void;
  onLog?(entry: LogEntry): void;
  onSelect?(id: string | null): void;
  onRoom?(id: string | null): void;
  onHover?(id: string | null): void;
  onInteract?(): void;
}

export class OfficeEngine {
  constructor(canvas: HTMLCanvasElement, art: typeof Art, callbacks?: EngineCallbacks);
  mode: LightMode;
  /** The face the canvas writes in: room names, bubbles, name tags. */
  font: string;
  /** The language the map's room names are written in. */
  lang: 'tr' | 'en';
  speed: number;
  room: string | null;
  led: Record<Art.ToolId, Led>;
  resize(fit?: boolean): void;
  select(id: string | null): void;
  focus(id: string): void;
  zoomAt(factor: number, clientX?: number, clientY?: number): void;
  setPreview(canvas: HTMLCanvasElement | null, roomId: string | null): void;
  triggerConvo(): void;
  snapshot(): AgentSnapshot[];
  setActive(on: boolean): void;
  setLeds(led: Partial<Record<Art.ToolId, Led>>): void;
  destroy(): void;
}

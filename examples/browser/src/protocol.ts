import type { LogEvent, Role, TextrudeOptions, UsedFont } from 'textrude';

/** Options passed straight through to `textrude()`. Fonts are sent separately, by key. */
export type RenderOptions = Omit<TextrudeOptions, 'font' | 'fallbackFonts' | 'onLog'>;

export type ExportFormat = '3mf' | 'svg' | 'png';

export interface ExportOptions {
  printer?: string;
  flip?: boolean;
}

export type WorkerRequest =
  /** Make font data available under `key` (fonts with URL keys are fetched on demand). */
  | { type: 'font'; key: string; data: Uint8Array }
  | { type: 'render'; id: number; text: string; font: string; fallbackFonts: string[]; options: RenderOptions }
  | { type: 'export'; id: number; format: ExportFormat; options: ExportOptions };

export interface ModelPart {
  id: string;
  color: string;
  filament: number;
  height: number;
  roles: Role[];
  /** x, y, z per vertex (mm), Z up. */
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Model {
  /** The render request this model came from. */
  id: number;
  text: string;
  parts: ModelPart[];
  width: number;
  depth: number;
  height: number;
  fonts: UsedFont[];
  bridged: { islands: number; bridges: number; remaining: number } | null;
  /** Render time (ms). */
  time: number;
}

export type WorkerResponse =
  | { type: 'rendered'; id: number; model: Model; logs: LogEvent[] }
  | { type: 'error'; id: number; message: string; logs: LogEvent[] }
  | { type: 'exported'; id: number; data: Uint8Array | string; logs: LogEvent[] }
  | { type: 'export-error'; id: number; message: string };

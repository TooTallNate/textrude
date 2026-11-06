import type { LogEvent, Role, TextrudeOptions } from 'textrude';

/** Options passed straight through to `textrude()`. Fonts are sent separately, by key. */
export type RenderOptions = Omit<TextrudeOptions, 'font' | 'fallbackFonts' | 'onLog'>;

export type ExportFormat = '3mf' | 'svg' | 'png';

export interface ExportOptions {
  printer?: string;
  flip?: boolean;
}

/** One text on the plate. */
export interface TextRequest {
  text: string;
  /** Font key (see the "font" request). */
  font: string;
  fallbackFonts: string[];
  options: RenderOptions;
}

export interface RenderRequest {
  texts: TextRequest[];
  /** Space between texts (mm). */
  gap: number;
  /** Start a new row of texts past this width (mm), e.g. the bed width. */
  maxWidth?: number;
  /** Mirror the meshes, as they're printed face-down. */
  flip: boolean;
}

export type WorkerRequest =
  /** Make font data available under `key` (fonts with URL keys are fetched on demand). */
  | { type: 'font'; key: string; data: Uint8Array }
  | ({ type: 'render'; id: number } & RenderRequest)
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
  /** The rendered texts (escape sequences removed). */
  texts: string[];
  /** Every text's parts, in their places on the plate. */
  parts: ModelPart[];
  width: number;
  depth: number;
  height: number;
  /** Render time (ms). */
  time: number;
}

export type WorkerResponse =
  | { type: 'rendered'; id: number; model: Model; logs: LogEvent[] }
  | { type: 'error'; id: number; message: string; logs: LogEvent[] }
  | { type: 'exported'; id: number; data: Uint8Array | string; logs: LogEvent[] }
  | { type: 'export-error'; id: number; message: string };

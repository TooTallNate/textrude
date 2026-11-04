/**
 * The parts of fontkit textrude uses, typed, including a few internals (raw table access,
 * COLR/CPAL records, the glyph cache) that its published typings don't cover. All fontkit
 * objects enter through {@link openFont} / {@link createFont}.
 */
import * as fontkit from 'fontkit';
import type { PathCommand } from './outline.js';

export interface Glyph {
  id: number;
  codePoints: number[];
  path: { commands: PathCommand[] };
  advanceWidth: number;
  _getContours?(): unknown;
}

export interface GlyphPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface GlyphRun {
  glyphs: Glyph[];
  positions: GlyphPosition[];
}

export interface VariationAxis {
  name: string;
  min: number;
  default: number;
  max: number;
}

interface TableEntry {
  offset: number;
  length: number;
}

interface Metric {
  advance: number;
}

export interface Font {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  underlinePosition: number;
  underlineThickness: number;
  xHeight: number;
  italicAngle: number;
  numGlyphs: number;
  fullName: string;
  postscriptName: string;
  familyName: string;
  subfamilyName: string;
  variationAxes: Record<string, VariationAxis>;
  'OS/2'?: {
    usWeightClass?: number;
    fsSelection?: { italic?: boolean; oblique?: boolean };
    yStrikeoutPosition?: number;
    yStrikeoutSize?: number;
  };
  hmtx: { metrics: { length: number; get(i: number): Metric | undefined } };
  COLR: {
    baseGlyphRecord: { gid: number; firstLayerIndex: number; numLayers: number }[];
    layerRecords: { gid: number; paletteIndex: number }[];
  };
  CPAL: {
    colorRecords: { red: number; green: number; blue: number; alpha: number }[];
    colorRecordIndices?: number[];
  };
  directory: { tables: Record<string, TableEntry | undefined> };
  stream: { buffer: Uint8Array };
  getName(key: string): string | null;
  getVariation(settings: Record<string, number>): Font;
  layout(text: string): GlyphRun;
  hasGlyphForCodePoint(codePoint: number): boolean;
  getGlyph(id: number, codePoints?: number[]): Glyph;
  _getBaseGlyph(id: number, codePoints?: number[]): Glyph;
  _glyphs: Record<number, Glyph>;
}

interface Collection {
  fonts: Font[];
}

const pick = (f: Font | Collection, index = 0): Font => ('fonts' in f && Array.isArray(f.fonts) ? f.fonts[index]! : (f as Font));

/** All faces in a font file (one, or several for .ttc/.otc collections). */
export function openFaces(file: string): Font[] {
  const f = fontkit.openSync(file) as unknown as Font | Collection;
  return 'fonts' in f && Array.isArray(f.fonts) ? f.fonts : [f as Font];
}

export function openFont(file: string, index = 0): Font {
  return pick(fontkit.openSync(file) as unknown as Font | Collection, index);
}

export function createFont(data: Uint8Array, index = 0): Font {
  return pick(fontkit.create(Buffer.from(data.buffer, data.byteOffset, data.byteLength)) as unknown as Font | Collection, index);
}

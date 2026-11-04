/**
 * The textrude pipeline: text -> fonts -> layout -> stroke / background / bridges -> colors ->
 * parts, with SVG / 3MF / PNG output.
 */
import { loadFont, resolveStyle, isColorFont, findEmojiFont } from './fonts.js';
import { renderText, type FontChoice, type LayoutOptions } from './layout.js';
import {
  JoinType, SCALE, area, bbox, clean, components, difference, intersection, makeBridges, offset, roundedRect, union,
} from './geometry.js';
import type { Shape } from './types.js';
import { parseColor, toHex, lab, nearestIndex, reduceColors, type RGB } from './colors.js';
import { parseAnsi } from './ansi.js';
import { writeSvg, type SvgOptions } from './svg.js';
import { write3mf } from './threemf.js';
import { renderPng, type PngOptions } from './raster.js';
import { PRINTERS, projectSettings, type PrinterProfile } from './printers.js';
import { TextrudeError } from './errors.js';

/** What a part of the design is. */
export type Role = 'text' | 'color' | 'stroke' | 'bridge' | 'background';

export type LogLevel = 'info' | 'note' | 'success' | 'warn' | 'detail';

export interface LogEvent {
  level: LogLevel;
  message: string;
  /** For "detail" events: what the message describes (e.g. "font"). */
  label?: string;
}

export interface TextrudeOptions {
  // Font
  /** Font name, file path, or URL. Default "Arial". */
  font?: string;
  /** Face index in a .ttc/.otc collection. */
  fontIndex?: number;
  /** Fonts for characters the main font lacks. Emoji also fall back to an installed color emoji font. */
  fallbackFonts?: string[];
  /** Variable font axis settings, e.g. `{ wght: 700 }`. */
  variations?: Record<string, number>;

  // Style
  bold?: boolean;
  italic?: boolean;
  /** Always synthesize bold/italic. */
  synthetic?: boolean;
  /** Thicken outlines by this much per side (mm). Default: 2% of size for synthetic bold. */
  embolden?: number;
  /** Slant in degrees. Default: 12 for synthetic italic. */
  slant?: number;
  underline?: boolean;
  strikethrough?: boolean;
  decorationThickness?: number;
  /** Distance from the baseline to the top of the underline (mm). */
  underlineOffset?: number;

  // Text
  /** Font size (em) in mm. Default 20. */
  size?: number;
  /** Text color, or "none" for hollow text. Default "#000000". */
  color?: string;
  /** Colors cycled per letter. */
  letterColors?: string[];
  align?: 'left' | 'center' | 'right';
  lineSpacing?: number;
  letterSpacing?: number;
  /** Interpret ANSI escape sequences in the text (colors). Default true. */
  ansi?: boolean;

  // Stroke
  /** Outline width (mm). Default 0 (none). */
  strokeWidth?: number;
  /** Default: the background color, else "#ffffff". */
  strokeColor?: string;
  strokeAlign?: 'outside' | 'center' | 'inside';
  strokeJoin?: 'round' | 'miter' | 'square';
  miterLimit?: number;

  // Connecting
  /** Bridge separate pieces into one. */
  connect?: boolean;
  /** Default: the stroke width, else 10% of size. */
  bridgeWidth?: number;
  /** Default: the stroke color, else the text color. */
  bridgeColor?: string;

  // Background
  /** A solid plate behind the design, in this color. */
  background?: string;
  /** Default: 25% of size. */
  backgroundPadding?: number;
  /** Corner radius, clamped like CSS border-radius. Default 0. */
  backgroundRadius?: number;

  // Colors
  /** Filament colors in slot order: every color is mapped to the nearest. */
  palette?: string[];
  /** Merge similar colors until at most this many remain. */
  maxColors?: number;
  /** Colors bitmap emoji are reduced to. Default 8. */
  bitmapColors?: number;

  // Parts
  /** Merge everything into a single part. */
  singlePath?: boolean;
  /** Max curve flattening error (mm). Default 0.01. */
  tolerance?: number;
  /** Part height (mm). Default 2. */
  height?: number;
  textHeight?: number;
  strokeHeight?: number;
  bridgeHeight?: number;
  backgroundHeight?: number;
  textFilament?: number;
  strokeFilament?: number;
  bridgeFilament?: number;
  backgroundFilament?: number;

  /** Progress and diagnostic messages. */
  onLog?: (event: LogEvent) => void;
}

export interface Part {
  /** Name, e.g. "text #000000". */
  id: string;
  roles: Role[];
  /** `#rrggbb` */
  color: string;
  /** Height (mm). */
  height: number;
  /** 1-based filament slot. */
  filament: number;
  shape: Shape;
}

export interface UsedFont {
  name: string;
  /** A color (emoji) font. */
  color: boolean;
  source: 'primary' | 'fallback' | 'emoji';
}

export interface ThreeMfExportOptions {
  /** A built-in printer id (see {@link PRINTERS}) or a custom profile, to embed filament colors. */
  printer?: string | PrinterProfile;
  /** Override the profile's process preset. */
  processPreset?: string;
  /** Override the profile's filament preset. */
  filamentPreset?: string;
  /** Override the profile's bed type. */
  bedType?: string;
  /** Bed position of the object's center (mm). Default: the printer's bed center, else 100,100. */
  position?: [number, number];
  /** Mirror for face-down printing. */
  flip?: boolean;
  /** Object name. Default: the text, without emoji. */
  name?: string;
}

export interface TextrudeResult {
  /** The text that was rendered (escape sequences removed). */
  text: string;
  fonts: UsedFont[];
  parts: Part[];
  /** Set when pieces were bridged together. */
  bridged: { islands: number; bridges: number; remaining: number } | null;
  /** Overall size (mm). */
  width: number;
  depth: number;
  height: number;
  /** One `<path>` per part. */
  toSVG(options?: SvgOptions & { flip?: boolean }): string;
  /** A 3MF with one part per color, each assigned its filament. */
  to3MF(options?: ThreeMfExportOptions): Uint8Array;
  /** A top-down preview image. */
  toPNG(options?: PngOptions): Uint8Array;
}

const JOINS = { round: JoinType.jtRound, miter: JoinType.jtMiter, square: JoinType.jtSquare } as const;

function color(value: string, name: string): RGB | null {
  try {
    return parseColor(value);
  } catch (err) {
    throw new TextrudeError(`${name}: ${(err as Error).message}`);
  }
}

function colorList(values: string[] | undefined, name: string): RGB[] | undefined {
  if (!values) return undefined;
  const colors = values.map((v) => color(v, name));
  if (!colors.length || colors.some((c) => !c)) throw new TextrudeError(`${name}: expected a list of colors`);
  return colors as RGB[];
}

/** Strip emoji (which slicers can't display in names) and collapse whitespace. */
export function plainName(text: string): string {
  return (
    text
      .replace(/\n/g, ' ')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim() || 'textrude'
  );
}

interface Layer {
  role: Role;
  roles?: Role[];
  color: RGB;
  shape: Shape;
  filament?: number;
}

/** Turn text into multi-color geometry for 3D printing. */
export async function textrude(input: string, options: TextrudeOptions = {}): Promise<TextrudeResult> {
  const log = (level: LogLevel, message: string, label?: string) => options.onLog?.({ level, message, label });
  // Library code reports "warning: ..." / "note: ..." strings.
  const libLog = (msg: string) => {
    if (msg.startsWith('warning: ')) log('warn', msg.slice(9));
    else if (msg.startsWith('note: ')) log('note', msg.slice(6));
    else log('info', msg);
  };

  // Text: ANSI escapes become per-character colors; tabs expand to 4 spaces.
  const normalized = input.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const ansi = options.ansi === false ? { text: normalized, colors: [], hasColor: false } : parseAnsi(normalized);
  const text = ansi.text;
  if (!text.trim()) throw new TextrudeError('no text to render');

  const size = options.size ?? 20;
  const tolerance = options.tolerance ?? 0.01;
  const minArea = (tolerance * 2) ** 2;
  const palette = colorList(options.palette, 'palette');
  const o: LayoutOptions = {
    size,
    align: options.align ?? 'left',
    lineSpacing: options.lineSpacing ?? 1,
    letterSpacing: options.letterSpacing ?? 0,
    tolerance,
    embolden: 0,
    slant: 0,
    underline: Boolean(options.underline),
    strikethrough: Boolean(options.strikethrough),
    decorationThickness: options.decorationThickness,
    underlineOffset: options.underlineOffset,
    letterColors: colorList(options.letterColors, 'letterColors'),
    charColors: ansi.hasColor ? ansi.colors : undefined,
    bitmapColors: Math.max(1, Math.round(options.bitmapColors ?? 8)),
    palette,
  };
  if (!['left', 'center', 'right'].includes(o.align)) throw new TextrudeError('align must be left, center, or right');
  const strokeWidth = options.strokeWidth ?? 0;
  const strokeAlign = options.strokeAlign ?? 'outside';
  const join = JOINS[options.strokeJoin ?? 'round'];
  if (join === undefined) throw new TextrudeError('strokeJoin must be round, miter, or square');
  const miterLimit = options.miterLimit ?? 4;
  const textColor = color(options.color ?? '#000000', 'color');
  const backgroundColor = options.background != null ? color(options.background, 'background') : null;
  // With a background, the stroke defaults to the background color (so it blends into the plate).
  const strokeColor = options.strokeColor != null ? color(options.strokeColor, 'strokeColor') : (backgroundColor ?? { r: 255, g: 255, b: 255 });
  const baseHeight = options.height ?? 2;
  const heightOf: Record<Role, number> = {
    text: options.textHeight ?? baseHeight,
    color: options.textHeight ?? baseHeight,
    stroke: options.strokeHeight ?? baseHeight,
    bridge: options.bridgeHeight ?? baseHeight,
    background: options.backgroundHeight ?? baseHeight,
  };
  const filamentOverride: Partial<Record<Role, number>> = {
    text: options.textFilament,
    stroke: options.strokeFilament,
    bridge: options.bridgeFilament,
    background: options.backgroundFilament,
  };

  // Fonts.
  const loaded = await loadFont(options.font ?? 'Arial', options.fontIndex);
  const styled = resolveStyle(
    loaded.font,
    loaded.file,
    { bold: options.bold, italic: options.italic, synthetic: options.synthetic, variations: options.variations },
    libLog,
  );
  o.embolden = options.embolden ?? (styled.synthBold ? size * 0.02 : 0);
  o.slant = options.slant ?? (styled.synthItalic ? 12 : 0);
  const fonts: FontChoice[] = [{ font: styled.font, color: isColorFont(styled.font) }];
  const used: UsedFont[] = [{ name: styled.font.fullName, color: fonts[0]!.color, source: 'primary' }];
  for (const spec of options.fallbackFonts ?? []) {
    const f = (await loadFont(spec)).font;
    fonts.push({ font: f, color: isColorFont(f) });
    used.push({ name: f.fullName, color: isColorFont(f), source: 'fallback' });
  }
  const fontLabel = (f: UsedFont) => `${f.name}${f.color ? ' (color)' : ''}`;
  log('detail', fontLabel(used[0]!), 'font');
  if (used.length > 1) log('detail', used.slice(1).map(fontLabel).join(', '), 'fallback');
  const getEmojiFont = () => {
    const f = findEmojiFont();
    if (!f) return null;
    const entry: UsedFont = { name: f.fullName, color: true, source: 'emoji' };
    used.push(entry);
    log('detail', `${entry.name} (installed; pass --fallback-font to choose another)`, 'emoji');
    return { font: f, color: true };
  };

  // Layout.
  const { regions, solid } = renderText(fonts, text, o, { getEmojiFont, log: libLog });
  if (!solid.length) throw new TextrudeError('nothing to render');

  // Stroke: an outline around the whole design. For center/inside alignment the colored regions
  // are trimmed to make room for it.
  let stroke: Shape = [];
  let textRegions = regions;
  if (strokeWidth > 0) {
    const off = (s: Shape, d: number) => offset(s, d, join, miterLimit, tolerance);
    let outer = solid;
    let fillArea = solid;
    if (strokeAlign === 'outside') outer = off(solid, strokeWidth);
    else if (strokeAlign === 'center') [outer, fillArea] = [off(solid, strokeWidth / 2), off(solid, -strokeWidth / 2)];
    else if (strokeAlign === 'inside') fillArea = off(solid, -strokeWidth);
    else throw new TextrudeError('strokeAlign must be outside, center, or inside');
    if (strokeAlign !== 'outside') {
      fillArea = clean(fillArea, minArea);
      textRegions = regions.map((r) => ({ ...r, shape: clean(intersection(r.shape, fillArea), minArea) }));
    }
    stroke = clean(difference(outer, fillArea), minArea);
  }

  // Non-overlapping layers. Regions in the text color (or a user-chosen color) are "text";
  // colors that come from the font (emoji) are "color".
  const layers: Layer[] = [];
  for (const r of textRegions) {
    const c = r.color === 'fg' ? textColor : r.color;
    if (c && r.shape.length) layers.push({ role: r.color === 'fg' || r.user ? 'text' : 'color', color: c, shape: r.shape });
  }
  if (strokeColor && stroke.length) layers.push({ role: 'stroke', color: strokeColor, shape: stroke });
  if (!layers.length) throw new TextrudeError('nothing visible (text and stroke colors are both "none")');

  let connected: Shape | null = null;
  let bridged: TextrudeResult['bridged'] = null;
  if (backgroundColor) {
    // A (rounded) plate behind everything, which also holds all the pieces together.
    const all = union(...layers.map((l) => l.shape));
    const b = bbox(all);
    const pad = options.backgroundPadding ?? size * 0.25;
    const plate = roundedRect(
      b.minX / SCALE - pad, b.minY / SCALE - pad, b.maxX / SCALE + pad, b.maxY / SCALE + pad,
      options.backgroundRadius ?? 0, tolerance,
    );
    // Share a part with a same-colored stroke/text layer of the same height: carve the plate
    // around the *other* layers (rather than unioning two edge-adjacent shapes, which can leave
    // seams).
    const sameAs = (l: Layer) => toHex(l.color) === toHex(backgroundColor) && heightOf[l.role] === heightOf.background;
    const target = layers.find((l) => l.role === 'stroke' && sameAs(l)) ?? layers.find((l) => l.role === 'text' && sameAs(l));
    if (target) {
      const others = layers.filter((l) => l !== target).flatMap((l) => l.shape);
      target.shape = clean(difference(plate, others), minArea);
      target.roles = [target.role, 'background'];
    } else {
      layers.push({ role: 'background', color: backgroundColor, shape: clean(difference(plate, all), minArea) });
    }
    connected = plate;
    if (options.connect) log('note', 'background holds everything together, so no bridges are needed');
  } else if (options.connect) {
    const all = union(...layers.map((l) => l.shape));
    const width = options.bridgeWidth ?? (strokeWidth > 0 ? strokeWidth : size * 0.1);
    const { bridges, count, islands } = makeBridges(all, width, tolerance);
    if (count) {
      const bcolor =
        options.bridgeColor != null
          ? color(options.bridgeColor, 'bridgeColor')!
          : (layers.find((l) => l.role === 'stroke') ?? layers.find((l) => l.role === 'text') ?? layers[0]!).color;
      const target =
        layers.find((l) => l.role !== 'color' && toHex(l.color) === toHex(bcolor)) ?? layers.find((l) => toHex(l.color) === toHex(bcolor));
      if (target) {
        // Union with the full bar (which overlaps the target) so it fuses robustly, then carve
        // out the other regions to keep everything non-overlapping.
        const others = layers.filter((l) => l !== target).flatMap((l) => l.shape);
        target.shape = clean(difference(union(target.shape, bridges), others), minArea);
      } else {
        layers.push({ role: 'bridge', color: bcolor, shape: clean(difference(bridges, all), minArea) });
      }
      connected = union(all, bridges);
      const remaining = components(connected).length;
      bridged = { islands, bridges: count, remaining };
      log('success', `connected ${islands} pieces with ${count} bridge${count === 1 ? '' : 's'}`);
      if (remaining > 1) log('warn', `${remaining} separate pieces remain`);
    }
  }

  // Map colors to the palette (filament slots) or merge them down to maxColors.
  if (palette) {
    const labs = palette.map(lab);
    for (const l of layers) {
      const i = nearestIndex(l.color, labs);
      l.color = palette[i]!;
      l.filament = i + 1;
    }
  } else if (options.maxColors) {
    const entries = new Map<string, { hex: string; color: RGB; area: number; fixed: boolean }>();
    for (const l of layers) {
      const hex = toHex(l.color);
      const e = entries.get(hex) ?? { hex, color: l.color, area: 0, fixed: false };
      e.area += Math.abs(area(l.shape));
      e.fixed ||= l.role !== 'color';
      entries.set(hex, e);
    }
    const map = reduceColors([...entries.values()], Math.max(1, Math.round(options.maxColors)));
    for (const l of layers) l.color = map.get(toHex(l.color))!;
  }

  // One part per (color, height).
  type Draft = Omit<Part, 'shape' | 'filament' | 'id'> & { shapes: Shape[]; filament?: number };
  const drafts: Draft[] = [];
  for (const l of layers) {
    const hex = toHex(l.color);
    const height = heightOf[l.role];
    let part = drafts.find((p) => p.color === hex && p.height === height);
    if (!part) drafts.push((part = { color: hex, height, roles: [], shapes: [], filament: l.filament }));
    for (const role of l.roles ?? [l.role]) {
      if (!part.roles.includes(role)) part.roles.push(role);
      const f = filamentOverride[role];
      if (f != null) part.filament = f;
    }
    part.shapes.push(l.shape);
  }
  const hexOrder = [...new Set(drafts.map((p) => p.color))];
  let parts: Part[] = drafts.map(({ shapes, ...p }) => ({
    ...p,
    id: `${p.roles.join('+')} ${p.color}`,
    filament: p.filament ?? hexOrder.indexOf(p.color) + 1,
    shape: shapes.length > 1 ? union(...shapes) : shapes[0]!,
  }));
  if (options.singlePath) {
    const first = parts[0]!;
    parts = [{ ...first, id: `textrude ${first.color}`, shape: connected ?? union(...parts.map((p) => p.shape)) }];
  }

  const box = bbox(parts.flatMap((p) => p.shape));
  return {
    text,
    fonts: used,
    parts,
    bridged,
    width: (box.maxX - box.minX) / SCALE,
    depth: (box.maxY - box.minY) / SCALE,
    height: Math.max(...parts.map((p) => p.height)),
    toSVG({ flip, ...svg } = {}) {
      return writeSvg(
        parts.map((p) => ({ id: p.id.replace(/[^\w-]+/g, '-'), shape: p.shape, color: p.color })),
        { ...svg, mirror: svg.mirror ?? flip },
      );
    },
    to3MF(opts = {}) {
      return export3mf(parts, text, palette, opts, log);
    },
    toPNG(opts = {}) {
      return renderPng(parts, opts);
    },
  };
}

function export3mf(parts: Part[], text: string, palette: RGB[] | undefined, opts: ThreeMfExportOptions, log: (l: LogLevel, m: string) => void): Uint8Array {
  let profile: PrinterProfile | null = null;
  if (typeof opts.printer === 'string') {
    const p = PRINTERS[opts.printer];
    if (!p) throw new TextrudeError(`unknown printer "${opts.printer}" (known: ${Object.keys(PRINTERS).join(', ')})`);
    profile = { ...p };
  } else if (opts.printer) {
    profile = { ...opts.printer };
  }
  if (profile) {
    if (opts.processPreset) profile.process = opts.processPreset;
    if (opts.filamentPreset) profile.filament = opts.filamentPreset;
    if (opts.bedType) profile.bedType = opts.bedType;
  }

  // Filament slots 1..N with their colors (palette slots keep their colors even if unused).
  const count = Math.max(...parts.map((p) => p.filament), palette?.length ?? 0);
  let projectConfig: string | null = null;
  if (profile) {
    const filamentColors = Array.from(
      { length: count },
      (_, i) => parts.find((p) => p.filament === i + 1)?.color ?? (palette?.[i] ? toHex(palette[i]) : '#ffffff'),
    );
    projectConfig = projectSettings(profile, filamentColors);
    if (profile.toolheads && count > profile.toolheads) {
      log('warn', `${count} filaments, but the ${profile.label} has ${profile.toolheads} toolheads (use --palette or --max-colors ${profile.toolheads})`);
    }
  } else if (count > 1) {
    log('note', "no printer profile given, so filament colors aren't embedded (the slicer keeps its current filament list)");
  }

  const position = opts.position ?? profile?.bedCenter ?? [100, 100];
  return write3mf(parts, { name: opts.name ?? plainName(text), position, mirror: opts.flip, projectConfig });
}

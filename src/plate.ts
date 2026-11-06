/**
 * Multiple texts on one plate: each text is a separate object, laid out in rows with a gap
 * between them so they print apart, with filament numbers shared across all of them.
 */
import { SCALE, bbox } from './geometry.js';
import type { Shape } from './types.js';
import { writeSvg, type SvgOptions } from './svg.js';
import { renderPng, type PngOptions } from './raster.js';
import { autoFilament, export3mf, plainName, resultInfo, type LogEvent, type Part, type TextrudeResult, type ThreeMfExportOptions } from './render.js';
import { TextrudeError } from './errors.js';

export interface ArrangeOptions {
  /** Space between objects (mm). Default 5. */
  gap?: number;
  /** Start a new row once a row would get wider than this (mm), e.g. the bed width. Default 200. */
  maxWidth?: number;
  /** Messages (e.g. bed size warnings when exporting). Default: the first result's `onLog`. */
  onLog?: (event: LogEvent) => void;
}

export interface PlateObject {
  /** Object name, e.g. the text without emoji. */
  name: string;
  result: TextrudeResult;
  /** The result's parts, moved into place, with plate-wide filament numbers. */
  parts: Part[];
}

export interface Plate {
  objects: PlateObject[];
  /** Every object's parts. */
  parts: Part[];
  /** Overall size (mm). */
  width: number;
  depth: number;
  height: number;
  /** One `<path>` per part. */
  toSVG(options?: SvgOptions & { flip?: boolean }): string;
  /** A 3MF with one object per text, each with one part per color. */
  to3MF(options?: ThreeMfExportOptions): Uint8Array;
  /** A top-down preview image. */
  toPNG(options?: PngOptions): Uint8Array;
}

const translate = (shape: Shape, dx: number, dy: number): Shape => shape.map((path) => path.map(({ X, Y }) => ({ X: X + dx, Y: Y + dy })));

/**
 * Lay out several {@link textrude} results as separate objects on one plate. Objects keep
 * their order, left to right and then top to bottom, `gap` mm apart.
 *
 * Automatically numbered filaments are renumbered across the plate, so a color uses the same
 * filament in every object. Palette slots and explicit filament numbers are kept.
 */
export function arrange(results: TextrudeResult[], options: ArrangeOptions = {}): Plate {
  if (!results.length) throw new TextrudeError('nothing to arrange');
  const gap = options.gap ?? 5;
  const maxWidth = options.maxWidth ?? 200;
  if (!(gap >= 0)) throw new TextrudeError('gap must be a non-negative number');

  // Rows of objects, wrapping at maxWidth.
  const sizes = results.map((r) => bbox(r.parts.flatMap((p) => p.shape)));
  const rows: { items: number[]; width: number; depth: number }[] = [];
  results.forEach((r, i) => {
    const row = rows[rows.length - 1];
    if (row && row.width + gap + r.width <= maxWidth) {
      row.items.push(i);
      row.width += gap + r.width;
      row.depth = Math.max(row.depth, r.depth);
    } else {
      rows.push({ items: [i], width: r.width, depth: r.depth });
    }
  });
  const width = Math.max(...rows.map((r) => r.width));
  const depth = rows.reduce((d, r) => d + r.depth, 0) + gap * (rows.length - 1);

  // Each row is centered horizontally, and each object vertically within its row.
  const offsets: [number, number][] = [];
  let y = 0;
  for (const row of rows) {
    let x = (width - row.width) / 2;
    for (const i of row.items) {
      const r = results[i]!;
      const b = sizes[i]!;
      const top = y + (row.depth - r.depth) / 2;
      // (A lone object stays put, so its output matches the result's own exactly.)
      offsets[i] = results.length === 1 ? [0, 0] : [Math.round(x * SCALE) - b.minX, Math.round(top * SCALE) - b.minY];
      x += r.width + gap;
    }
    y += row.depth + gap;
  }

  // One filament per color across the plate (in order of first use).
  const hexOrder = [...new Set(results.flatMap((r) => r.parts.filter((p) => autoFilament.has(p)).map((p) => p.color)))];
  const objects: PlateObject[] = results.map((result, i) => {
    const [dx, dy] = offsets[i]!;
    const parts = result.parts.map((p) => ({
      ...p,
      filament: autoFilament.has(p) ? hexOrder.indexOf(p.color) + 1 : p.filament,
      shape: translate(p.shape, dx, dy),
    }));
    return { name: plainName(result.text), result, parts };
  });
  const parts = objects.flatMap((o) => o.parts);

  const infos = results.map((r) => resultInfo.get(r));
  const palette = infos.find((info) => info?.palette)?.palette;
  const log = (level: LogEvent['level'], message: string) => {
    if (options.onLog) options.onLog({ level, message });
    else infos[0]?.log(level, message);
  };

  const plate: Plate = {
    objects,
    parts,
    width,
    depth,
    height: Math.max(...parts.map((p) => p.height)),
    toSVG({ flip, ...svg } = {}) {
      return writeSvg(
        objects.flatMap((o, i) =>
          o.parts.map((p) => ({ id: `${objects.length > 1 ? `t${i + 1}-` : ''}${p.id.replace(/[^\w-]+/g, '-')}`, shape: p.shape, color: p.color })),
        ),
        { ...svg, mirror: svg.mirror ?? flip },
      );
    },
    to3MF(opts = {}) {
      return export3mf(objects, palette, opts, log, plate);
    },
    toPNG(opts = {}) {
      return renderPng(parts, opts);
    },
  };
  return plate;
}

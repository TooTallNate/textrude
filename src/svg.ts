import { SCALE, bbox } from './geometry.js';
import type { Shape } from './types.js';

/** Format a number with at most `prec` decimals, without trailing zeros. */
export function fmt(v: number, prec: number): string {
  const s = v.toFixed(prec).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

export interface SvgLayer {
  id: string;
  shape: Shape;
  /** `#rrggbb` */
  color: string;
}

export interface SvgOptions {
  /** Padding around the artwork. Default 1. */
  margin?: number;
  /** Unit for the SVG width/height. Default "mm". */
  units?: string;
  /** Decimal places. Default 3. */
  precision?: number;
  /** Mirror horizontally (for face-down printing). */
  mirror?: boolean;
}

/** One filled `<path>` per layer. Coordinates are output units (mm). */
export function writeSvg(layers: SvgLayer[], { margin = 1, units = 'mm', precision = 3, mirror = false }: SvgOptions = {}): string {
  const b = bbox(layers.flatMap((l) => l.shape));
  const minX = b.minX / SCALE - margin;
  const minY = b.minY / SCALE - margin;
  const w = (b.maxX - b.minX) / SCALE + 2 * margin;
  const h = (b.maxY - b.minY) / SCALE + 2 * margin;
  const px = (X: number) => (mirror ? w - (X / SCALE - minX) : X / SCALE - minX);
  const pt = ({ X, Y }: { X: number; Y: number }) => `${fmt(px(X), precision)} ${fmt(Y / SCALE - minY, precision)}`;

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, precision)}${units}" height="${fmt(h, precision)}${units}" viewBox="0 0 ${fmt(w, precision)} ${fmt(h, precision)}">`,
  ];
  for (const { id, shape, color } of layers) {
    if (!shape.length) continue;
    const d = shape.map((p) => `M${p.map(pt).join(' L')} Z`).join(' ');
    out.push(`  <path id="${id}" fill="${color}" fill-rule="nonzero" stroke="none" d="${d}"/>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/** Rasterize color regions to a PNG (for previews). */
import pngjs from 'pngjs';
import { bbox } from './geometry.js';
import type { Shape } from './types.js';
import { parseColor, type RGB } from './colors.js';

export interface PngOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Backdrop color. Default `#3a3a3a`. */
  background?: string;
  mirror?: boolean;
  /** Supersampling factor per axis. Default 4. */
  supersample?: number;
}

interface Edge {
  ya: number;
  yb: number;
  xa: number;
  dx: number;
  w: 1 | -1;
}

/**
 * Render layers (`#rrggbb` colored shapes) top-down into a PNG of at most maxWidth x
 * maxHeight pixels, using a nonzero scanline fill with supersampling.
 */
export function renderPng(
  layers: { shape: Shape; color: string }[],
  { maxWidth = 800, maxHeight = 400, background = '#3a3a3a', mirror = false, supersample: ss = 4 }: PngOptions = {},
): Uint8Array {
  const b = bbox(layers.flatMap((l) => l.shape));
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.04;
  const minX = b.minX - pad;
  const minY = b.minY - pad;
  const spanX = b.maxX - b.minX + 2 * pad;
  const spanY = b.maxY - b.minY + 2 * pad;
  const scale = Math.min(maxWidth / spanX, maxHeight / spanY);
  const W = Math.max(1, Math.round(spanX * scale));
  const H = Math.max(1, Math.round(spanY * scale));
  const SW = W * ss;
  const SH = H * ss;
  const s = scale * ss;

  // Supersampled label image: index of the layer covering each sample (-1 = background).
  const label = new Int16Array(SW * SH).fill(-1);
  layers.forEach((layer, li) => {
    const edges: Edge[] = [];
    for (const path of layer.shape) {
      for (let i = 0; i < path.length; i++) {
        const a = path[i]!;
        const c = path[(i + 1) % path.length]!;
        let x0 = (a.X - minX) * s;
        let x1 = (c.X - minX) * s;
        if (mirror) [x0, x1] = [SW - x0, SW - x1];
        const y0 = (a.Y - minY) * s;
        const y1 = (c.Y - minY) * s;
        if (y0 === y1) continue;
        edges.push(
          y0 < y1
            ? { ya: y0, yb: y1, xa: x0, dx: (x1 - x0) / (y1 - y0), w: 1 }
            : { ya: y1, yb: y0, xa: x1, dx: (x0 - x1) / (y0 - y1), w: -1 },
        );
      }
    }
    edges.sort((p, q) => p.ya - q.ya);
    let active: Edge[] = [];
    let next = 0;
    for (let y = 0; y < SH; y++) {
      const cy = y + 0.5;
      while (next < edges.length && edges[next]!.ya <= cy) active.push(edges[next++]!);
      active = active.filter((e) => e.yb > cy);
      const xs = active
        .filter((e) => e.ya <= cy)
        .map((e) => ({ x: e.xa + (cy - e.ya) * e.dx, w: e.w }))
        .sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        wind += xs[k]!.w;
        if (!wind) continue;
        const from = Math.max(0, Math.ceil(xs[k]!.x - 0.5));
        const to = Math.min(SW - 1, Math.floor(xs[k + 1]!.x - 0.5));
        for (let x = from; x <= to; x++) label[y * SW + x] = li;
      }
    }
  });

  // Box-filter down to the output size.
  const colors = layers.map((l) => parseColor(l.color) ?? { r: 0, g: 0, b: 0 });
  const bg: RGB = parseColor(background) ?? { r: 0, g: 0, b: 0 };
  const png = new pngjs.PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const l = label[(y * ss + sy) * SW + x * ss + sx]!;
          const c = l < 0 ? bg : colors[l]!;
          r += c.r;
          g += c.g;
          bl += c.b;
        }
      }
      const n = ss * ss;
      const i = (y * W + x) * 4;
      png.data[i] = r / n;
      png.data[i + 1] = g / n;
      png.data[i + 2] = bl / n;
      png.data[i + 3] = 255;
    }
  }
  return pngjs.PNG.sync.write(png);
}

// Color glyph support: COLR v0 vector layers, and CBDT / sbix bitmap glyphs (traced to shapes).
import pngjs from 'pngjs';
import { kmeans, lab, nearestIndex } from './colors.mjs';

/**
 * COLR v0 layers for a glyph: [{ glyph, color }] in paint order (bottom first), where a null
 * color means "use the text color". Returns null if the glyph has no color layers.
 */
export function colrLayers(font, glyph) {
  const t = font.directory.tables;
  if (!t.COLR || !t.CPAL) return null;
  const colr = font.COLR;
  const cpal = font.CPAL;
  const records = colr.baseGlyphRecord;
  let lo = 0;
  let hi = records.length - 1;
  let base = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (glyph.id < records[mid].gid) hi = mid - 1;
    else if (glyph.id > records[mid].gid) lo = mid + 1;
    else {
      base = records[mid];
      break;
    }
  }
  if (!base) return null;
  const paletteStart = cpal.colorRecordIndices?.[0] ?? 0;
  const layers = [];
  for (let i = base.firstLayerIndex; i < base.firstLayerIndex + base.numLayers; i++) {
    const rec = colr.layerRecords[i];
    const c = rec.paletteIndex === 0xffff ? null : cpal.colorRecords[paletteStart + rec.paletteIndex];
    if (c && c.alpha < 26) continue; // effectively invisible
    layers.push({ glyph: font._getBaseGlyph(rec.gid), color: c ? { r: c.red, g: c.green, b: c.blue } : null });
  }
  return layers;
}

// ------------------------------------------------------------------ bitmap glyphs

const view = (font) => {
  const b = font.stream.buffer;
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
};

const strikeCache = new WeakMap();

function cbdtStrike(font) {
  if (strikeCache.has(font)) return strikeCache.get(font);
  const dv = view(font);
  const cblc = font.directory.tables.CBLC.offset;
  let best = null;
  for (let i = 0, n = dv.getUint32(cblc + 4); i < n; i++) {
    const o = cblc + 8 + i * 48;
    const s = { arrayOffset: dv.getUint32(o), numSubtables: dv.getUint32(o + 8), ppem: dv.getUint8(o + 44) };
    if (!best || s.ppem > best.ppem) best = s;
  }
  strikeCache.set(font, best);
  return best;
}

function cbdtImage(font, gid) {
  const dv = view(font);
  const cblc = font.directory.tables.CBLC.offset;
  const cbdt = font.directory.tables.CBDT.offset;
  const strike = cbdtStrike(font);
  if (!strike) return null;
  const arr = cblc + strike.arrayOffset;
  for (let j = 0; j < strike.numSubtables; j++) {
    const first = dv.getUint16(arr + j * 8);
    const last = dv.getUint16(arr + j * 8 + 2);
    if (gid < first || gid > last) continue;
    const st = arr + dv.getUint32(arr + j * 8 + 4);
    const indexFormat = dv.getUint16(st);
    const imageFormat = dv.getUint16(st + 2);
    const base = cbdt + dv.getUint32(st + 4);
    let pos = null;
    let big = null; // metrics stored in the index (formats 2 and 5)
    const k = gid - first;
    if (indexFormat === 1) {
      const a = dv.getUint32(st + 8 + k * 4);
      if (dv.getUint32(st + 8 + (k + 1) * 4) !== a) pos = base + a;
    } else if (indexFormat === 3) {
      const a = dv.getUint16(st + 8 + k * 2);
      if (dv.getUint16(st + 8 + (k + 1) * 2) !== a) pos = base + a;
    } else if (indexFormat === 2) {
      pos = base + k * dv.getUint32(st + 8);
      big = st + 12;
    } else if (indexFormat === 4) {
      const num = dv.getUint32(st + 8);
      for (let g = 0; g < num; g++) {
        if (dv.getUint16(st + 12 + g * 4) === gid) {
          pos = base + dv.getUint16(st + 12 + g * 4 + 2);
          break;
        }
      }
    } else if (indexFormat === 5) {
      const size = dv.getUint32(st + 8);
      const num = dv.getUint32(st + 20);
      for (let g = 0; g < num; g++) {
        if (dv.getUint16(st + 24 + g * 2) === gid) {
          pos = base + g * size;
          big = st + 12;
          break;
        }
      }
    }
    if (pos == null) return null;
    let left, top, png;
    if (imageFormat === 17) {
      left = dv.getInt8(pos + 2);
      top = dv.getInt8(pos + 3);
      png = [pos + 9, dv.getUint32(pos + 5)];
    } else if (imageFormat === 18) {
      left = dv.getInt8(pos + 2);
      top = dv.getInt8(pos + 3);
      png = [pos + 12, dv.getUint32(pos + 8)];
    } else if (imageFormat === 19 && big != null) {
      left = dv.getInt8(big + 2);
      top = dv.getInt8(big + 3);
      png = [pos + 4, dv.getUint32(pos)];
    } else {
      return null;
    }
    return { png: font.stream.buffer.subarray(png[0], png[0] + png[1]), ppem: strike.ppem, left, top };
  }
  return null;
}

function sbixImage(font, gid, depth = 0) {
  const dv = view(font);
  const sbix = font.directory.tables.sbix.offset;
  const numGlyphs = font.numGlyphs;
  let strike = null;
  for (let i = 0, n = dv.getUint32(sbix + 4); i < n; i++) {
    const o = sbix + dv.getUint32(sbix + 8 + i * 4);
    const ppem = dv.getUint16(o);
    if (!strike || ppem > strike.ppem) strike = { o, ppem };
  }
  if (!strike || gid >= numGlyphs) return null;
  const start = dv.getUint32(strike.o + 4 + gid * 4);
  const end = dv.getUint32(strike.o + 4 + (gid + 1) * 4);
  if (end - start <= 8) return null;
  const p = strike.o + start;
  const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
  if (type === 'dupe' && depth < 4) return sbixImage(font, dv.getUint16(p + 8), depth + 1);
  if (type !== 'png ') return null;
  return {
    png: font.stream.buffer.subarray(p + 8, strike.o + end),
    ppem: strike.ppem,
    left: dv.getInt16(p),
    bottom: dv.getInt16(p + 2),
  };
}

/**
 * The bitmap for a glyph, decoded: { width, height, rgba, ppem, left, top } where left/top are
 * pixel offsets of the image's top-left corner from the glyph origin (y up). Null if none.
 */
export function bitmapGlyph(font, gid) {
  const t = font.directory.tables;
  let img = null;
  try {
    if (t.CBDT && t.CBLC) img = cbdtImage(font, gid);
    else if (t.sbix) img = sbixImage(font, gid);
  } catch {
    return null;
  }
  if (!img) return null;
  const png = pngjs.PNG.sync.read(Buffer.from(img.png));
  return {
    width: png.width,
    height: png.height,
    rgba: png.data,
    ppem: img.ppem,
    left: img.left,
    top: img.top ?? img.bottom + png.height,
  };
}

/**
 * Reduce the opaque pixels of all bitmaps to a shared set of colors: either the given
 * palette, or `count` colors found by k-means. Sets `bitmap.labels` (-1 = transparent) and
 * returns the label colors.
 */
export function quantizeBitmaps(bitmaps, { palette, count }) {
  const opaque = (bm, i) => bm.rgba[i * 4 + 3] >= 128;
  const px = (bm, i) => ({ r: bm.rgba[i * 4], g: bm.rgba[i * 4 + 1], b: bm.rgba[i * 4 + 2] });
  let colors = palette;
  if (!colors) {
    const sample = [];
    const total = bitmaps.reduce((s, bm) => s + bm.width * bm.height, 0);
    const step = Math.max(1, Math.floor(total / 40000));
    for (const bm of bitmaps) {
      for (let i = 0; i < bm.width * bm.height; i += step) if (opaque(bm, i)) sample.push(px(bm, i));
    }
    colors = kmeans(sample, count);
  }
  const labs = colors.map(lab);
  const cache = new Map();
  for (const bm of bitmaps) {
    const labels = new Int16Array(bm.width * bm.height).fill(-1);
    for (let i = 0; i < labels.length; i++) {
      if (!opaque(bm, i)) continue;
      const key = (bm.rgba[i * 4] << 16) | (bm.rgba[i * 4 + 1] << 8) | bm.rgba[i * 4 + 2];
      let l = cache.get(key);
      if (l === undefined) cache.set(key, (l = nearestIndex(px(bm, i), labs)));
      labels[i] = l;
    }
    bm.labels = despeckle(labels, bm.width, bm.height);
  }
  return colors;
}

/** Reassign isolated pixels (at most one same-colored neighbor) to their most common neighbor. */
function despeckle(labels, w, h) {
  const out = labels.slice();
  const counts = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      counts.clear();
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          const n = nx < 0 || ny < 0 || nx >= w || ny >= h ? -1 : labels[ny * w + nx];
          if (n === l) same++;
          counts.set(n, (counts.get(n) || 0) + 1);
        }
      }
      if (same > 1) continue;
      let best = l;
      let bestN = -1;
      for (const [n, c] of counts) if (c > bestN) [best, bestN] = [n, c];
      out[y * w + x] = best;
    }
  }
  return out;
}

/**
 * Trace a labeled bitmap into rectangles per label, in font units (y up). The label image is
 * upsampled `S`x with bilinear voting first, which smooths the pixel staircase on diagonals
 * while keeping the colors an exact partition (no gaps or overlaps).
 */
export function traceBitmap(bm, unitsPerEm, S = 3) {
  const { width: w, height: h, labels } = bm;
  const u = unitsPerEm / bm.ppem;
  const W = w * S;
  const H = h * S;
  const grid = new Int16Array(W * H);
  const lab = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]);
  const score = new Map();
  for (let sy = 0; sy < H; sy++) {
    const v = (sy + 0.5) / S - 0.5;
    const y0 = Math.floor(v);
    const fy = v - y0;
    for (let sx = 0; sx < W; sx++) {
      const uu = (sx + 0.5) / S - 0.5;
      const x0 = Math.floor(uu);
      const fx = uu - x0;
      score.clear();
      const add = (l, wgt) => score.set(l, (score.get(l) || 0) + wgt);
      add(lab(x0, y0), (1 - fx) * (1 - fy));
      add(lab(x0 + 1, y0), fx * (1 - fy));
      add(lab(x0, y0 + 1), (1 - fx) * fy);
      add(lab(x0 + 1, y0 + 1), fx * fy);
      let best = -1;
      let bw = -1;
      for (const [l, wgt] of score) if (wgt > bw) [best, bw] = [l, wgt];
      grid[sy * W + sx] = best;
    }
  }

  // Break diagonal-only contacts (2x2 checkerboards): regions touching at a single corner
  // would produce non-manifold mesh edges.
  for (let pass = 0, changed = true; changed && pass < 4; pass++) {
    changed = false;
    for (let sy = 0; sy + 1 < H; sy++) {
      for (let sx = 0; sx + 1 < W; sx++) {
        const i = sy * W + sx;
        const [a, b, c, d] = [grid[i], grid[i + 1], grid[i + W], grid[i + W + 1]];
        if ((a === d && b !== a && c !== a) || (b === c && a !== b && d !== b)) {
          if (a === d) grid[i + 1] = a;
          else grid[i] = b;
          changed = true;
        }
      }
    }
  }

  // Horizontal runs, merged vertically when identical, become rectangles.
  const out = new Map();
  const rect = (l, x0, x1, y0, y1) => {
    const X0 = (bm.left + x0 / S) * u;
    const X1 = (bm.left + x1 / S) * u;
    const Y0 = (bm.top - y0 / S) * u;
    const Y1 = (bm.top - y1 / S) * u;
    if (!out.has(l)) out.set(l, []);
    out.get(l).push([[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]);
  };
  let open = new Map(); // "label,x0,x1" -> start row
  for (let sy = 0; sy <= H; sy++) {
    const next = new Map();
    if (sy < H) {
      let sx = 0;
      while (sx < W) {
        const l = grid[sy * W + sx];
        let ex = sx + 1;
        while (ex < W && grid[sy * W + ex] === l) ex++;
        if (l >= 0) {
          const key = `${l},${sx},${ex}`;
          next.set(key, open.has(key) ? open.get(key) : sy);
          open.delete(key);
        }
        sx = ex;
      }
    }
    for (const [key, start] of open) {
      const [l, x0, x1] = key.split(',').map(Number);
      rect(l, x0, x1, start, sy);
    }
    open = next;
  }
  return out;
}

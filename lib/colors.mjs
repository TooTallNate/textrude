// Colors are { r, g, b } with 0-255 channels.

const NAMED = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', lime: '00ff00', blue: '0000ff',
  yellow: 'ffff00', cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', orange: 'ffa500',
  purple: '800080', pink: 'ffc0cb', brown: 'a52a2a', gray: '808080', grey: '808080', silver: 'c0c0c0',
  gold: 'ffd700', navy: '000080', teal: '008080', maroon: '800000', olive: '808000', beige: 'f5f5dc',
  tan: 'd2b48c', skyblue: '87ceeb', darkgreen: '006400', darkblue: '00008b', darkred: '8b0000',
  lightgray: 'd3d3d3', lightgrey: 'd3d3d3', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', violet: 'ee82ee',
  indigo: '4b0082', coral: 'ff7f50', salmon: 'fa8072', turquoise: '40e0d0', crimson: 'dc143c',
  khaki: 'f0e68c', lavender: 'e6e6fa', chocolate: 'd2691e', orchid: 'da70d6', plum: 'dda0dd',
};

/** Parse a CSS-style color (#rgb, #rrggbb, rgb(...), or a common name). Returns null for "none". */
export function parseColor(s) {
  const v = String(s).trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return null;
  let hex = NAMED[v] ?? v.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) {
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  const m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  throw new Error(`invalid color "${s}"`);
}

export const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');

/** sRGB -> CIELAB, for perceptual color distances. */
export function lab({ r, g, b }) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function nearestIndex(color, paletteLabs) {
  const l = lab(color);
  let best = 0;
  for (let i = 1; i < paletteLabs.length; i++) if (dist2(l, paletteLabs[i]) < dist2(l, paletteLabs[best])) best = i;
  return best;
}

/**
 * Merge similar colors until at most `max` remain. `entries` are { hex, color, area, fixed };
 * clusters containing a fixed (user-specified) color keep that exact color.
 * Returns a Map of hex -> resulting color.
 */
export function reduceColors(entries, max) {
  let clusters = entries.map((e) => ({ ...e, members: [e.hex], lab: lab(e.color) }));
  while (clusters.length > max) {
    let bi = 0;
    let bj = 1;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist2(clusters[i].lab, clusters[j].lab);
        if (d < bd) [bi, bj, bd] = [i, j, d];
      }
    }
    const a = clusters[bi];
    const b = clusters[bj];
    const total = a.area + b.area || 1;
    const color = a.fixed && (!b.fixed || a.area >= b.area) ? a.color : b.fixed ? b.color : {
      r: (a.color.r * a.area + b.color.r * b.area) / total,
      g: (a.color.g * a.area + b.color.g * b.area) / total,
      b: (a.color.b * a.area + b.color.b * b.area) / total,
    };
    const merged = { color, area: a.area + b.area, fixed: a.fixed || b.fixed, members: [...a.members, ...b.members], lab: lab(color) };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj).concat(merged);
  }
  const map = new Map();
  for (const c of clusters) for (const m of c.members) map.set(m, c.color);
  return map;
}

/**
 * k-means color quantization in CIELAB. `pixels` is an array of { r, g, b }. Returns cluster
 * colors (mean RGB of their members), largest cluster first.
 */
export function kmeans(pixels, k, iterations = 12) {
  if (!pixels.length) return [];
  // Deterministic k-means++ seeding.
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const labs = pixels.map(lab);
  const centers = [labs[Math.floor(rand() * labs.length)]];
  const d = labs.map((l) => dist2(l, centers[0]));
  while (centers.length < Math.min(k, labs.length)) {
    const total = d.reduce((s, v) => s + v, 0);
    if (!total) break;
    let t = rand() * total;
    let i = 0;
    while ((t -= d[i]) > 0 && i < d.length - 1) i++;
    centers.push(labs[i]);
    for (let j = 0; j < labs.length; j++) d[j] = Math.min(d[j], dist2(labs[j], labs[i]));
  }
  const assign = new Int32Array(labs.length);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < labs.length; j++) {
      let best = 0;
      for (let c = 1; c < centers.length; c++) if (dist2(labs[j], centers[c]) < dist2(labs[j], centers[best])) best = c;
      assign[j] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < labs.length; j++) {
      const s = sums[assign[j]];
      s[0] += labs[j][0];
      s[1] += labs[j][1];
      s[2] += labs[j][2];
      s[3]++;
    }
    sums.forEach((s, c) => {
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }
  const rgb = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let j = 0; j < pixels.length; j++) {
    const c = rgb[assign[j]];
    c.r += pixels[j].r;
    c.g += pixels[j].g;
    c.b += pixels[j].b;
    c.n++;
  }
  return rgb
    .filter((c) => c.n)
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }));
}

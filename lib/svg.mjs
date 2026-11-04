import { SCALE, bbox } from './geometry.mjs';

export function fmt(v, prec) {
  const s = v.toFixed(prec).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

export function writeSvg(layers, margin, units, prec, mirror) {
  const all = layers.flatMap((l) => l.shape);
  const b = bbox(all);
  const minX = b.minX / SCALE - margin;
  const minY = b.minY / SCALE - margin;
  const w = (b.maxX - b.minX) / SCALE + 2 * margin;
  const h = (b.maxY - b.minY) / SCALE + 2 * margin;
  const px = (X) => (mirror ? w - (X / SCALE - minX) : X / SCALE - minX);
  const pt = ({ X, Y }) => `${fmt(px(X), prec)} ${fmt(Y / SCALE - minY, prec)}`;

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, prec)}${units}" height="${fmt(h, prec)}${units}" viewBox="0 0 ${fmt(w, prec)} ${fmt(h, prec)}">`,
  ];
  for (const { id, shape, color } of layers) {
    if (!shape.length) continue;
    const d = shape.map((p) => `M${p.map(pt).join(' L')} Z`).join(' ');
    out.push(`  <path id="${id}" fill="${color}" fill-rule="nonzero" stroke="none" d="${d}"/>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

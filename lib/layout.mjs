import { flattenCommands } from './outline.mjs';
import { SCALE, JoinType, union, difference, offset, area } from './geometry.mjs';
import { colrLayers, bitmapGlyph, quantizeBitmaps, traceBitmap } from './emoji.mjs';
import { toHex } from './colors.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|\uFE0F/u;
// Code points that don't need their own glyph (joiners, variation selectors, tag characters).
const ignorable = (cp) => cp === 0x200d || cp === 0x200c || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0020 && cp <= 0xe007f);

/**
 * Pick the font for a grapheme cluster: the first that has glyphs for all of it. Emoji with
 * emoji presentation prefer color fonts.
 */
function chooseFont(cluster, fonts) {
  const cps = [...cluster].map((c) => c.codePointAt(0)).filter((cp) => !ignorable(cp));
  const covers = (f) => cps.every((cp) => f.font.hasGlyphForCodePoint(cp));
  let order = fonts;
  if (EMOJI.test(cluster) && EMOJI_PRESENTATION.test(cluster) && !cluster.includes('\uFE0E')) {
    order = [...fonts.filter((f) => f.color), ...fonts.filter((f) => !f.color)];
  }
  return order.find(covers) ?? null;
}

/**
 * Lay out and render text. Returns non-overlapping color regions:
 * { regions: [{ color: 'fg' | {r,g,b}, shape }], solid } where 'fg' is the text color.
 *
 * `fonts` is [{ font, color }] (primary first, then fallbacks). `getEmojiFont` is called at
 * most once, when an emoji isn't covered by any of them, and may return another such entry.
 */
export function renderText(fonts, text, o, { getEmojiFont, log }) {
  const primary = fonts[0].font;
  const primaryScale = o.size / primary.unitsPerEm;
  const lineH = (primary.ascent - primary.descent + (primary.lineGap || 0)) * primaryScale * o.lineSpacing;
  const skew = Math.tan((o.slant * Math.PI) / 180);
  const items = []; // paint order, bottom first: { color, paths } or { bitmap, xf }
  const decorations = [];
  const contourCache = new Map();
  const warned = new Set();
  let emojiTried = false;
  let letter = 0;

  const contours = (font, glyph, scale) => {
    const key = `${font.postscriptName}|${font.unitsPerEm}|${glyph.id}`;
    if (!contourCache.has(key)) contourCache.set(key, flattenCommands(glyph.path.commands, o.tolerance / scale));
    return contourCache.get(key);
  };

  text.split('\n').forEach((line, li) => {
    // Split the line into runs of grapheme clusters that use the same font.
    const runs = [];
    for (const { segment } of segmenter.segment(line)) {
      let f = chooseFont(segment, fonts);
      if (!f && EMOJI.test(segment) && !emojiTried && getEmojiFont) {
        emojiTried = true;
        const extra = getEmojiFont();
        if (extra) {
          fonts.push(extra);
          f = chooseFont(segment, fonts);
        }
      }
      if (!f) {
        if (!/^\s+$/.test(segment) && !warned.has(segment)) {
          warned.add(segment);
          log(`warning: no font has a glyph for ${JSON.stringify(segment)}`);
        }
        f = fonts[0];
      }
      if (runs.length && runs[runs.length - 1].f === f) runs[runs.length - 1].text += segment;
      else runs.push({ f, text: segment });
    }

    // Shape each run, then measure the whole line for alignment.
    const placed = [];
    let width = 0;
    let count = 0;
    for (const run of runs) {
      const scale = o.size / run.f.font.unitsPerEm;
      const r = run.f.font.layout(run.text);
      r.glyphs.forEach((glyph, gi) => {
        const pos = r.positions[gi];
        placed.push({ font: run.f.font, glyph, pos, scale, x: width });
        width += pos.xAdvance * scale;
        count++;
      });
    }
    // Emboldening grows each glyph by `embolden` per side, so widen the advance to match.
    const spacing = o.letterSpacing + 2 * o.embolden;
    width += spacing * Math.max(0, count - 1);
    const shift = { left: 0, center: -width / 2, right: -width }[o.align];
    const baseline = li * lineH;

    placed.forEach(({ font, glyph, pos, scale, x }, gi) => {
      const ox = x + gi * spacing + pos.xOffset * scale + shift;
      const oy = baseline - pos.yOffset * scale;
      const xf = ([gx, gy]) => ({
        X: Math.round((gx * scale + ox + skew * (gy + pos.yOffset) * scale) * SCALE),
        Y: Math.round((-gy * scale + oy) * SCALE),
      });
      const blank = glyph.codePoints.length > 0 && glyph.codePoints.every((cp) => /\s/.test(String.fromCodePoint(cp)));
      const fg = !blank && o.letterColors?.length ? o.letterColors[letter++ % o.letterColors.length] : 'fg';

      const layers = colrLayers(font, glyph);
      if (layers) {
        for (const layer of layers) {
          items.push({ color: layer.color ?? fg, paths: contours(font, layer.glyph, scale).map((c) => c.map(xf)) });
        }
        return;
      }
      const bitmap = bitmapGlyph(font, glyph.id);
      if (bitmap) {
        items.push({ bitmap, unitsPerEm: font.unitsPerEm, xf });
        return;
      }
      const paths = contours(font, glyph, scale).map((c) => c.map(xf));
      if (paths.length) items.push({ color: fg, paths });
    });

    // Underline / strikethrough, from the primary font's metrics.
    const os2 = primary['OS/2'];
    const s = primaryScale;
    const bar = (topAboveBaseline, thickness) => {
      const x0 = shift - o.embolden;
      const x1 = shift + width + o.embolden;
      const y0 = baseline - topAboveBaseline;
      const pts = [[x0, y0], [x1, y0], [x1, y0 + thickness], [x0, y0 + thickness]];
      decorations.push(pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
    };
    if (o.underline && width > 0) {
      const t = o.decorationThickness ?? (primary.underlineThickness || primary.unitsPerEm * 0.05) * s;
      const top = o.underlineOffset != null ? -o.underlineOffset : (primary.underlinePosition || -primary.unitsPerEm * 0.1) * s;
      bar(top, t);
    }
    if (o.strikethrough && width > 0) {
      const t = o.decorationThickness ?? (os2?.yStrikeoutSize || primary.unitsPerEm * 0.05) * s;
      const top = (os2?.yStrikeoutPosition || (primary.xHeight || primary.unitsPerEm * 0.5) * 0.5 + t / s / 2) * s;
      bar(top, t);
    }
  });

  // Bitmap glyphs: quantize all of them to one shared color set, then trace.
  const bitmapItems = items.filter((it) => it.bitmap);
  if (bitmapItems.length) {
    // (With a --palette, the found colors are mapped to it later along with everything else;
    // mapping pixels straight to the palette turns anti-aliased edges into stray rims.)
    const count = o.palette ? Math.max(o.bitmapColors, 16) : o.bitmapColors;
    const colors = quantizeBitmaps(bitmapItems.map((it) => it.bitmap), { count });
    for (const it of bitmapItems) {
      const traced = traceBitmap(it.bitmap, it.unitsPerEm);
      it.parts = [...traced].map(([label, rects]) => ({ color: colors[label], paths: rects.map((r) => r.map(it.xf)) }));
    }
  }
  const flat = items.flatMap((it) => (it.bitmap ? it.parts : [it]));
  if (decorations.length) flat.push({ color: 'fg', paths: decorations });

  // Resolve painter's order top-down so each region only keeps what's visible.
  let covered = [];
  const visible = [];
  for (let i = flat.length - 1; i >= 0; i--) {
    let shape = union(flat[i].paths);
    if (o.embolden && flat[i].paths !== decorations) shape = offset(shape, o.embolden, JoinType.jtMiter, 2, o.tolerance);
    if (!shape.length) continue;
    const vis = covered.length ? difference(shape, covered) : shape;
    covered = covered.length ? union(covered, shape) : shape;
    if (vis.length) visible.push({ color: flat[i].color, shape: vis });
  }

  // Merge regions of the same color.
  const byColor = new Map();
  for (const r of visible.reverse()) {
    const key = r.color === 'fg' ? 'fg' : toHex(r.color);
    const entry = byColor.get(key);
    if (entry) entry.shapes.push(r.shape);
    else byColor.set(key, { color: r.color, shapes: [r.shape] });
  }
  const regions = [...byColor.values()]
    .map((e) => ({ color: e.color, shape: union(...e.shapes) }))
    .filter((r) => area(r.shape) > 0);
  return { regions, solid: covered };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fontkit from 'fontkit';

const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?|dfont)$/i;

export const fontDirs = () =>
  [
    path.resolve('fonts'), // project-local fonts take priority
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library/Fonts'),
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local/share/fonts'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'),
  ].filter(Boolean);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fontNames(font) {
  const names = new Set([font.fullName, font.postscriptName].filter(Boolean));
  const fam = font.familyName;
  const sub = font.subfamilyName || '';
  if (fam) {
    names.add(`${fam} ${sub}`.trim());
    if (/^(regular|roman|book|normal)?$/i.test(sub)) names.add(fam);
  }
  return [...names];
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (FONT_EXT.test(e.name)) yield p;
  }
}

/**
 * Glyph stand-in for bitmap-only color fonts (CBDT without glyf/CFF outlines). fontkit can't
 * create glyphs for those, which breaks shaping; this provides ids and advances so ligatures
 * (skin tones, flags, ZWJ sequences) still work. The images are read in ./color.mjs.
 */
class BitmapGlyph {
  constructor(id, codePoints, font) {
    this.id = id;
    this.codePoints = codePoints;
    this._font = font;
    this.isMark = false;
    this.isLigature = codePoints.length > 1;
  }
  get advanceWidth() {
    const t = this._font.hmtx;
    const m = this.id < t.metrics.length ? t.metrics.get(this.id) : t.metrics.get(t.metrics.length - 1);
    return m?.advance ?? 0;
  }
  get advanceHeight() {
    return this._font.unitsPerEm;
  }
  get path() {
    const box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { commands: [], cbox: box, bbox: box };
  }
  get cbox() {
    return this.path.cbox;
  }
  get bbox() {
    return this.path.bbox;
  }
}

export function prepareFont(font) {
  const t = font.directory.tables;
  if (t.COLR && t.CPAL && t.glyf) {
    // fontkit bug: composite glyphs fetch their components via getGlyph(), which returns a
    // COLRGlyph (no outline methods) in color fonts. Delegate to the outline glyph.
    // (Both kinds share one glyph cache, so build the outline glyph class directly.)
    const saved = font._glyphs;
    font._glyphs = {};
    const OutlineGlyph = font._getBaseGlyph(0).constructor;
    font._glyphs = saved;
    const proto = Object.getPrototypeOf(font.getGlyph(0));
    if (!proto._getContours) {
      proto._getContours = function () {
        this._outline ??= new OutlineGlyph(this.id, this.codePoints, this._font);
        return this._outline._getContours();
      };
    }
  }
  if (!t.glyf && !t.CFF && !t.CFF2 && (t.CBDT || t.sbix)) {
    font._getBaseGlyph = function (id, codePoints = []) {
      if (!this._glyphs[id]) this._glyphs[id] = new BitmapGlyph(id, codePoints, this);
      return this._glyphs[id];
    };
  }
  return font;
}

export function isColorFont(font) {
  const t = font.directory.tables;
  return Boolean((t.COLR && t.CPAL) || t.CBDT || t.sbix);
}

export function fontStyle(font) {
  const os2 = font['OS/2'];
  const sub = font.getName('preferredSubfamily') || font.subfamilyName || '';
  let weight = os2?.usWeightClass;
  if (!(weight >= 100 && weight <= 1000)) {
    weight = /black|heavy/i.test(sub) ? 900 : /extra ?bold|ultra ?bold/i.test(sub) ? 800
      : /semi ?bold|demi/i.test(sub) ? 600 : /bold/i.test(sub) ? 700 : /medium/i.test(sub) ? 500
      : /light/i.test(sub) ? 300 : 400;
  }
  const italic = Boolean(os2?.fsSelection?.italic || os2?.fsSelection?.oblique || font.italicAngle ||
    /italic|oblique/i.test(sub));
  const family = font.getName('preferredFamily') || font.familyName;
  return { weight, italic, family, condensed: /condensed|narrow|compressed/i.test(sub) };
}

function openFile(file, index = 0) {
  const f = fontkit.openSync(file);
  return prepareFont(f.fonts ? f.fonts[index] : f);
}

let fontIndex = null;

/** Metadata for every installed font face (cached; font data itself isn't kept in memory). */
export function systemFonts() {
  if (fontIndex) return fontIndex;
  fontIndex = [];
  const seen = new Set();
  for (const dir of fontDirs()) {
    for (const file of walk(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let f;
      try {
        f = fontkit.openSync(file);
      } catch {
        continue;
      }
      const faces = f.fonts || [f];
      for (let index = 0; index < faces.length; index++) {
        try {
          const face = faces[index];
          fontIndex.push({ file, index, names: fontNames(face), style: fontStyle(face), familyName: face.familyName });
        } catch {
          /* unreadable face */
        }
      }
    }
  }
  return fontIndex;
}

/**
 * Load a font from a file path, URL, or installed font name (installed fonts include a
 * ./fonts directory in the working directory). Returns { font, file }.
 */
export async function loadFont(spec, index) {
  if (/^https?:\/\//i.test(spec)) {
    const res = await fetch(spec);
    if (!res.ok) throw new Error(`could not download font (${res.status} ${res.statusText}): ${spec}`);
    const f = fontkit.create(Buffer.from(await res.arrayBuffer()));
    return { font: prepareFont(f.fonts ? f.fonts[index ?? 0] : f), file: null };
  }
  const p = spec.replace(/^~(?=$|\/)/, os.homedir());
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return { font: openFile(p, index), file: p };

  const target = norm(spec);
  let fallback = null;
  for (const entry of systemFonts()) {
    if (entry.names.some((n) => norm(n) === target)) return { font: openFile(entry.file, entry.index), file: entry.file };
    if (!fallback && norm(path.parse(entry.file).name) === target) fallback = entry;
  }
  if (fallback) return { font: openFile(fallback.file, fallback.index), file: fallback.file };
  throw new Error(`font "${spec}" not found (pass a font file path or URL, or use --list-fonts)`);
}

const EMOJI_FONTS = ['Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji', 'Twemoji Mozilla', 'OpenMoji Color'];

/** An installed color emoji font, or null. */
export function findEmojiFont() {
  for (const name of EMOJI_FONTS) {
    const entry = systemFonts().find((e) => e.names.some((n) => norm(n) === norm(name)));
    if (entry) {
      try {
        return openFile(entry.file, entry.index);
      } catch {
        /* try the next one */
      }
    }
  }
  return null;
}

/**
 * Find the bold and/or italic face of `base`'s family among installed fonts (and the base
 * font's own directory). Returns null if the family has no suitable face.
 */
function findStyledFace(base, baseFile, { bold, italic }) {
  const want = fontStyle(base);
  const targetWeight = bold ? (want.weight >= 600 ? 900 : 700) : want.weight;
  const targetItalic = italic || want.italic;
  const fams = new Set([norm(want.family), norm(base.familyName)]);

  const candidates = [];
  if (baseFile) {
    const dir = path.dirname(baseFile);
    for (const file of fs.readdirSync(dir)) {
      if (!FONT_EXT.test(file)) continue;
      try {
        const f = fontkit.openSync(path.join(dir, file));
        (f.fonts || [f]).forEach((face, index) =>
          candidates.push({ file: path.join(dir, file), index, style: fontStyle(face), familyName: face.familyName }),
        );
      } catch {
        /* unreadable */
      }
    }
  }
  candidates.push(...systemFonts());

  let best = null;
  for (const c of candidates) {
    const s = c.style;
    if (!fams.has(norm(s.family)) && !fams.has(norm(c.familyName))) continue;
    if (s.italic !== targetItalic || s.condensed !== want.condensed) continue;
    if (bold ? s.weight < want.weight + 150 : Math.abs(s.weight - want.weight) > 50) continue;
    const score = Math.abs(s.weight - targetWeight);
    if (!best || score < best.score) best = { c, score };
  }
  return best ? openFile(best.c.file, best.c.index) : null;
}

/**
 * Resolve bold/italic for a font: a real face from the family first, then variable-font axes,
 * and finally synthetic emboldening/slanting (reported via `synthBold` / `synthItalic`).
 */
export function resolveStyle(font, file, { bold, italic, synthetic, variations = {} }, log) {
  const vars = { ...variations };
  let needBold = bold;
  let needItalic = italic;
  const baseStyle = fontStyle(font);
  if (needItalic && baseStyle.italic) {
    log('note: font is already italic');
    needItalic = false;
  }
  if ((needBold || needItalic) && !synthetic) {
    // Prefer a face with both styles; otherwise one of them, getting the other from an axis
    // or synthesis below.
    const tries = [{ bold: needBold, italic: needItalic }];
    if (needBold && needItalic) tries.push({ bold: false, italic: true }, { bold: true, italic: false });
    for (const want of tries) {
      const face = findStyledFace(font, file, want);
      if (face) {
        log(`using face "${face.fullName}"`);
        font = face;
        if (want.bold) needBold = false;
        if (want.italic) needItalic = false;
        break;
      }
    }
  }
  const axes = font.variationAxes || {};
  if (needBold && !synthetic && axes.wght && !('wght' in vars)) {
    const target = baseStyle.weight >= 600 ? 900 : 700;
    if (axes.wght.min <= target && target <= axes.wght.max && axes.wght.default < target) {
      vars.wght = target;
      needBold = false;
    }
  }
  if (needItalic && !synthetic) {
    if (axes.ital && !('ital' in vars) && axes.ital.max >= 1) {
      vars.ital = 1;
      needItalic = false;
    } else if (axes.slnt && !('slnt' in vars) && axes.slnt.min < 0) {
      vars.slnt = Math.max(axes.slnt.min, -12);
      needItalic = false;
    }
  }
  if (Object.keys(vars).length) font = prepareFont(font.getVariation(vars));
  if (needBold || needItalic) {
    log(`synthesizing ${[needBold && 'bold', needItalic && 'italic'].filter(Boolean).join(' + ')}`);
  }
  return { font, synthBold: needBold, synthItalic: needItalic };
}

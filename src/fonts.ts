/**
 * Font loading (files, URLs, bytes, installed names), fontkit workarounds, and bold/italic
 * resolution.
 */
import { bitmapFontToTtf, isBmfont, isZip, parseBmfont, readBmfontFiles, readBmfontZip } from '@tootallnate/bitmap-font';
import { createFont, openFaces, type Font, type Glyph } from './fontkit.js';
import { basename, dirname, findFile, fontDirs, fontFiles, readFile, sibling } from './system.js';
import { TextrudeError } from './errors.js';

// ----- Bitmap fonts -----
//
// AngelCode BMFont (a .fnt descriptor plus PNG/TGA page images) is the common bitmap font format.
// Its glyphs are traced into outlines and the result is a TrueType font in memory, so layout,
// kerning and everything downstream treat it like any other font.

const bmfontError = (err: unknown) => new TextrudeError(`could not read bitmap font: ${(err as Error).message}`);

/** Font file bytes, with a zipped BMFont converted to TrueType. */
function fontBytes(data: Uint8Array): Uint8Array {
  if (isZip(data)) {
    try {
      return bitmapFontToTtf(readBmfontZip(data));
    } catch (err) {
      const e = bmfontError(err);
      if (/page/.test(e.message)) e.message += ' (the .fnt and its page images go together)';
      throw e;
    }
  }
  if (isBmfont(data)) {
    throw new TextrudeError('a BMFont .fnt needs its page images: pass the .fnt file path or URL, or a .zip of the .fnt and its pages');
  }
  return data;
}

/** A BMFont descriptor plus its pages, fetched by `readPage` (page names are relative to the .fnt), as TrueType. */
async function bmfontToTtf(descriptor: Uint8Array, name: string, readPage: (page: string) => Uint8Array | Promise<Uint8Array>): Promise<Uint8Array> {
  try {
    const files = new Map([[name, descriptor]]);
    for (const page of parseBmfont(descriptor).pages) files.set(page, await readPage(page));
    return bitmapFontToTtf(readBmfontFiles(files, name));
  } catch (err) {
    throw err instanceof TextrudeError ? err : bmfontError(err);
  }
}

/** A font file's bytes (TrueType for bitmap fonts), reading BMFont pages from beside it. */
async function readFontFile(file: string, data = readFile(file)): Promise<Uint8Array> {
  if (!isBmfont(data)) return fontBytes(data);
  return bmfontToTtf(data, basename(file), (page) => {
    const p = findFile(sibling(file, page));
    if (!p) throw new TextrudeError(`BMFont page "${page}" not found next to ${file}`);
    return readFile(p);
  });
}

const norm = (s: string | null | undefined) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fontNames(font: Font): string[] {
  const names = new Set([font.fullName, font.postscriptName].filter(Boolean));
  const fam = font.familyName;
  const sub = font.subfamilyName || '';
  if (fam) {
    names.add(`${fam} ${sub}`.trim());
    if (/^(regular|roman|book|normal)?$/i.test(sub)) names.add(fam);
  }
  return [...names];
}

/**
 * Glyph stand-in for bitmap-only color fonts (CBDT without glyf/CFF outlines). fontkit can't
 * create glyphs for those, which breaks shaping; this provides ids and advances so ligatures
 * (skin tones, flags, ZWJ sequences) still work. The images are read in ./emoji.ts.
 */
class BitmapGlyph implements Glyph {
  isMark = false;
  isLigature: boolean;
  constructor(
    public id: number,
    public codePoints: number[],
    private _font: Font,
  ) {
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

type GlyphProto = Glyph & { _font: Font; _outline?: Glyph };

/** Work around fontkit limitations for color fonts. Call on every font fontkit returns. */
export function prepareFont(font: Font): Font {
  const t = font.directory.tables;
  if (t.COLR && t.CPAL && t.glyf) {
    // fontkit bug: composite glyphs fetch their components via getGlyph(), which returns a
    // COLRGlyph (no outline methods) in color fonts. Delegate to the outline glyph. (Both
    // kinds share one glyph cache, so build the outline glyph class directly.)
    const saved = font._glyphs;
    font._glyphs = {};
    const OutlineGlyph = font._getBaseGlyph(0).constructor as new (id: number, cps: number[], font: Font) => Glyph;
    font._glyphs = saved;
    const proto = Object.getPrototypeOf(font.getGlyph(0)) as GlyphProto;
    if (!Object.hasOwn(proto, '_getContours')) {
      proto._getContours = function (this: GlyphProto) {
        this._outline ??= new OutlineGlyph(this.id, this.codePoints, this._font);
        return this._outline._getContours!();
      };
    }
  }
  if (!t.glyf && !t.CFF && !t.CFF2 && (t.CBDT || t.sbix)) {
    font._getBaseGlyph = function (this: Font, id: number, codePoints: number[] = []) {
      this._glyphs[id] ??= new BitmapGlyph(id, codePoints, this);
      return this._glyphs[id]!;
    };
  }
  return font;
}

export function isColorFont(font: Font): boolean {
  const t = font.directory.tables;
  return Boolean((t.COLR && t.CPAL) || t.CBDT || t.sbix);
}

export interface FontStyle {
  weight: number;
  italic: boolean;
  family: string;
  condensed: boolean;
}

export function fontStyle(font: Font): FontStyle {
  const os2 = font['OS/2'];
  const sub = font.getName('preferredSubfamily') || font.subfamilyName || '';
  let weight = os2?.usWeightClass ?? 0;
  if (!(weight >= 100 && weight <= 1000)) {
    weight = /black|heavy/i.test(sub) ? 900
      : /extra ?bold|ultra ?bold/i.test(sub) ? 800
      : /semi ?bold|demi/i.test(sub) ? 600
      : /bold/i.test(sub) ? 700
      : /medium/i.test(sub) ? 500
      : /light/i.test(sub) ? 300
      : 400;
  }
  const italic = Boolean(os2?.fsSelection?.italic || os2?.fsSelection?.oblique || font.italicAngle || /italic|oblique/i.test(sub));
  const family = font.getName('preferredFamily') || font.familyName;
  return { weight, italic, family, condensed: /condensed|narrow|compressed/i.test(sub) };
}

const openPrepared = (file: string, index = 0) => prepareFont(createFont(readFile(file), index));

export interface FontEntry {
  file: string;
  index: number;
  names: string[];
  style: FontStyle;
  familyName: string;
}

let fontIndex: FontEntry[] | null = null;

/** Metadata for every installed font face (cached; the font data itself isn't kept). */
export function systemFonts(): FontEntry[] {
  if (fontIndex) return fontIndex;
  const entries: FontEntry[] = [];
  const seen = new Set<string>();
  for (const dir of fontDirs()) {
    for (const file of fontFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let faces: Font[];
      try {
        faces = openFaces(readFile(file));
      } catch {
        continue;
      }
      faces.forEach((face, index) => {
        try {
          entries.push({ file, index, names: fontNames(face), style: fontStyle(face), familyName: face.familyName });
        } catch {
          /* unreadable face */
        }
      });
    }
  }
  return (fontIndex = entries);
}

export interface LoadedFont {
  font: Font;
  /** The font file (null for fonts loaded from a URL or bytes). */
  file: string | null;
}

/** A font name, file path, or URL, or the contents of a font file. */
export type FontSource = string | Uint8Array | ArrayBuffer;

// Parsed fonts by their data, so passing the same bytes again (e.g. re-rendering in a live
// preview) reuses the parsed font and its glyph cache.
const parsed = new WeakMap<object, Map<number, Font>>();

function fromBytes(data: Uint8Array | ArrayBuffer, index = 0): Font {
  let byIndex = parsed.get(data);
  if (!byIndex) parsed.set(data, (byIndex = new Map()));
  let font = byIndex.get(index);
  if (!font) {
    try {
      font = prepareFont(createFont(fontBytes(data instanceof Uint8Array ? data : new Uint8Array(data)), index));
    } catch (err) {
      if (err instanceof TextrudeError) throw err;
      throw new TextrudeError(`could not read font: ${(err as Error).message}`);
    }
    byIndex.set(index, font);
  }
  return font;
}

async function download(url: string, what = 'font'): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new TextrudeError(`could not download ${what} (${res.status} ${res.statusText}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load a font from bytes, a URL, a file path, or an installed font name (installed fonts include
 * a ./fonts directory in the working directory). Bitmap fonts in BMFont format load as a .fnt
 * path or URL (its pages are read from beside it) or as a .zip of the .fnt and its pages.
 */
export async function loadFont(spec: FontSource, index?: number): Promise<LoadedFont> {
  if (typeof spec !== 'string') return { font: fromBytes(spec, index), file: null };
  if (/^(https?|blob|data):/i.test(spec)) {
    let data = await download(spec);
    if (isBmfont(data)) {
      const name = decodeURIComponent(new URL(spec).pathname.split('/').pop() || 'font.fnt');
      data = await bmfontToTtf(data, name, (page) => download(new URL(page, spec).href, 'BMFont page'));
    }
    return { font: fromBytes(data, index), file: null };
  }
  const p = findFile(spec);
  if (p) {
    const data = readFile(p);
    if (isBmfont(data) || isZip(data)) return { font: prepareFont(createFont(await readFontFile(p, data), index)), file: p };
    return { font: openPrepared(p, index), file: p };
  }

  const target = norm(spec);
  let fallback: FontEntry | null = null;
  for (const entry of systemFonts()) {
    if (entry.names.some((n) => norm(n) === target)) return { font: openPrepared(entry.file, entry.index), file: entry.file };
    if (!fallback && norm(basename(entry.file)) === target) fallback = entry;
  }
  if (fallback) return { font: openPrepared(fallback.file, fallback.index), file: fallback.file };
  throw new TextrudeError(
    fontDirs().length
      ? `font "${spec}" not found (pass a font file path or URL, or use --list-fonts)`
      : `font "${spec}" not found (installed fonts aren't available here: pass a font URL or the font file's contents)`,
  );
}

const EMOJI_FONTS = ['Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji', 'Twemoji Mozilla', 'OpenMoji Color'];

/** An installed color emoji font, or null. */
export function findEmojiFont(): Font | null {
  for (const name of EMOJI_FONTS) {
    const entry = systemFonts().find((e) => e.names.some((n) => norm(n) === norm(name)));
    if (entry) {
      try {
        return openPrepared(entry.file, entry.index);
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
function findStyledFace(base: Font, baseFile: string | null, { bold, italic }: { bold: boolean; italic: boolean }): Font | null {
  const want = fontStyle(base);
  const targetWeight = bold ? (want.weight >= 600 ? 900 : 700) : want.weight;
  const targetItalic = italic || want.italic;
  const fams = new Set([norm(want.family), norm(base.familyName)]);

  const candidates: Pick<FontEntry, 'file' | 'index' | 'style' | 'familyName'>[] = [];
  if (baseFile) {
    for (const file of fontFiles(dirname(baseFile), false)) {
      try {
        openFaces(readFile(file)).forEach((face, index) => candidates.push({ file, index, style: fontStyle(face), familyName: face.familyName }));
      } catch {
        /* unreadable */
      }
    }
  }
  candidates.push(...systemFonts());

  let best: { c: (typeof candidates)[number]; score: number } | null = null;
  for (const c of candidates) {
    const s = c.style;
    if (!fams.has(norm(s.family)) && !fams.has(norm(c.familyName))) continue;
    if (s.italic !== targetItalic || s.condensed !== want.condensed) continue;
    if (bold ? s.weight < want.weight + 150 : Math.abs(s.weight - want.weight) > 50) continue;
    const score = Math.abs(s.weight - targetWeight);
    if (!best || score < best.score) best = { c, score };
  }
  return best ? openPrepared(best.c.file, best.c.index) : null;
}

export interface StyleRequest {
  bold?: boolean;
  italic?: boolean;
  /** Skip face lookup and variable axes; always synthesize. */
  synthetic?: boolean;
  /** Explicit variable-font axis settings. */
  variations?: Record<string, number>;
}

export interface ResolvedStyle {
  font: Font;
  /** Bold has to be synthesized (no face or axis provides it). */
  synthBold: boolean;
  /** Italic has to be synthesized. */
  synthItalic: boolean;
}

/**
 * Resolve bold/italic for a font: a real face from the family first, then variable-font axes,
 * and finally synthetic emboldening/slanting (reported via `synthBold` / `synthItalic`).
 */
export function resolveStyle(font: Font, file: string | null, req: StyleRequest, log: (msg: string) => void = () => {}): ResolvedStyle {
  const vars = { ...req.variations };
  let needBold = Boolean(req.bold);
  let needItalic = Boolean(req.italic);
  const baseStyle = fontStyle(font);
  if (needItalic && baseStyle.italic) {
    log('note: font is already italic');
    needItalic = false;
  }
  if ((needBold || needItalic) && !req.synthetic) {
    // Prefer a face with both styles; otherwise one of them, getting the other from an axis or
    // synthesis below.
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
  if (needBold && !req.synthetic && axes.wght && !('wght' in vars)) {
    const target = baseStyle.weight >= 600 ? 900 : 700;
    if (axes.wght.min <= target && target <= axes.wght.max && axes.wght.default < target) {
      vars.wght = target;
      needBold = false;
    }
  }
  if (needItalic && !req.synthetic) {
    if (axes.ital && !('ital' in vars) && axes.ital.max >= 1) {
      vars.ital = 1;
      needItalic = false;
    } else if (axes.slnt && !('slnt' in vars) && axes.slnt.min < 0) {
      vars.slnt = Math.max(axes.slnt.min, -12);
      needItalic = false;
    }
  }
  if (Object.keys(vars).length) font = prepareFont(font.getVariation(vars));
  if (needBold || needItalic) log(`synthesizing ${[needBold && 'bold', needItalic && 'italic'].filter(Boolean).join(' + ')}`);
  return { font, synthBold: needBold, synthItalic: needItalic };
}

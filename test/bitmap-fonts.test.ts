import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bitmapFontToBmfont, bitmapFontToBmfontZip, type BitmapFont, type BitmapGlyph } from '@tootallnate/bitmap-font';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadFont } from '../src/fonts.js';
import { textrude, TextrudeError } from '../src/index.js';
import { checkMeshes } from './helpers.js';

/** Anti-aliased coverage of a shape, by 4×4 supersampling. */
function raster(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let s = 0; s < 16; s++) if (inside(x + ((s % 4) + 0.5) / 4, y + ((s >> 2) + 0.5) / 4)) n++;
      out[y * w + x] = Math.round((n * 255) / 16);
    }
  }
  return out;
}

const glyph = (cp: number, w: number, h: number, inside: (x: number, y: number) => boolean): BitmapGlyph => ({
  codepoints: [cp],
  advance: w + 4,
  x: 2,
  y: 8,
  width: w,
  height: h,
  coverage: raster(w, h, inside),
});

/** A 48 px anti-aliased font with "I" (a bar) and "O" (a ring), and a space. */
const font: BitmapFont = {
  family: 'Synthetic Bitmap',
  emSize: 48,
  lineHeight: 48,
  base: 40,
  glyphs: [
    glyph(0x49, 10, 32, (x) => x >= 1 && x < 9),
    glyph(0x4f, 30, 32, (x, y) => {
      const d = Math.hypot((x - 15) / 14, (y - 16) / 15);
      return d <= 1 && d >= 0.55;
    }),
    { codepoints: [0x20], advance: 12, x: 0, y: 0, width: 0, height: 0, coverage: new Uint8Array(0) },
  ],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textrude-bmfont-'));
const { files } = bitmapFontToBmfont(font, 'synthetic');
// Pages in a subfolder, referenced by relative path from the .fnt.
fs.mkdirSync(path.join(dir, 'pages'));
const fnt = new TextDecoder().decode(files.get('synthetic.fnt')).replace('file="synthetic_0.png"', 'file="pages/synthetic_0.png"');
fs.writeFileSync(path.join(dir, 'synthetic.fnt'), fnt);
fs.writeFileSync(path.join(dir, 'pages', 'synthetic_0.png'), files.get('synthetic_0.png')!);
const FNT = path.join(dir, 'synthetic.fnt');
const ZIP = bitmapFontToBmfontZip(font, 'synthetic');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('BMFont bitmap fonts', () => {
  it('loads a .fnt file, reading its pages from beside it', async () => {
    const { font: f, file } = await loadFont(FNT);
    expect(file).toBe(FNT);
    expect(f.familyName).toBe('Synthetic Bitmap');
    expect(f.hasGlyphForCodePoint(0x49)).toBe(true);
    expect(f.hasGlyphForCodePoint(0x4f)).toBe(true);
    // The ring traces to an outer contour and a hole.
    const ring = f.layout('O').glyphs[0]!.path.commands.filter((c) => c.command === 'moveTo');
    expect(ring).toHaveLength(2);
  });

  it('loads a zipped BMFont from bytes or a file', async () => {
    expect((await loadFont(ZIP)).font.familyName).toBe('Synthetic Bitmap');
    const zipFile = path.join(dir, 'synthetic.zip');
    fs.writeFileSync(zipFile, ZIP);
    expect((await loadFont(zipFile)).font.familyName).toBe('Synthetic Bitmap');
  });

  it('loads a .fnt URL, fetching its pages relative to it', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      const file = url.endsWith('.fnt') ? FNT : path.join(dir, 'pages', 'synthetic_0.png');
      return new Response(fs.readFileSync(file));
    });
    try {
      const { font: f } = await loadFont('https://example.com/fonts/synthetic.fnt');
      expect(f.familyName).toBe('Synthetic Bitmap');
      expect(fetched).toEqual(['https://example.com/fonts/synthetic.fnt', 'https://example.com/fonts/pages/synthetic_0.png']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('explains what a bare .fnt needs, and which page is missing', async () => {
    await expect(loadFont(new TextEncoder().encode(fnt))).rejects.toThrow(/needs its page images/);
    const lonely = path.join(dir, 'lonely.fnt');
    fs.writeFileSync(lonely, fnt);
    fs.mkdirSync(path.join(dir, 'empty'));
    fs.renameSync(lonely, path.join(dir, 'empty', 'lonely.fnt'));
    const err = await loadFont(path.join(dir, 'empty', 'lonely.fnt')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TextrudeError);
    expect((err as Error).message).toMatch(/page "pages\/synthetic_0.png" not found/);
  });

  it('renders text to a valid, watertight 3MF', async () => {
    const result = await textrude('IO OI', { font: FNT, size: 20, strokeWidth: 1, connect: true });
    expect(result.parts.length).toBeGreaterThan(0);
    // Two em-wide-ish letters per word at 20 mm per 48 px.
    expect(result.width).toBeGreaterThan(20);
    const meshes = checkMeshes(result.to3MF());
    for (const m of meshes) {
      expect(m.badEdges, m.name).toBe(0);
      expect(m.volume, m.name).toBeGreaterThan(0);
    }
  });
});

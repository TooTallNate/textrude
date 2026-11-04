import { describe, expect, it } from 'vitest';
import { loadFont, resolveStyle, fontStyle, isColorFont } from '../src/fonts.js';
import { TextrudeError } from '../src/errors.js';
import { BLOBMOJI, INTER, INTER_VARIABLE, TWEMOJI } from './helpers.js';

describe('loadFont', () => {
  it('loads font files', async () => {
    const { font, file } = await loadFont(INTER);
    expect(font.fullName).toBe('Inter Regular');
    expect(file).toBe(INTER);
  });

  it('throws a TextrudeError for unknown fonts', async () => {
    await expect(loadFont('Definitely Not A Font 123')).rejects.toBeInstanceOf(TextrudeError);
  });

  it('detects color fonts', async () => {
    expect(isColorFont((await loadFont(TWEMOJI)).font)).toBe(true);
    expect(isColorFont((await loadFont(BLOBMOJI)).font)).toBe(true);
    expect(isColorFont((await loadFont(INTER)).font)).toBe(false);
  });

  it('shapes bitmap-only (CBDT) fonts, including ligatures', async () => {
    const { font } = await loadFont(BLOBMOJI);
    const run = font.layout('👍🏽🇺🇸');
    expect(run.glyphs).toHaveLength(2);
    expect(run.glyphs[0]!.codePoints).toEqual([0x1f44d, 0x1f3fd]);
  });
});

describe('resolveStyle', () => {
  it("uses the family's real bold and italic faces from the font's folder", async () => {
    const { font, file } = await loadFont(INTER);
    const bold = resolveStyle(font, file, { bold: true });
    expect(bold.font.fullName).toBe('Inter Bold');
    expect(bold.synthBold).toBe(false);
    const italic = resolveStyle(font, file, { italic: true });
    expect(italic.font.fullName).toBe('Inter Italic');
    expect(italic.synthItalic).toBe(false);
  });

  it('falls back to synthesizing what no face provides', async () => {
    const { font, file } = await loadFont(INTER);
    // There's a Bold and an Italic, but no Bold Italic: take the italic face, synthesize bold.
    const both = resolveStyle(font, file, { bold: true, italic: true });
    expect(both.font.fullName).toBe('Inter Italic');
    expect(both.synthBold).toBe(true);
    expect(both.synthItalic).toBe(false);
  });

  it("uses a variable font's weight axis", async () => {
    const { font, file } = await loadFont(INTER_VARIABLE);
    const bold = resolveStyle(font, file, { bold: true });
    expect(bold.synthBold).toBe(false);
    // The variation is applied: glyphs get wider.
    const regular = font.layout('H').positions[0]!.xAdvance;
    expect(bold.font.layout('H').positions[0]!.xAdvance).toBeGreaterThan(regular);
  });

  it('always synthesizes with `synthetic`', async () => {
    const { font, file } = await loadFont(INTER);
    const r = resolveStyle(font, file, { bold: true, italic: true, synthetic: true });
    expect(r.font.fullName).toBe('Inter Regular');
    expect([r.synthBold, r.synthItalic]).toEqual([true, true]);
  });

  it('notices fonts that are already italic', async () => {
    const { font, file } = await loadFont(INTER.replace('Regular', 'Italic'));
    expect(fontStyle(font).italic).toBe(true);
    const logs: string[] = [];
    const r = resolveStyle(font, file, { italic: true }, (m) => logs.push(m));
    expect(r.synthItalic).toBe(false);
    expect(logs).toContain('note: font is already italic');
  });
});

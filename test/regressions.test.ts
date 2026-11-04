/**
 * Geometry that broke the mesher before, reproduced with the exact macOS system fonts it
 * happened with. Skipped where those fonts aren't installed (CI runs them on macOS).
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { textrude, type TextrudeOptions } from '../src/index.js';
import { checkMeshes } from './helpers.js';

const HELVETICA = '/System/Library/Fonts/Helvetica.ttc';
const APPLE_EMOJI = '/System/Library/Fonts/Apple Color Emoji.ttc';
const hasHelvetica = fs.existsSync(HELVETICA);

async function expectValid(text: string, options: TextrudeOptions) {
  const result = await textrude(text, options);
  for (const flip of [false, true]) {
    for (const m of checkMeshes(result.to3MF({ flip }))) {
      expect(m.badEdges, `${m.name}: bad edges`).toBe(0);
      expect(m.volume, `${m.name}: volume`).toBeGreaterThan(0);
    }
  }
}

describe.skipIf(!hasHelvetica)('mesher regressions (macOS fonts)', () => {
  it('hole edges collinear with outer-ring vertices ("j" with a stroke)', async () => {
    await expectValid('j', { font: HELVETICA, strokeWidth: 1.5 });
  });

  it('rings touching along an edge (underline + strikethrough + stroke)', async () => {
    await expectValid('Bold Italic', { font: HELVETICA, bold: true, italic: true, underline: true, strikethrough: true, strokeWidth: 1.5, connect: true });
  });

  it('bridges meeting stroke edges exactly', async () => {
    await expectValid('Hi, Ojij!\nWorld ®', { font: HELVETICA, strokeWidth: 1.5, connect: true, align: 'center' });
  });
});

describe.skipIf(!fs.existsSync(APPLE_EMOJI))('sbix bitmap emoji (Apple Color Emoji)', () => {
  it('traces into valid meshes, mapped onto a palette', async () => {
    const result = await textrude('🦄😀', { font: APPLE_EMOJI, palette: ['white', 'black', 'pink', 'purple', 'gold'] });
    expect(result.parts.length).toBeGreaterThan(2);
    for (const m of checkMeshes(result.to3MF())) expect(m.badEdges).toBe(0);
  });
});

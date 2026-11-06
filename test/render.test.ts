import { describe, expect, it } from 'vitest';
import { textrude, plainName, TextrudeError, type TextrudeOptions } from '../src/index.js';
import { BLOBMOJI, INTER, TWEMOJI, checkMeshes, unzip3mf } from './helpers.js';

const base: TextrudeOptions = { font: INTER, fallbackFonts: [TWEMOJI] };

async function render(text: string, options: TextrudeOptions = {}) {
  return textrude(text, { ...base, ...options });
}

/** Every mesh in the 3MF is watertight, manifold, and outward-facing. */
function expectValidMeshes(data: Uint8Array) {
  const meshes = checkMeshes(data);
  expect(meshes.length).toBeGreaterThan(0);
  for (const m of meshes) {
    expect(m.badEdges, `${m.name}: bad edges`).toBe(0);
    expect(m.volume, `${m.name}: volume`).toBeGreaterThan(0);
  }
  return meshes;
}

describe('option matrix', () => {
  const cases: [string, string, TextrudeOptions][] = [
    ['plain text', 'Hello', {}],
    ['stroke + connect', 'Hi, Ojij!', { strokeWidth: 1.5, connect: true }],
    ['multi-line, centered', 'Hello\nWorld', { align: 'center', strokeWidth: 1, connect: true }],
    ['center stroke, miter joins', 'Miter', { strokeWidth: 1, strokeAlign: 'center', strokeJoin: 'miter' }],
    ['inside stroke', 'Inside', { strokeWidth: 0.6, strokeAlign: 'inside', strokeColor: 'red' }],
    ['hollow text', 'Hollow', { color: 'none', strokeWidth: 1, strokeColor: 'black', connect: true }],
    ['synthetic bold + italic', 'Bold', { bold: true, italic: true, synthetic: true, strokeWidth: 1, connect: true }],
    ['underline + strikethrough', 'Lines', { underline: true, strikethrough: true, strokeWidth: 1.5, connect: true }],
    ['letter colors', 'Rainbow', { letterColors: ['red', 'orange', 'gold', 'green'], strokeWidth: 1.5, connect: true }],
    ['COLR emoji', 'Hi 😀👍🏽🇺🇸👨‍👩‍👧', { strokeWidth: 1, connect: true }],
    ['CBDT emoji', 'Hi 😀👍🏽🇺🇸', { fallbackFonts: [BLOBMOJI], strokeWidth: 1, connect: true }],
    ['emoji + max colors', 'Party 🎉🔥', { maxColors: 3, strokeWidth: 1, connect: true }],
    ['background pill', 'Pill 😀', { color: 'white', background: 'navy', backgroundRadius: 999 }],
    ['background + raised text', 'Raised', { background: 'gold', backgroundRadius: 3, textHeight: 3 }],
    ['background + separate stroke', 'Stroke', { strokeWidth: 2, strokeColor: 'gold', background: 'navy', backgroundRadius: 999 }],
    ['ANSI colors + bold', '\x1b[31mRed \x1b[34mBlue', { bold: true, synthetic: true, strokeWidth: 1, connect: true }],
    ['palette', '🔥 Fire', { palette: ['white', 'black', 'orange', 'gold'], strokeWidth: 1, connect: true }],
    ['single path', 'One piece', { strokeWidth: 1.5, connect: true, singlePath: true }],
  ];

  for (const [name, text, options] of cases) {
    it(name, async () => {
      const result = await render(text, options);
      expect(result.parts.length).toBeGreaterThan(0);
      for (const flip of [false, true]) expectValidMeshes(result.to3MF({ printer: 'snapmaker-u1', flip }));
      expect(result.toSVG()).toMatch(/^<\?xml/);
      expect(Buffer.from(result.toPNG()).subarray(1, 4).toString()).toBe('PNG');
    });
  }
});

describe('text', () => {
  it('treats a literal backslash-n as text, and real newlines as line breaks', async () => {
    const literal = await render('a\\nb');
    const lines = await render('a\nb');
    expect(literal.text).toBe('a\\nb');
    expect(lines.depth).toBeGreaterThan(literal.depth * 1.5);
    expect(literal.width).toBeGreaterThan(lines.width);
  });

  it('strips ANSI escapes and turns their colors into user-colored text parts', async () => {
    const result = await render('\x1b[31mRed\x1b[0m \x1b[38;2;0;128;255mBlue');
    expect(result.text).toBe('Red Blue');
    const colors = result.parts.map((p) => p.color).sort();
    expect(colors).toEqual(['#0080ff', '#cd0000']);
    expect(result.parts.every((p) => p.roles.includes('text'))).toBe(true);
  });

  it('can leave ANSI escapes uninterpreted', async () => {
    const result = await render('\x1b[31mRed', { ansi: false });
    expect(result.parts.map((p) => p.color)).toEqual(['#000000']);
  });

  it('expands tabs and normalizes CRLF', async () => {
    expect((await render('a\tb\r\nc')).text).toBe('a    b\nc');
  });

  it('rejects empty text', async () => {
    await expect(render('  ')).rejects.toBeInstanceOf(TextrudeError);
  });
});

describe('fonts and styles', () => {
  it('falls back per character, and reports the fonts used', async () => {
    const result = await render('Hi 😀');
    expect(result.fonts.map((f) => [f.source, f.color])).toEqual([
      ['primary', false],
      ['fallback', true],
    ]);
    expect(result.parts.length).toBeGreaterThan(1);
  });

  it('synthesizes bold (regression: offset() was shadowed)', async () => {
    const regular = await render('🔥', { font: TWEMOJI, fallbackFonts: [] });
    const bold = await render('🔥', { font: TWEMOJI, fallbackFonts: [], bold: true });
    expect(bold.width).toBeGreaterThan(regular.width);
  });

  it('reports synthesized styles', async () => {
    const events: string[] = [];
    await render('x', { bold: true, synthetic: true, onLog: (e) => events.push(e.message) });
    expect(events).toContain('synthesizing bold');
  });
});

describe('emoji', () => {
  it('keeps exact COLR colors', async () => {
    const result = await render('😀', { font: TWEMOJI, fallbackFonts: [] });
    const colors = result.parts.map((p) => p.color);
    expect(colors).toContain('#ffcc4d'); // Twemoji's face yellow
    expect(result.parts.every((p) => p.roles.includes('color'))).toBe(true);
  });

  it('traces CBDT bitmaps into a limited number of colors', async () => {
    const result = await render('😀👍🏽', { font: BLOBMOJI, fallbackFonts: [], bitmapColors: 5 });
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.length).toBeLessThanOrEqual(5);
  });

  it('merges colors down to maxColors, keeping user colors exact', async () => {
    const result = await render('Fire 🔥🎉', { maxColors: 3, strokeWidth: 1, strokeColor: 'white' });
    const colors = new Set(result.parts.map((p) => p.color));
    expect(colors.size).toBeLessThanOrEqual(3);
    expect(colors).toContain('#000000');
    expect(colors).toContain('#ffffff');
  });
});

describe('stroke, background, and bridges', () => {
  it('connects pieces with bridges in the stroke color', async () => {
    const result = await render('i j', { strokeWidth: 0, connect: true });
    expect(result.bridged).toMatchObject({ remaining: 1 });
    expect(result.bridged!.bridges).toBeGreaterThan(0);
  });

  it('uses the background color for the stroke by default', async () => {
    const result = await render('Hi', { strokeWidth: 2, background: 'navy' });
    expect(result.parts).toHaveLength(2);
    expect(result.parts.find((p) => p.color === '#000080')!.roles).toEqual(['stroke', 'background']);
  });

  it('keeps an explicit stroke color separate from the background', async () => {
    const result = await render('Hi', { strokeWidth: 2, strokeColor: 'gold', background: 'navy' });
    expect(result.parts.map((p) => p.roles.join('+')).sort()).toEqual(['background', 'stroke', 'text']);
  });

  it('skips bridges when there is a background', async () => {
    const events: string[] = [];
    const result = await render('i j', { background: 'white', connect: true, onLog: (e) => events.push(e.message) });
    expect(result.bridged).toBeNull();
    expect(events.some((m) => /no bridges are needed/.test(m))).toBe(true);
  });

  it('gives parts their role heights', async () => {
    const result = await render('Raised', { background: 'gold', height: 2, textHeight: 3 });
    expect(Object.fromEntries(result.parts.map((p) => [p.roles[0], p.height]))).toEqual({ text: 3, background: 2 });
    expect(result.height).toBe(3);
  });
});

describe('filaments', () => {
  it('numbers filaments by distinct color', async () => {
    const result = await render('Hi', { strokeWidth: 1 });
    expect(result.parts.map((p) => [p.roles[0], p.filament])).toEqual([
      ['text', 1],
      ['stroke', 2],
    ]);
  });

  it('uses palette slots', async () => {
    const result = await render('Hi', { strokeWidth: 1, strokeColor: '#fefefe', palette: ['red', 'white', 'black'] });
    expect(Object.fromEntries(result.parts.map((p) => [p.color, p.filament]))).toEqual({ '#000000': 3, '#ffffff': 2 });
  });

  it('honors explicit filament numbers', async () => {
    const result = await render('Hi', { strokeWidth: 1, textFilament: 4, strokeFilament: 2 });
    expect(result.parts.map((p) => p.filament)).toEqual([4, 2]);
  });
});

describe('3MF output', () => {
  it('embeds filament colors and presets with a printer profile', async () => {
    const result = await render('Hi 😀', { strokeWidth: 1, connect: true });
    const files = unzip3mf(result.to3MF({ printer: 'snapmaker-u1', filamentPreset: 'Snapmaker PLA Matte @U1' }));
    const project = JSON.parse(files['Metadata/project_settings.config']!);
    expect(project.printer_settings_id).toBe('Snapmaker U1 (0.4 nozzle)');
    expect(project.filament_settings_id[0]).toBe('Snapmaker PLA Matte @U1');
    expect(project.filament_colour).toEqual(
      [...result.parts].sort((a, b) => a.filament - b.filament).map((p) => p.color.toUpperCase()),
    );
    expect(project.different_settings_to_system).toHaveLength(project.filament_colour.length + 2);
    // Centered on the U1's bed.
    expect(files['3D/3dmodel.model']).toMatch(/transform="1 0 0 0 1 0 0 0 1 135.5 136 0"/);
  });

  it('assigns each part its filament in model_settings.config', async () => {
    const result = await render('Hi', { strokeWidth: 1 });
    const settings = unzip3mf(result.to3MF())['Metadata/model_settings.config']!;
    const parts = [...settings.matchAll(/<part id="(\d+)"[^>]*>\s*<metadata key="name" value="([^"]*)"\/>\s*<metadata key="extruder" value="(\d+)"/g)];
    expect(parts.map((m) => [m[2], m[3]])).toEqual(result.parts.map((p) => [p.id, String(p.filament)]));
  });

  it('omits project settings without a printer, and names the object without emoji', async () => {
    const result = await render('Hi 😀🇺🇸');
    const files = unzip3mf(result.to3MF({ position: [10, 20] }));
    expect(files['Metadata/project_settings.config']).toBeUndefined();
    expect(files['3D/3dmodel.model']).toMatch(/name="Hi" type="model"><components>/);
    expect(files['3D/3dmodel.model']).toMatch(/0 0 1 10 20 0"/);
  });

  it('mirrors with flip', async () => {
    const result = await render('L');
    const [normal] = checkMeshes(result.to3MF());
    const [flipped] = checkMeshes(result.to3MF({ flip: true }));
    expect(flipped!.minX).toBeCloseTo(-normal!.maxX, 3);
    expect(flipped!.maxX).toBeCloseTo(-normal!.minX, 3);
  });

  it('rejects unknown printers', async () => {
    const result = await render('Hi');
    expect(() => result.to3MF({ printer: 'nope' })).toThrow(TextrudeError);
  });
});

describe('meshes', () => {
  it('returns one centered mesh per part, matching the 3MF', async () => {
    const result = await render('Hi 😀', { strokeWidth: 1, connect: true, textHeight: 3 });
    const meshes = result.toMeshes();
    expect(meshes.map((m) => m.part)).toEqual(result.parts);
    const reports = checkMeshes(result.to3MF());
    meshes.forEach((m, i) => {
      expect(m.positions.length / 3).toBe(reports[i]!.vertices);
      expect(m.indices.length / 3).toBe(reports[i]!.triangles);
      const zs = m.positions.filter((_, j) => j % 3 === 2);
      expect(Math.max(...zs)).toBeCloseTo(m.part.height, 5);
    });
    const xs = meshes.flatMap((m) => [...m.positions.filter((_, j) => j % 3 === 0)]);
    expect(Math.min(...xs)).toBeCloseTo(-result.width / 2, 3);
    expect(Math.max(...xs)).toBeCloseTo(result.width / 2, 3);
  });
});

describe('SVG output', () => {
  it('writes one path per part, sized in mm', async () => {
    const result = await render('Hi', { strokeWidth: 1 });
    const svg = result.toSVG({ margin: 2 });
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toMatch(/fill="#000000"/);
    expect(svg).toMatch(/fill="#ffffff"/);
    const width = Number(svg.match(/width="([\d.]+)mm"/)![1]);
    expect(width).toBeCloseTo(result.width + 4, 2);
  });
});

describe('plainName', () => {
  it('strips emoji and collapses whitespace', () => {
    expect(plainName('Hi 😀👍🏽 🇺🇸\nthere')).toBe('Hi there');
    expect(plainName('🔥')).toBe('textrude');
  });
});

import { describe, expect, it } from 'vitest';
import { arrange, textrude, TextrudeError, type Part, type TextrudeOptions } from '../src/index.js';
import { bbox, SCALE } from '../src/geometry.js';
import { INTER, TWEMOJI, checkMeshes, unzip3mf } from './helpers.js';

const base: TextrudeOptions = { font: INTER, fallbackFonts: [TWEMOJI] };
const render = (text: string, options: TextrudeOptions = {}) => textrude(text, { ...base, ...options });

/** Bounding box of some parts, in mm. */
const box = (parts: Part[]) => {
  const b = bbox(parts.flatMap((p) => p.shape));
  return { minX: b.minX / SCALE, minY: b.minY / SCALE, maxX: b.maxX / SCALE, maxY: b.maxY / SCALE };
};

describe('arrange', () => {
  it('lays objects out in a row, gap mm apart', async () => {
    const results = await Promise.all(['One', 'Two', 'Three'].map((t) => render(t, { strokeWidth: 1 })));
    const plate = arrange(results, { gap: 4 });
    const boxes = plate.objects.map((o) => box(o.parts));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.minX - boxes[i - 1]!.maxX).toBeCloseTo(4, 3);
    expect(plate.width).toBeCloseTo(results.reduce((w, r) => w + r.width, 0) + 8, 3);
    expect(plate.objects.map((o) => o.name)).toEqual(['One', 'Two', 'Three']);
  });

  it('wraps into rows at maxWidth', async () => {
    const results = await Promise.all(['Aaaa', 'Bbbb', 'Cccc'].map((t) => render(t)));
    const plate = arrange(results, { maxWidth: results[0]!.width * 2 + 10, gap: 5 });
    const [a, b, c] = plate.objects.map((o) => box(o.parts));
    expect(Math.abs(a!.minY - b!.minY)).toBeLessThan(results[0]!.depth);
    expect(c!.minY - Math.max(a!.maxY, b!.maxY)).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(plate.depth).toBeGreaterThan(results[0]!.depth * 2);
  });

  it('shares automatic filament numbers by color across objects', async () => {
    const plate = arrange([await render('A', { color: 'red', strokeWidth: 1 }), await render('B', { color: 'blue', strokeWidth: 1 })]);
    const filaments = Object.fromEntries(plate.parts.map((p) => [p.color, p.filament]));
    expect(filaments).toEqual({ '#ff0000': 1, '#ffffff': 2, '#0000ff': 3 });
  });

  it('keeps palette slots and explicit filaments', async () => {
    const palette = ['white', 'black', 'red'];
    const plate = arrange([await render('A', { palette, strokeWidth: 1 }), await render('B', { textFilament: 7 })]);
    expect(plate.parts.map((p) => p.filament)).toEqual([2, 1, 7]);
  });

  it('writes one 3MF object per text, placed apart and centered on the bed', async () => {
    const results = await Promise.all(['Hi 😀', 'There'].map((t) => render(t, { strokeWidth: 1, connect: true })));
    const plate = arrange(results, { gap: 10 });
    for (const flip of [false, true]) {
      const data = plate.to3MF({ printer: 'snapmaker-u1', flip });
      const files = unzip3mf(data);
      const model = files['3D/3dmodel.model']!;
      expect([...model.matchAll(/name="([^"]*)" type="model"><components>/g)].map((m) => m[1])).toEqual(['Hi', 'There']);
      const xs = [...model.matchAll(/<item objectid="\d+" transform="1 0 0 0 1 0 0 0 1 ([\d.-]+) ([\d.-]+) 0"\/>/g)].map((m) => Number(m[1]));
      expect(xs).toHaveLength(2);
      // Centers are half of each width plus the gap apart; the group is centered on the bed.
      const distance = results[0]!.width / 2 + 10 + results[1]!.width / 2;
      expect(Math.abs(xs[1]! - xs[0]!)).toBeCloseTo(distance, 2);
      expect(flip ? xs[0]! > xs[1]! : xs[0]! < xs[1]!).toBe(true);
      const settings = files['Metadata/model_settings.config']!;
      expect(settings.match(/<model_instance>/g)).toHaveLength(2);
      expect(JSON.parse(files['Metadata/project_settings.config']!).filament_colour.length).toBe(Math.max(...plate.parts.map((p) => p.filament)));
      for (const m of checkMeshes(data)) {
        expect(m.badEdges, m.name).toBe(0);
        expect(m.volume, m.name).toBeGreaterThan(0);
      }
    }
    expect(plate.toSVG().match(/<path id="t2-/g)?.length).toBe(plate.objects[1]!.parts.length);
    expect(Buffer.from(plate.toPNG()).subarray(1, 4).toString()).toBe('PNG');
  });

  it('warns when the plate is bigger than the bed', async () => {
    const results = await Promise.all(['Wide', 'Wider'].map((t) => render(t, { size: 100 })));
    const events: string[] = [];
    arrange(results, { onLog: (e) => events.push(e.message) }).to3MF({ printer: 'snapmaker-u1' });
    expect(events.some((m) => /bed is 270 × 270 mm/.test(m))).toBe(true);
  });

  it('rejects an empty list', () => {
    expect(() => arrange([])).toThrow(TextrudeError);
  });
});

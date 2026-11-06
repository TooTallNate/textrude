import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { decodePng, encodePng } from '../src/png.js';

/** A PNG from raw (already filtered) scanlines. */
function png(width: number, height: number, depth: number, colorType: number, rows: number[][], extra: [string, number[]][] = []) {
  const chunk = (type: string, body: number[]) => {
    const len = body.length;
    return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0];
  };
  const ihdr = [0, 0, 0, width, 0, 0, 0, height, depth, colorType, 0, 0, 0];
  const idat = [...zlibSync(new Uint8Array(rows.flat()))];
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...extra.flatMap(([t, b]) => chunk(t, b)), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}

describe('png', () => {
  it('round-trips RGBA images', () => {
    const image = { width: 7, height: 5, data: new Uint8Array(7 * 5 * 4).map((_, i) => (i * 37) & 255) };
    const decoded = decodePng(encodePng(image));
    expect(decoded.width).toBe(7);
    expect(decoded.height).toBe(5);
    expect([...decoded.data]).toEqual([...image.data]);
  });

  it('decodes palette images with sub-byte depths and transparency', () => {
    // 2-bit indices 0..3, "sub" filtered.
    const decoded = decodePng(png(4, 1, 2, 3, [[1, 0b00011011]], [['PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]], ['tRNS', [0, 128]]]));
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255]);
  });

  it('decodes 16-bit gray + alpha', () => {
    const decoded = decodePng(png(1, 2, 16, 4, [[0, 0xff, 0xff, 0x80, 0x00], [2, 0x00, 0x00, 0x00, 0x00]]));
    expect([...decoded.data]).toEqual([255, 255, 255, 128, 255, 255, 255, 128]);
  });

  it('decodes interlaced images', () => {
    // 2x2 grayscale, Adam7: pass 1 has (0,0), pass 6 has (1,0), pass 7 has row 1.
    const decoded = decodePng(
      (() => {
        const p = png(2, 2, 8, 0, [[0, 10], [0, 20], [0, 30, 40]]);
        p[28] = 1; // interlace method (the CRC isn't checked)
        return p;
      })(),
    );
    expect([...decoded.data].filter((_, i) => i % 4 === 0)).toEqual([10, 20, 30, 40]);
  });

  it('rejects non-PNG data', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

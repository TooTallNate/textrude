import { describe, expect, it } from 'vitest';
import { kmeans, lab, nearestIndex, parseColor, reduceColors, toHex } from '../src/colors.js';

describe('parseColor', () => {
  it('parses hex, short hex, names, and rgb()', () => {
    expect(parseColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseColor('ff8000cc')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseColor('Navy')).toEqual({ r: 0, g: 0, b: 128 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('returns null for none / transparent', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });

  it('throws on invalid colors', () => {
    expect(() => parseColor('nope')).toThrow(/invalid color/);
    expect(() => parseColor('#12')).toThrow();
  });
});

describe('toHex', () => {
  it('rounds and clamps', () => {
    expect(toHex({ r: 254.6, g: -3, b: 300 })).toBe('#ff00ff');
  });
});

describe('nearestIndex', () => {
  it('finds the perceptually nearest palette color', () => {
    const palette = ['black', 'white', 'red', 'gold'].map((c) => lab(parseColor(c)!));
    expect(nearestIndex({ r: 20, g: 20, b: 30 }, palette)).toBe(0);
    expect(nearestIndex({ r: 240, g: 240, b: 235 }, palette)).toBe(1);
    expect(nearestIndex({ r: 200, g: 30, b: 40 }, palette)).toBe(2);
    expect(nearestIndex({ r: 255, g: 204, b: 77 }, palette)).toBe(3);
  });
});

describe('reduceColors', () => {
  const entry = (hex: string, area: number, fixed = false) => ({ hex, color: parseColor(hex)!, area, fixed });

  it('merges the closest colors first', () => {
    const map = reduceColors([entry('#ff0000', 1), entry('#fe0101', 1), entry('#0000ff', 1)], 2);
    expect(new Set(map.values()).size).toBe(2);
    expect(map.get('#ff0000')).toEqual(map.get('#fe0101'));
    expect(map.get('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('keeps fixed (user-chosen) colors exact', () => {
    const map = reduceColors([entry('#000000', 1, true), entry('#202020', 100)], 1);
    expect(map.get('#202020')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('averages unfixed colors by area', () => {
    const map = reduceColors([entry('#000000', 3), entry('#040404', 1)], 1);
    expect(map.get('#000000')).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe('kmeans', () => {
  it('is deterministic and finds the dominant colors', () => {
    const pixels = [...Array(300).fill({ r: 255, g: 0, b: 0 }), ...Array(100).fill({ r: 0, g: 0, b: 255 })];
    const a = kmeans(pixels, 2);
    const b = kmeans(pixels, 2);
    expect(a).toEqual(b);
    expect(a.map(toHex)).toEqual(['#ff0000', '#0000ff']);
  });

  it('returns fewer clusters than k for few distinct colors', () => {
    expect(kmeans([{ r: 1, g: 2, b: 3 }], 8)).toHaveLength(1);
    expect(kmeans([], 8)).toEqual([]);
  });
});

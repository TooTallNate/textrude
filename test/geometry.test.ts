import { describe, expect, it } from 'vitest';
import { SCALE, JoinType, area, bbox, components, difference, makeBridges, offset, roundedRect, union, type Shape } from '../src/geometry.js';

const rect = (x0: number, y0: number, x1: number, y1: number): Shape => [
  [
    { X: x0 * SCALE, Y: y0 * SCALE },
    { X: x1 * SCALE, Y: y0 * SCALE },
    { X: x1 * SCALE, Y: y1 * SCALE },
    { X: x0 * SCALE, Y: y1 * SCALE },
  ],
];

describe('roundedRect', () => {
  it('is a plain rectangle with radius 0', () => {
    const r = roundedRect(0, 0, 10, 5, 0, 0.01);
    expect(Math.abs(area(r))).toBeCloseTo(50, 6);
  });

  it('clamps the radius like CSS, giving a pill', () => {
    const pill = roundedRect(0, 0, 20, 10, 999, 0.001);
    // A 20x10 stadium: a 10x10 rectangle plus a circle of radius 5.
    expect(Math.abs(area(pill))).toBeCloseTo(100 + Math.PI * 25, 1);
    const b = bbox(pill);
    expect((b.maxX - b.minX) / SCALE).toBeCloseTo(20, 3);
    expect((b.maxY - b.minY) / SCALE).toBeCloseTo(10, 3);
  });

  it('gives a circle for a square', () => {
    expect(Math.abs(area(roundedRect(0, 0, 10, 10, 999, 0.001)))).toBeCloseTo(Math.PI * 25, 1);
  });
});

describe('boolean ops', () => {
  it('unions, subtracts, and offsets', () => {
    const u = union(rect(0, 0, 10, 10), rect(5, 0, 15, 10));
    expect(Math.abs(area(u))).toBeCloseTo(150, 6);
    expect(Math.abs(area(difference(u, rect(0, 0, 5, 10))))).toBeCloseTo(100, 6);
    expect(Math.abs(area(offset(rect(0, 0, 10, 10), 1, JoinType.jtMiter, 4, 0.01)))).toBeCloseTo(144, 3);
  });

  it('splits components, keeping holes with their outer ring', () => {
    const ring = difference(rect(0, 0, 10, 10), rect(2, 2, 8, 8));
    const comps = components(union(ring, rect(20, 0, 25, 5), rect(4, 4, 6, 6)));
    expect(comps).toHaveLength(3);
    expect(comps.map((c) => c.length).sort()).toEqual([1, 1, 2]);
  });
});

describe('makeBridges', () => {
  it('does nothing for a single piece', () => {
    expect(makeBridges(rect(0, 0, 10, 10), 1, 0.01)).toMatchObject({ count: 0, islands: 1 });
  });

  it('connects every piece with a minimum spanning tree of bars', () => {
    const pieces = union(rect(0, 0, 5, 5), rect(8, 0, 13, 5), rect(30, 0, 35, 5), rect(0, 9, 5, 14));
    const { bridges, count, islands } = makeBridges(pieces, 1, 0.01);
    expect(islands).toBe(4);
    expect(count).toBe(3);
    expect(components(union(pieces, bridges))).toHaveLength(1);
  });

  it('keeps bars inside the gap instead of poking past corners', () => {
    // Two squares whose closest points are corners: a centered bar would stick out.
    const pieces = union(rect(0, 0, 5, 5), rect(8, 0, 13, 5));
    const { bridges } = makeBridges(pieces, 2, 0.01);
    const b = bbox(bridges);
    expect(b.minY).toBeGreaterThanOrEqual(0);
    expect(b.maxY).toBeLessThanOrEqual(5 * SCALE);
  });
});

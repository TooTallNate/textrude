/**
 * 2D polygon geometry on top of Clipper (integer coordinates).
 *
 * A {@link Shape} is a list of Clipper paths using the nonzero fill rule: outer rings and
 * holes with opposite orientations. Coordinates are output units (mm) times {@link SCALE}.
 */
import ClipperLib from 'clipper-lib';

export const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;
export type JoinType = ClipperLib.JoinType;

import type { Point, Path, Shape } from './types.js';
export type { Point, Path, Shape };

/** A connected component: its outer ring followed by its holes. */
export type Component = Path[];

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Clipper works on integers: 1 output unit (mm) = SCALE clipper units. */
export const SCALE = 10000;

export function clip(type: ClipperLib.ClipType, subject: Shape, clipPaths: Shape = []): Shape {
  const c = new Clipper();
  c.AddPaths(subject, PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(clipPaths, PolyType.ptClip, true);
  const out: Shape = [];
  c.Execute(type, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out;
}

export const union = (...shapes: Shape[]): Shape => clip(ClipType.ctUnion, shapes.flat());
export const difference = (a: Shape, b: Shape): Shape => (b.length ? clip(ClipType.ctDifference, a, b) : union(a));
export const intersection = (a: Shape, b: Shape): Shape =>
  a.length && b.length ? clip(ClipType.ctIntersection, a, b) : [];

/** Signed area in output units² (holes count negative). */
export const area = (shape: Shape): number => shape.reduce((s, p) => s + Clipper.Area(p), 0) / (SCALE * SCALE);

/**
 * A rounded rectangle (output units). Like CSS border-radius, the radius is clamped to half
 * the shorter side, so a huge radius gives a pill (or a circle, for a square).
 */
export function roundedRect(x0: number, y0: number, x1: number, y1: number, radius: number, tol: number): Shape {
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const pts: Path = [];
  const corner = (cx: number, cy: number, start: number) => {
    const n = r > tol ? Math.max(2, Math.ceil(Math.PI / 2 / Math.acos(1 - tol / r))) : 0;
    for (let i = 0; i <= n; i++) {
      const a = start + (i / (n || 1)) * (Math.PI / 2);
      pts.push({ X: Math.round((cx + r * Math.cos(a)) * SCALE), Y: Math.round((cy + r * Math.sin(a)) * SCALE) });
      if (!n) break;
    }
  };
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  corner(x1 - r, y0 + r, (3 * Math.PI) / 2);
  return union([pts]);
}

/** Grow (or shrink, if negative) a shape by `delta` output units. */
export function offset(shape: Shape, delta: number, join: ClipperLib.JoinType, miterLimit: number, tol: number): Shape {
  const co = new ClipperOffset(miterLimit, tol * SCALE);
  co.AddPaths(shape, join, EndType.etClosedPolygon);
  const out: Shape = [];
  co.Execute(out, delta * SCALE);
  return out;
}

/** Drop specks/slivers smaller than minArea (in output units²). */
export function clean(shape: Shape, minArea: number): Shape {
  return union(shape.filter((p) => Math.abs(Clipper.Area(p)) > minArea * SCALE * SCALE));
}

/** Split a shape into connected components. */
export function components(shape: Shape, strictlySimple = false): Component[] {
  const c = new Clipper();
  c.StrictlySimple = strictlySimple;
  c.AddPaths(shape, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const out: Component[] = [];
  const visit = (node: ClipperLib.PolyNode) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) {
        visit(child);
      } else {
        out.push([child.Contour(), ...child.Childs().map((h) => h.Contour())]);
        for (const h of child.Childs()) visit(h);
      }
    }
  };
  visit(tree);
  return out;
}

export function bbox(paths: Path[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of paths) {
    for (const { X, Y } of p) {
      if (X < minX) minX = X;
      if (Y < minY) minY = Y;
      if (X > maxX) maxX = X;
      if (Y > maxY) maxY = Y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function bboxDist(a: BBox, b: BBox): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.X - a.X;
  const dy = b.Y - a.Y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { X: a.X + t * dx, Y: a.Y + t * dy };
}

interface Nearest {
  d: number;
  p: Point;
  q: Point;
  /** Set for a horizontal bar at a chosen height: which way it may slide to still connect. */
  slide?: number[];
}

/** Closest pair of points between two components (vertex-to-edge, both directions). */
function nearest(compA: Component, compB: Component): Nearest {
  let best: Nearest = { d: Infinity, p: { X: 0, Y: 0 }, q: { X: 0, Y: 0 } };
  const scan = (from: Component, to: Component, swap: boolean) => {
    for (const ring of from) {
      for (const v of ring) {
        for (const r of to) {
          for (let i = 0; i < r.length; i++) {
            const c = closestOnSegment(v, r[i]!, r[(i + 1) % r.length]!);
            const d = Math.hypot(c.X - v.X, c.Y - v.Y);
            if (d < best.d) best = swap ? { d, p: c, q: v } : { d, p: v, q: c };
          }
        }
      }
    }
  };
  scan(compA, compB, false);
  scan(compB, compA, true);
  return best;
}

/**
 * Where bridges go between pieces side by side: "auto" bridges the shortest gap, and "top",
 * "middle", and "bottom" put a horizontal bar at that height of the span the two pieces share.
 */
export type BridgePlacement = 'auto' | 'top' | 'middle' | 'bottom';

/** The spans a component covers along the horizontal line at `y`. */
function scanline(comp: Component, y: number): [number, number][] {
  const xs: number[] = [];
  for (const ring of comp) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.Y <= y !== b.Y <= y) xs.push(a.X + ((y - a.Y) * (b.X - a.X)) / (b.Y - a.Y));
    }
  }
  xs.sort((m, n) => m - n);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i]!, xs[i + 1]!]);
  return spans;
}

/**
 * The gap between two components along a horizontal line at the placement's height of the
 * span they share, or null when they don't overlap vertically (one is above the other).
 */
function placedGap(compA: Component, compB: Component, a: BBox, b: BBox, placement: BridgePlacement, w: number): Nearest | null {
  const lo = Math.max(a.minY, b.minY);
  const hi = Math.min(a.maxY, b.maxY);
  if (hi <= lo) return null;
  // Y grows downward, so the top is the smallest Y. Keep the whole bar inside the shared span.
  let y = (lo + hi) / 2;
  let slide = [0, -0.25, 0.25, -0.5, 0.5];
  if (hi - lo > w && placement === 'top') [y, slide] = [lo + w / 2, [0, 0.25, 0.5, 0.75, 1]];
  if (hi - lo > w && placement === 'bottom') [y, slide] = [hi - w / 2, [0, -0.25, -0.5, -0.75, -1]];
  y = Math.floor(y) + 0.5; // off the integer grid, so the line never passes through a vertex

  const spans = [
    ...scanline(compA, y).map(([s, e]) => ({ s, e, k: 0 })),
    ...scanline(compB, y).map(([s, e]) => ({ s, e, k: 1 })),
  ].sort((m, n) => m.s - n.s);
  let best: Nearest | null = null;
  for (let i = 1; i < spans.length; i++) {
    const l = spans[i - 1]!;
    const r = spans[i]!;
    const d = r.s - l.e;
    if (l.k === r.k || d < 0 || (best && d >= best.d)) continue;
    // p is the left end, so the bar's normal points down (+Y), the way `slide` counts.
    best = { d, p: { X: l.e, Y: y }, q: { X: r.s, Y: y }, slide };
  }
  return best;
}

export interface Bridges {
  /** The bars, as one shape (overlapping the pieces they join). */
  bridges: Shape;
  /** Number of bars. */
  count: number;
  /** Number of separate pieces before bridging. */
  islands: number;
}

/**
 * Bridge all components of `shape` with bars along a minimum spanning tree of nearest gaps. With
 * a `placement` other than "auto", pieces side by side are joined at that height instead.
 */
export function makeBridges(shape: Shape, width: number, tol: number, placement: BridgePlacement = 'auto'): Bridges {
  const comps = components(shape);
  const n = comps.length;
  if (n <= 1) return { bridges: [], count: 0, islands: n };
  const boxes = comps.map(bbox);

  // Prim's MST; bounding boxes give a cheap lower bound to skip exact distance checks.
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const link = new Array<(Nearest & { i: number; j: number }) | null>(n).fill(null);
  best[0] = 0;
  const edges: (Nearest & { i: number; j: number })[] = [];
  for (let step = 0; step < n; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!inTree[k] && (i < 0 || best[k]! < best[i]!)) i = k;
    inTree[i] = true;
    const l = link[i];
    if (l) edges.push(l);
    for (let j = 0; j < n; j++) {
      if (inTree[j] || bboxDist(boxes[i]!, boxes[j]!) >= best[j]!) continue;
      const r =
        (placement !== 'auto' && placedGap(comps[i]!, comps[j]!, boxes[i]!, boxes[j]!, placement, width * SCALE)) ||
        nearest(comps[i]!, comps[j]!);
      if (r.d < best[j]!) {
        best[j] = r.d;
        link[j] = { ...r, i, j };
      }
    }
  }

  const bars = edges.flatMap((e) => placeBridge(comps[e.i]!, comps[e.j]!, e.p, e.q, width * SCALE, tol, e.slide));
  return { bridges: union(bars), count: edges.length, islands: n };
}

/**
 * Build a straight bar joining two components near their closest points. The bar is slid
 * sideways to whichever position still connects both pieces while adding the least new
 * material, so it sits inside the gap instead of poking out past corners. With `slide`, the bar
 * is at a chosen height instead: it takes the first of those offsets that connects both pieces.
 */
function placeBridge(compA: Component, compB: Component, p: Point, q: Point, w: number, tol: number, slide?: number[]): Shape {
  let ux = q.X - p.X;
  let uy = q.Y - p.Y;
  const len = Math.hypot(ux, uy);
  if (len < 1) [ux, uy] = [1, 0];
  else [ux, uy] = [ux / len, uy / len];
  const [nx, ny] = [-uy, ux];
  const ext = w / 2; // overlap into each piece
  const pair = [...compA, ...compB];

  let best: { bar: Path; added: number } | null = null;
  for (const f of slide ?? [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -1, 1]) {
    const t = f * w;
    const pt = (base: Point, along: number, side: number): Point => ({
      X: Math.round(base.X + ux * along + nx * (t + side)),
      Y: Math.round(base.Y + uy * along + ny * (t + side)),
    });
    const bar = [pt(p, -ext, -w / 2), pt(q, ext, -w / 2), pt(q, ext, w / 2), pt(p, -ext, w / 2)];
    if (components(union(pair, [bar])).length !== 1) continue;
    const added = difference([bar], pair).reduce((s, r) => s + Math.abs(Clipper.Area(r)), 0);
    if (!best || added < best.added * 0.999) best = { bar, added };
    if (slide) break;
  }
  if (best) return [best.bar];

  // Fallback: round-capped bar centered on the closest points.
  const co = new ClipperOffset(2, tol * SCALE);
  const a = { X: Math.round(p.X), Y: Math.round(p.Y) };
  const b = len < 1 ? { X: a.X + 1, Y: a.Y } : { X: Math.round(q.X), Y: Math.round(q.Y) };
  co.AddPath([a, b], JoinType.jtRound, EndType.etOpenRound);
  const out: Shape = [];
  co.Execute(out, w / 2 + tol * SCALE);
  return union(out);
}

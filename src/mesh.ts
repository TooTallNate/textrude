/**
 * Solids made of stacked slabs: each slab is a 2D shape over a range of heights, with vertical
 * walls (or sloped ones, between two rings with matching vertices, for round handles). Where
 * neighboring slabs differ, the exposed parts become horizontal faces. The result is one closed,
 * manifold triangle mesh: every edge is shared by exactly two triangles.
 *
 * Also: a binary STL writer and a manifold check.
 */
import { SCALE, components, difference } from './geometry.js';
import type { Path, Shape } from './types.js';
import { triangulate, type Mesh } from './threemf.js';

/** One slab of a solid, from z0 to z1 (mm). */
export interface Slab {
  z0: number;
  z1: number;
  /** The slab's shape (Clipper coordinates, Y down like SVG). */
  shape: Shape;
  /**
   * The shape at the top, for a sloped wall: the same rings with the same number of vertices as
   * `shape`, moved. Default: `shape` (vertical walls).
   */
  top?: Shape;
}

/** Integer model coordinates: x right, y up (Clipper's Y flipped). */
type Ring = [number, number][];

const signedArea = (ring: Ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  return a / 2;
};

/** A slab's rings in model coordinates: outer rings counterclockwise, holes clockwise. */
function slabRings(slab: Slab): { bottom: Ring[]; top: Ring[] } {
  const toRing = (p: Path): Ring => p.map(({ X, Y }) => [X, -Y]);
  if (slab.top) {
    // Kept as given (the rings must correspond vertex by vertex), each one an outer ring.
    const bottom: Ring[] = [];
    const top: Ring[] = [];
    slab.shape.forEach((p, i) => {
      const b = toRing(p);
      const t = toRing(slab.top![i]!);
      const flip = signedArea(b) < 0;
      bottom.push(flip ? b.reverse() : b);
      top.push(flip ? t.reverse() : t);
    });
    return { bottom, top };
  }
  const rings: Ring[] = [];
  for (const comp of components(slab.shape, true)) {
    comp.forEach((p, i) => {
      const r = dedupe(toRing(p));
      if (r.length < 3) return;
      if (signedArea(r) > 0 !== (i === 0)) r.reverse();
      rings.push(r);
    });
  }
  return { bottom: rings, top: rings };
}

function dedupe(r: Ring): Ring {
  return r.filter((p, i) => {
    const q = r[(i + r.length - 1) % r.length]!;
    return p[0] !== q[0] || p[1] !== q[1];
  });
}

/** Back to a Clipper shape (Y down), for boolean operations. */
const toShape = (rings: Ring[]): Shape => rings.map((r) => r.map(([x, y]) => ({ X: x, Y: -y })));

const TOL = 2; // Clipper units (0.2 µm): how close a vertex must be to an edge to count as on it

/** Vertices in one horizontal plane, in a grid, to find the ones lying on an edge. */
class PlanePoints {
  private cells = new Map<string, number[]>();
  constructor(
    private pts: [number, number][],
    private cell: number,
  ) {
    pts.forEach(([x, y], i) => {
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    });
  }

  /** Points strictly inside segment a→b (within TOL of it), ordered from a to b. */
  onSegment(a: [number, number], b: [number, number]): [number, number][] {
    const [ax, ay] = a;
    const [bx, by] = b;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) return [];
    const len = Math.sqrt(len2);
    const hits: [number, number][] = [];
    const test = (i: number) => {
      const [px, py] = this.pts[i]!;
      const t = (px - ax) * dx + (py - ay) * dy;
      if (t <= 0 || t >= len2) return;
      if ((px === ax && py === ay) || (px === bx && py === by)) return;
      if (Math.abs((px - ax) * dy - (py - ay) * dx) / len > TOL) return;
      hits.push([t, i]);
    };
    const c0 = Math.floor((Math.min(ax, bx) - TOL) / this.cell);
    const c1 = Math.floor((Math.max(ax, bx) + TOL) / this.cell);
    const r0 = Math.floor((Math.min(ay, by) - TOL) / this.cell);
    const r1 = Math.floor((Math.max(ay, by) + TOL) / this.cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 4 * this.cells.size) {
      for (const l of this.cells.values()) l.forEach(test);
    } else {
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) this.cells.get(`${c},${r}`)?.forEach(test);
    }
    return hits.sort((m, n) => m[0] - n[0]).map(([, i]) => this.pts[i]!);
  }
}

/**
 * Build a closed mesh from stacked slabs (sorted bottom to top, each starting where the previous
 * one ends). Coordinates come out in mm, centered on (cx, cy) in Clipper coordinates/SCALE, with
 * Y up; `mirror` mirrors X.
 *
 * Walls are built first. Then each horizontal face is triangulated with every wall vertex that
 * lies on its edges, so the faces and walls share edges exactly; finally, walls are split where
 * a face has a vertex on their top or bottom edge.
 */
export function buildSolid(slabs: Slab[], cx = 0, cy = 0, mirror = false): Mesh {
  const verts: [number, number, number][] = [];
  const index = new Map<string, number>();
  const zKey = (z: number) => Math.round(z * 1e6) / 1e6; // so slabs meet despite rounding (0.1 + 0.2)
  const vertex = (x: number, y: number, z: number) => {
    z = zKey(z);
    const key = `${x},${y},${z}`;
    let i = index.get(key);
    if (i === undefined) index.set(key, (i = verts.push([x, y, z]) - 1));
    return i;
  };

  // Walls (rings are oriented so these face outward).
  const walls: [number, number, number][] = [];
  const rings = slabs.map(slabRings);
  slabs.forEach(({ z0, z1 }, s) => {
    const { bottom, top } = rings[s]!;
    bottom.forEach((rb, ri) => {
      const rt = top[ri]!;
      for (let i = 0; i < rb.length; i++) {
        const j = (i + 1) % rb.length;
        const a0 = vertex(rb[i]![0], rb[i]![1], z0);
        const b0 = vertex(rb[j]![0], rb[j]![1], z0);
        const a1 = vertex(rt[i]![0], rt[i]![1], z1);
        const b1 = vertex(rt[j]![0], rt[j]![1], z1);
        if (b0 !== b1) walls.push([a0, b0, b1]);
        if (a0 !== a1) walls.push([a0, b1, a1]);
      }
    });
  });

  // Faces: below the first slab, above the last, and wherever a slab differs from the one below.
  const faces: { z: number; up: boolean; rings: Ring[] }[] = [];
  const addFace = (shape: Shape, z: number, up: boolean) => {
    for (const comp of components(shape, true)) {
      const rs = comp.map((p) => dedupe(p.map(({ X, Y }): [number, number] => [X, -Y]))).filter((r) => r.length >= 3);
      if (rs.length) faces.push({ z: zKey(z), up, rings: rs });
    }
  };
  slabs.forEach(({ z0, z1 }, s) => {
    const below = s > 0 ? toShape(rings[s - 1]!.top) : [];
    const here = toShape(rings[s]!.bottom);
    addFace(difference(here, below), z0, false);
    if (s > 0) addFace(difference(below, here), z0, true);
    if (s === slabs.length - 1) addFace(toShape(rings[s]!.top), z1, true);
  });
  for (const f of faces) for (const r of f.rings) for (const [x, y] of r) vertex(x, y, f.z);

  // Every vertex, by plane.
  const byPlane = new Map<number, [number, number][]>();
  for (const [x, y, z] of verts) {
    let l = byPlane.get(z);
    if (!l) byPlane.set(z, (l = []));
    l.push([x, y]);
  }
  const planes = new Map<number, PlanePoints>();
  for (const [z, pts] of byPlane) {
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    planes.set(z, new PlanePoints(pts, Math.max(1, Math.sqrt(((maxX - minX + 1) * (maxY - minY + 1)) / pts.length) * 2)));
  }

  const tris: [number, number, number][] = [];
  for (const { z, up, rings: rs } of faces) {
    const plane = planes.get(z)!;
    const pts: [number, number][] = [];
    const local = new Map<string, number>();
    const at = (x: number, y: number) => {
      const k = `${x},${y}`;
      let i = local.get(k);
      if (i === undefined) local.set(k, (i = pts.push([x, y]) - 1));
      return i;
    };
    // Each ring, with the plane's vertices that lie on its edges added.
    const ringIdx = rs.map((r) => {
      const out: number[] = [];
      r.forEach((p, i) => {
        out.push(at(p[0], p[1]));
        for (const q of plane.onSegment(p, r[(i + 1) % r.length]!)) out.push(at(q[0], q[1]));
      });
      return out;
    });
    const t = triangulate(pts, ringIdx, (x, y) => at(Math.round(x), Math.round(y)));
    let total = 0;
    for (let k = 0; k < t.length; k += 3) {
      const [a, b, c] = [pts[t[k]!]!, pts[t[k + 1]!]!, pts[t[k + 2]!]!];
      total += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    for (let k = 0; k < t.length; k += 3) {
      const [a, b, c] = [t[k]!, t[k + 1]!, t[k + 2]!].map((i) => vertex(pts[i]![0], pts[i]![1], z)) as [number, number, number];
      tris.push(total > 0 === up ? [a, b, c] : [a, c, b]);
    }
  }

  // Split walls where vertices (e.g. where two slabs' outlines cross) lie on their horizontal edges.
  for (const tri of walls) {
    let done = false;
    for (let k = 0; k < 3 && !done; k++) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const apex = tri[(k + 2) % 3]!;
      const [pa, pb] = [verts[a]!, verts[b]!];
      if (pa[2] !== pb[2]) continue;
      const extra = planes.get(pa[2])!.onSegment([pa[0], pa[1]], [pb[0], pb[1]]);
      if (!extra.length) continue;
      // (A wall triangle has one horizontal edge, so a fan from the opposite corner does it.)
      const chain = [a, ...extra.map(([x, y]) => vertex(x, y, pa[2])), b];
      for (let i = 0; i + 1 < chain.length; i++) tris.push([apex, chain[i]!, chain[i + 1]!]);
      done = true;
    }
    if (!done) tris.push(tri);
  }

  const sx = mirror ? -1 : 1;
  return {
    verts: verts.map(([x, y, z]) => [sx * (x / SCALE - cx), y / SCALE + cy, z]),
    tris: mirror ? tris.map(([a, b, c]) => [a, c, b]) : tris,
  };
}

/** Combine meshes into one. */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const verts: Mesh['verts'] = [];
  const tris: Mesh['tris'] = [];
  for (const m of meshes) {
    const base = verts.length;
    verts.push(...m.verts);
    for (const [a, b, c] of m.tris) tris.push([a + base, b + base, c + base]);
  }
  return { verts, tris };
}

export interface ManifoldReport {
  /** Edges not shared by exactly two triangles. */
  badEdges: number;
  /** Edges shared by two triangles that use it in the same direction (inconsistent winding). */
  flippedEdges: number;
  /** Enclosed volume (mm³); positive when the triangles face outward. */
  volume: number;
}

/** Check that a mesh is closed and consistently oriented. */
export function checkManifold({ verts, tris }: Mesh): ManifoldReport {
  const count = new Map<string, number>();
  for (const [a, b, c] of tris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const k = `${p},${q}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let badEdges = 0;
  let flippedEdges = 0;
  for (const [k, n] of count) {
    const [p, q] = k.split(',');
    const back = count.get(`${q},${p}`) ?? 0;
    if (n > 1) flippedEdges++;
    if (n + back !== 2 || n !== 1 || back !== 1) badEdges++;
  }
  let volume = 0;
  for (const [a, b, c] of tris) {
    const [p, q, r] = [verts[a]!, verts[b]!, verts[c]!];
    volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
  }
  return { badEdges, flippedEdges, volume };
}

/** A binary STL file. */
export function writeStl(mesh: Mesh, name = 'textrude'): Uint8Array {
  const { verts, tris } = mesh;
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const header = `${name} (binary STL from textrude)`.slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const [p, q, r] = [verts[a]!, verts[b]!, verts[c]!];
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const uz = q[2] - p[2];
    const vx = r[0] - p[0];
    const vy = r[1] - p[1];
    const vz = r[2] - p[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    [nx, ny, nz] = [nx / len, ny / len, nz / len];
    for (const v of [nx, ny, nz, ...p, ...q, ...r]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

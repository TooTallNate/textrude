import ClipperLib from 'clipper-lib';

export const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;

// Clipper works on integers: 1 output unit (mm) = SCALE clipper units.
export const SCALE = 10000;

// A "shape" is an array of Clipper paths ([{X, Y}, ...]) using the nonzero fill rule.

export function clip(type, subject, clipPaths = []) {
  const c = new Clipper();
  c.AddPaths(subject, PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(clipPaths, PolyType.ptClip, true);
  const out = [];
  c.Execute(type, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out;
}

export const union = (...shapes) => clip(ClipType.ctUnion, shapes.flat());
export const difference = (a, b) => (b.length ? clip(ClipType.ctDifference, a, b) : union(a));
export const intersection = (a, b) => (a.length && b.length ? clip(ClipType.ctIntersection, a, b) : []);
export const area = (shape) => shape.reduce((s, p) => s + Clipper.Area(p), 0) / (SCALE * SCALE);

export function offset(shape, delta, join, miterLimit, tol) {
  const co = new ClipperOffset(miterLimit, tol * SCALE);
  co.AddPaths(shape, join, EndType.etClosedPolygon);
  const out = [];
  co.Execute(out, delta * SCALE);
  return out;
}

/** Drop specks/slivers smaller than minArea (in output units²). */
export function clean(shape, minArea) {
  return union(shape.filter((p) => Math.abs(Clipper.Area(p)) > minArea * SCALE * SCALE));
}

/** Split a shape into connected components: [[outer, ...holes], ...]. */
export function components(shape, strictlySimple = false) {
  const c = new Clipper();
  c.StrictlySimple = strictlySimple;
  c.AddPaths(shape, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const out = [];
  const visit = (node) => {
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

export function bbox(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

function bboxDist(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function closestOnSegment(p, a, b) {
  const dx = b.X - a.X;
  const dy = b.Y - a.Y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { X: a.X + t * dx, Y: a.Y + t * dy };
}

/** Closest pair of points between two components (vertex-to-edge, both directions). */
function nearest(compA, compB) {
  let best = { d: Infinity, p: null, q: null };
  const scan = (from, to, swap) => {
    for (const ring of from) {
      for (const v of ring) {
        for (const r of to) {
          for (let i = 0; i < r.length; i++) {
            const c = closestOnSegment(v, r[i], r[(i + 1) % r.length]);
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

/** Bridge all components with bars along a minimum spanning tree of nearest gaps. */
export function makeBridges(shape, width, tol) {
  const comps = components(shape);
  const n = comps.length;
  if (n <= 1) return { bridges: [], count: 0, islands: n };
  const boxes = comps.map(bbox);

  // Prim's MST; bounding boxes give a cheap lower bound to skip exact distance checks.
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const link = new Array(n).fill(null);
  best[0] = 0;
  const edges = [];
  for (let step = 0; step < n; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!inTree[k] && (i < 0 || best[k] < best[i])) i = k;
    inTree[i] = true;
    if (link[i]) edges.push(link[i]);
    for (let j = 0; j < n; j++) {
      if (inTree[j] || bboxDist(boxes[i], boxes[j]) >= best[j]) continue;
      const r = nearest(comps[i], comps[j]);
      if (r.d < best[j]) {
        best[j] = r.d;
        link[j] = { ...r, i, j };
      }
    }
  }

  const bridges = edges.flatMap((e) => placeBridge(comps[e.i], comps[e.j], e.p, e.q, width * SCALE, tol));
  return { bridges: union(bridges), count: edges.length, islands: n };
}

/**
 * Build a straight bar joining two components near their closest points. The bar is
 * slid sideways to whichever position still connects both pieces while adding the least
 * new material, so it sits inside the gap instead of poking out past corners.
 */
function placeBridge(compA, compB, p, q, w, tol) {
  let ux = q.X - p.X;
  let uy = q.Y - p.Y;
  const len = Math.hypot(ux, uy);
  if (len < 1) [ux, uy] = [1, 0];
  else [ux, uy] = [ux / len, uy / len];
  const [nx, ny] = [-uy, ux];
  const ext = w / 2; // overlap into each piece
  const pair = [...compA, ...compB];

  let best = null;
  for (const f of [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -1, 1]) {
    const t = f * w;
    const pt = (base, along, side) => ({
      X: Math.round(base.X + ux * along + nx * (t + side)),
      Y: Math.round(base.Y + uy * along + ny * (t + side)),
    });
    const bar = [pt(p, -ext, -w / 2), pt(q, ext, -w / 2), pt(q, ext, w / 2), pt(p, -ext, w / 2)];
    if (components(union(pair, [bar])).length !== 1) continue;
    const added = difference([bar], pair).reduce((s, r) => s + Math.abs(Clipper.Area(r)), 0);
    if (!best || added < best.added * 0.999) best = { bar, added };
  }
  if (best) return [best.bar];

  // Fallback: round-capped bar centered on the closest points.
  const co = new ClipperOffset(2, tol * SCALE);
  const a = { X: Math.round(p.X), Y: Math.round(p.Y) };
  const b = len < 1 ? { X: a.X + 1, Y: a.Y } : { X: Math.round(q.X), Y: Math.round(q.Y) };
  co.AddPath([a, b], JoinType.jtRound, EndType.etOpenRound);
  const out = [];
  co.Execute(out, w / 2 + tol * SCALE);
  return union(out);
}

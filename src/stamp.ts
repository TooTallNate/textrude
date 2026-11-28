/**
 * Cookie stamps and cutters from an SVG: the SVG's outermost shape becomes the stamp's outline
 * (and the matching cutter's), and everything inside it is the design, pressed into the cookie
 * (`imprinted`) or left standing on it (`embossed`).
 *
 * Which part is the outline: all the SVG's filled shapes (and strokes) are merged, and the outer
 * edge of the result, with any holes filled in, is the outline. If one element covers that whole
 * area by itself with a solid fill (a background shape, like a filled circle behind the artwork),
 * it only sets the outline: the design is every other element (plus any small holes cut out of
 * the background). If not
 * (the artwork is its own silhouette, or the outermost element is just a ring, like a stroked
 * circle), every element is part of the design, and the outline is grown by a margin so the
 * design has a border to sit in.
 */
import { SCALE, JoinType, area, bbox, components, difference, intersection, offset, union } from './geometry.js';
import type { Path, Shape } from './types.js';
import { parseSvg, type ParsedSvg } from './svg-input.js';
import { buildSolid, writeStl, type Slab } from './mesh.js';
import { write3mf, type Mesh } from './threemf.js';
import { PRINTERS, projectSettings, type PrinterProfile } from './printers.js';
import { TextrudeError } from './errors.js';
import type { LogEvent, LogLevel } from './render.js';

/** What the design does to the cookie. */
export type StampStyle = 'imprinted' | 'embossed';

/**
 * How the handle is made: `attached` prints with the stamp in one piece, face-down; `separate`
 * prints the stamp face-up and the handle on its own, joined by a keyed peg and socket; `none`
 * leaves a plain plate.
 */
export type HandleMode = 'attached' | 'separate' | 'none';

export type StampPartName = 'stamp' | 'handle' | 'cutter';

export interface CookieStampOptions {
  /**
   * `imprinted`: the design is pressed into the cookie (raised on the stamp). `embossed`: the
   * design stands up on the cookie (recessed into the stamp). Default "imprinted".
   */
  style?: StampStyle;
  /** How far the design is raised or recessed (mm). Default 1.8. */
  depth?: number;
  /**
   * The stamp's size: its width or height, whichever is larger (mm). Default: the SVG's own size
   * when its width/height are in mm, cm, in, pt or pc, else 60.
   */
  size?: number;
  /**
   * Space between the design and the edge of the stamp (mm), when the outline comes from the
   * artwork itself. Default 3 when the SVG has no element covering the whole outline, else 0.
   */
  margin?: number;
  /** Thickness of the stamp's plate, behind the design (mm). Default 4. */
  plateThickness?: number;
  /**
   * Slope the walls of the relief at 45° instead of making them vertical: they need no support
   * and let go of the dough more cleanly. Default: on for imprinted, off for embossed (where it
   * would also make thin parts of the design shallower).
   */
  chamfer?: boolean;
  /** Default: `separate` for imprinted, `attached` for embossed. */
  handle?: HandleMode;
  /** Handle height above the plate (mm). Default 45% of the size, 20 to 35. */
  handleHeight?: number;
  /** Diameter of the knob on top of the handle (mm). Default 40% of the size, 16 to 32. */
  knobDiameter?: number;
  /** Diameter of the handle's stem (mm). Default half the knob's, 9 to 16. */
  stemDiameter?: number;
  /** Gap on each side between a separate handle's peg and the socket in the stamp (mm). Default 0.2. */
  pegClearance?: number;
  /** Make the matching cutter. Default true. */
  cutter?: boolean;
  /** Cutter height (mm). Default 14. */
  cutterHeight?: number;
  /** Cutter wall thickness at the cutting edge (mm); it's twice this lower down. Default 1. */
  cutterWall?: number;
  /** Gap between the stamp's outline and the inside of the cutter (mm). Default 0.5. */
  clearance?: number;
  /** Width of the cutter's rim (flange) from its inside edge (mm). Default 5. */
  rimWidth?: number;
  /** Thickness of the cutter's rim (mm). Default 2.5. */
  rimHeight?: number;
  /** Warn about parts of the design (or gaps in it) thinner than this (mm). Default 1. */
  minFeature?: number;
  /** Max curve flattening error (mm). Default 0.02. */
  tolerance?: number;
  /** Space between the parts on the plate (mm). Default 10. */
  gap?: number;
  /** Start a new row of parts past this width (mm), e.g. the bed's width. Default 220. */
  maxWidth?: number;
  onLog?: (event: LogEvent) => void;
}

/** The options after defaults. */
export type ResolvedStampOptions = Required<Omit<CookieStampOptions, 'onLog'>>;

export interface StampPart {
  name: StampPartName;
  /** Closed triangle mesh in print orientation: mm, Z up, bottom at 0, centered on (0, 0). */
  mesh: Mesh;
  /** Its size (mm). */
  width: number;
  depth: number;
  height: number;
  /** Where its center goes on the plate, relative to the plate's center (mm). */
  x: number;
  y: number;
  /** Preview color. */
  color: string;
}

export interface StampMeshOptions {
  /** Show a stamp that prints face-down turned over, with its face up (the 3MF keeps print orientation). */
  faceUp?: boolean;
}

export interface StampPartMesh {
  part: StampPart;
  /** x, y, z per vertex (mm), in place on the plate. */
  positions: Float32Array;
  indices: Uint32Array;
}

export interface StampThreeMfOptions {
  /** Printer profile id (see PRINTERS) or a custom profile. */
  printer?: string | PrinterProfile;
  /** Bed position of the center of the parts (mm). Default: the printer's bed center, else 100,100. */
  position?: [number, number];
  /** Only this part. */
  part?: StampPartName;
}

export interface CookieStampResult {
  /** The stamp, then the separate handle and the cutter, if any. */
  parts: StampPart[];
  /** The stamp's outline (Clipper coordinates, mm × SCALE, Y down, centered on 0,0). */
  outline: Shape;
  /** The design, as on the cookie (not mirrored). */
  design: Shape;
  /** Whether an SVG element was taken as the background (outline only). */
  background: boolean;
  options: ResolvedStampOptions;
  /** Overall size of the plate's layout (mm). */
  width: number;
  depth: number;
  height: number;
  /** Meshes in place on the plate, for previews. */
  toMeshes(options?: StampMeshOptions): StampPartMesh[];
  /** A 3MF with each part as its own object, side by side. */
  to3MF(options?: StampThreeMfOptions): Uint8Array;
  /** A binary STL of one part (default: the stamp). */
  toSTL(part?: StampPartName): Uint8Array;
}

const COLORS: Record<StampPartName, string> = { stamp: '#e9b872', handle: '#c98b4a', cutter: '#7cc4e8' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const S = (mm: number) => Math.round(mm * SCALE);
const scaleShape = (shape: Shape, k: number, dx = 0, dy = 0): Shape =>
  shape.map((p) => p.map(({ X, Y }) => ({ X: Math.round(X * k + dx), Y: Math.round(Y * k + dy) })));
const filled = (shape: Shape): Shape => union(components(shape).map((c) => c[0]!));
const grow = (shape: Shape, mm: number, tol: number) => (mm ? offset(shape, mm, JoinType.jtRound, 2, tol) : shape);

/** A circle (Clipper coordinates) with a fixed number of vertices, so rings of different sizes line up. */
function circle(r: number, n = 96, cx = 0, cy = 0): Path {
  const out: Path = [];
  for (let i = 0; i < n; i++) {
    const a = (-2 * Math.PI * i) / n;
    out.push({ X: Math.round(cx + S(r) * Math.cos(a)), Y: Math.round(cy + S(r) * Math.sin(a)) });
  }
  return out;
}

/** The largest circle inside a shape, roughly: its center (Clipper coordinates) and radius (mm). */
function inscribedCircle(shape: Shape, tol: number): { cx: number; cy: number; r: number } {
  const b = bbox(shape);
  let lo = 0;
  let hi = Math.max(b.maxX - b.minX, b.maxY - b.minY) / SCALE / 2;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (offset(shape, -mid, JoinType.jtRound, 2, tol).length) lo = mid;
    else hi = mid;
  }
  const core = offset(shape, -lo * 0.95, JoinType.jtRound, 2, tol);
  // The biggest remaining piece's middle.
  const pieces = components(core).sort((m, n) => Math.abs(area(n)) - Math.abs(area(m)));
  const cb = bbox(pieces[0] ?? shape);
  return { cx: (cb.minX + cb.maxX) / 2, cy: (cb.minY + cb.maxY) / 2, r: lo };
}

/** Parts of `shape` thinner than `width`: what an opening (shrink, then grow back) removes. */
function thinSpots(shape: Shape, width: number, tol: number): number {
  if (!shape.length) return 0;
  const opened = offset(offset(shape, -width / 2, JoinType.jtRound, 2, tol), width / 2, JoinType.jtRound, 2, tol);
  return components(difference(shape, opened)).filter((c) => Math.abs(area(c)) > width * width).length;
}

/** Split an SVG into the stamp's outline and design (unscaled, in the SVG's mm). */
export function splitOutline(svg: ParsedSvg): { outline: Shape; design: Shape; background: boolean; ring: boolean } {
  const all = union(...svg.shapes.map((s) => s.shape));
  if (!all.length) throw new TextrudeError('the SVG has no filled shapes or strokes');
  const outline = filled(all);
  const outlineArea = area(outline);
  let background = -1;
  let ring = false;
  for (const [i, s] of svg.shapes.entries()) {
    const own = filled(s.shape);
    // Covers the whole outline by itself?
    if (area(own) < outlineArea * 0.98 || area(difference(outline, own)) > outlineArea * 0.005) continue;
    if (area(s.shape) >= area(own) * 0.95) {
      background = i;
      break;
    }
    ring = true; // a border (e.g. a stroked circle): it's part of the design
  }
  // A background needs something on it; a lone shape is its own design.
  if (background >= 0 && svg.shapes.length === 1) background = -1;
  if (background < 0) return { outline, design: all, background: false, ring };
  const bg = svg.shapes[background]!.shape;
  const design = union(...svg.shapes.filter((_, i) => i !== background).map((s) => s.shape), difference(outline, bg));
  return { outline, design: intersection(design, outline), background: true, ring };
}

/** The handle's profile from the plate up: [height, radius] pairs (mm). */
function handleProfile(height: number, knobR: number, stemR: number, baseR: number): [number, number][] {
  const chamferTop = Math.min(1, knobR * 0.1);
  const flare = Math.max(0, baseR - stemR);
  let edge = Math.min(4, height * 0.15);
  let knobR2 = knobR;
  // Knob widens at 45°; shrink it if the handle is too short for that.
  let k0 = height - chamferTop - edge - (knobR2 - stemR);
  if (k0 < flare + 1) {
    edge = Math.max(1, edge - (flare + 1 - k0));
    k0 = height - chamferTop - edge - (knobR2 - stemR);
    if (k0 < flare + 1) {
      knobR2 = Math.max(stemR, stemR + (height - chamferTop - edge - flare - 1));
      k0 = height - chamferTop - edge - (knobR2 - stemR);
    }
  }
  const pts: [number, number][] = [
    [0, baseR],
    [flare, stemR],
    [k0, stemR],
    [height - chamferTop - edge, knobR2],
    [height - chamferTop, knobR2],
    [height, knobR2 - chamferTop],
  ];
  // Drop zero-height steps.
  return pts.filter((p, i) => i === 0 || p[0] > pts[i - 1]![0] + 1e-6);
}

/** Slabs for a solid of revolution through [z, r] points (ascending z), centered on (cx, cy). */
function revolve(points: [number, number][], cx: number, cy: number): Slab[] {
  const slabs: Slab[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [z0, r0] = points[i]!;
    const [z1, r1] = points[i + 1]!;
    const bottom = [circle(r0, 96, cx, cy)];
    slabs.push(r0 === r1 ? { z0, z1, shape: bottom } : { z0, z1, shape: bottom, top: [circle(r1, 96, cx, cy)] });
  }
  return slabs;
}

/** A keyed socket shape: a circle with one flat side, so the handle can't turn. */
function keyShape(r: number, cx: number, cy: number): Shape {
  const c = [circle(r, 64, cx, cy)];
  const flat = [[
    { X: cx - S(r * 2), Y: cy - S(r * 2) },
    { X: cx + S(r * 0.6), Y: cy - S(r * 2) },
    { X: cx + S(r * 0.6), Y: cy + S(r * 2) },
    { X: cx - S(r * 2), Y: cy + S(r * 2) },
  ]];
  return intersection(c, flat);
}

function meshBounds(mesh: Mesh) {
  let [minX, minY, minZ, maxX, maxY, maxZ] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of mesh.verts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Move a mesh so its footprint is centered on (0, 0) and its bottom is at z = 0. */
function recenter(mesh: Mesh): { mesh: Mesh; width: number; depth: number; height: number } {
  const b = meshBounds(mesh);
  const [dx, dy] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  return {
    mesh: { verts: mesh.verts.map(([x, y, z]) => [x - dx, y - dy, z - b.minZ]), tris: mesh.tris },
    width: b.maxX - b.minX,
    depth: b.maxY - b.minY,
    height: b.maxZ - b.minZ,
  };
}

/**
 * Make a cookie stamp (and matching cutter) from an SVG document. See the module comment for how
 * the outline and the design are told apart.
 */
export function cookieStamp(svg: string | Uint8Array, options: CookieStampOptions = {}): CookieStampResult {
  const source = typeof svg === 'string' ? svg : new TextDecoder().decode(svg);
  const log = (level: LogLevel, message: string, label?: string) => options.onLog?.({ level, message, label });
  const num = (name: keyof CookieStampOptions, v: number | undefined, def: number, min = 0, inclusive = true): number => {
    if (v == null) return def;
    if (!Number.isFinite(v) || (inclusive ? v < min : v <= min)) throw new TextrudeError(`${name} must be a number ${inclusive ? '>=' : '>'} ${min}`);
    return v;
  };
  const style = options.style ?? 'imprinted';
  if (style !== 'imprinted' && style !== 'embossed') throw new TextrudeError('style must be "imprinted" or "embossed"');
  const handle = options.handle ?? (style === 'imprinted' ? 'separate' : 'attached');
  if (!['attached', 'separate', 'none'].includes(handle)) throw new TextrudeError('handle must be "attached", "separate" or "none"');
  const tol = num('tolerance', options.tolerance, 0.02, 0, false);

  const parsed = parseSvg(source, { tolerance: tol, targetSize: options.size });
  for (const w of parsed.warnings) log('warn', w);
  const split = splitOutline(parsed);

  // Scale so the outline (with its margin) is `size` across.
  const margin = num('margin', options.margin, split.background || split.ring ? 0 : 3);
  const ob = bbox(split.outline);
  const native = Math.max(ob.maxX - ob.minX, ob.maxY - ob.minY) / SCALE;
  const size = num('size', options.size, parsed.physical ? native + 2 * margin : 60, 0, false);
  if (size <= 2 * margin) throw new TextrudeError(`size (${size} mm) must be more than twice the margin (${margin} mm)`);
  const k = (size - 2 * margin) / native;
  const [ocx, ocy] = [((ob.minX + ob.maxX) / 2) * k, ((ob.minY + ob.maxY) / 2) * k];
  const outline = grow(scaleShape(split.outline, k, -ocx, -ocy), margin, tol);
  const design = intersection(scaleShape(split.design, k, -ocx, -ocy), outline);
  const outlineParts = components(outline).length;
  if (outlineParts > 1) log('warn', `the outline has ${outlineParts} separate pieces, so the stamp and cutter will too (the handle goes on the largest)`);

  const depth = num('depth', options.depth, 1.8, 0, false);
  const plate = num('plateThickness', options.plateThickness, 4, 0, false);
  const chamfer = options.chamfer ?? style === 'imprinted';
  const minFeature = num('minFeature', options.minFeature, 1);
  const handleHeight = num('handleHeight', options.handleHeight, +clamp(size * 0.45, 20, 35).toFixed(1), 0, false);
  const knobD = num('knobDiameter', options.knobDiameter, +clamp(size * 0.4, 16, 32).toFixed(1), 0, false);
  const stemD = num('stemDiameter', options.stemDiameter, +clamp(knobD / 2, 9, 16).toFixed(1), 0, false);
  const pegClearance = num('pegClearance', options.pegClearance, 0.2);
  const wantCutter = options.cutter ?? true;
  const cutterHeight = num('cutterHeight', options.cutterHeight, 14, 0, false);
  const cutterWall = num('cutterWall', options.cutterWall, 1, 0, false);
  const clearance = num('clearance', options.clearance, 0.5);
  const rimHeight = num('rimHeight', options.rimHeight, 2.5, 0, false);
  const rimWidth = num('rimWidth', options.rimWidth, 5, 0, false);
  const gap = num('gap', options.gap, 10);
  const maxWidth = num('maxWidth', options.maxWidth, 220);
  const resolved: ResolvedStampOptions = {
    style, depth, size, margin, plateThickness: plate, chamfer, handle, handleHeight, knobDiameter: knobD, stemDiameter: stemD,
    pegClearance, cutter: wantCutter, cutterHeight, cutterWall, clearance, rimWidth, rimHeight, minFeature, tolerance: tol, gap, maxWidth,
  };

  // Warnings about the design.
  if (!design.length) log('warn', 'the design is empty: the stamp face will be flat');
  else if (area(difference(outline, design)) < area(outline) * 0.01) log('warn', 'the design covers the whole outline, so the stamp face will be flat (give the SVG a background shape, or a --margin)');
  if (minFeature > 0 && design.length) {
    const lines = thinSpots(design, minFeature, tol);
    const gaps = thinSpots(difference(outline, design), minFeature, tol);
    if (lines) log('warn', `${lines} part${lines > 1 ? 's' : ''} of the design ${lines > 1 ? 'are' : 'is'} thinner than ${minFeature} mm, too fine for dough to hold`);
    if (gaps) log('warn', `${gaps} gap${gaps > 1 ? 's' : ''} in the design ${gaps > 1 ? 'are' : 'is'} narrower than ${minFeature} mm, too fine for dough to hold`);
  }

  // The relief, by distance from the face (0) to the plate (depth): the solid part of that layer.
  const steps = chamfer ? Math.max(1, Math.ceil(depth / 0.2)) : 1;
  const relief: { u0: number; u1: number; shape: Shape }[] = [];
  for (let i = 0; i < steps; i++) {
    const u0 = (depth * i) / steps;
    const u1 = (depth * (i + 1)) / steps;
    // Each step is as wide as the slope at its middle, so the stairs follow a 45° line.
    const g = chamfer ? (u0 + u1) / 2 : 0;
    const shape =
      style === 'imprinted'
        ? intersection(chamfer ? grow(design, g, tol) : design, outline)
        : difference(outline, chamfer ? (g ? offset(design, -g, JoinType.jtRound, 2, tol) : design) : design);
    if (!shape.length) throw new TextrudeError(style === 'imprinted' ? 'nothing to raise: the design is empty' : 'the design covers the whole stamp');
    relief.push({ u0, u1, shape });
  }

  // The handle's place: the middle of the largest circle that fits in the outline.
  const fit = inscribedCircle(outline, tol);
  const stemR = Math.min(stemD / 2, Math.max(1.5, fit.r - 1));
  const baseR = Math.min(stemR + 3, Math.max(stemR, fit.r - 0.5));
  const profile = handleProfile(handleHeight, Math.max(knobD / 2, stemR), stemR, baseR);
  if (handle !== 'none' && stemR < stemD / 2 - 1e-6) log('note', `the handle's stem is ${(stemR * 2).toFixed(1)} mm wide, to fit inside the outline`);

  const parts: Omit<StampPart, 'x' | 'y'>[] = [];
  if (handle === 'attached') {
    // Face-down: face on the bed, plate above it, handle on top (as it's used, so not mirrored).
    const slabs: Slab[] = [
      ...relief.map((r) => ({ z0: r.u0, z1: r.u1, shape: r.shape })),
      { z0: depth, z1: depth + plate, shape: outline },
      ...revolve(profile.map(([h, r]) => [depth + plate + h, r]), fit.cx, fit.cy),
    ];
    parts.push({ name: 'stamp', color: COLORS.stamp, ...recenter(buildSolid(slabs)) });
  } else {
    // Face-up: back on the bed (with the socket for a separate handle), design on top. Turned
    // over, so mirrored.
    const top = depth + plate;
    const slabs: Slab[] = [];
    let socket: Shape = [];
    let socketDepth = 0;
    if (handle === 'separate') {
      socketDepth = Math.min(3, plate - 1.2);
      if (socketDepth < 1) throw new TextrudeError(`the plate is too thin for a separate handle's socket (needs plateThickness >= 2.2 mm)`);
      socket = keyShape(Math.max(1.5, stemR * 0.75), fit.cx, fit.cy);
      slabs.push({ z0: 0, z1: socketDepth, shape: difference(outline, socket) });
    }
    slabs.push({ z0: socketDepth, z1: plate, shape: outline });
    for (const r of [...relief].reverse()) slabs.push({ z0: top - r.u1, z1: top - r.u0, shape: r.shape });
    parts.push({ name: 'stamp', color: COLORS.stamp, ...recenter(buildSolid(slabs, 0, 0, true)) });

    if (handle === 'separate') {
      // Knob-down, so every overhang is 45° or less, with the peg on top.
      const peg = offset(socket, -pegClearance, JoinType.jtMiter, 2, tol);
      if (!peg.length) throw new TextrudeError('pegClearance is too big for the peg');
      const pegLength = socketDepth - 0.3;
      const hs: Slab[] = [
        ...revolve([...profile].reverse().map(([h, r]) => [handleHeight - h, r]), fit.cx, fit.cy),
        { z0: handleHeight, z1: handleHeight + pegLength, shape: peg },
      ];
      parts.push({ name: 'handle', color: COLORS.handle, ...recenter(buildSolid(hs, 0, 0, true)) });
    }
  }

  if (wantCutter) {
    // Rim down, cutting edge up (turned over from how it's used, so mirrored).
    const inner = grow(outline, clearance, tol);
    const ring = (w: number) => difference(grow(outline, clearance + w, tol), inner);
    const thick = Math.max(cutterWall * 2, cutterWall + 0.4);
    const thickTo = Math.max(rimHeight, cutterHeight * 0.55);
    const slabs: Slab[] = [
      { z0: 0, z1: rimHeight, shape: ring(Math.max(rimWidth, thick)) },
      { z0: rimHeight, z1: thickTo, shape: ring(thick) },
    ];
    // Thin down to the cutting edge at 45°, in 0.2 mm steps.
    const taper = Math.min(thick - cutterWall, cutterHeight - thickTo - 0.5);
    const n = Math.max(0, Math.ceil(taper / 0.2));
    for (let i = 0; i < n; i++) {
      const z0 = thickTo + (taper * i) / n;
      const z1 = thickTo + (taper * (i + 1)) / n;
      slabs.push({ z0, z1, shape: ring(thick - (thick - cutterWall) * ((i + 0.5) / n)) });
    }
    if (thickTo + Math.max(0, taper) < cutterHeight) slabs.push({ z0: thickTo + Math.max(0, taper), z1: cutterHeight, shape: ring(cutterWall) });
    if (rimHeight >= cutterHeight) throw new TextrudeError('the cutter must be taller than its rim');
    parts.push({ name: 'cutter', color: COLORS.cutter, ...recenter(buildSolid(slabs, 0, 0, true)) });
  }

  // Lay the parts out in rows no wider than maxWidth.
  const rows: { items: typeof parts; width: number; depth: number }[] = [];
  for (const p of parts) {
    const row = rows[rows.length - 1];
    if (row && row.width + gap + p.width <= maxWidth) {
      row.items.push(p);
      row.width += gap + p.width;
      row.depth = Math.max(row.depth, p.depth);
    } else rows.push({ items: [p], width: p.width, depth: p.depth });
  }
  const width = Math.max(...rows.map((r) => r.width));
  const depthAll = rows.reduce((d, r) => d + r.depth, 0) + gap * (rows.length - 1);
  const placed: StampPart[] = [];
  let y = depthAll / 2;
  for (const row of rows) {
    let x = -row.width / 2;
    for (const p of row.items) {
      placed.push({ ...p, x: x + p.width / 2, y: y - row.depth / 2 });
      x += p.width + gap;
    }
    y -= row.depth + gap;
  }
  const height = Math.max(...placed.map((p) => p.height));
  const find = (name: StampPartName) => {
    const p = placed.find((q) => q.name === name);
    if (!p) throw new TextrudeError(`there's no ${name} (parts: ${placed.map((q) => q.name).join(', ')})`);
    return p;
  };

  log('detail', `${style}, ${depth} mm deep${chamfer ? ', 45° relief walls' : ''}`, 'style');
  log('detail', `${placed[0]!.width.toFixed(1)} × ${placed[0]!.depth.toFixed(1)} mm, plate ${plate} mm`, 'stamp');
  if (handle !== 'none') log('detail', `${handle}, ${handleHeight} mm tall, knob ${knobD} mm, stem ${(stemR * 2).toFixed(1)} mm`, 'handle');
  if (wantCutter) log('detail', `${cutterHeight} mm tall, ${cutterWall} mm edge, ${clearance} mm clearance`, 'cutter');

  return {
    parts: placed,
    outline,
    design,
    background: split.background,
    options: resolved,
    width,
    depth: depthAll,
    height,
    toMeshes({ faceUp = false } = {}) {
      return placed.map((part) => {
        const flip = faceUp && part.name === 'stamp' && handle === 'attached';
        const positions = new Float32Array(part.mesh.verts.length * 3);
        part.mesh.verts.forEach(([vx, vy, vz], i) => {
          // Turned over about the Y axis (a rotation, so the triangles keep facing out).
          positions[i * 3] = (flip ? -vx : vx) + part.x;
          positions[i * 3 + 1] = vy + part.y;
          positions[i * 3 + 2] = flip ? part.height - vz : vz;
        });
        return { part, positions, indices: new Uint32Array(part.mesh.tris.flat()) };
      });
    },
    to3MF({ printer, position, part } = {}) {
      let profile: PrinterProfile | null = null;
      if (typeof printer === 'string') {
        const p = PRINTERS[printer];
        if (!p) throw new TextrudeError(`unknown printer "${printer}" (known: ${Object.keys(PRINTERS).join(', ')})`);
        profile = p;
      } else if (printer) profile = printer;
      const chosen = part ? [find(part)] : placed;
      if (profile?.bedSize && (width > profile.bedSize[0] || depthAll > profile.bedSize[1])) {
        log('warn', `the parts take ${width.toFixed(0)} × ${depthAll.toFixed(0)} mm, but the ${profile.label} bed is ${profile.bedSize[0]} × ${profile.bedSize[1]} mm`);
      }
      const objects = chosen.map((p) => {
        // The footprint places the object (Y down, like the shapes write3mf expects).
        const [x0, x1] = [S(p.x - p.width / 2), S(p.x + p.width / 2)];
        const [y0, y1] = [S(-p.y - p.depth / 2), S(-p.y + p.depth / 2)];
        const footprint: Shape = [[{ X: x0, Y: y0 }, { X: x1, Y: y0 }, { X: x1, Y: y1 }, { X: x0, Y: y1 }]];
        return { name: p.name, parts: [{ id: p.name, shape: footprint, height: p.height, filament: 1, mesh: p.mesh }] };
      });
      return write3mf(objects, {
        name: 'cookie stamp',
        position: position ?? profile?.bedCenter ?? [100, 100],
        projectConfig: profile ? projectSettings(profile, ['#ffffff']) : null,
      });
    },
    toSTL(part = 'stamp') {
      return writeStl(find(part).mesh, `cookie ${part}`);
    },
  };
}

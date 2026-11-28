import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCALE, area, bbox } from '../src/geometry.js';
import type { Shape } from '../src/types.js';
import { parseXml } from '../src/xml.js';
import { parsePathData, parseSvg, parseTransform } from '../src/svg-input.js';
import { cookieStamp, splitOutline, type CookieStampOptions, type StampPart } from '../src/stamp.js';
import { buildSolid, checkManifold, writeStl } from '../src/mesh.js';
import type { Mesh } from '../src/threemf.js';
import { run } from '../src/cli.js';
import { checkMeshes, unzip3mf } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SNOWFLAKE = path.join(here, '..', 'examples', 'stamps', 'snowflake.svg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'textrude-stamp-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const svgDoc = (body: string, attrs = 'viewBox="0 0 100 100" width="100mm" height="100mm"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
/** Total area (mm²) of everything in an SVG. */
const svgArea = (body: string, attrs?: string) => parseSvg(svgDoc(body, attrs)).shapes.reduce((a, s) => a + area(s.shape), 0);
const mmBox = (shape: Shape) => {
  const b = bbox(shape);
  return { minX: b.minX / SCALE, minY: b.minY / SCALE, maxX: b.maxX / SCALE, maxY: b.maxY / SCALE };
};

describe('xml', () => {
  it('parses elements, attributes, entities, comments, CDATA and doctypes', () => {
    const el = parseXml(
      `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [<!ENTITY a "b">]><!-- hi --><svg:svg a='1' b="&amp;&#x41;&#66;"><style><![CDATA[.a{fill:red}]]></style><g/></svg:svg>`,
    );
    expect(el.name).toBe('svg');
    expect(el.attrs).toEqual({ a: '1', b: '&AB' });
    expect(el.children.map((c) => c.name)).toEqual(['style', 'g']);
    expect(el.children[0]!.text).toBe('.a{fill:red}');
  });

  it('reports malformed documents', () => {
    expect(() => parseXml('<svg><g></svg>')).toThrow(/unexpected <\/svg>/);
    expect(() => parseXml('<svg>')).toThrow(/unclosed/);
  });
});

describe('svg parsing', () => {
  it('parses every path command, including arcs with packed flags', () => {
    const cmds = parsePathData('M10 10h10v10H10zm30 0l5 5 5-5c0 5 5 5 5 0s5-5 5 0q5 5 10 0t10 0a5 5 0 0110 0A5 5 0 1 0 100 10z');
    const kinds = cmds.map((c) => c.command);
    expect(kinds.filter((k) => k === 'moveTo')).toHaveLength(2);
    expect(kinds).toContain('quadraticCurveTo');
    expect(kinds).toContain('bezierCurveTo');
    expect(kinds.filter((k) => k === 'closePath')).toHaveLength(2);
    // The relative moveTo after Z starts from the subpath's start (10,10).
    expect(cmds[5]).toEqual({ command: 'moveTo', args: [40, 10] });
    // S reflects the previous control point.
    const s = cmds.filter((c) => c.command === 'bezierCurveTo')[1]!;
    expect(s.args.slice(0, 2)).toEqual([55, 5]);
  });

  it('makes circles from arcs, circle, ellipse and rounded rects with the right areas', () => {
    const circle = Math.PI * 20 * 20;
    expect(svgArea('<path d="M30 50a20 20 0 1 0 40 0a20 20 0 1 0 -40 0z"/>')).toBeCloseTo(circle, 0);
    expect(svgArea('<circle cx="50" cy="50" r="20"/>')).toBeCloseTo(circle, 0);
    expect(svgArea('<ellipse cx="50" cy="50" rx="20" ry="10"/>')).toBeCloseTo(circle / 2, 0);
    expect(svgArea('<rect x="10" y="10" width="40" height="20" rx="5"/>')).toBeCloseTo(800 - (4 - Math.PI) * 25, 0);
    expect(svgArea('<polygon points="0,0 10,0 10,10"/>')).toBeCloseTo(50, 3);
    expect(svgArea('<polyline points="0,0 10,0 10,10"/>')).toBeCloseTo(50, 3); // polylines fill too
  });

  it('follows fill-rule', () => {
    const rings = 'M10 10H90V90H10Z M30 30H70V70H30Z'; // both clockwise
    expect(svgArea(`<path d="${rings}"/>`)).toBeCloseTo(6400, 3);
    expect(svgArea(`<path fill-rule="evenodd" d="${rings}"/>`)).toBeCloseTo(6400 - 1600, 3);
    expect(svgArea(`<g style="fill-rule: evenodd"><path d="${rings}"/></g>`)).toBeCloseTo(4800, 3);
  });

  it('turns strokes into geometry', () => {
    // A 40 long line, 2 wide, butt caps; then square caps add 1 at each end.
    expect(svgArea('<line x1="10" y1="10" x2="50" y2="10" stroke="#000" stroke-width="2"/>')).toBeCloseTo(80, 1);
    expect(svgArea('<line x1="10" y1="10" x2="50" y2="10" stroke="#000" stroke-width="2" stroke-linecap="square"/>')).toBeCloseTo(84, 1);
    // A stroked, unfilled square is a ring.
    expect(svgArea('<rect x="10" y="10" width="40" height="40" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="miter"/>')).toBeCloseTo(42 * 42 - 38 * 38, 1);
    // Strokes scale with their transform.
    expect(svgArea('<g transform="scale(2)"><line x1="10" y1="10" x2="30" y2="10" stroke="#000"/></g>')).toBeCloseTo(80, 1);
  });

  it('applies nested transforms', () => {
    expect(parseTransform('translate(10 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform('rotate(90 10 10)');
    expect(r.map((v) => +v.toFixed(9))).toEqual([0, 1, -1, 0, 20, 0]);
    const svg = parseSvg(svgDoc('<g transform="translate(50 0)"><g transform="rotate(90)"><rect width="10" height="20"/></g></g>'));
    expect(mmBox(svg.shapes[0]!.shape)).toEqual({ minX: 30, minY: 0, maxX: 50, maxY: 10 });
    const skew = parseSvg(svgDoc('<rect width="10" height="10" transform="skewX(45)"/>'));
    expect(mmBox(skew.shapes[0]!.shape).maxX).toBeCloseTo(20, 6);
  });

  it('reads units from width, height and viewBox', () => {
    const inMm = parseSvg(svgDoc('<rect width="10" height="10"/>', 'width="20mm" height="20mm" viewBox="0 0 10 10"'));
    expect(inMm.physical).toBe(true);
    expect(mmBox(inMm.shapes[0]!.shape)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
    const inches = parseSvg(svgDoc('<rect width="1" height="1"/>', 'width="1in" height="1in" viewBox="0 0 1 1"'));
    expect(mmBox(inches.shapes[0]!.shape).maxX).toBeCloseTo(25.4, 6);
    const px = parseSvg(svgDoc('<rect width="96" height="96"/>', 'width="96" height="96"'));
    expect(px.physical).toBe(false);
    expect(mmBox(px.shapes[0]!.shape).maxX).toBeCloseTo(25.4, 6);
    // viewBox offsets, and xMidYMid meet centering for a wider viewport.
    const meet = parseSvg(svgDoc('<rect x="10" y="10" width="10" height="10"/>', 'width="40mm" height="20mm" viewBox="10 10 10 10"'));
    expect(mmBox(meet.shapes[0]!.shape)).toEqual({ minX: 10, minY: 0, maxX: 30, maxY: 20 });
  });

  it('reads styles from attributes, style="" and <style> rules', () => {
    const svg = parseSvg(
      svgDoc(`<style>.hole{fill:none}#big{fill:red} rect.thin { stroke: #000; stroke-width: 2 }</style>
        <rect class="hole" width="10" height="10"/>
        <rect id="big" class="hole" x="20" width="10" height="10"/>
        <rect class="hole thin" x="40" width="10" height="10"/>
        <rect style="display:none" x="60" width="10" height="10"/>
        <g display="none"><rect x="80" width="10" height="10"/></g>`),
    );
    // The first is unfilled; the id rule beats the class rule; the third is a stroke only.
    expect(svg.shapes.map((s) => [mmBox(s.shape).minX, s.fill.length > 0, s.stroke.length > 0])).toEqual([
      [20, true, false],
      [39, false, true],
    ]);
  });

  it('follows <use> references', () => {
    const svg = parseSvg(svgDoc('<defs><rect id="r" width="10" height="10"/></defs><use href="#r" x="5"/><use xlink:href="#r" x="30"/>'));
    expect(svg.shapes.map((s) => mmBox(s.shape).minX)).toEqual([5, 30]);
  });

  it('warns about text and images', () => {
    const svg = parseSvg(svgDoc('<rect width="10" height="10"/><text x="0" y="20">Hello</text><image href="a.png"/>'));
    expect(svg.warnings.join('\n')).toMatch(/convert text to outlines/);
    expect(svg.warnings.join('\n')).toMatch(/images/);
    expect(svg.shapes).toHaveLength(1);
  });

  it('rejects files that are not SVGs', () => {
    expect(() => parseSvg('<html></html>')).toThrow(/not an SVG/);
  });
});

describe('outline', () => {
  it('uses a solid background shape as the outline only', () => {
    const svg = parseSvg(svgDoc('<circle cx="50" cy="50" r="40" fill="#eee"/><rect x="40" y="40" width="20" height="20"/>'));
    const { outline, design, background } = splitOutline(svg);
    expect(background).toBe(true);
    expect(area(outline)).toBeCloseTo(Math.PI * 1600, -1);
    expect(area(design)).toBeCloseTo(400, 1);
  });

  it('keeps a border ring (a stroked outline) as part of the design', () => {
    const svg = parseSvg(svgDoc('<circle cx="50" cy="50" r="40" fill="none" stroke="#000" stroke-width="2"/><rect x="40" y="40" width="20" height="20"/>'));
    const { outline, design, background, ring } = splitOutline(svg);
    expect(background).toBe(false);
    expect(ring).toBe(true);
    expect(area(outline)).toBeCloseTo(Math.PI * 41 * 41, -1);
    expect(area(design)).toBeCloseTo(400 + Math.PI * (41 * 41 - 39 * 39), -1);
  });

  it('takes the silhouette of artwork without a background, with its holes filled', () => {
    const svg = parseSvg(svgDoc('<path fill-rule="evenodd" d="M10 10H90V90H10Z M30 30H70V70H30Z"/>'));
    const { outline, design, background } = splitOutline(svg);
    expect(background).toBe(false);
    expect(area(outline)).toBeCloseTo(6400, 3);
    expect(area(design)).toBeCloseTo(4800, 3);
  });

  it('scales to --size and adds a margin when there is no background', () => {
    // A plus sign on its own is its own design.
    const r = cookieStamp(svgDoc('<path d="M40 10H60V40H90V60H60V90H40V60H10V40H40Z"/>'), { size: 50, cutter: false, handle: 'none' });
    expect(r.background).toBe(false);
    expect(r.options.margin).toBe(3);
    const b = mmBox(r.outline);
    expect(b.maxX - b.minX).toBeCloseTo(50, 2);
    // The design is 44 mm across, inside the 3 mm margin.
    const d = mmBox(r.design);
    expect(d.maxX - d.minX).toBeCloseTo(44, 2);
    // A border ring (here an even-odd square frame) needs no margin.
    expect(cookieStamp(svgDoc('<path fill-rule="evenodd" d="M10 10H90V90H10Z M30 30H70V70H30Z"/>'), { cutter: false }).options.margin).toBe(0);
  });

  it("uses the SVG's own size when it's in real units", () => {
    const r = cookieStamp(svgDoc('<circle cx="50" cy="50" r="25" fill="#eee"/><circle cx="50" cy="50" r="5"/>', 'viewBox="0 0 100 100" width="80mm" height="80mm"'), { cutter: false });
    expect(r.options.size).toBeCloseTo(40, 3);
    const px = cookieStamp(svgDoc('<circle cx="50" cy="50" r="25" fill="#eee"/><circle cx="50" cy="50" r="5"/>', 'viewBox="0 0 100 100"'), { cutter: false });
    expect(px.options.size).toBe(60);
  });
});

/** Every triangle's unit normal z and its min z. */
function faces(mesh: Mesh) {
  return mesh.tris.map(([a, b, c]) => {
    const [p, q, r] = [mesh.verts[a]!, mesh.verts[b]!, mesh.verts[c]!];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    return { nz: len ? n[2]! / len : 0, z: Math.min(p[2], q[2], r[2]), area: len / 2 };
  });
}

/** Heights of downward-facing flat faces (bridges, or the bed at 0), and the steepest sloped overhang. */
function overhangs(mesh: Mesh) {
  const flat = new Set<number>();
  let worst = 0; // |nz| of downward faces that aren't flat: sin(overhang angle from vertical)
  for (const f of faces(mesh)) {
    if (f.area < 1e-9 || f.nz >= -1e-6) continue;
    if (f.nz < -0.9999) flat.add(+f.z.toFixed(4));
    else worst = Math.max(worst, -f.nz);
  }
  return { flat: [...flat].sort((a, b) => a - b), worst };
}

const svg = fs.readFileSync(SNOWFLAKE, 'utf8');
const part = (parts: StampPart[], name: string) => parts.find((p) => p.name === name)!;

describe('cookie stamp', () => {
  const combos: [CookieStampOptions['style'], CookieStampOptions['handle'], boolean][] = [];
  for (const style of ['imprinted', 'embossed'] as const) for (const handle of ['attached', 'separate', 'none'] as const) for (const chamfer of [true, false]) combos.push([style, handle, chamfer]);

  it.each(combos)('makes closed, manifold meshes (%s, handle %s, chamfer %s)', (style, handle, chamfer) => {
    const r = cookieStamp(svg, { style, handle, chamfer });
    expect(r.parts.map((p) => p.name)).toEqual(handle === 'separate' ? ['stamp', 'handle', 'cutter'] : ['stamp', 'cutter']);
    for (const p of r.parts) {
      const report = checkManifold(p.mesh);
      expect(report, p.name).toMatchObject({ badEdges: 0, flippedEdges: 0 });
      expect(report.volume, p.name).toBeGreaterThan(0);
    }
    // The 3MF carries the same meshes, still closed.
    for (const m of checkMeshes(r.to3MF())) {
      expect(m.badEdges, m.name).toBe(0);
      expect(m.volume, m.name).toBeGreaterThan(0);
    }
  });

  it('defaults to a separate handle for imprinted stamps and an attached one for embossed', () => {
    expect(cookieStamp(svg).options).toMatchObject({ style: 'imprinted', handle: 'separate', chamfer: true, depth: 1.8, plateThickness: 4 });
    expect(cookieStamp(svg, { style: 'embossed' }).options).toMatchObject({ handle: 'attached', chamfer: false });
  });

  it('builds the attached stamp face-down: relief, plate, then handle', () => {
    const r = cookieStamp(svg, { handle: 'attached', cutter: false, handleHeight: 25 });
    const stamp = part(r.parts, 'stamp');
    expect(stamp.height).toBeCloseTo(1.8 + 4 + 25, 4);
    // Every sloped overhang is at most 45°; the only flat ones are the bed and the plate's
    // underside (bridging between the raised design).
    const o = overhangs(stamp.mesh);
    expect(o.worst).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-3);
    expect(o.flat.every((z) => z < 1.8 + 1e-3)).toBe(true);
  });

  it('prints the separate stamp face-up and the handle knob-down, with no steep overhangs', () => {
    const r = cookieStamp(svg, { handle: 'separate' });
    const stamp = part(r.parts, 'stamp');
    const handle = part(r.parts, 'handle');
    expect(stamp.height).toBeCloseTo(1.8 + 4, 4);
    // The stamp only bridges over its socket (2.8 mm deep).
    expect(overhangs(stamp.mesh).flat).toEqual([0, 2.8]);
    expect(overhangs(handle.mesh).flat).toEqual([0]);
    expect(overhangs(handle.mesh).worst).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-3);
    expect(overhangs(part(r.parts, 'cutter').mesh).flat).toEqual([0]);
  });

  it('sizes the peg to fit the socket with the clearance', () => {
    for (const pegClearance of [0.2, 0.35]) {
      const r = cookieStamp(svg, { handle: 'separate', cutter: false, pegClearance });
      const stamp = part(r.parts, 'stamp');
      const handle = part(r.parts, 'handle');
      // The socket: the stamp's bed-side vertices within 8 mm of the handle's axis (the middle here).
      const socket = stamp.mesh.verts.filter(([x, y, z]) => z === 0 && Math.hypot(x, y) < 8);
      const peg = handle.mesh.verts.filter(([, , z]) => Math.abs(z - handle.height) < 1e-6);
      const extent = (pts: number[][], i: number) => Math.max(...pts.map((p) => p[i]!)) - Math.min(...pts.map((p) => p[i]!));
      for (const axis of [0, 1]) expect(extent(socket, axis) - extent(peg, axis)).toBeCloseTo(2 * pegClearance, 2);
      // The peg is shorter than the socket is deep, so the handle sits flat on the stamp.
      const socketDepth = Math.min(...stamp.mesh.verts.filter(([x, y, z]) => z > 0 && Math.hypot(x, y) < 6).map(([, , z]) => z));
      const pegLength = handle.height - Math.max(...handle.mesh.verts.filter(([x, y, z]) => z < handle.height && Math.hypot(x, y) > 6).map(([, , z]) => z));
      expect(socketDepth).toBeCloseTo(2.8, 4);
      expect(pegLength).toBeCloseTo(2.5, 4);
      // The flat side (the key) is on the same side of the peg and the socket.
      const side = (pts: number[][]) => Math.sign(Math.max(...pts.map((p) => p[0]!)) + Math.min(...pts.map((p) => p[0]!)));
      expect(side(peg)).toBe(side(socket));
    }
  });

  it('mirrors the design on the stamp face, so it reads correctly on the cookie', () => {
    // An L-shaped mark on the left of the design (as you look at the SVG).
    const doc = svgDoc('<circle cx="50" cy="50" r="45" fill="#eee"/><path d="M20 30H30V60H45V70H20Z"/>');
    const relief = (mesh: Mesh, z: number) => mesh.verts.filter((v) => Math.abs(v[2] - z) < 1e-6);
    const meanX = (pts: number[][]) => pts.reduce((s, p) => s + p[0]!, 0) / pts.length;

    // Attached prints face-down: the face is on the bed. From above (as it presses on the
    // cookie) the mark is on the left, so looking at the face itself it's mirrored.
    const attached = part(cookieStamp(doc, { handle: 'attached', cutter: false }).parts, 'stamp');
    expect(meanX(relief(attached.mesh, 0))).toBeLessThan(-5);

    // Separate prints face-up: looking down at the face, the mark is on the right (mirrored).
    const separate = part(cookieStamp(doc, { handle: 'separate', cutter: false }).parts, 'stamp');
    expect(meanX(relief(separate.mesh, separate.height))).toBeGreaterThan(5);

    // Embossed: the recessed mark is where the face isn't.
    const embossed = part(cookieStamp(doc, { style: 'embossed', handle: 'separate', cutter: false }).parts, 'stamp');
    const floor = relief(embossed.mesh, embossed.height - 1.8).filter((v) => Math.hypot(v[0]!, v[1]!) < 40);
    expect(meanX(floor)).toBeGreaterThan(5);
  });

  it('makes a cutter around the outline with the clearance, mirrored to match', () => {
    // A D shape: flat on the left.
    const doc = svgDoc('<path d="M30 10H50A40 40 0 0 1 50 90H30Z" fill="#eee"/><circle cx="45" cy="50" r="10"/>');
    const r = cookieStamp(doc, { handle: 'none', clearance: 0.5, cutterWall: 1, rimWidth: 5, cutterHeight: 12, size: 60 });
    const cutter = part(r.parts, 'cutter');
    const stamp = part(r.parts, 'stamp');
    expect(cutter.height).toBeCloseTo(12, 6);
    // At the top, the wall runs from 0.5 to 1.5 mm outside the stamp's outline; the rim, to 5.5.
    const top = cutter.mesh.verts.filter((v) => Math.abs(v[2] - 12) < 1e-6);
    const bottom = cutter.mesh.verts.filter((v) => v[2] === 0);
    const width = (pts: number[][]) => Math.max(...pts.map((p) => p[1]!)) - Math.min(...pts.map((p) => p[1]!));
    expect(width(top)).toBeCloseTo(stamp.depth + 3, 1);
    expect(width(bottom)).toBeCloseTo(stamp.depth + 11, 1);
    // Printed rim-down, it's turned over: the flat side is on the right.
    const flatSide = (pts: number[][]) => {
      const xs = pts.map((p) => p[0]!);
      const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
      // The straight edge: points at that extreme span much of the height.
      const span = (sel: number[][]) => Math.max(...sel.map((p) => p[1]!)) - Math.min(...sel.map((p) => p[1]!));
      return span(pts.filter((p) => p[0]! > hi - 0.3)) > span(pts.filter((p) => p[0]! < lo + 0.3)) ? 'right' : 'left';
    };
    expect(flatSide(top)).toBe('right');
    // The stamp (no handle) prints face-up, so it's turned over too.
    expect(flatSide(stamp.mesh.verts.filter((v) => v[2] === 0))).toBe('right');
  });

  it('warns about features too thin for dough', () => {
    const logs: string[] = [];
    cookieStamp(svgDoc('<rect width="100" height="60" fill="#eee"/><path d="M10 20H90" stroke="#000" stroke-width="0.4"/><rect x="10" y="30" width="20" height="20"/>'), {
      onLog: (e) => e.level === 'warn' && logs.push(e.message),
      cutter: false,
    });
    expect(logs.join('\n')).toMatch(/1 part of the design is thinner than 1 mm/);
  });

  it('warns when the design leaves nothing to stamp', () => {
    const logs: string[] = [];
    cookieStamp(svgDoc('<circle cx="50" cy="50" r="40"/>'), { margin: 0, onLog: (e) => e.level === 'warn' && logs.push(e.message) });
    expect(logs.join('\n')).toMatch(/covers the whole outline/);
  });

  it('lays parts out in rows that fit the bed', () => {
    const wide = cookieStamp(svg, { size: 100 });
    expect(wide.width).toBeLessThanOrEqual(220);
    expect(new Set(wide.parts.map((p) => p.y)).size).toBe(2);
    const xml = unzip3mf(wide.to3MF({ printer: 'snapmaker-u1' }));
    expect(xml['3D/3dmodel.model']!.match(/<item /g)).toHaveLength(3);
    expect(xml['Metadata/project_settings.config']).toMatch(/Snapmaker U1/);
    expect(xml['Metadata/model_settings.config']).toMatch(/value="cutter"/);
  });

  it('builds sloped walls between matching rings', () => {
    const ring = (r: number) => Array.from({ length: 32 }, (_, i) => ({ X: Math.round(r * SCALE * Math.cos((i / 32) * 2 * Math.PI)), Y: Math.round(r * SCALE * Math.sin((i / 32) * 2 * Math.PI)) }));
    const mesh = buildSolid([
      { z0: 0, z1: 5, shape: [ring(10)], top: [ring(5)] },
      { z0: 5, z1: 6, shape: [ring(8)] },
    ]);
    const report = checkManifold(mesh);
    expect(report.badEdges).toBe(0);
    // Frustum (polygonal) plus a cylinder.
    const polyArea = (r: number) => 16 * r * r * Math.sin((2 * Math.PI) / 32);
    const [a1, a2] = [polyArea(10), polyArea(5)];
    expect(report.volume).toBeCloseTo((5 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)) + polyArea(8), 0);
  });
});

describe('stl', () => {
  it('writes a binary STL', () => {
    const r = cookieStamp(svg, { handle: 'separate' });
    const mesh = part(r.parts, 'handle').mesh;
    const stl = writeStl(mesh, 'cookie handle');
    expect(stl.length).toBe(84 + 50 * mesh.tris.length);
    const view = new DataView(stl.buffer, stl.byteOffset);
    expect(new TextDecoder().decode(stl.slice(0, 13))).toBe('cookie handle');
    expect(view.getUint32(80, true)).toBe(mesh.tris.length);
    // The first triangle: unit normal, then its vertices.
    const n = [0, 1, 2].map((i) => view.getFloat32(84 + i * 4, true));
    expect(Math.hypot(...n)).toBeCloseTo(1, 5);
    const v0 = mesh.verts[mesh.tris[0]![0]]!;
    expect([0, 1, 2].map((i) => view.getFloat32(96 + i * 4, true))).toEqual(v0.map((x) => Math.fround(x)));
    expect(r.toSTL('cutter').length).toBe(84 + 50 * part(r.parts, 'cutter').mesh.tris.length);
    expect(() => cookieStamp(svg, { handle: 'attached' }).toSTL('handle')).toThrow(/no handle/);
  });
});

describe('stamp cli', () => {
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });

  it('writes a 3MF with every part', async () => {
    const out = path.join(tmp, 'snow.3mf');
    expect(await run(['stamp', SNOWFLAKE, '-o', out, '--printer', 'snapmaker-u1'], { env: {} })).toBe(0);
    const meshes = checkMeshes(fs.readFileSync(out));
    expect(meshes.map((m) => m.name)).toEqual(['stamp', 'handle', 'cutter']);
    expect(meshes.every((m) => m.badEdges === 0)).toBe(true);
    expect(errors.join('\n')).toMatch(/wrote/);
  });

  it('writes one STL per part, or one with --part', async () => {
    const out = path.join(tmp, 'snow.stl');
    expect(await run(['stamp', SNOWFLAKE, '--style', 'embossed', '--handle', 'separate', '-o', out, '-q'], { env: {} })).toBe(0);
    for (const p of ['stamp', 'handle', 'cutter']) expect(fs.existsSync(path.join(tmp, `snow-${p}.stl`))).toBe(true);
    const one = path.join(tmp, 'cutter.stl');
    expect(await run(['stamp', SNOWFLAKE, '--part', 'cutter', '-o', one, '-q'], { env: {} })).toBe(0);
    expect(fs.statSync(one).size).toBe(fs.statSync(path.join(tmp, 'snow-cutter.stl')).size);
  });

  it('passes options through, and --no-handle and --no-cutter', async () => {
    let data: Uint8Array | undefined;
    const code = await run(['stamp', SNOWFLAKE, '--no-handle', '--no-cutter', '--size', '40', '--depth', '1.2', '-q'], {
      env: {},
      stdout: (d) => (data = d as Uint8Array),
    });
    expect(code).toBe(0);
    const meshes = checkMeshes(data!);
    expect(meshes.map((m) => m.name)).toEqual(['stamp']);
    expect(meshes[0]!.maxZ - meshes[0]!.minZ).toBeCloseTo(5.2, 3);
    expect(meshes[0]!.maxX - meshes[0]!.minX).toBeCloseTo(40, 1);
  });

  it('reports bad input', async () => {
    const bad = path.join(tmp, 'bad.svg');
    fs.writeFileSync(bad, '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>');
    expect(await run(['stamp', bad, '-o', path.join(tmp, 'x.3mf')], { env: {} })).toBe(1);
    expect(errors.join('\n')).toMatch(/convert text to outlines/);
    expect(errors.join('\n')).toMatch(/no filled shapes/);
    expect(await run(['stamp', SNOWFLAKE, '--style', 'raised'], { env: {} })).toBe(1);
    expect(errors.join('\n')).toMatch(/--style must be one of: imprinted, embossed/);
  });

  it('prints help', async () => {
    let out = '';
    expect(await run(['stamp', '--help'], { stdout: (d) => (out += d) })).toBe(0);
    expect(out).toMatch(/Usage: textrude stamp/);
  });
});

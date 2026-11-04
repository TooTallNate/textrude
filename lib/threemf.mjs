import libtess from 'libtess';
import { zipSync, strToU8 } from 'fflate';
import { SCALE, Clipper, JoinType, bbox, components, offset } from './geometry.mjs';
import { fmt } from './svg.mjs';

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
};

/** Remove duplicate and exactly-collinear vertices. */
function cleanRing(ring) {
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = out.length ? out[out.length - 1] : pts[pts.length - 1];
      const c = pts[i];
      const n = pts[(i + 1) % pts.length];
      const cross = (c.X - p.X) * (n.Y - c.Y) - (c.Y - p.Y) * (n.X - c.X);
      if ((c.X === p.X && c.Y === p.Y) || cross === 0) changed = true;
      else out.push(c);
    }
    pts = out;
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * Triangulate a polygon with holes using the GLU tessellator, which keeps every input vertex
 * (unlike earcut, which drops collinear ones and leaves T-junctions). `rings` are arrays of
 * vertex indices into `pts`. Returns a flat list of vertex indices; `addPoint` is called
 * for any new intersection vertex.
 */
function triangulate(pts, rings, addPoint) {
  const { GluTesselator, gluEnum, windingRule, primitiveType } = libtess;
  const tess = new GluTesselator();
  const out = [];
  tess.gluTessCallback(gluEnum.GLU_TESS_VERTEX_DATA, (index, list) => list.push(index));
  tess.gluTessCallback(gluEnum.GLU_TESS_BEGIN, (type) => {
    if (type !== primitiveType.GL_TRIANGLES) throw new Error(`unexpected primitive ${type}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_ERROR, (err) => {
    throw new Error(`tessellation error ${err}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_COMBINE, (coords) => addPoint(coords[0], coords[1]));
  // Registering an edge-flag callback forces plain GL_TRIANGLES output (no fans/strips).
  tess.gluTessCallback(gluEnum.GLU_TESS_EDGE_FLAG, () => {});
  tess.gluTessProperty(gluEnum.GLU_TESS_WINDING_RULE, windingRule.GLU_TESS_WINDING_NONZERO);
  tess.gluTessNormal(0, 0, 1);
  tess.gluTessBeginPolygon(out);
  for (const ring of rings) {
    tess.gluTessBeginContour();
    for (const i of ring) tess.gluTessVertex([pts[i][0], pts[i][1], 0], i);
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();
  return out;
}

/**
 * Extrude a 2D shape (SVG coordinates) into closed triangle meshes from z=0 to z=height.
 * With `mirror`, X is mirrored so the design reads correctly when viewed from below.
 */
export function extrude(shape, height, cx, cy, mirror) {
  const verts = [];
  const tris = [];
  const sx = mirror ? -1 : 1;
  // Close zero-width slits (edges lying exactly on each other) with a 1µm grow + shrink, snap
  // near-coincident vertices, and rebuild as strictly simple polygons.
  const e = 0.001;
  const closed = offset(offset(shape, e, JoinType.jtMiter, 10, e), -e, JoinType.jtMiter, 10, e);
  const snapped = Clipper.CleanPolygons(closed, 0.002 * SCALE);
  for (const raw of components(snapped, true)) {
    const comp = raw.map(cleanRing);
    if (!comp[0]) continue;
    // Flip Y so the text reads correctly from above; outer ring CCW, holes CW.
    const rings = comp.filter(Boolean).map((r, ri) => {
      const ring = r.map(({ X, Y }) => [sx * (X / SCALE - cx), -(Y / SCALE - cy)]);
      const ccw = signedArea(ring) > 0;
      return (ri === 0) !== ccw ? ring.reverse() : ring;
    });
    // One index per distinct position (the tessellator merges coincident points, so the caps
    // and walls must agree on them).
    const pts = [];
    const index = new Map();
    const indexOf = (x, y) => {
      const key = `${x},${y}`;
      if (!index.has(key)) index.set(key, pts.push([x, y]) - 1);
      return index.get(key);
    };
    const ringIdx = rings.map((ring) => ring.map(([x, y]) => indexOf(x, y)));
    const caps = triangulate(pts, ringIdx, (x, y) => indexOf(x, y));

    const n = pts.length;
    const base = verts.length;
    for (const [x, y] of pts) verts.push([x, y, 0]);
    for (const [x, y] of pts) verts.push([x, y, height]);
    const bot = (k) => base + k;
    const top = (k) => base + n + k;

    // Decide the orientation once for the whole cap: per-triangle checks could flip
    // zero-area slivers and break the mesh topology.
    let total = 0;
    for (let t = 0; t < caps.length; t += 3) {
      const [a, b, c] = [pts[caps[t]], pts[caps[t + 1]], pts[caps[t + 2]]];
      total += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    for (let t = 0; t < caps.length; t += 3) {
      let [a, b, c] = [caps[t], caps[t + 1], caps[t + 2]];
      if (total < 0) [b, c] = [c, b];
      tris.push([top(a), top(b), top(c)], [bot(a), bot(c), bot(b)]);
    }

    for (const ring of ringIdx) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        tris.push([bot(a), bot(b), top(b)], [bot(a), top(b), top(a)]);
      }
    }
  }
  return { verts, tris };
}

export function write3mf(parts, name, position, mirror) {
  const b = bbox(parts.flatMap((p) => p.shape));
  const cx = (b.minX + b.maxX) / 2 / SCALE;
  const cy = (b.minY + b.maxY) / 2 / SCALE;
  const f = (v) => fmt(v, 4);

  const objects = parts.map((part, i) => {
    const { verts, tris } = extrude(part.shape, part.height, cx, cy, mirror);
    const v = verts.map(([x, y, z]) => `<vertex x="${f(x)}" y="${f(y)}" z="${f(z)}"/>`).join('');
    const t = tris.map(([a, b2, c]) => `<triangle v1="${a}" v2="${b2}" v3="${c}"/>`).join('');
    return `  <object id="${i + 1}" name="${xmlEsc(part.id)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
  });
  const asmId = parts.length + 1;
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <metadata name="Application">text2svg</metadata>',
    ' <resources>',
    ...objects,
    `  <object id="${asmId}" name="${xmlEsc(name)}" type="model"><components>` +
      parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('') +
      '</components></object>',
    ' </resources>',
    ` <build><item objectid="${asmId}" transform="1 0 0 0 1 0 0 0 1 ${f(position[0])} ${f(position[1])} 0"/></build>`,
    '</model>',
  ].join('\n');

  // Orca / Bambu Studio read per-part names and filament ("extruder") assignments from here.
  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${asmId}">`,
    `    <metadata key="name" value="${xmlEsc(name)}"/>`,
    `    <metadata key="extruder" value="${parts[0].filament}"/>`,
    ...parts.flatMap((p, i) => [
      `    <part id="${i + 1}" subtype="normal_part">`,
      `      <metadata key="name" value="${xmlEsc(p.id)}"/>`,
      `      <metadata key="extruder" value="${p.filament}"/>`,
      '    </part>',
    ]),
    '  </object>',
    '</config>',
  ].join('\n');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(settings),
  });
}

/**
 * 3MF output: each part is extruded into a closed (watertight, manifold) triangle mesh, and
 * the parts are grouped into one object with per-part filament assignments in the format
 * OrcaSlicer / Bambu Studio read (`Metadata/model_settings.config`).
 */
import libtess from 'libtess';
import { zipSync, strToU8 } from 'fflate';
import { SCALE, Clipper, JoinType, bbox, components, offset, type Path } from './geometry.js';
import type { Shape } from './types.js';
import { fmt } from './svg.js';

export interface MeshPart {
  /** Part name shown in the slicer. */
  id: string;
  shape: Shape;
  /** Extrusion height (mm). */
  height: number;
  /** Where the part's bottom sits (mm). Default 0. */
  z?: number;
  /** 1-based filament ("extruder") number. */
  filament: number;
}

export interface Mesh {
  verts: [number, number, number][];
  tris: [number, number, number][];
}

const xmlEsc = (s: string) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Ring = [number, number][];

const signedArea = (ring: Ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  }
  return a / 2;
};

/** Remove duplicate and exactly-collinear vertices. */
function cleanRing(ring: Path): Path | null {
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out: Path = [];
    for (let i = 0; i < pts.length; i++) {
      const p = out.length ? out[out.length - 1]! : pts[pts.length - 1]!;
      const c = pts[i]!;
      const n = pts[(i + 1) % pts.length]!;
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
 * vertex indices into `pts`. Returns a flat list of vertex indices; `addPoint` is called for
 * any new intersection vertex.
 */
function triangulate(pts: [number, number][], rings: number[][], addPoint: (x: number, y: number) => number): number[] {
  const { GluTesselator, gluEnum, windingRule, primitiveType } = libtess;
  const tess = new GluTesselator();
  const out: number[] = [];
  tess.gluTessCallback(gluEnum.GLU_TESS_VERTEX_DATA, (index: number, list: number[]) => list.push(index));
  tess.gluTessCallback(gluEnum.GLU_TESS_BEGIN, (type: number) => {
    if (type !== primitiveType.GL_TRIANGLES) throw new Error(`unexpected primitive ${type}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_ERROR, (err: number) => {
    throw new Error(`tessellation error ${err}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_COMBINE, (coords: number[]) => addPoint(coords[0]!, coords[1]!));
  // Registering an edge-flag callback forces plain GL_TRIANGLES output (no fans/strips).
  tess.gluTessCallback(gluEnum.GLU_TESS_EDGE_FLAG, () => {});
  tess.gluTessProperty(gluEnum.GLU_TESS_WINDING_RULE, windingRule.GLU_TESS_WINDING_NONZERO);
  tess.gluTessNormal(0, 0, 1);
  tess.gluTessBeginPolygon(out);
  for (const ring of rings) {
    tess.gluTessBeginContour();
    for (const i of ring) tess.gluTessVertex([pts[i]![0], pts[i]![1], 0], i);
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();
  return out;
}

/**
 * Extrude a 2D shape (SVG coordinates) into closed triangle meshes from z to z+height,
 * centered on (cx, cy). With `mirror`, X is mirrored so the design reads correctly from below.
 */
export function extrude(shape: Shape, height: number, cx: number, cy: number, mirror = false, z = 0): Mesh {
  const verts: Mesh['verts'] = [];
  const tris: Mesh['tris'] = [];
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
    const rings = comp
      .filter((r): r is Path => r !== null)
      .map((r, ri) => {
        const ring: Ring = r.map(({ X, Y }) => [sx * (X / SCALE - cx), -(Y / SCALE - cy)]);
        const ccw = signedArea(ring) > 0;
        return (ri === 0) !== ccw ? ring.reverse() : ring;
      });
    // One index per distinct position (the tessellator merges coincident points, so the caps
    // and walls must agree on them).
    const pts: [number, number][] = [];
    const index = new Map<string, number>();
    const indexOf = (x: number, y: number) => {
      const key = `${x},${y}`;
      let i = index.get(key);
      if (i === undefined) index.set(key, (i = pts.push([x, y]) - 1));
      return i;
    };
    const ringIdx = rings.map((ring) => ring.map(([x, y]) => indexOf(x, y)));
    const caps = triangulate(pts, ringIdx, indexOf);

    const n = pts.length;
    const base = verts.length;
    for (const [x, y] of pts) verts.push([x, y, z]);
    for (const [x, y] of pts) verts.push([x, y, z + height]);
    const bot = (k: number) => base + k;
    const top = (k: number) => base + n + k;

    // Decide the orientation once for the whole cap: per-triangle checks could flip zero-area
    // slivers and break the mesh topology.
    let total = 0;
    for (let t = 0; t < caps.length; t += 3) {
      const [a, b, c] = [pts[caps[t]!]!, pts[caps[t + 1]!]!, pts[caps[t + 2]!]!];
      total += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    for (let t = 0; t < caps.length; t += 3) {
      let [a, b, c] = [caps[t]!, caps[t + 1]!, caps[t + 2]!];
      if (total < 0) [b, c] = [c, b];
      tris.push([top(a), top(b), top(c)], [bot(a), bot(c), bot(b)]);
    }

    for (const ring of ringIdx) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        tris.push([bot(a), bot(b), top(b)], [bot(a), top(b), top(a)]);
      }
    }
  }
  return { verts, tris };
}

/** A separate object on the plate, made of one part per color. */
export interface MeshObject {
  /** Object name shown in the slicer. */
  name: string;
  parts: MeshPart[];
}

export interface ThreeMfOptions {
  /** Plate name. */
  name: string;
  /** Bed position of the center of all the objects (mm). */
  position: [number, number];
  /** Mirror horizontally (for face-down printing). */
  mirror?: boolean;
  /** `Metadata/project_settings.config` contents, which carry filament colors (see printers.ts). */
  projectConfig?: string | null;
}

/**
 * Build the 3MF archive. Every object keeps its place relative to the others (shapes share one
 * coordinate space), and the whole group is centered on `position`.
 */
export function write3mf(objects: MeshObject[], { name, position, mirror = false, projectConfig }: ThreeMfOptions): Uint8Array {
  const center = (shape: Shape): [number, number] => {
    const b = bbox(shape);
    return [(b.minX + b.maxX) / 2 / SCALE, (b.minY + b.maxY) / 2 / SCALE];
  };
  const [gx, gy] = center(objects.flatMap((o) => o.parts.flatMap((p) => p.shape)));
  const f = (v: number) => fmt(v, 4);
  const sx = mirror ? -1 : 1;

  let nextId = 1;
  const resources: string[] = [];
  const items: string[] = [];
  const configs: string[] = [];
  const instances: string[] = [];
  for (const obj of objects) {
    // Each object's mesh is centered on itself; its build item places it on the bed.
    const [cx, cy] = center(obj.parts.flatMap((p) => p.shape));
    const ids = obj.parts.map((part) => {
      const id = nextId++;
      const { verts, tris } = extrude(part.shape, part.height, cx, cy, mirror, part.z);
      const v = verts.map(([x, y, z]) => `<vertex x="${f(x)}" y="${f(y)}" z="${f(z)}"/>`).join('');
      const t = tris.map(([a, b2, c]) => `<triangle v1="${a}" v2="${b2}" v3="${c}"/>`).join('');
      resources.push(`  <object id="${id}" name="${xmlEsc(part.id)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`);
      return id;
    });
    const asmId = nextId++;
    resources.push(
      `  <object id="${asmId}" name="${xmlEsc(obj.name)}" type="model"><components>` +
        ids.map((id) => `<component objectid="${id}"/>`).join('') +
        '</components></object>',
    );
    const x = position[0] + sx * (cx - gx);
    const y = position[1] - (cy - gy);
    items.push(`<item objectid="${asmId}" transform="1 0 0 0 1 0 0 0 1 ${f(x)} ${f(y)} 0"/>`);

    // Orca / Bambu Studio read per-part names and filament ("extruder") assignments from here.
    configs.push(
      `  <object id="${asmId}">`,
      `    <metadata key="name" value="${xmlEsc(obj.name)}"/>`,
      `    <metadata key="extruder" value="${obj.parts[0]?.filament ?? 1}"/>`,
      ...obj.parts.flatMap((p, i) => [
        `    <part id="${ids[i]}" subtype="normal_part">`,
        `      <metadata key="name" value="${xmlEsc(p.id)}"/>`,
        `      <metadata key="extruder" value="${p.filament}"/>`,
        '    </part>',
      ]),
      '  </object>',
    );
    instances.push(
      '    <model_instance>',
      `      <metadata key="object_id" value="${asmId}"/>`,
      '      <metadata key="instance_id" value="0"/>',
      '    </model_instance>',
    );
  }

  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <metadata name="Application">textrude</metadata>',
    ' <resources>',
    ...resources,
    ' </resources>',
    ` <build>${items.join('')}</build>`,
    '</model>',
  ].join('\n');

  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    ...configs,
    // Without a plate entry, Orca names the plate "Untitled".
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    `    <metadata key="plater_name" value="${xmlEsc(name)}"/>`,
    '    <metadata key="locked" value="false"/>',
    ...instances,
    '  </plate>',
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

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(settings),
  };
  if (projectConfig) files['Metadata/project_settings.config'] = strToU8(projectConfig);
  return zipSync(files, { level: 6 });
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => path.join(here, 'fixtures', 'fonts', name);

export const INTER = fixture('inter-static/Inter-Regular.ttf');
export const INTER_VARIABLE = fixture('Inter-Variable.ttf');
export const TWEMOJI = fixture('twemoji-subset.ttf');
export const BLOBMOJI = fixture('blobmoji-subset.ttf');

export function unzip3mf(data: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(data)).map(([k, v]) => [k, strFromU8(v)]));
}

export interface MeshReport {
  name: string;
  vertices: number;
  triangles: number;
  /** Directed edges that aren't matched by exactly one opposite edge. */
  badEdges: number;
  volume: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Check every mesh in a 3MF: closed and manifold (each directed edge appears once, with its
 * reverse appearing once) and outward-facing (positive signed volume).
 */
export function checkMeshes(data: Uint8Array): MeshReport[] {
  const model = unzip3mf(data)['3D/3dmodel.model']!;
  const reports: MeshReport[] = [];
  for (const obj of model.matchAll(/<object id="\d+" name="([^"]*)" type="model"><mesh>(.*?)<\/mesh>/gs)) {
    const V = [...obj[2]!.matchAll(/x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
    const T = [...obj[2]!.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
    const edges = new Map<string, number>();
    for (const [a, b, c] of T) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) edges.set(`${p},${q}`, (edges.get(`${p},${q}`) ?? 0) + 1);
    }
    let badEdges = 0;
    for (const [k, n] of edges) {
      const [p, q] = k.split(',');
      if (n !== 1 || edges.get(`${q},${p}`) !== 1) badEdges++;
    }
    let volume = 0;
    for (const [a, b, c] of T) {
      const [p, q, r] = [V[a]!, V[b]!, V[c]!];
      volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
    const xs = V.map((v) => v[0]);
    const zs = V.map((v) => v[2]);
    reports.push({
      name: obj[1]!,
      vertices: V.length,
      triangles: T.length,
      badEdges,
      volume,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    });
  }
  return reports;
}

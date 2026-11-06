/**
 * Runs textrude off the main thread, so typing stays responsive while designs render.
 */
import { textrude, TextrudeError, type LogEvent, type TextrudeResult } from 'textrude';
import type { Model, WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

// Font data by key. URL keys are fetched the first time they're used; the same Uint8Array is
// passed to textrude every time, so it reuses the parsed font.
const fonts = new Map<string, Promise<Uint8Array>>();

function font(key: string): Promise<Uint8Array> {
  let data = fonts.get(key);
  if (!data) {
    if (!/^(https?|blob):/.test(key)) throw new TextrudeError(`font "${key}" isn't loaded`);
    data = fetch(key).then(async (res) => {
      if (!res.ok) throw new TextrudeError(`could not download font (${res.status}): ${key}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    data.catch(() => fonts.delete(key));
    fonts.set(key, data);
  }
  return data;
}

let last: TextrudeResult | null = null;
// Where messages go. A result keeps the logger it was rendered with, so this is swapped for each
// request (exports log too, e.g. bed size warnings).
let sink: LogEvent[] = [];
const onLog = (ev: LogEvent) => sink.push(ev);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'font') {
    fonts.set(msg.key, Promise.resolve(msg.data));
  } else if (msg.type === 'render') {
    const logs: LogEvent[] = (sink = []);
    try {
      const [main, ...fallbacks] = await Promise.all([font(msg.font), ...msg.fallbackFonts.map(font)]);
      const start = performance.now();
      const result = await textrude(msg.text, { ...msg.options, font: main, fallbackFonts: fallbacks, onLog });
      const meshes = result.toMeshes();
      last = result;
      const model: Model = {
        id: msg.id,
        text: result.text,
        parts: meshes.map(({ part, positions, indices }) => ({
          id: part.id,
          color: part.color,
          filament: part.filament,
          height: part.height,
          roles: part.roles,
          positions,
          indices,
        })),
        width: result.width,
        depth: result.depth,
        height: result.height,
        fonts: result.fonts,
        bridged: result.bridged,
        time: performance.now() - start,
      };
      post({ type: 'rendered', id: msg.id, model, logs }, model.parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]));
    } catch (err) {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err), logs });
    }
  } else if (msg.type === 'export') {
    try {
      if (!last) throw new Error('nothing to export yet');
      const logs: LogEvent[] = (sink = []);
      const { printer, flip } = msg.options;
      const data =
        msg.format === '3mf'
          ? last.to3MF({ printer: printer || undefined, flip })
          : msg.format === 'svg'
            ? last.toSVG({ flip })
            : last.toPNG({ mirror: flip, maxWidth: 2048, maxHeight: 2048 });
      post({ type: 'exported', id: msg.id, data, logs });
    } catch (err) {
      post({ type: 'export-error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};

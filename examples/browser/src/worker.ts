/**
 * Runs textrude off the main thread, so typing stays responsive while designs render.
 */
import { isBmfont, parseBmfont } from '@tootallnate/bitmap-font';
import { zipSync } from 'fflate';
import { arrange, textrude, TextrudeError, type LogEvent, type Plate, type TextrudeResult } from 'textrude';
import type { Model, WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

// Font data by key. URL keys are fetched the first time they're used; the same Uint8Array is
// passed to textrude every time, so it reuses the parsed font.
const fonts = new Map<string, Promise<Uint8Array>>();

async function download(url: string, what = 'font'): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new TextrudeError(`could not download ${what} (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * A font URL's data. A BMFont .fnt comes with its page images, fetched relative to it and zipped
 * together, the same as an uploaded .fnt and its pages.
 */
async function downloadFont(url: string): Promise<Uint8Array> {
  const data = await download(url);
  if (!isBmfont(data)) return data;
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'font.fnt');
  const files: Record<string, Uint8Array> = { [name]: data };
  for (const page of parseBmfont(data).pages) files[page] = await download(new URL(page, url).href, 'BMFont page');
  return zipSync(files);
}

function font(key: string): Promise<Uint8Array> {
  let data = fonts.get(key);
  if (!data) {
    if (!/^(https?|blob):/.test(key)) throw new TextrudeError(`font "${key}" isn't loaded`);
    data = downloadFont(key);
    data.catch(() => fonts.delete(key));
    fonts.set(key, data);
  }
  return data;
}

let last: Plate | null = null;
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
      const loaded = await Promise.all(msg.texts.map((t) => Promise.all([font(t.font), ...t.fallbackFonts.map(font)])));
      const start = performance.now();
      const results: TextrudeResult[] = [];
      for (const [i, t] of msg.texts.entries()) {
        const [main, ...fallbacks] = loaded[i]!;
        try {
          results.push(await textrude(t.text, { ...t.options, font: main, fallbackFonts: fallbacks, onLog }));
        } catch (err) {
          if (msg.texts.length > 1 && err instanceof Error) err.message = `Text ${i + 1}: ${err.message}`;
          throw err;
        }
      }
      const plate = arrange(results, { gap: msg.gap, maxWidth: msg.maxWidth, onLog });
      const meshes = plate.toMeshes({ flip: msg.flip });
      last = plate;
      const model: Model = {
        id: msg.id,
        texts: results.map((r) => r.text),
        parts: meshes.map(({ part, positions, indices }) => ({
          id: part.id,
          color: part.color,
          filament: part.filament,
          height: part.height,
          roles: part.roles,
          positions,
          indices,
        })),
        width: plate.width,
        depth: plate.depth,
        height: plate.height,
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

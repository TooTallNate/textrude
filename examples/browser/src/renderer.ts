import type { LogEvent } from 'textrude';
import type { ExportFormat, ExportOptions, Model, RenderRequest, WorkerRequest, WorkerResponse } from './protocol';

export type RenderOutcome = { model: Model; logs: LogEvent[]; error?: undefined } | { error: string; logs: LogEvent[]; model?: undefined };

/**
 * The textrude worker. Renders are coalesced: while one is running, only the newest request
 * waits, and anything older is dropped.
 */
export class Renderer {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private busy = false;
  private pending: RenderRequest | null = null;
  private sentFonts = new Set<string>();
  private exports = new Map<number, { resolve: (data: Uint8Array | string) => void; reject: (err: Error) => void }>();

  /** Called with each finished render (only the newest request's). */
  onResult: (outcome: RenderOutcome) => void = () => {};
  /** Called when the worker starts or stops rendering. */
  onBusy: (busy: boolean) => void = () => {};

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
    this.worker.onerror = (e) => {
      this.busy = false;
      this.onBusy(false);
      this.onResult({ error: e.message || 'the renderer crashed', logs: [] });
    };
  }

  /** Give the worker a font's data (once per key). */
  addFont(key: string, data: Uint8Array) {
    if (this.sentFonts.has(key)) return;
    this.sentFonts.add(key);
    this.send({ type: 'font', key, data });
  }

  render(req: RenderRequest) {
    this.pending = req;
    this.flush();
  }

  export(format: ExportFormat, options: ExportOptions): Promise<Uint8Array | string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.exports.set(id, { resolve, reject });
      this.send({ type: 'export', id, format, options });
    });
  }

  dispose() {
    this.worker.terminate();
  }

  private send(msg: WorkerRequest) {
    this.worker.postMessage(msg);
  }

  private flush() {
    if (this.busy || !this.pending) return;
    const req = this.pending;
    this.pending = null;
    this.busy = true;
    this.onBusy(true);
    this.send({ type: 'render', id: this.nextId++, ...req });
  }

  private receive(msg: WorkerResponse) {
    if (msg.type === 'rendered' || msg.type === 'error') {
      this.busy = false;
      // A newer request is waiting, so this result is already stale.
      if (!this.pending) {
        this.onBusy(false);
        this.onResult(msg.type === 'rendered' ? { model: msg.model, logs: msg.logs } : { error: msg.message, logs: msg.logs });
      }
      this.flush();
    } else {
      const waiter = this.exports.get(msg.id);
      this.exports.delete(msg.id);
      if (msg.type === 'exported') waiter?.resolve(msg.data);
      else waiter?.reject(new Error(msg.message));
    }
  }
}

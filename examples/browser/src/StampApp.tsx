import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Cookie, Eye, EyeOff, FileUp, Info, LoaderCircle, Rotate3d, TriangleAlert, Upload } from 'lucide-react';
import type { HandleMode, LogEvent, StampPartName, StampStyle } from 'textrude';
import { PRINTERS } from 'textrude/printers';
import { Viewer, type ViewerHandle } from './components/Viewer';
import { NumberInput, Row, Section, Segmented, Select, Slider, Switch } from './components/ui';
import type { Model, StampExportFormat, StampRequest } from './protocol';
import { Renderer } from './renderer';
import { cn, download } from './lib/utils';
import exampleSvg from '../../stamps/snowflake.svg?raw';

export interface StampSettings {
  style: StampStyle;
  depth: number;
  /** Null: the SVG's own size (if it's in real units), else 60 mm. */
  size: number | null;
  margin: number | null;
  plateThickness: number;
  /** Null: on for imprinted, off for embossed. */
  chamfer: boolean | null;
  /** Null: separate for imprinted, attached for embossed. */
  handle: HandleMode | null;
  handleHeight: number | null;
  knobDiameter: number | null;
  stemDiameter: number | null;
  pegClearance: number;
  cutter: boolean;
  cutterHeight: number;
  cutterWall: number;
  clearance: number;
  rimWidth: number;
  rimHeight: number;
  faceUp: boolean;
  printer: string;
}

export const STAMP_DEFAULTS: StampSettings = {
  style: 'imprinted',
  depth: 1.8,
  size: null,
  margin: null,
  plateThickness: 4,
  chamfer: null,
  handle: null,
  handleHeight: null,
  knobDiameter: null,
  stemDiameter: null,
  pegClearance: 0.2,
  cutter: true,
  cutterHeight: 14,
  cutterWall: 1,
  clearance: 0.5,
  rimWidth: 5,
  rimHeight: 2.5,
  faceUp: false,
  printer: '',
};

const PART_LABELS: Record<string, string> = { stamp: 'Stamp', handle: 'Handle', cutter: 'Cutter' };

/** Settings from the URL hash (#stamp=<json>), for shareable links. */
function initialSettings(): StampSettings {
  const m = /(?:^#|&)stamp=([^&]*)/.exec(location.hash);
  if (!m) return STAMP_DEFAULTS;
  try {
    return { ...STAMP_DEFAULTS, ...(JSON.parse(decodeURIComponent(m[1]!)) as Partial<StampSettings>) };
  } catch {
    return STAMP_DEFAULTS;
  }
}

/** The cookie stamp maker: an SVG in, a stamp (and handle) and matching cutter out. */
export default function StampApp({ modeTabs }: { modeTabs: ReactNode }) {
  const [s, setSettings] = useState<StampSettings>(initialSettings);
  const set = <K extends keyof StampSettings>(key: K, value: StampSettings[K]) => setSettings((x) => ({ ...x, [key]: value }));
  const [svg, setSvg] = useState<{ name: string; text: string }>({ name: 'snowflake.svg', text: exampleSvg });
  const [model, setModel] = useState<Model | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const renderer = useMemo(() => new Renderer(), []);
  useEffect(() => {
    renderer.onBusy = setBusy;
    renderer.onResult = (outcome) => {
      setLogs(outcome.logs);
      setModel(outcome.model ?? null);
      setError(outcome.error ?? null);
    };
  }, [renderer]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const changed = Object.fromEntries(Object.entries(s).filter(([k, v]) => STAMP_DEFAULTS[k as keyof StampSettings] !== v));
      const hash = Object.keys(changed).length ? `#stamp=${encodeURIComponent(JSON.stringify(changed))}` : '';
      history.replaceState(null, '', location.pathname + location.search + hash);
    }, 300);
    return () => clearTimeout(timer);
  }, [s]);

  const style = s.style;
  const handle = s.handle ?? (style === 'imprinted' ? 'separate' : 'attached');
  const chamfer = s.chamfer ?? (style === 'imprinted' && handle === 'attached');

  useEffect(() => {
    const timer = setTimeout(() => {
      const req: StampRequest = {
        svg: svg.text,
        name: svg.name.replace(/\.svg$/i, ''),
        faceUp: s.faceUp,
        options: {
          style,
          depth: s.depth,
          size: s.size ?? undefined,
          margin: s.margin ?? undefined,
          plateThickness: s.plateThickness,
          chamfer,
          handle,
          handleHeight: s.handleHeight ?? undefined,
          knobDiameter: s.knobDiameter ?? undefined,
          stemDiameter: s.stemDiameter ?? undefined,
          pegClearance: s.pegClearance,
          cutter: s.cutter,
          cutterHeight: s.cutterHeight,
          cutterWall: s.cutterWall,
          clearance: s.clearance,
          rimWidth: s.rimWidth,
          rimHeight: s.rimHeight,
          maxWidth: s.printer ? PRINTERS[s.printer]?.bedSize?.[0] : undefined,
        },
      };
      renderer.renderStamp(req);
    }, 80);
    return () => clearTimeout(timer);
  }, [s, svg, renderer, style, handle, chamfer]);

  const openFile = async (file: File) => {
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
      setError(`${file.name} isn't an SVG file`);
      return;
    }
    setSvg({ name: file.name, text: await file.text() });
    setHidden(new Set());
    viewer.current?.fit('perspective');
  };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (f) openFile(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });

  const baseName = svg.name.replace(/\.svg$/i, '') || 'cookie';
  const exportAs = async (format: StampExportFormat, part?: StampPartName) => {
    if (!model) return;
    const key = `${format}:${part ?? ''}`;
    setExporting(key);
    try {
      const data = await renderer.exportStamp(format, { printer: s.printer, part });
      download(data, `${baseName}${part ? `-${part}` : ''}.${format}`, format === '3mf' ? 'model/3mf' : 'model/stl');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const notes = logs.filter((l) => l.level === 'warn' || l.level === 'note');
  const printer = s.printer ? PRINTERS[s.printer] : undefined;
  const bed = printer?.bedSize ?? null;
  const parts = model?.parts ?? [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      <aside className="order-2 flex min-h-0 flex-1 flex-col border-zinc-800 bg-zinc-950 lg:order-1 lg:w-[380px] lg:flex-none lg:border-r">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Cookie className="size-4.5 text-amber-400" /> textrude
            </h1>
            <p className="text-xs text-zinc-500">SVG to cookie stamps and cutters</p>
          </div>
          {modeTabs}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="Design">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" title={svg.name}>
                {svg.name}
              </div>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                title="Open an SVG (or drop one anywhere)"
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 text-sm text-zinc-300 hover:text-zinc-100"
              >
                <Upload className="size-4" /> SVG
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".svg,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) openFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            {svg.text !== exampleSvg && (
              <button
                type="button"
                onClick={() => setSvg({ name: 'snowflake.svg', text: exampleSvg })}
                className="cursor-pointer text-xs text-zinc-500 underline-offset-2 hover:text-zinc-200 hover:underline"
              >
                Use the example snowflake
              </button>
            )}
            <p className="text-xs leading-relaxed text-zinc-500">
              The outermost shape is the outline of the stamp and cutter. A solid background shape (like a filled circle behind the artwork) only sets the
              outline; everything else is the design. Convert text to outlines first.
            </p>
          </Section>

          <Section title="Stamp">
            <Row label="Style" hint="Imprinted: the design is pressed into the cookie. Embossed: the design stands up on the cookie">
              <Segmented
                value={style}
                onChange={(v) => set('style', v)}
                options={[
                  { value: 'imprinted', label: 'Imprinted', title: 'The design is pressed into the cookie (raised on the stamp)' },
                  { value: 'embossed', label: 'Embossed', title: 'The design stands up on the cookie (recessed into the stamp)' },
                ]}
              />
            </Row>
            <Row label="Depth" hint="How far the design is raised or recessed">
              <Slider value={s.depth} onChange={(v) => set('depth', v)} min={0.4} max={5} step={0.1} unit="mm" />
            </Row>
            <Row label="Size" hint="Width or height, whichever is larger. Empty: the SVG's size if it's in mm, cm or inches, else 60 mm">
              <NumberInput value={s.size} onChange={(v) => set('size', v)} min={10} nullable placeholder="auto" unit="mm" />
            </Row>
            <Row label="Margin" hint="Border around a design that has no background shape (empty: 3 mm, or none with a background or border)">
              <NumberInput value={s.margin} onChange={(v) => set('margin', v)} min={0} nullable placeholder="auto" unit="mm" />
            </Row>
            <Row label="Plate thickness">
              <Slider value={s.plateThickness} onChange={(v) => set('plateThickness', v)} min={2} max={10} step={0.5} unit="mm" />
            </Row>
            <Row label="45° relief walls" hint="Slope the design's walls: no supports needed, and the dough lets go more cleanly (off by default for embossed, where it makes thin lines shallower)">
              <Switch checked={chamfer} onChange={(v) => set('chamfer', v)} label="45° relief walls" />
            </Row>
          </Section>

          <Section title="Handle">
            <Row label="Handle">
              <Segmented
                value={handle}
                onChange={(v) => set('handle', v)}
                options={[
                  { value: 'separate', label: 'Separate', title: 'The stamp prints face-up and the handle on its own; it plugs into a keyed socket' },
                  { value: 'attached', label: 'One piece', title: 'Stamp and handle in one piece, printed face-down' },
                  { value: 'none', label: 'None', title: 'A plain plate' },
                ]}
              />
            </Row>
            <p className="text-xs leading-relaxed text-zinc-500">
              {handle === 'separate'
                ? 'The stamp prints face-up, so the design needs no bridging. The handle prints knob-down and plugs into a keyed socket in the back (glue it if the fit is loose).'
                : handle === 'attached'
                  ? style === 'imprinted'
                    ? 'Prints face-down in one piece. The plate bridges over the gaps between the raised parts of the design (the 45° walls keep them short).'
                    : 'Prints face-down in one piece, with the handle up. The tops of the recesses are short bridges.'
                  : 'A plain plate with no handle.'}
            </p>
            {handle !== 'none' && (
              <>
                <Row label="Height">
                  <NumberInput value={s.handleHeight} onChange={(v) => set('handleHeight', v)} min={5} nullable placeholder="auto" unit="mm" />
                </Row>
                <Row label="Knob diameter">
                  <NumberInput value={s.knobDiameter} onChange={(v) => set('knobDiameter', v)} min={5} nullable placeholder="auto" unit="mm" />
                </Row>
                <Row label="Stem diameter">
                  <NumberInput value={s.stemDiameter} onChange={(v) => set('stemDiameter', v)} min={3} nullable placeholder="auto" unit="mm" />
                </Row>
              </>
            )}
            {handle === 'separate' && (
              <Row label="Peg clearance" hint="Gap on each side of the peg in its socket: raise it if the fit is too tight">
                <Slider value={s.pegClearance} onChange={(v) => set('pegClearance', v)} min={0} max={0.6} step={0.05} unit="mm" />
              </Row>
            )}
          </Section>

          <Section title="Cutter" right={<Switch checked={s.cutter} onChange={(v) => set('cutter', v)} label="Cutter" />}>
            {s.cutter && (
              <>
                <Row label="Height">
                  <Slider value={s.cutterHeight} onChange={(v) => set('cutterHeight', v)} min={6} max={30} step={0.5} unit="mm" />
                </Row>
                <Row label="Edge thickness" hint="Wall thickness at the cutting edge (twice this lower down)">
                  <Slider value={s.cutterWall} onChange={(v) => set('cutterWall', v)} min={0.4} max={3} step={0.1} unit="mm" />
                </Row>
                <Row label="Clearance" hint="Gap between the stamp and the inside of the cutter">
                  <Slider value={s.clearance} onChange={(v) => set('clearance', v)} min={0} max={3} step={0.1} unit="mm" />
                </Row>
                <Row label="Rim width" hint="The flange on the bed, measured from the inside edge">
                  <Slider value={s.rimWidth} onChange={(v) => set('rimWidth', v)} min={1} max={15} step={0.5} unit="mm" />
                </Row>
                <Row label="Rim thickness">
                  <Slider value={s.rimHeight} onChange={(v) => set('rimHeight', v)} min={0.6} max={6} step={0.1} unit="mm" />
                </Row>
              </>
            )}
          </Section>

          <Section title="Export">
            <Row label="Printer" hint="Opens the 3MF with this printer's presets, centered on its bed">
              <Select value={s.printer} onChange={(v) => set('printer', v)} className="w-48">
                <option value="">None</option>
                {Object.entries(PRINTERS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Row>
            <button
              type="button"
              disabled={!model || busy || !!exporting}
              onClick={() => exportAs('3mf')}
              className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-sky-500 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
            >
              {exporting === '3mf:' ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
              3MF (all parts)
            </button>
            <div className={cn('grid gap-2', parts.length === 3 ? 'grid-cols-3' : parts.length === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
              {parts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!model || busy || !!exporting}
                  onClick={() => exportAs('stl', p.id as StampPartName)}
                  className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-zinc-700 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-50"
                >
                  {exporting === `stl:${p.id}` ? <LoaderCircle className="size-4 animate-spin" /> : <FileUp className="size-4 rotate-180" />}
                  {PART_LABELS[p.id] ?? p.id} STL
                </button>
              ))}
            </div>
          </Section>

          <footer className="space-y-1 px-4 py-4 text-[11px] leading-relaxed text-zinc-500">
            <p>Everything runs in your browser. Your SVG never leaves your device.</p>
            <p>Every part prints without supports: a one-piece stamp face-down, a separate stamp face-up with its handle knob-down, and the cutter rim-down.</p>
          </footer>
        </div>
      </aside>

      <main className="relative order-1 h-[45dvh] shrink-0 bg-zinc-900 lg:order-2 lg:h-auto lg:flex-1">
        <Viewer ref={viewer} model={model} hidden={hidden} bed={bed} />

        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex flex-col gap-1 rounded-lg bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 backdrop-blur">
            {model ? (
              <>
                <span className="font-medium text-zinc-100 tabular-nums">
                  {model.width.toFixed(1)} × {model.depth.toFixed(1)} × {model.height.toFixed(1)} mm
                </span>
                <span className="text-zinc-400 tabular-nums">
                  {style === 'imprinted' ? 'Imprinted' : 'Embossed'} · {parts.length} part{parts.length === 1 ? '' : 's'} · {Math.round(model.time)} ms
                </span>
              </>
            ) : (
              <span className="text-zinc-400">{error ? 'Nothing to show' : 'Loading…'}</span>
            )}
          </div>
          <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-zinc-950/70 p-1 backdrop-blur">
            {busy && <LoaderCircle className="mx-1.5 size-4 animate-spin text-zinc-400" aria-label="Rendering" />}
            {handle === 'attached' && (
              <div className="flex items-center rounded-md bg-zinc-900 p-0.5 text-xs" role="group" aria-label="Preview orientation">
                {([
                  [false, 'As printed', 'Show the one-piece stamp the way it prints: face-down on the bed, handle up (this is how the exported file is oriented)'],
                  [true, 'Face up', 'Flip the preview to look at the design (preview only; the exported file stays face-down)'],
                ] as const).map(([v, label, title]) => (
                  <button
                    key={label}
                    type="button"
                    title={title}
                    aria-pressed={s.faceUp === v}
                    onClick={() => set('faceUp', v)}
                    className={cn(
                      'flex h-6 cursor-pointer items-center rounded px-2 hover:bg-zinc-800',
                      s.faceUp === v ? 'bg-zinc-700 text-white' : 'text-zinc-400',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <ViewButton title="Reset view" onClick={() => viewer.current?.fit('perspective')}>
              <Rotate3d className="size-4" />
            </ViewButton>
            <ViewButton title="Top" onClick={() => viewer.current?.fit('top')}>
              Top
            </ViewButton>
            <ViewButton title="Front" onClick={() => viewer.current?.fit('front')}>
              Front
            </ViewButton>
            <ViewButton title="Bottom (the side on the bed)" onClick={() => viewer.current?.fit('bottom')}>
              Bottom
            </ViewButton>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col items-start gap-2">
          {(error || notes.length > 0) && (
            <div className="pointer-events-auto max-w-md space-y-1 rounded-lg bg-zinc-950/80 px-3 py-2 text-xs backdrop-blur">
              {error && (
                <p className="flex gap-2 text-red-300">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" /> {error}
                </p>
              )}
              {notes.map((n, i) => (
                <p key={i} className={cn('flex gap-2', n.level === 'warn' ? 'text-amber-300' : 'text-zinc-400')}>
                  {n.level === 'warn' ? <TriangleAlert className="mt-px size-3.5 shrink-0" /> : <Info className="mt-px size-3.5 shrink-0" />}
                  {n.message}
                </p>
              ))}
            </div>
          )}
          {model && (
            <div className="pointer-events-auto flex max-w-full flex-wrap gap-1.5">
              {parts.map((p) => {
                const off = hidden.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={`${PART_LABELS[p.id] ?? p.id}: ${p.height.toFixed(1)} mm tall${off ? ' (hidden)' : ''}`}
                    onClick={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (off) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md bg-zinc-950/70 py-1 pr-2 pl-1 text-xs backdrop-blur transition-opacity hover:bg-zinc-950',
                      off && 'opacity-50',
                    )}
                  >
                    <span className="size-5 rounded ring-1 ring-white/15" style={{ background: p.color }} />
                    <span className="text-zinc-200">{PART_LABELS[p.id] ?? p.id}</span>
                    {off ? <EyeOff className="size-3.5 text-zinc-500" /> : <Eye className="size-3.5 text-zinc-500" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {dragging && (
          <div className="absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-amber-400 bg-amber-500/10 text-sm text-amber-200">
            <Upload className="mr-2 size-4" /> Drop an SVG
          </div>
        )}
      </main>
    </div>
  );
}

function ViewButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
    >
      {children}
    </button>
  );
}

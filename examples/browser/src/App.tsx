import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, Bold, Box, Eye, EyeOff, Info, Italic, LoaderCircle, Rotate3d,
  Strikethrough, TriangleAlert, Underline, Upload,
} from 'lucide-react';
import type { LogEvent } from 'textrude';
import { PRINTERS } from 'textrude/printers';
import { Viewer, type ViewerHandle } from './components/Viewer';
import { ColorInput, ColorList, luminance, NumberInput, Row, Section, Segmented, Select, Slider, Switch, ToggleButton } from './components/ui';
import {
  BUNDLED, CATEGORIES, EMOJI_FONTS, canUseLocalFonts, fontUrl, localFamilies, pickLocalFace, type FontRef, type LocalFace, type UploadedFont,
} from './fonts';
import type { ExportFormat, Model } from './protocol';
import { Renderer } from './renderer';
import { DEFAULTS, decodeSettings, encodeSettings, renderOptions, type Settings } from './settings';
import { cn, download } from './lib/utils';

const FONT_FILE = /\.(ttf|otf|ttc|otc|woff2?)$/i;
const ROLE_LABELS: Record<string, string> = { text: 'Text', color: 'Emoji', stroke: 'Outline', bridge: 'Bridges', background: 'Background' };

const fontValue = (f: FontRef) => (f.kind === 'bundled' ? `bundled:${f.name}` : f.kind === 'local' ? `local:${f.family}` : `upload:${f.id}`);

function parseFontValue(v: string): FontRef {
  const [kind, ...rest] = v.split(':');
  const name = rest.join(':');
  return kind === 'local' ? { kind, family: name } : kind === 'upload' ? { kind, id: name } : { kind: 'bundled', name };
}

/** A file name for the design: its text, without emoji or punctuation. */
function fileName(text: string) {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  return slug || 'textrude';
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => decodeSettings(location.hash));
  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value })), []);

  const [uploads, setUploads] = useState<UploadedFont[]>([]);
  const [localFonts, setLocalFonts] = useState<Map<string, LocalFace[]> | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
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

  // Keep the design in the URL, so it survives reloads and can be shared.
  useEffect(() => {
    const t = setTimeout(() => {
      const hash = encodeSettings(settings);
      history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
    }, 300);
    return () => clearTimeout(t);
  }, [settings]);

  // Fonts that aren't available (e.g. an uploaded font after a reload) fall back to the default.
  useEffect(() => {
    const f = settings.font;
    if ((f.kind === 'upload' && !uploads.some((u) => u.id === f.id)) || (f.kind === 'local' && !localFonts?.has(f.family))) {
      set('font', DEFAULTS.font);
    } else if (f.kind === 'bundled' && !BUNDLED.some((b) => b.name === f.name)) {
      set('font', DEFAULTS.font);
    }
  }, [settings.font, uploads, localFonts, set]);

  // Render whenever the settings change.
  const localLoaded = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const s = settings;
      let font: string;
      let style = { bold: s.bold, italic: s.italic };
      if (s.font.kind === 'bundled') {
        const name = s.font.name;
        const b = BUNDLED.find((x) => x.name === name) ?? BUNDLED[0]!;
        const useItalic = s.italic && b.italic;
        font = fontUrl(useItalic ? b.italic!.file : b.file);
        if (useItalic) style = { ...style, italic: false };
      } else if (s.font.kind === 'local') {
        const faces = localFonts?.get(s.font.family);
        if (!faces) return;
        const pick = pickLocalFace(faces, s.bold, s.italic);
        font = `local:${pick.face.postscriptName}`;
        style = { bold: s.bold && !pick.bold, italic: s.italic && !pick.italic };
        if (!localLoaded.current.has(font)) {
          const data = new Uint8Array(await (await pick.face.blob()).arrayBuffer());
          if (cancelled) return;
          renderer.addFont(font, data);
          localLoaded.current.add(font);
        }
      } else {
        const id = s.font.id;
        if (!uploads.some((u) => u.id === id)) return;
        font = `upload:${id}`;
      }
      const emoji = EMOJI_FONTS.find((e) => e.name === s.emojiFont);
      // Only load the (large) emoji font when the text might need it.
      const fallbackFonts = emoji && /[^\x00-\x7f]/.test(s.text) ? [fontUrl(emoji.file)] : [];
      if (!cancelled) renderer.render({ text: s.text, font, fallbackFonts, options: renderOptions(s, style), flip: s.flip });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [settings, uploads, localFonts, renderer]);

  const addFontFiles = useCallback(
    async (files: FileList | File[]) => {
      const fonts = [...files].filter((f) => FONT_FILE.test(f.name));
      if (!fonts.length) return;
      const added: UploadedFont[] = [];
      for (const file of fonts) {
        const id = `${file.name}-${file.size}-${file.lastModified}`;
        const data = new Uint8Array(await file.arrayBuffer());
        renderer.addFont(`upload:${id}`, data);
        added.push({ id, name: file.name.replace(FONT_FILE, ''), data });
      }
      setUploads((u) => [...u.filter((x) => !added.some((a) => a.id === x.id)), ...added]);
      set('font', { kind: 'upload', id: added[0]!.id });
    },
    [renderer, set],
  );

  // Drop font files anywhere on the page.
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
      if (e.dataTransfer?.files.length) addFontFiles(e.dataTransfer.files);
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
  }, [addFontFiles]);

  const loadLocalFonts = async () => {
    try {
      const families = await localFamilies();
      setLocalFonts(families);
      return families;
    } catch (err) {
      setError(`Couldn't read installed fonts: ${(err as Error).message}`);
      return null;
    }
  };

  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const exportAs = async (format: ExportFormat) => {
    if (!model) return;
    setExporting(format);
    try {
      const data = await renderer.export(format, { printer: settings.printer, flip: settings.flip });
      const type = format === '3mf' ? 'model/3mf' : format === 'svg' ? 'image/svg+xml' : 'image/png';
      download(data, `${fileName(model.text)}.${format}`, type);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const printer = settings.printer ? PRINTERS[settings.printer] : undefined;
  const bed = printer?.bedSize ?? null;
  const filaments = model ? new Set(model.parts.map((p) => p.filament)).size : 0;
  const tooManyColors = printer?.toolheads != null && filaments > printer.toolheads;
  const notes = logs.filter((l) => l.level === 'warn' || l.level === 'note');
  const multiline = settings.text.includes('\n');
  const s = settings;

  return (
    <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
      {/* Controls */}
      <aside className="order-2 flex min-h-0 flex-1 flex-col border-zinc-800 bg-zinc-950 lg:order-1 lg:w-[380px] lg:flex-none lg:border-r">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Box className="size-4.5 text-sky-400" /> textrude
            </h1>
            <p className="text-xs text-zinc-500">Text and emoji to multi-color 3D prints</p>
          </div>
          <a
            href="https://github.com/TooTallNate/textrude"
            target="_blank"
            rel="noreferrer"
            className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="textrude on GitHub"
          >
            <GitHubIcon className="size-4.5" />
          </a>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="Text">
            <textarea
              value={s.text}
              onChange={(e) => set('text', e.target.value)}
              rows={Math.min(6, Math.max(2, s.text.split('\n').length))}
              spellCheck={false}
              placeholder="Type something…"
              className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
            <Row label="Font">
              <Select
                value={fontValue(s.font)}
                className="w-44"
                onChange={async (v) => {
                  if (v === 'action:upload') fileInput.current?.click();
                  else if (v === 'action:local') {
                    const families = await loadLocalFonts();
                    const first = families?.keys().next().value;
                    if (first) set('font', { kind: 'local', family: first });
                  } else set('font', parseFontValue(v));
                }}
              >
                {CATEGORIES.map((cat) => (
                  <optgroup key={cat} label={cat}>
                    {BUNDLED.filter((f) => f.category === cat).map((f) => (
                      <option key={f.name} value={`bundled:${f.name}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {uploads.length > 0 && (
                  <optgroup label="Uploaded">
                    {uploads.map((u) => (
                      <option key={u.id} value={`upload:${u.id}`}>
                        {u.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {localFonts && (
                  <optgroup label="Installed">
                    {[...localFonts.keys()].map((family) => (
                      <option key={family} value={`local:${family}`}>
                        {family}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="More fonts">
                  <option value="action:upload">Upload a font file…</option>
                  {canUseLocalFonts && !localFonts && <option value="action:local">Use installed fonts…</option>}
                </optgroup>
              </Select>
              <button
                type="button"
                title="Upload a font file (TTF, OTF, WOFF, WOFF2, TTC), or drop one anywhere"
                aria-label="Upload a font file"
                onClick={() => fileInput.current?.click()}
                className="flex size-8 cursor-pointer items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
              >
                <Upload className="size-4" />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".ttf,.otf,.ttc,.otc,.woff,.woff2"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFontFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </Row>
            <Row label="Style">
              <ToggleButton pressed={s.bold} onChange={(v) => set('bold', v)} title="Bold">
                <Bold className="size-4" />
              </ToggleButton>
              <ToggleButton pressed={s.italic} onChange={(v) => set('italic', v)} title="Italic">
                <Italic className="size-4" />
              </ToggleButton>
              <ToggleButton pressed={s.underline} onChange={(v) => set('underline', v)} title="Underline">
                <Underline className="size-4" />
              </ToggleButton>
              <ToggleButton pressed={s.strikethrough} onChange={(v) => set('strikethrough', v)} title="Strikethrough">
                <Strikethrough className="size-4" />
              </ToggleButton>
            </Row>
            <Row label="Size" hint="The font's em size">
              <Slider value={s.size} onChange={(v) => set('size', v)} min={5} max={80} step={0.5} unit="mm" />
            </Row>
            <Row label="Letter spacing">
              <Slider value={s.letterSpacing} onChange={(v) => set('letterSpacing', v)} min={-2} max={10} step={0.1} unit="mm" />
            </Row>
            {multiline && (
              <>
                <Row label="Align">
                  <Segmented
                    value={s.align}
                    onChange={(v) => set('align', v)}
                    options={[
                      { value: 'left', label: <AlignLeft className="size-3.5" />, title: 'Left' },
                      { value: 'center', label: <AlignCenter className="size-3.5" />, title: 'Center' },
                      { value: 'right', label: <AlignRight className="size-3.5" />, title: 'Right' },
                    ]}
                  />
                </Row>
                <Row label="Line spacing">
                  <Slider value={s.lineSpacing} onChange={(v) => set('lineSpacing', v)} min={0.5} max={3} step={0.05} unit="×" />
                </Row>
              </>
            )}
          </Section>

          <Section title="Colors">
            <Row label="Text color">
              <ColorInput value={s.color} onChange={(v) => set('color', v)} disabled={s.hollow || !!s.letterColors} />
            </Row>
            <Row label="Hollow letters" hint="No fill: only the outline is printed">
              <Switch checked={s.hollow} onChange={(v) => set('hollow', v)} label="Hollow letters" />
            </Row>
            <Row label="Color per letter">
              <Switch
                checked={!!s.letterColors}
                onChange={(v) => set('letterColors', v ? ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7'] : null)}
                label="Color per letter"
              />
            </Row>
            {s.letterColors && <ColorList colors={s.letterColors} onChange={(v) => set('letterColors', v)} />}
            <Row label="Emoji font">
              <Select value={s.emojiFont} onChange={(v) => set('emojiFont', v)} className="w-36">
                {EMOJI_FONTS.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
                <option value="none">None</option>
              </Select>
            </Row>
          </Section>

          <Section title="Outline" right={<Switch checked={s.strokeWidth > 0} onChange={(v) => set('strokeWidth', v ? 1.5 : 0)} label="Outline" />}>
            {s.strokeWidth > 0 && (
              <>
                <Row label="Width">
                  <Slider value={s.strokeWidth} onChange={(v) => set('strokeWidth', v)} min={0.1} max={8} step={0.1} unit="mm" />
                </Row>
                {s.background && (
                  <Row label="Same as background">
                    <Switch checked={s.strokeMatchesBackground} onChange={(v) => set('strokeMatchesBackground', v)} label="Same color as the background" />
                  </Row>
                )}
                <Row label="Color">
                  <ColorInput
                    value={s.background && s.strokeMatchesBackground ? s.backgroundColor : s.strokeColor}
                    onChange={(v) => setSettings((x) => ({ ...x, strokeColor: v, strokeMatchesBackground: false }))}
                  />
                </Row>
                <Row label="Position">
                  <Segmented
                    value={s.strokeAlign}
                    onChange={(v) => set('strokeAlign', v)}
                    options={[
                      { value: 'outside', label: 'Outside' },
                      { value: 'center', label: 'Center' },
                      { value: 'inside', label: 'Inside' },
                    ]}
                  />
                </Row>
                <Row label="Corners">
                  <Segmented
                    value={s.strokeJoin}
                    onChange={(v) => set('strokeJoin', v)}
                    options={[
                      { value: 'round', label: 'Round' },
                      { value: 'miter', label: 'Sharp' },
                      { value: 'square', label: 'Square' },
                    ]}
                  />
                </Row>
              </>
            )}
          </Section>

          <Section title="Background plate" right={<Switch checked={s.background} onChange={(v) => set('background', v)} label="Background plate" />}>
            {s.background && (
              <>
                <Row label="Color">
                  <ColorInput value={s.backgroundColor} onChange={(v) => set('backgroundColor', v)} />
                </Row>
                <Row label="Padding">
                  <NumberInput value={s.backgroundPadding} onChange={(v) => set('backgroundPadding', v)} min={0} nullable placeholder={String(s.size * 0.25)} unit="mm" />
                </Row>
                <Row label="Corner radius" hint="Like CSS border-radius: a huge radius makes a pill">
                  <Slider value={s.backgroundRadius} onChange={(v) => set('backgroundRadius', v)} min={0} max={50} step={0.5} unit="mm" />
                </Row>
              </>
            )}
            {!s.background && (
              <Row label="Connect pieces" hint="Bridge separate letters and dots so the print is one piece">
                <Switch checked={s.connect} onChange={(v) => set('connect', v)} label="Connect pieces" />
              </Row>
            )}
            {!s.background && s.connect && (
              <Row label="Bridge width">
                <NumberInput
                  value={s.bridgeWidth}
                  onChange={(v) => set('bridgeWidth', v)}
                  min={0.1}
                  nullable
                  placeholder={String(s.strokeWidth > 0 ? s.strokeWidth : +(s.size * 0.1).toFixed(2))}
                  unit="mm"
                />
              </Row>
            )}
          </Section>

          <Section title="Heights">
            <Row label="Height">
              <Slider value={s.height} onChange={(v) => set('height', v)} min={0.2} max={10} step={0.1} unit="mm" />
            </Row>
            <Row label="Text height" hint="Make the letters taller (raised) or shorter than the rest">
              <NumberInput value={s.textHeight} onChange={(v) => set('textHeight', v)} min={0.1} nullable placeholder={String(s.height)} unit="mm" />
            </Row>
            {s.strokeWidth > 0 && (
              <Row label="Outline height">
                <NumberInput value={s.strokeHeight} onChange={(v) => set('strokeHeight', v)} min={0.1} nullable placeholder={String(s.height)} unit="mm" />
              </Row>
            )}
            {s.background && (
              <Row label="Plate height">
                <NumberInput value={s.backgroundHeight} onChange={(v) => set('backgroundHeight', v)} min={0.1} nullable placeholder={String(s.height)} unit="mm" />
              </Row>
            )}
          </Section>

          <Section title="Filaments">
            <Row label="Map to my filaments" hint="Every color becomes the nearest of these, in slot order">
              <Switch
                checked={!!s.palette}
                onChange={(v) => set('palette', v ? ['#ffffff', '#111111', '#ef4444', '#facc15'] : null)}
                label="Map colors to filaments"
              />
            </Row>
            {s.palette && <ColorList colors={s.palette} onChange={(v) => set('palette', v)} numbered />}
            {!s.palette && (
              <Row label="Max colors" hint="Merge similar colors until at most this many remain">
                <NumberInput value={s.maxColors} onChange={(v) => set('maxColors', v == null ? null : Math.round(v))} min={1} max={32} step={1} nullable placeholder="all" />
              </Row>
            )}
          </Section>

          <Section title="Export">
            <Row label="Printer" hint="Embeds filament colors in the 3MF and centers the model on the bed">
              <Select value={s.printer} onChange={(v) => set('printer', v)} className="w-48">
                <option value="">None (no filament colors)</option>
                {Object.entries(PRINTERS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Row>
            <Row label="Print face-down" hint="Mirrors the model, so the visible side is the smooth side that touched the bed">
              <Switch checked={s.flip} onChange={(v) => set('flip', v)} label="Print face-down" />
            </Row>
            <div className="grid grid-cols-3 gap-2 pt-1">
              {(['3mf', 'svg', 'png'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  disabled={!model || busy || !!exporting}
                  onClick={() => exportAs(format)}
                  className={cn(
                    'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50',
                    format === '3mf' ? 'bg-sky-500 text-white hover:bg-sky-400' : 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800',
                  )}
                >
                  {exporting === format ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          </Section>

          <footer className="space-y-1 px-4 py-4 text-[11px] leading-relaxed text-zinc-500">
            <p>Everything runs in your browser. Fonts and designs never leave your device.</p>
            <p>
              Fonts from{' '}
              <a className="underline hover:text-zinc-300" href="https://fonts.google.com" target="_blank" rel="noreferrer">
                Google Fonts
              </a>{' '}
              (OFL / Apache 2.0).{' '}
              {EMOJI_FONTS.map((e) => (
                <span key={e.name}>
                  <a className="underline hover:text-zinc-300" href={e.license} target="_blank" rel="noreferrer">
                    {e.credit}
                  </a>
                  .{' '}
                </span>
              ))}
            </p>
          </footer>
        </div>
      </aside>

      {/* Preview */}
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
                  {model.parts.length} part{model.parts.length === 1 ? '' : 's'} · {filaments} filament{filaments === 1 ? '' : 's'} ·{' '}
                  {Math.round(model.time)} ms
                </span>
              </>
            ) : (
              <span className="text-zinc-400">{error ? 'Nothing to show' : 'Loading…'}</span>
            )}
          </div>
          <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-zinc-950/70 p-1 backdrop-blur">
            {busy && <LoaderCircle className="mx-1.5 size-4 animate-spin text-zinc-400" aria-label="Rendering" />}
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
          {(error || notes.length > 0 || tooManyColors) && (
            <div className="pointer-events-auto max-w-md space-y-1 rounded-lg bg-zinc-950/80 px-3 py-2 text-xs backdrop-blur">
              {error && (
                <p className="flex gap-2 text-red-300">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" /> {error}
                </p>
              )}
              {tooManyColors && (
                <p className="flex gap-2 text-amber-300">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {filaments} filaments, but the {printer!.label} has {printer!.toolheads} toolheads. Lower “Max colors” or map to your filaments.
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
              {model.parts.map((p) => {
                const off = hidden.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={`${p.id}: filament ${p.filament}, ${p.height} mm${off ? ' (hidden)' : ''}`}
                    onClick={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (off) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md bg-zinc-950/70 py-1 pr-1.5 pl-1 text-xs sm:gap-2 sm:pr-2 backdrop-blur transition-opacity hover:bg-zinc-950',
                      off && 'opacity-50',
                    )}
                  >
                    <span
                      className="flex size-5 items-center justify-center rounded text-[10px] font-semibold ring-1 ring-white/15"
                      style={{ background: p.color, color: luminance(p.color) > 0.5 ? '#000' : '#fff' }}
                    >
                      {p.filament}
                    </span>
                    <span className="hidden text-zinc-200 sm:inline">{p.roles.map((r) => ROLE_LABELS[r] ?? r).join(' + ')}</span>
                    <span className="hidden font-mono text-[10px] text-zinc-500 sm:inline">{p.color}</span>
                    {off ? <EyeOff className="size-3.5 text-zinc-500" /> : <Eye className="size-3.5 text-zinc-500" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {dragging && (
          <div className="absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-sky-400 bg-sky-500/10 text-sm text-sky-200">
            <Upload className="mr-2 size-4" /> Drop a font file to use it
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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

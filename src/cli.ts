/** The `textrude` command-line interface. */
import fs from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { textrude, type TextrudeOptions, type TextrudeResult, type ThreeMfExportOptions, type LogEvent } from './render.js';
import { arrange } from './plate.js';
import { PRINTERS, type PrinterProfile } from './printers.js';
import { systemFonts } from './fonts.js';
import { area } from './geometry.js';
import { TextrudeError } from './errors.js';
import { ui, setQuiet, formatBytes } from './ui.js';

const HELP = `Usage: textrude [text] [options]
       textrude [shared options] -t <text> [options] -t <text> [options] ...

Turn text (including color emoji) into a multi-color 3MF model or an SVG for 3D printing.
Text comes from the arguments, a config file, or stdin (piped, or "-"). Newlines start new
lines, and ANSI color codes color the text, e.g. syntax-highlighted code or lolcat output.

Multiple texts
  -t, --text <text>          Add a separate object (repeatable; "-" reads stdin). Options
                             before the first --text apply to all of them; options after a
                             --text apply to that text only (output options, like -o and
                             --printer, can go anywhere). Objects are laid out in rows
                             that fit the printer's bed (else 200 mm wide)
      --gap <n>              Space between objects in mm             [5]

Font
  -f, --font <name|path|url> Font name, file (ttf/otf/ttc/woff/woff2), or URL  [Arial]
                             Names are looked up in ./fonts, then installed fonts
      --font-index <n>       Face index inside a .ttc/.otc collection
      --fallback-font <f>    Font for characters the main font lacks (repeatable).
                             Emoji fall back to an installed color emoji font
      --variation <a=v>      Variable font axis, e.g. wght=700 (repeatable)
      --list-fonts           List installed fonts and exit

Style
  -b, --bold                 Bold: uses the family's bold face or the variable
                             font's weight axis, else synthesizes it
  -i, --italic               Italic: uses the family's italic face or the
                             ital/slnt axis, else synthesizes a slant
      --synthetic            Always synthesize bold/italic (skip face lookup)
      --embolden <n>         Thicken (or thin, if negative) outlines by n mm
                             per side                   [0, or 2% of size for synthetic bold]
      --slant <deg>          Slant glyphs by deg       [0, or 12 for synthetic italic]
  -u, --underline            Underline each line
      --strikethrough        Strike through each line
      --decoration-thickness <n>  Underline/strikethrough thickness  [font metric]
      --underline-offset <n> Distance from baseline to top of underline [font metric]

Text
  -s, --size <n>             Font size (em height) in mm             [20]
  -c, --color <css>          Text color ("none" = hollow)            [#000000]
      --letter-colors <list> Cycle through these colors per letter, e.g. red,gold,blue
      --align <l|c|r>        left | center | right                   [left]
      --line-spacing <n>     Line height multiplier                  [1]
      --letter-spacing <n>   Extra space between glyphs in mm        [0]
      --no-ansi              Don't interpret ANSI escape sequences in the text

Stroke
  -w, --stroke-width <n>     Stroke (outline) width in mm (0 = none) [0]
      --stroke-color <css>   Stroke color             [--background color, else #ffffff]
      --stroke-align <a>     outside | center | inside               [outside]
      --stroke-join <j>      round | miter | square                  [round]
      --miter-limit <n>      Miter limit                             [4]

Connecting
      --connect              Bridge disconnected islands into one piece
      --bridge-width <n>     Bridge thickness   [stroke width, or 10% of size]
      --bridge-color <css>   Bridge color       [stroke color, or text color]

Background
      --background <css>     Solid plate behind the whole design, in this color. It
                             holds every piece together, so no bridges are needed
      --background-padding <n>  Space around the design in mm        [25% of size]
      --background-radius <n>   Corner radius in mm (like CSS: a huge radius makes
                             a pill, or a circle for a square)         [0]

Colors & filaments
      --palette <list>       Your filament colors, in slot order, e.g.
                             "black,white,red,#ffd700". Every color is mapped to
                             the nearest one, and parts use that filament slot
      --max-colors <n>       Merge similar colors until at most n remain
      --bitmap-colors <n>    Colors to reduce bitmap emoji to (Apple / Noto /
                             Blobmoji), when no --palette is given   [8]

Output
  -o, --output <file>        Output file (default: stdout). A .3mf extension
                             implies --format 3mf
      --format <f>           svg | 3mf                    [from extension, else svg]
      --single-path          Merge everything into one region (single-material)
      --flip                 Mirror the design so it prints face-down: the text side
                             sits on the build plate for the smoothest finish
      --tolerance <n>        Max curve flattening error              [0.01]
      --config <file>        Read options from a JSON file (CLI flags override it)
      --no-preview           Don't show an image preview in the terminal
                             [preview shown when stderr is a terminal]
      --preview-png <file>   Also save the preview image as a PNG
  -q, --quiet                Only print errors
  -v, --version              Show the version
  -h, --help                 Show this help

SVG only
      --margin <n>           Padding around the artwork              [1]
      --units <u>            SVG width/height unit                   [mm]
      --precision <n>        Decimal places                          [3]

3MF only (one part per color, each assigned its own filament)
      --printer <id>         Printer profile, so the 3MF carries its filament colors and
                             opens with the right printer: ${Object.keys(PRINTERS).join(', ')}
                             [$TEXTRUDE_PRINTER]. Without one, the slicer can't know
                             the colors and keeps its current filament list
      --printer-preset <s>   Or any printer: the slicer's exact printer preset name
                             (also needs --process-preset and --filament-preset)
      --process-preset <s>   Process preset name                     [from profile]
      --filament-preset <s>  Filament preset name, e.g. "Snapmaker PLA Matte @U1"
                                                                     [from profile]
      --bed-type <s>         Bed type, e.g. "Textured PEI Plate"     [from profile]
      --height <n>           Height of every part in mm              [2]
      --text-height <n>      Height of text (and emoji) parts        [--height]
      --stroke-height <n>    Height of the stroke part               [--height]
      --bridge-height <n>    Height of the bridges part              [--height]
      --background-height <n>  Height of the background part         [--height]
      --text-filament <n>    Filament number for the text            [auto]
      --stroke-filament <n>  Filament number for the stroke          [auto]
      --bridge-filament <n>  Filament number for bridges             [auto]
      --background-filament <n>  Filament number for the background  [auto]
      --position <x,y>       Bed position of the object's center
                             [printer's bed center, else 100,100]
                             (without --palette, filaments are numbered 1, 2, 3...
                             by distinct color)

Examples
  textrude "Hello" -f "Arial Black" -w 2 --connect --flip --printer snapmaker-u1 -o hello.3mf
  textrude "I ❤️ 3D printing 🎉" -f Helvetica --fallback-font ./fonts/twemoji.ttf -w 1.5 --connect -o emoji.3mf
  textrude "Rainbow" -f "Arial Black" --letter-colors red,orange,gold,green,blue,purple -o rainbow.3mf
  textrude "🦄" -f ./fonts/openmoji.ttf -s 40 --palette white,black,pink,purple -o unicorn.3mf
  textrude $'Hello\\nWorld' --align center -o hello.3mf
  textrude -f "Arial Black" -w 2 --connect -t Alice -c red -t Bob -c blue -t Carol -o names.3mf
  FORCE_COLOR=1 npx cli-highlight hello.c | textrude -f Menlo --background '#1e1e1e' -o code.3mf
  echo "Rainbow" | lolcat -f | textrude -f "Arial Black" -o rainbow.3mf
`;

const OPTIONS = {
  text: { type: 'string', short: 't' },
  gap: { type: 'string' },
  font: { type: 'string', short: 'f' },
  'font-index': { type: 'string' },
  'fallback-font': { type: 'string', multiple: true },
  variation: { type: 'string', multiple: true },
  'list-fonts': { type: 'boolean' },
  bold: { type: 'boolean', short: 'b' },
  italic: { type: 'boolean', short: 'i' },
  synthetic: { type: 'boolean' },
  embolden: { type: 'string' },
  slant: { type: 'string' },
  underline: { type: 'boolean', short: 'u' },
  strikethrough: { type: 'boolean' },
  'decoration-thickness': { type: 'string' },
  'underline-offset': { type: 'string' },
  size: { type: 'string', short: 's' },
  color: { type: 'string', short: 'c' },
  'letter-colors': { type: 'string' },
  align: { type: 'string' },
  'line-spacing': { type: 'string' },
  'letter-spacing': { type: 'string' },
  ansi: { type: 'boolean' },
  'stroke-width': { type: 'string', short: 'w' },
  'stroke-color': { type: 'string' },
  'stroke-align': { type: 'string' },
  'stroke-join': { type: 'string' },
  'miter-limit': { type: 'string' },
  connect: { type: 'boolean' },
  'bridge-width': { type: 'string' },
  'bridge-color': { type: 'string' },
  background: { type: 'string' },
  'background-padding': { type: 'string' },
  'background-radius': { type: 'string' },
  'background-height': { type: 'string' },
  'background-filament': { type: 'string' },
  palette: { type: 'string' },
  'max-colors': { type: 'string' },
  'bitmap-colors': { type: 'string' },
  output: { type: 'string', short: 'o' },
  format: { type: 'string' },
  'single-path': { type: 'boolean' },
  flip: { type: 'boolean' },
  tolerance: { type: 'string' },
  precision: { type: 'string' },
  config: { type: 'string' },
  margin: { type: 'string' },
  units: { type: 'string' },
  height: { type: 'string' },
  'text-height': { type: 'string' },
  'stroke-height': { type: 'string' },
  'bridge-height': { type: 'string' },
  'text-filament': { type: 'string' },
  'stroke-filament': { type: 'string' },
  'bridge-filament': { type: 'string' },
  position: { type: 'string' },
  printer: { type: 'string' },
  'printer-preset': { type: 'string' },
  'process-preset': { type: 'string' },
  'filament-preset': { type: 'string' },
  'bed-type': { type: 'string' },
  preview: { type: 'boolean' },
  'preview-png': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} satisfies NonNullable<ParseArgsConfig['options']>;

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string | boolean | (string | boolean)[]>>;

export interface RunOptions {
  /** Text read when none is given (defaults to process.stdin when it isn't a TTY). */
  stdin?: NodeJS.ReadableStream | string;
  /** Where output goes without -o (default process.stdout). */
  stdout?: (data: string | Uint8Array) => void;
  env?: NodeJS.ProcessEnv;
  /** Show the preview by default (default: whether stderr is a TTY). */
  preview?: boolean;
}

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Options for the whole output, which can't differ per text. */
const SHARED_ONLY = new Set<string>([
  'list-fonts', 'palette', 'output', 'format', 'flip', 'config', 'margin', 'units', 'precision', 'position', 'gap',
  'printer', 'printer-preset', 'process-preset', 'filament-preset', 'bed-type', 'preview', 'preview-png', 'quiet', 'version', 'help',
]);

/** One text to render, with its own option values (shared values already merged in). */
interface Job {
  text: string;
  values: Values;
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS, tokens: true });
  } catch (err) {
    throw new TextrudeError((err as Error).message);
  }
}

/** Option values from a config object (camelCase or kebab-case keys). */
function configValues(raw: Record<string, unknown>, file: string, item: boolean): { values: Values; text?: string; texts?: unknown } {
  const values: Values = {};
  let text: string | undefined;
  let texts: unknown;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (key === 'text') {
      text = String(v);
      continue;
    }
    if (key === 'texts' && !item) {
      texts = v;
      continue;
    }
    if (!(key in OPTIONS)) throw new TextrudeError(`unknown option "${k}" in ${file}`);
    if (item && SHARED_ONLY.has(key)) throw new TextrudeError(`"${k}" applies to every text, so it can't be set inside "texts" in ${file}`);
    const def = OPTIONS[key as OptionName];
    const list = Array.isArray(v) ? v : [v];
    if ('multiple' in def) values[key as OptionName] = list.map(String);
    else if (def.type === 'boolean') values[key as OptionName] = Boolean(v);
    else values[key as OptionName] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return { values, text, texts };
}

/**
 * Parse flags and a config file into option values (CLI flags override the config).
 *
 * Every `-t/--text` starts a separate text: flags before the first one are shared, and flags
 * after one apply to that text only (except output options, which apply everywhere). A config file's `texts` array works the same way, with its
 * top-level options shared. Texts given with `-t` replace the config's.
 */
function parse(argv: string[]): { values: Values; positionals: string[]; text?: string; jobs: Job[] | null } {
  const all = parseFlags(argv);
  const starts = [...new Set(all.tokens.filter((t) => t.kind === 'option' && t.name === 'text').map((t) => t.index))];
  const shared = starts.length ? parseFlags(argv.slice(0, starts[0])) : all;
  const sharedValues: Values = { ...shared.values };

  // Output options (-o, --printer, ...) can't differ per text, so they count wherever they are.
  const cliItems = starts.map((start, k): Job => {
    const segment = parseFlags(argv.slice(start, starts[k + 1] ?? argv.length));
    const { text: itemText, ...itemValues } = segment.values;
    if (segment.positionals.length) {
      throw new TextrudeError(`unexpected argument "${segment.positionals[0]}" after --text ${JSON.stringify(itemText)} (quote texts that contain spaces)`);
    }
    const values: Values = {};
    for (const [key, value] of Object.entries(itemValues)) {
      if (SHARED_ONLY.has(key)) sharedValues[key as OptionName] = value;
      else values[key as OptionName] = value;
    }
    return { text: String(itemText), values };
  });

  const values: Values = {};
  let text: string | undefined;
  let configItems: Job[] | null = null;
  const file = sharedValues.config == null ? undefined : String(sharedValues.config);
  if (file) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new TextrudeError(`could not read config ${file}: ${(err as Error).message}`);
    }
    const config = configValues(raw, file, false);
    Object.assign(values, config.values);
    text = config.text;
    if (config.texts !== undefined) {
      if (text !== undefined) throw new TextrudeError(`${file} has both "text" and "texts"`);
      if (!Array.isArray(config.texts) || !config.texts.length) throw new TextrudeError(`"texts" in ${file} must be a non-empty array`);
      configItems = config.texts.map((entry, i) => {
        if (typeof entry === 'string') return { text: entry, values: {} };
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TextrudeError(`"texts" in ${file}: entry ${i + 1} must be a string or an object`);
        const item = configValues(entry as Record<string, unknown>, file, true);
        if (item.text === undefined) throw new TextrudeError(`"texts" in ${file}: entry ${i + 1} has no "text"`);
        return { text: item.text, values: item.values };
      });
    }
  }
  Object.assign(values, sharedValues);

  const items = cliItems.length ? cliItems : configItems;
  const jobs = items && items.map((item) => ({ text: item.text, values: { ...values, ...item.values } }));
  return { values, positionals: shared.positionals, text, jobs };
}

/** Typed accessors for option values. */
function reader(v: Values) {
  const str = (name: OptionName) => (v[name] == null ? undefined : String(v[name]));
  const list = (name: OptionName) => (v[name] == null ? undefined : ([] as unknown[]).concat(v[name]).map(String));
  const num = (name: OptionName): number | undefined => {
    if (v[name] == null) return undefined;
    const n = Number(v[name]);
    if (v[name] === '' || !Number.isFinite(n)) throw new TextrudeError(`--${name} must be a number`);
    return n;
  };
  const choice = <T extends string>(name: OptionName, allowed: readonly T[]): T | undefined => {
    const value = str(name);
    if (value == null) return undefined;
    const match = allowed.find((a) => a === value || a[0] === value);
    if (!match) throw new TextrudeError(`--${name} must be one of: ${allowed.join(', ')}`);
    return match;
  };
  const csv = (name: OptionName) => str(name)?.split(',').map((s) => s.trim());
  return { str, list, num, choice, csv };
}

/** The design options for one text. */
function renderOptions(v: Values): TextrudeOptions {
  const { str, list, num, choice, csv } = reader(v);
  const variations: Record<string, number> = {};
  for (const spec of list('variation') ?? []) {
    const [k, val] = spec.split('=');
    if (!k || val == null || !Number.isFinite(Number(val))) throw new TextrudeError(`--variation must look like "wght=700"`);
    variations[k.trim()] = Number(val);
  }
  return {
    font: str('font'),
    fontIndex: num('font-index'),
    fallbackFonts: list('fallback-font'),
    variations,
    bold: Boolean(v.bold),
    italic: Boolean(v.italic),
    synthetic: Boolean(v.synthetic),
    embolden: num('embolden'),
    slant: num('slant'),
    underline: Boolean(v.underline),
    strikethrough: Boolean(v.strikethrough),
    decorationThickness: num('decoration-thickness'),
    underlineOffset: num('underline-offset'),
    size: num('size'),
    color: str('color'),
    letterColors: csv('letter-colors'),
    align: choice('align', ['left', 'center', 'right'] as const),
    lineSpacing: num('line-spacing'),
    letterSpacing: num('letter-spacing'),
    ansi: v.ansi !== false,
    strokeWidth: num('stroke-width'),
    strokeColor: str('stroke-color'),
    strokeAlign: choice('stroke-align', ['outside', 'center', 'inside'] as const),
    strokeJoin: choice('stroke-join', ['round', 'miter', 'square'] as const),
    miterLimit: num('miter-limit'),
    connect: Boolean(v.connect),
    bridgeWidth: num('bridge-width'),
    bridgeColor: str('bridge-color'),
    background: str('background'),
    backgroundPadding: num('background-padding'),
    backgroundRadius: num('background-radius'),
    palette: csv('palette'),
    maxColors: num('max-colors'),
    bitmapColors: num('bitmap-colors'),
    singlePath: Boolean(v['single-path']),
    tolerance: num('tolerance'),
    height: num('height'),
    textHeight: num('text-height'),
    strokeHeight: num('stroke-height'),
    bridgeHeight: num('bridge-height'),
    backgroundHeight: num('background-height'),
    textFilament: num('text-filament'),
    strokeFilament: num('stroke-filament'),
    bridgeFilament: num('bridge-filament'),
    backgroundFilament: num('background-filament'),
    onLog: (e: LogEvent) => ui.log(e),
  };
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv: string[], io: RunOptions = {}): Promise<number> {
  try {
    return await main(argv, io);
  } catch (err) {
    if (err instanceof TextrudeError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
}

async function main(argv: string[], io: RunOptions): Promise<number> {
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((d: string | Uint8Array) => process.stdout.write(d));
  const { values: v, positionals, text: configText, jobs: textJobs } = parse(argv);
  setQuiet(Boolean(v.quiet));
  const { str, num } = reader(v);

  if (v.help) {
    write(HELP);
    return 0;
  }
  if (v.version) {
    write(`${version()}\n`);
    return 0;
  }
  if (v['list-fonts']) {
    const rows = systemFonts().map(({ file, index, names }) => `${[...names].sort().join(' | ')}    (${file}${index ? `#${index}` : ''})`);
    write(rows.sort().join('\n') + '\n');
    return 0;
  }

  let stdinText: string | undefined;
  const readStdin = async () => {
    const source = io.stdin ?? process.stdin;
    stdinText ??= (typeof source === 'string' ? source : await readAll(source)).replace(/\r?\n$/, '');
    return stdinText;
  };

  // Text: arguments, then the config file, then stdin (when piped, or given as "-").
  let jobs: Job[];
  if (textJobs) {
    if (positionals.length) throw new TextrudeError(`with --text, give every text its own --text (unexpected "${positionals[0]}")`);
    jobs = [];
    for (const job of textJobs) jobs.push(job.text === '-' ? { ...job, text: await readStdin() } : job);
  } else {
    let input = '';
    const useStdin = positionals.length === 1 && positionals[0] === '-';
    if (positionals.length && !useStdin) input = positionals.join(' ');
    else if (!positionals.length && configText != null) input = configText;
    else if (useStdin || io.stdin != null || !process.stdin.isTTY) input = await readStdin();
    if (!input) {
      process.stderr.write(HELP);
      return 1;
    }
    jobs = [{ text: input, values: v }];
  }

  const output = str('output');
  const format = str('format') ?? (/\.3mf$/i.test(output ?? '') ? '3mf' : 'svg');
  if (format !== '3mf' && format !== 'svg') throw new TextrudeError('--format must be svg or 3mf');

  let printer: string | PrinterProfile | undefined = str('printer') ?? (v['printer-preset'] ? undefined : env.TEXTRUDE_PRINTER || undefined);
  if (format === '3mf' && !printer && v['printer-preset']) {
    if (!v['process-preset'] || !v['filament-preset']) throw new TextrudeError('--printer-preset also needs --process-preset and --filament-preset');
    printer = { label: str('printer-preset')!, printer: str('printer-preset')!, process: str('process-preset')!, filament: str('filament-preset')!, bedType: 'Textured PEI Plate' };
  }

  const plain = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, '');
  ui.header(plain(jobs[0]!.text), jobs.length - 1);
  const results: TextrudeResult[] = [];
  for (const [i, job] of jobs.entries()) {
    if (jobs.length > 1) {
      if (i) ui.blank();
      ui.detail('text', ui.chalk.bold(JSON.stringify(plain(job.text))));
    }
    results.push(await textrude(job.text, renderOptions(job.values)));
  }
  const bed = typeof printer === 'string' ? PRINTERS[printer]?.bedSize : printer?.bedSize;
  const gap = num('gap');
  const plate = arrange(results, { gap, maxWidth: bed?.[0], onLog: (e) => ui.log(e) });

  let data: string | Uint8Array;
  if (format === '3mf') {
    let position: [number, number] | undefined;
    if (v.position != null) {
      const p = String(v.position).split(',').map(Number);
      if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) throw new TextrudeError('--position must be "x,y"');
      position = [p[0]!, p[1]!];
    }
    const exportOptions: ThreeMfExportOptions = {
      printer,
      processPreset: str('process-preset'),
      filamentPreset: str('filament-preset'),
      bedType: str('bed-type'),
      position,
      flip: Boolean(v.flip),
    };
    data = plate.to3MF(exportOptions);
    if (printer) ui.detail('printer', typeof printer === 'string' ? PRINTERS[printer]!.label : printer.label);
  } else {
    data = plate.toSVG({ margin: num('margin'), units: str('units'), precision: num('precision'), flip: Boolean(v.flip) });
  }

  // Preview and summary.
  const previewPath = str('preview-png');
  if (previewPath) fs.writeFileSync(previewPath, plate.toPNG());
  const showPreview = v.preview ?? io.preview ?? Boolean(process.stderr.isTTY);
  if (showPreview && !v.quiet) {
    try {
      const { default: terminalImage } = await import('terminal-image');
      ui.blank();
      ui.raw(await terminalImage.buffer(plate.toPNG(), { width: '70%', height: '40%' }));
    } catch (err) {
      ui.warn(`preview failed: ${(err as Error).message}`);
    }
  }

  const { parts, objects } = plate;
  ui.blank();
  const dims = `${plate.width.toFixed(1)} × ${plate.depth.toFixed(1)}`;
  ui.detail('size', format === '3mf' ? `${dims} × ${plate.height} mm` : `${dims} mm`);
  if (objects.length > 1) ui.detail('objects', `${objects.length} ${ui.chalk.dim(`(one per text, ${gap ?? 5} mm apart)`)}`);
  ui.detail('parts', `${parts.length} ${ui.chalk.dim(format === '3mf' ? '(one per color: filament, color, role, height, volume)' : '(one path per color)')}`);
  const roleWidth = Math.max(16, ...parts.map((p) => p.roles.join(' + ').length + 2));
  for (const obj of objects) {
    const indent = objects.length > 1 ? '  ' : '';
    if (objects.length > 1) ui.raw(`    ${ui.chalk.bold(obj.name)}`);
    for (const p of obj.parts) {
      const slot = format === '3mf' ? ui.chalk.bold(String(p.filament).padStart(2)) + '  ' : '';
      const vol = format === '3mf' ? ui.chalk.dim(`${(Math.abs(area(p.shape)) * p.height).toFixed(0)} mm³`.padStart(10)) : '';
      const h = format === '3mf' ? `${p.height} mm`.padStart(7) : '';
      ui.raw(`    ${indent}${ui.swatch(p.color)}  ${slot}${p.color}  ${p.roles.join(' + ').padEnd(roleWidth)}${h}${vol}`);
    }
  }
  ui.blank();

  if (output) {
    fs.writeFileSync(output, data);
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    ui.success(`wrote ${ui.chalk.bold(output)} ${ui.chalk.dim(`(${formatBytes(bytes)})`)}`);
    ui.blank();
  } else {
    write(data);
  }
  return 0;
}

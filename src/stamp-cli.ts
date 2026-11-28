/** `textrude stamp`: a cookie stamp and matching cutter from an SVG. */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cookieStamp, type HandleMode, type StampPartName, type StampStyle } from './stamp.js';
import { PRINTERS } from './printers.js';
import { TextrudeError } from './errors.js';
import { ui, setQuiet, formatBytes } from './ui.js';
import type { RunOptions } from './cli.js';

export const STAMP_HELP = `Usage: textrude stamp <file.svg> [options]

Make a cookie stamp and a matching cookie cutter from an SVG, as 3MF or STL files.

The SVG's outermost shape is the outline of the stamp and the cutter: all its shapes merged,
with holes filled in. If one element covers that whole outline with a solid fill (a background,
like a filled circle behind the artwork), it only sets the outline and every other element is
the design. Otherwise everything is the design, and the outline gets a --margin around it.
Text must be converted to outlines (paths) first. Colors don't matter.

Stamp
      --style <s>            imprinted: the design is pressed into the cookie (raised on
                             the stamp). embossed: the design stands up on the cookie
                             (recessed into the stamp)                 [imprinted]
      --depth <n>            How far the design is raised or recessed, in mm  [1.8]
  -s, --size <n>             Stamp width or height, whichever is larger, in mm
                             [the SVG's size if it's in mm/cm/in/pt/pc, else 60]
      --margin <n>           Border around a design with no background shape, in mm
                                                  [3, or 0 with a background or border]
      --plate-thickness <n>  Thickness of the plate behind the design, in mm  [4]
      --chamfer, --no-chamfer
                             Slope the design's walls at 45°: no supports needed, and
                             cleaner release from the dough   [on for imprinted only]
      --min-feature <n>      Warn about lines or gaps thinner than this, in mm  [1]

Handle
      --handle <h>           attached: one piece, printed face-down with the handle up.
                             separate: the stamp prints face-up (no bridging under a
                             raised design) and the handle prints on its own, then
                             plugs into a keyed socket in the back. none: a plain plate
                                           [separate for imprinted, attached for embossed]
      --no-handle            Same as --handle none
      --handle-height <n>    Height above the plate, in mm      [45% of size, 20-35]
      --knob-diameter <n>    Knob diameter, in mm               [40% of size, 16-32]
      --stem-diameter <n>    Stem diameter, in mm               [half the knob, 9-16]
      --peg-clearance <n>    Gap around a separate handle's peg in its socket, in mm
                             (per side; raise it if the fit is too tight)  [0.2]

Cutter
      --no-cutter            Don't make a cutter
      --cutter-height <n>    Height, in mm                                 [14]
      --cutter-wall <n>      Wall thickness at the cutting edge, in mm (twice that
                             lower down)                                   [1]
      --clearance <n>        Gap between the stamp and the inside of the cutter, in mm
                                                                           [0.5]
      --rim-width <n>        Width of the rim on the bed, from the inside edge, in mm [5]
      --rim-height <n>       Thickness of the rim, in mm                   [2.5]

Output
  -o, --output <file>        .3mf: every part on one plate. .stl: one file per part
                             (name-stamp.stl, name-handle.stl, name-cutter.stl), or
                             just one with --part. Default: 3MF to stdout
      --format <f>           3mf | stl                         [from extension, else 3mf]
      --part <p>             stamp | handle | cutter: only this part
      --printer <id>         Printer profile for the 3MF: ${Object.keys(PRINTERS).join(', ')}
                             [$TEXTRUDE_PRINTER]
      --position <x,y>       Bed position of the parts' center [bed center, else 100,100]
      --gap <n>              Space between parts on the plate, in mm      [10]
                             (rows wrap at the printer's bed width, else 220 mm)
      --tolerance <n>        Max curve flattening error, in mm            [0.02]
  -q, --quiet                Only print errors
  -h, --help                 Show this help

Every part prints without supports: an attached stamp face-down (the plate bridges over
the gaps of a raised design: the 45° walls keep the gaps short), a separate stamp face-up,
its handle knob-down with the peg up, and the cutter rim-down.

Examples
  textrude stamp snowflake.svg -o snowflake.3mf
  textrude stamp logo.svg --style embossed --size 70 --depth 2 -o logo.3mf
  textrude stamp heart.svg --handle attached --no-cutter -o heart.stl
`;

const OPTIONS = {
  style: { type: 'string' },
  depth: { type: 'string' },
  size: { type: 'string', short: 's' },
  margin: { type: 'string' },
  'plate-thickness': { type: 'string' },
  chamfer: { type: 'boolean' },
  'min-feature': { type: 'string' },
  handle: { type: 'string' },
  'handle-height': { type: 'string' },
  'knob-diameter': { type: 'string' },
  'stem-diameter': { type: 'string' },
  'peg-clearance': { type: 'string' },
  cutter: { type: 'boolean' },
  'cutter-height': { type: 'string' },
  'cutter-wall': { type: 'string' },
  clearance: { type: 'string' },
  'rim-width': { type: 'string' },
  'rim-height': { type: 'string' },
  output: { type: 'string', short: 'o' },
  format: { type: 'string' },
  part: { type: 'string' },
  printer: { type: 'string' },
  position: { type: 'string' },
  gap: { type: 'string' },
  tolerance: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  preview: { type: 'boolean' }, // accepted for symmetry with textrude; there's no preview
  help: { type: 'boolean', short: 'h' },
} as const;

/** Run `textrude stamp` (argv without the "stamp"). Returns the exit code. */
export async function stampMain(argv: string[], io: RunOptions = {}): Promise<number> {
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((d: string | Uint8Array) => process.stdout.write(d));
  let parsed;
  try {
    // (--no-handle is "--handle none", so it's swapped before parsing.)
    const args = argv.map((a) => (a === '--no-handle' ? '--handle=none' : a));
    parsed = parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS });
  } catch (err) {
    throw new TextrudeError((err as Error).message);
  }
  const { values: v, positionals } = parsed;
  setQuiet(Boolean(v.quiet));
  if (v.help) {
    write(STAMP_HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    if (!positionals.length) {
      process.stderr.write(STAMP_HELP);
      return 1;
    }
    throw new TextrudeError(`give one SVG file (got ${positionals.length} arguments)`);
  }
  const num = (name: keyof typeof OPTIONS): number | undefined => {
    const raw = v[name];
    if (raw == null) return undefined;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) throw new TextrudeError(`--${name} must be a number`);
    return n;
  };
  const choice = <T extends string>(name: keyof typeof OPTIONS, allowed: readonly T[]): T | undefined => {
    const raw = v[name];
    if (raw == null) return undefined;
    const match = allowed.find((a) => a === raw);
    if (!match) throw new TextrudeError(`--${name} must be one of: ${allowed.join(', ')}`);
    return match;
  };

  const file = positionals[0]!;
  let source: string;
  try {
    if (file === '-') {
      const stdin = io.stdin ?? process.stdin;
      if (typeof stdin === 'string') source = stdin;
      else {
        const chunks: Buffer[] = [];
        for await (const c of stdin) chunks.push(Buffer.from(c as Buffer));
        source = Buffer.concat(chunks).toString('utf8');
      }
    } else source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new TextrudeError(`could not read ${file}: ${(err as Error).message}`);
  }

  const output = v.output;
  const format = choice('format', ['3mf', 'stl'] as const) ?? (/\.stl$/i.test(output ?? '') ? 'stl' : '3mf');
  const part = choice('part', ['stamp', 'handle', 'cutter'] as const);
  const printer = v.printer ?? (env.TEXTRUDE_PRINTER || undefined);
  let position: [number, number] | undefined;
  if (v.position != null) {
    const p = v.position.split(',').map(Number);
    if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) throw new TextrudeError('--position must be "x,y"');
    position = [p[0]!, p[1]!];
  }

  ui.header(file === '-' ? 'stamp (stdin)' : `stamp ${path.basename(file)}`);
  const result = cookieStamp(source, {
    style: choice('style', ['imprinted', 'embossed'] as const) as StampStyle | undefined,
    depth: num('depth'),
    size: num('size'),
    margin: num('margin'),
    plateThickness: num('plate-thickness'),
    chamfer: v.chamfer,
    minFeature: num('min-feature'),
    handle: choice('handle', ['attached', 'separate', 'none'] as const) as HandleMode | undefined,
    handleHeight: num('handle-height'),
    knobDiameter: num('knob-diameter'),
    stemDiameter: num('stem-diameter'),
    pegClearance: num('peg-clearance'),
    cutter: v.cutter ?? (part === 'cutter' ? true : undefined),
    cutterHeight: num('cutter-height'),
    cutterWall: num('cutter-wall'),
    clearance: num('clearance'),
    rimWidth: num('rim-width'),
    rimHeight: num('rim-height'),
    tolerance: num('tolerance'),
    gap: num('gap'),
    maxWidth: printer ? PRINTERS[printer]?.bedSize?.[0] : undefined,
    onLog: (e) => ui.log(e),
  });

  ui.blank();
  for (const p of result.parts) {
    ui.raw(`    ${ui.swatch(p.color)}  ${p.name.padEnd(8)}${`${p.width.toFixed(1)} × ${p.depth.toFixed(1)} × ${p.height.toFixed(1)} mm`.padStart(26)}`);
  }
  ui.blank();

  const files: [string | null, Uint8Array][] = [];
  if (format === '3mf') {
    files.push([output ?? null, result.to3MF({ printer, position, part })]);
    if (printer) ui.detail('printer', PRINTERS[printer]?.label ?? printer);
  } else if (part || result.parts.length === 1) {
    files.push([output ?? null, result.toSTL(part ?? result.parts[0]!.name)]);
  } else {
    if (!output) throw new TextrudeError('STL output of several parts needs -o (each part gets its own file), or pick one with --part');
    const base = output.replace(/\.stl$/i, '');
    for (const p of result.parts) files.push([`${base}-${p.name}.stl`, result.toSTL(p.name as StampPartName)]);
  }
  for (const [name, data] of files) {
    if (name) {
      fs.writeFileSync(name, data);
      ui.success(`wrote ${ui.chalk.bold(name)} ${ui.chalk.dim(`(${formatBytes(data.length)})`)}`);
    } else {
      if (!io.stdout && process.stdout.isTTY) throw new TextrudeError('give an output file with -o (or pipe the output)');
      write(data);
    }
  }
  ui.blank();
  return 0;
}

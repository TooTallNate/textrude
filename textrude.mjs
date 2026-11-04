#!/usr/bin/env node
/**
 * textrude - turn text (including color emoji) into multi-color 3MF models or SVGs for
 * 3D printing.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadFont, resolveStyle, isColorFont, findEmojiFont, systemFonts } from './lib/fonts.mjs';
import { renderText } from './lib/layout.mjs';
import { JoinType, union, difference, intersection, offset, clean, components, makeBridges, area } from './lib/geometry.mjs';
import { parseColor, toHex, lab, nearestIndex, reduceColors } from './lib/colors.mjs';
import { writeSvg } from './lib/svg.mjs';
import { write3mf } from './lib/threemf.mjs';
import { PRINTERS, projectSettings } from './lib/printers.mjs';
import { parseAnsi } from './lib/ansi.mjs';
import { renderPng } from './lib/raster.mjs';
import { ui, setQuiet, formatBytes } from './lib/ui.mjs';
import { bbox, SCALE, roundedRect } from './lib/geometry.mjs';

const HELP = `Usage: textrude [text] [options]

Turn text (including color emoji) into a multi-color 3MF model or an SVG for 3D printing.
Text comes from the arguments, a config file, or stdin (piped, or "-"). Newlines start new
lines, and ANSI color codes color the text, e.g. syntax-highlighted code or lolcat output.

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
      --precision <n>        Decimal places in SVG output            [3]
      --config <file>        Read options from a JSON file (CLI flags override it)
      --no-preview           Don't show an image preview in the terminal
                             [preview shown when stderr is a terminal]
      --preview-png <file>   Also save the preview image as a PNG
  -q, --quiet                Only print errors
  -h, --help                 Show this help

SVG only
      --margin <n>           Padding around the artwork              [1]
      --units <u>            SVG width/height unit                   [mm]

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
  FORCE_COLOR=1 npx cli-highlight hello.c | textrude -f Menlo --background '#1e1e1e' -o code.3mf
  echo "Rainbow" | lolcat -f | textrude -f "Arial Black" -o rainbow.3mf
`;

const OPTIONS = {
  font: { type: 'string', short: 'f', default: 'Arial' },
  'font-index': { type: 'string' },
  'fallback-font': { type: 'string', multiple: true, default: [] },
  variation: { type: 'string', multiple: true, default: [] },
  'list-fonts': { type: 'boolean', default: false },
  bold: { type: 'boolean', short: 'b', default: false },
  italic: { type: 'boolean', short: 'i', default: false },
  synthetic: { type: 'boolean', default: false },
  embolden: { type: 'string' },
  slant: { type: 'string' },
  underline: { type: 'boolean', short: 'u', default: false },
  strikethrough: { type: 'boolean', default: false },
  'decoration-thickness': { type: 'string' },
  'underline-offset': { type: 'string' },
  size: { type: 'string', short: 's', default: '20' },
  color: { type: 'string', short: 'c', default: '#000000' },
  'letter-colors': { type: 'string' },
  align: { type: 'string', default: 'left' },
  'line-spacing': { type: 'string', default: '1' },
  'letter-spacing': { type: 'string', default: '0' },
  'stroke-width': { type: 'string', short: 'w', default: '0' },
  'stroke-color': { type: 'string', default: '#ffffff' },
  'stroke-align': { type: 'string', default: 'outside' },
  'stroke-join': { type: 'string', default: 'round' },
  'miter-limit': { type: 'string', default: '4' },
  connect: { type: 'boolean', default: false },
  'bridge-width': { type: 'string' },
  'bridge-color': { type: 'string' },
  background: { type: 'string' },
  'background-padding': { type: 'string' },
  'background-radius': { type: 'string' },
  'background-height': { type: 'string' },
  'background-filament': { type: 'string' },
  palette: { type: 'string' },
  'max-colors': { type: 'string' },
  'bitmap-colors': { type: 'string', default: '8' },
  output: { type: 'string', short: 'o' },
  format: { type: 'string' },
  'single-path': { type: 'boolean', default: false },
  flip: { type: 'boolean', default: false },
  tolerance: { type: 'string', default: '0.01' },
  precision: { type: 'string', default: '3' },
  config: { type: 'string' },
  margin: { type: 'string', default: '1' },
  units: { type: 'string', default: 'mm' },
  height: { type: 'string', default: '2' },
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
  quiet: { type: 'boolean', short: 'q', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const log = ui.log;

function fail(msg) {
  ui.error(msg);
  process.exit(1);
}

// ------------------------------------------------------------------------- options

let cli;
try {
  // Parse without defaults so config-file values can sit between defaults and CLI flags.
  const noDefaults = Object.fromEntries(Object.entries(OPTIONS).map(([k, { default: _, ...v }]) => [k, v]));
  cli = parseArgs({ allowPositionals: true, allowNegative: true, options: noDefaults });
} catch (err) {
  fail(err.message);
}

let config = {};
if (cli.values.config) {
  try {
    const raw = JSON.parse(fs.readFileSync(cli.values.config, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      const key = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (key !== 'text' && !(key in OPTIONS)) fail(`unknown option "${k}" in ${cli.values.config}`);
      config[key] = OPTIONS[key]?.multiple && !Array.isArray(v) ? [v] : v;
    }
  } catch (err) {
    fail(`could not read config ${cli.values.config}: ${err.message}`);
  }
}

const defaults = Object.fromEntries(Object.entries(OPTIONS).filter(([, v]) => 'default' in v).map(([k, v]) => [k, v.default]));
const opt = { ...defaults, ...config, ...cli.values };

function num(name) {
  const v = Number(opt[name]);
  if (opt[name] == null || opt[name] === '' || !Number.isFinite(v)) fail(`--${name} must be a number`);
  return v;
}
const optNum = (name) => (opt[name] != null ? num(name) : undefined);

function choice(name, allowed) {
  const v = opt[name];
  const match = allowed.find((a) => a === v || a[0] === v);
  if (!match) fail(`--${name} must be one of: ${allowed.join(', ')}`);
  return match;
}

function color(name) {
  try {
    return parseColor(opt[name]);
  } catch (err) {
    fail(`--${name}: ${err.message}`);
  }
}

function colorList(name) {
  if (opt[name] == null) return undefined;
  const list = Array.isArray(opt[name]) ? opt[name] : String(opt[name]).split(',');
  try {
    const colors = list.map((c) => parseColor(c));
    if (!colors.length || colors.some((c) => !c)) throw new Error('expected a comma-separated list of colors');
    return colors;
  } catch (err) {
    fail(`--${name}: ${err.message}`);
  }
}

if (opt.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opt['list-fonts']) {
  const rows = systemFonts().map(({ file, index, names }) => `${names.sort().join(' | ')}    (${file}${index ? `#${index}` : ''})`);
  console.log(rows.sort().join('\n'));
  process.exit(0);
}
// Text: arguments, then the config file, then stdin (when piped, or given as "-").
let input;
if (cli.positionals.length && !(cli.positionals.length === 1 && cli.positionals[0] === '-')) input = cli.positionals.join(' ');
else if (!cli.positionals.length && config.text != null) input = String(config.text);
else if (cli.positionals[0] === '-' || !process.stdin.isTTY) {
  // (Read as a stream: readFileSync(0) fails with EAGAIN on pipes that aren't ready yet.)
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
else input = '';
// ANSI escapes become per-character colors; tabs expand to 4 spaces.
const ansi = parseAnsi(input.replace(/\r\n?/g, '\n').replace(/\t/g, '    '));
const text = ansi.text;
if (!text) {
  process.stderr.write(HELP);
  process.exit(1);
}
setQuiet(opt.quiet);
ui.header(text);

const o = {
  charColors: ansi.hasColor ? ansi.colors : undefined,
  size: num('size'),
  align: choice('align', ['left', 'center', 'right']),
  lineSpacing: num('line-spacing'),
  letterSpacing: num('letter-spacing'),
  tolerance: num('tolerance'),
  underline: opt.underline,
  strikethrough: opt.strikethrough,
  decorationThickness: optNum('decoration-thickness'),
  underlineOffset: optNum('underline-offset'),
  letterColors: colorList('letter-colors'),
  palette: colorList('palette'),
  bitmapColors: Math.max(1, Math.round(num('bitmap-colors'))),
};
const strokeWidth = num('stroke-width');
const strokeAlign = choice('stroke-align', ['outside', 'center', 'inside']);
const join = { round: JoinType.jtRound, miter: JoinType.jtMiter, square: JoinType.jtSquare }[
  choice('stroke-join', ['round', 'miter', 'square'])
];
const miterLimit = num('miter-limit');
const minArea = (o.tolerance * 2) ** 2;
const textColor = color('color');
const backgroundColor = opt.background != null ? color('background') : null;
// With a background, the stroke defaults to the background color (so it blends into the plate),
// unless --stroke-color is given explicitly.
const explicitStroke = cli.values['stroke-color'] != null || config['stroke-color'] != null;
const strokeColor = backgroundColor && !explicitStroke ? backgroundColor : color('stroke-color');
const maxColors = optNum('max-colors');

// --------------------------------------------------------------------------- fonts

const variations = {};
for (const v of opt.variation) {
  const [k, val] = String(v).split('=');
  variations[k.trim()] = Number(val);
}

let primary;
const fonts = [];
try {
  const loaded = await loadFont(opt.font, opt['font-index'] != null ? num('font-index') : undefined);
  const styled = resolveStyle(loaded.font, loaded.file, { bold: opt.bold, italic: opt.italic, synthetic: opt.synthetic, variations }, log);
  primary = styled.font;
  o.embolden = opt.embolden != null ? num('embolden') : styled.synthBold ? o.size * 0.02 : 0;
  o.slant = opt.slant != null ? num('slant') : styled.synthItalic ? 12 : 0;
  fonts.push({ font: primary, color: isColorFont(primary) });
  for (const spec of opt['fallback-font']) {
    const f = (await loadFont(String(spec))).font;
    fonts.push({ font: f, color: isColorFont(f) });
  }
} catch (err) {
  fail(err.message);
}
const fontLabel = (f) => `${f.font.fullName}${f.color ? ui.chalk.dim(' (color)') : ''}`;
ui.detail('font', fontLabel(fonts[0]));
if (fonts.length > 1) ui.detail('fallback', fonts.slice(1).map(fontLabel).join(ui.chalk.dim(', ')));

const getEmojiFont = () => {
  const f = findEmojiFont();
  if (!f) return null;
  ui.detail('emoji', `${f.fullName} ${ui.chalk.dim('(installed; pass --fallback-font to choose another)')}`);
  return { font: f, color: true };
};

// ------------------------------------------------------------------------ geometry

const { regions, solid } = renderText(fonts, text, o, { getEmojiFont, log });
if (!solid.length) fail('nothing to render');

// Stroke: an outline around the whole design. For center/inside alignment the colored
// regions are trimmed to make room for it.
let stroke = [];
let textRegions = regions;
if (strokeWidth > 0) {
  const off = (s, d) => offset(s, d, join, miterLimit, o.tolerance);
  let outer = solid;
  let fillArea = solid;
  if (strokeAlign === 'outside') outer = off(solid, strokeWidth);
  else if (strokeAlign === 'center') [outer, fillArea] = [off(solid, strokeWidth / 2), off(solid, -strokeWidth / 2)];
  else fillArea = off(solid, -strokeWidth);
  if (strokeAlign !== 'outside') {
    fillArea = clean(fillArea, minArea);
    textRegions = regions.map((r) => ({ ...r, shape: clean(intersection(r.shape, fillArea), minArea) }));
  }
  stroke = clean(difference(outer, fillArea), minArea);
}

// Layers: { role, color, shape }, non-overlapping. Regions in the text color are role "text";
// colors that come from the font (emoji, letter colors) are role "color".
const layers = [];
for (const r of textRegions) {
  const c = r.color === 'fg' ? textColor : r.color;
  if (c && r.shape.length) layers.push({ role: r.color === 'fg' || r.user ? 'text' : 'color', color: c, shape: r.shape });
}
if (strokeColor && stroke.length) layers.push({ role: 'stroke', color: strokeColor, shape: stroke });
if (!layers.length) fail('nothing visible (text and stroke colors are both "none")');

// Background: a (rounded) plate behind everything, which also holds all the pieces together.
let connected = null;
if (backgroundColor) {
  const all = union(...layers.map((l) => l.shape));
  const b = bbox(all);
  const pad = opt['background-padding'] != null ? num('background-padding') : o.size * 0.25;
  const plate = roundedRect(
    b.minX / SCALE - pad, b.minY / SCALE - pad, b.maxX / SCALE + pad, b.maxY / SCALE + pad,
    opt['background-radius'] != null ? num('background-radius') : 0, o.tolerance,
  );
  // Share a part with a same-colored stroke/text layer of the same height: carve the plate
  // around the *other* layers (rather than unioning two edge-adjacent shapes, which can leave
  // seams).
  const height = optNum('background-height') ?? num('height');
  const sameAs = (l) => toHex(l.color) === toHex(backgroundColor) && (optNum(`${l.role}-height`) ?? num('height')) === height;
  const target = layers.find((l) => l.role === 'stroke' && sameAs(l)) ?? layers.find((l) => l.role === 'text' && sameAs(l));
  if (target) {
    const others = layers.filter((l) => l !== target).flatMap((l) => l.shape);
    target.shape = clean(difference(plate, others), minArea);
    target.roles = [target.role, 'background'];
  } else {
    layers.push({ role: 'background', color: backgroundColor, shape: clean(difference(plate, all), minArea) });
  }
  connected = plate;
  if (opt.connect) ui.info(ui.chalk.dim('background holds everything together, so no bridges are needed'));
} else if (opt.connect) {
  const all = union(...layers.map((l) => l.shape));
  const width = opt['bridge-width'] != null ? num('bridge-width') : strokeWidth > 0 ? strokeWidth : o.size * 0.1;
  const { bridges, count, islands } = makeBridges(all, width, o.tolerance);
  if (count) {
    const bcolor = opt['bridge-color'] != null ? color('bridge-color') : (layers.find((l) => l.role === 'stroke') ?? layers.find((l) => l.role === 'text') ?? layers[0]).color;
    const target = layers.find((l) => l.role !== 'color' && toHex(l.color) === toHex(bcolor)) ?? layers.find((l) => toHex(l.color) === toHex(bcolor));
    if (target) {
      // Union with the full bar (which overlaps the target) so it fuses robustly, then carve
      // out the other regions to keep everything non-overlapping.
      const others = layers.filter((l) => l !== target).flatMap((l) => l.shape);
      target.shape = clean(difference(union(target.shape, bridges), others), minArea);
    } else {
      layers.push({ role: 'bridge', color: bcolor, shape: clean(difference(bridges, all), minArea) });
    }
    connected = union(all, bridges);
    const remaining = components(connected).length;
    ui.success(`connected ${islands} pieces with ${count} bridge${count === 1 ? '' : 's'}`);
    if (remaining > 1) ui.warn(`${remaining} separate pieces remain`);
  }
}

// ---------------------------------------------------------------- colors & parts

// Map colors to the palette (filament slots) or merge them down to --max-colors.
let filamentOf = null;
if (o.palette) {
  const labs = o.palette.map(lab);
  for (const l of layers) {
    const i = nearestIndex(l.color, labs);
    l.color = o.palette[i];
    l.filament = i + 1;
  }
  filamentOf = (l) => l.filament;
} else if (maxColors) {
  const entries = new Map();
  for (const l of layers) {
    const hex = toHex(l.color);
    const e = entries.get(hex) ?? { hex, color: l.color, area: 0, fixed: false };
    e.area += Math.abs(area(l.shape));
    e.fixed ||= l.role !== 'color';
    entries.set(hex, e);
  }
  const map = reduceColors([...entries.values()], Math.max(1, Math.round(maxColors)));
  for (const l of layers) l.color = map.get(toHex(l.color));
}

const heightOf = { text: 'text-height', color: 'text-height', stroke: 'stroke-height', bridge: 'bridge-height', background: 'background-height' };
const filamentOpt = { text: 'text-filament', stroke: 'stroke-filament', bridge: 'bridge-filament', background: 'background-filament' };

// One part per (color, height).
let parts = [];
for (const l of layers) {
  const hex = toHex(l.color);
  const height = optNum(heightOf[l.role]) ?? num('height');
  let part = parts.find((p) => p.hex === hex && p.height === height);
  if (!part) parts.push((part = { hex, color: hex, height, roles: [], shapes: [], filament: filamentOf?.(l) }));
  for (const role of l.roles ?? [l.role]) {
    if (!part.roles.includes(role)) part.roles.push(role);
    if (filamentOpt[role] && opt[filamentOpt[role]] != null) part.filament = num(filamentOpt[role]);
  }
  part.shapes.push(l.shape);
}
const hexOrder = [...new Set(parts.map((p) => p.hex))];
for (const p of parts) {
  p.shape = p.shapes.length > 1 ? union(...p.shapes) : p.shapes[0];
  p.filament ??= hexOrder.indexOf(p.hex) + 1;
  p.id = `${p.roles.join('+')} ${p.hex}`;
}
if (opt['single-path']) {
  const first = parts[0];
  parts = [{ ...first, id: `textrude ${first.hex}`, shape: connected ?? union(...parts.map((p) => p.shape)) }];
}

// -------------------------------------------------------------------------- output

const format = opt.format ?? (/\.3mf$/i.test(opt.output || '') ? '3mf' : 'svg');
let data;
if (format === '3mf') {
  // Printer profile: a built-in one, or custom preset names.
  let profile = null;
  const printerId = opt.printer ?? (opt['printer-preset'] ? null : process.env.TEXTRUDE_PRINTER || null);
  if (printerId) {
    profile = PRINTERS[printerId];
    if (!profile) fail(`unknown --printer "${printerId}" (known: ${Object.keys(PRINTERS).join(', ')}; or use --printer-preset)`);
  } else if (opt['printer-preset']) {
    if (!opt['process-preset'] || !opt['filament-preset']) fail('--printer-preset also needs --process-preset and --filament-preset');
    profile = { label: opt['printer-preset'], printer: opt['printer-preset'], process: opt['process-preset'], filament: opt['filament-preset'], bedType: 'Textured PEI Plate' };
  }
  if (profile) {
    profile = { ...profile };
    if (opt['process-preset']) profile.process = opt['process-preset'];
    if (opt['filament-preset']) profile.filament = opt['filament-preset'];
    if (opt['bed-type']) profile.bedType = opt['bed-type'];
  }

  const position = opt.position != null ? String(opt.position).split(',').map(Number) : profile?.bedCenter ?? [100, 100];
  if (position.length !== 2 || position.some((v) => !Number.isFinite(v))) fail('--position must be "x,y"');

  // Filament slots 1..N with their colors (palette slots keep their colors even if unused).
  let projectConfig = null;
  const count = Math.max(...parts.map((p) => p.filament), o.palette?.length ?? 0);
  if (profile) {
    const filamentColors = Array.from({ length: count }, (_, i) =>
      parts.find((p) => p.filament === i + 1)?.hex ?? (o.palette?.[i] ? toHex(o.palette[i]) : '#ffffff'),
    );
    projectConfig = projectSettings(profile, filamentColors);
    if (profile.toolheads && count > profile.toolheads) {
      log(`warning: ${count} filaments, but the ${profile.label} has ${profile.toolheads} toolheads (use --palette or --max-colors ${profile.toolheads})`);
    }
  } else if (count > 1) {
    log('note: no --printer given, so filament colors aren\'t embedded (the slicer keeps its current filament list)');
  }

  // Slicers can't display emoji in object names.
  const name = text.replace(/\n/g, ' ').replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/gu, '').replace(/\s+/g, ' ').trim() || 'textrude';
  data = write3mf(parts, name, position, opt.flip, projectConfig);
  if (profile) ui.detail('printer', profile.label);
} else if (format === 'svg') {
  const svgLayers = parts.map((p) => ({ ...p, id: p.id.replace(/[^\w-]+/g, '-') }));
  data = writeSvg(svgLayers, num('margin'), opt.units, Math.max(0, Math.round(num('precision'))), opt.flip);
} else {
  fail('--format must be svg or 3mf');
}

// ------------------------------------------------------------------------- summary

const showPreview = opt.preview ?? (process.stderr.isTTY && !opt.quiet);
let previewPng = null;
const preview = () => (previewPng ??= renderPng(parts.map((p) => ({ shape: p.shape, color: p.hex }))));
if (opt['preview-png']) fs.writeFileSync(opt['preview-png'], preview());
if (showPreview && !opt.quiet) {
  try {
    const { default: terminalImage } = await import('terminal-image');
    const png = preview();
    ui.blank();
    ui.raw(await terminalImage.buffer(png, { width: '70%', height: '40%' }));
  } catch (err) {
    ui.warn(`preview failed: ${err.message}`);
  }
}

const box = bbox(parts.flatMap((p) => p.shape));
const maxHeight = Math.max(...parts.map((p) => p.height));
const dims = [(box.maxX - box.minX) / SCALE, (box.maxY - box.minY) / SCALE];
ui.blank();
ui.detail('size', format === '3mf'
  ? `${dims.map((d) => d.toFixed(1)).join(' × ')} × ${maxHeight} mm`
  : `${dims.map((d) => d.toFixed(1)).join(' × ')} mm`);
ui.detail('parts', `${parts.length} ${ui.chalk.dim(format === '3mf' ? '(one per color: filament, color, role, height, volume)' : '(one path per color)')}`);
const roleWidth = Math.max(16, ...parts.map((p) => p.roles.join(' + ').length + 2));
for (const p of parts) {
  const slot = format === '3mf' ? ui.chalk.bold(String(p.filament).padStart(2)) + '  ' : '';
  const vol = format === '3mf' ? ui.chalk.dim(`${(Math.abs(area(p.shape)) * p.height).toFixed(0)} mm³`.padStart(10)) : '';
  const h = format === '3mf' ? `${p.height} mm`.padStart(7) : '';
  ui.raw(`    ${ui.swatch(p.hex)}  ${slot}${p.hex}  ${p.roles.join(' + ').padEnd(roleWidth)}${h}${vol}`);
}
ui.blank();

if (opt.output) {
  fs.writeFileSync(opt.output, data);
  ui.success(`wrote ${ui.chalk.bold(opt.output)} ${ui.chalk.dim(`(${formatBytes(Buffer.byteLength(data))})`)}`);
  ui.blank();
} else {
  process.stdout.write(data);
}

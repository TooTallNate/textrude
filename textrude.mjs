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

const HELP = `Usage: textrude <text> [options]

Turn text (including color emoji) into a multi-color 3MF model or an SVG for 3D printing.
Use "\\n" in the text for line breaks.

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
      --stroke-color <css>   Stroke color                            [#ffffff]
      --stroke-align <a>     outside | center | inside               [outside]
      --stroke-join <j>      round | miter | square                  [round]
      --miter-limit <n>      Miter limit                             [4]

Connecting
      --connect              Bridge disconnected islands into one piece
      --bridge-width <n>     Bridge thickness   [stroke width, or 10% of size]
      --bridge-color <css>   Bridge color       [stroke color, or text color]

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
  -h, --help                 Show this help

SVG only
      --margin <n>           Padding around the artwork              [1]
      --units <u>            SVG width/height unit                   [mm]

3MF only (one part per color, each assigned its own filament)
      --height <n>           Height of every part in mm              [2]
      --text-height <n>      Height of text (and emoji) parts        [--height]
      --stroke-height <n>    Height of the stroke part               [--height]
      --bridge-height <n>    Height of the bridges part              [--height]
      --text-filament <n>    Filament number for the text            [auto]
      --stroke-filament <n>  Filament number for the stroke          [auto]
      --bridge-filament <n>  Filament number for bridges             [auto]
      --position <x,y>       Bed position of the object's center     [100,100]
                             (without --palette, filaments are numbered 1, 2, 3...
                             by distinct color)

Examples
  textrude "Hello" -f "Arial Black" -w 2 --connect --flip -o hello.3mf
  textrude "I ❤️ 3D printing 🎉" -f Helvetica --fallback-font ./fonts/twemoji.ttf -w 1.5 --connect -o emoji.3mf
  textrude "Rainbow" -f "Arial Black" --letter-colors red,orange,gold,green,blue,purple -o rainbow.3mf
  textrude "🦄" -f ./fonts/apple.ttf -s 40 --palette white,black,pink,purple -o unicorn.3mf
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
  position: { type: 'string', default: '100,100' },
  help: { type: 'boolean', short: 'h', default: false },
};

const log = (msg) => console.error(msg);

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------------- options

let cli;
try {
  // Parse without defaults so config-file values can sit between defaults and CLI flags.
  const noDefaults = Object.fromEntries(Object.entries(OPTIONS).map(([k, { default: _, ...v }]) => [k, v]));
  cli = parseArgs({ allowPositionals: true, options: noDefaults });
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
const text = (cli.positionals.length ? cli.positionals.join(' ') : config.text ?? '').replace(/\\n/g, '\n');
if (!text) {
  process.stderr.write(HELP);
  process.exit(1);
}

const o = {
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
const strokeColor = color('stroke-color');
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

const getEmojiFont = () => {
  const f = findEmojiFont();
  if (!f) return null;
  log(`using "${f.fullName}" for emoji (pass --fallback-font to choose another)`);
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
  if (c && r.shape.length) layers.push({ role: r.color === 'fg' ? 'text' : 'color', color: c, shape: r.shape });
}
if (strokeColor && stroke.length) layers.push({ role: 'stroke', color: strokeColor, shape: stroke });
if (!layers.length) fail('nothing visible (text and stroke colors are both "none")');

let connected = null;
if (opt.connect) {
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
    log(`connected ${islands} islands with ${count} bridge(s)` + (remaining > 1 ? ` (warning: ${remaining} pieces remain)` : ''));
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

const heightOf = { text: 'text-height', color: 'text-height', stroke: 'stroke-height', bridge: 'bridge-height' };
const filamentOpt = { text: 'text-filament', stroke: 'stroke-filament', bridge: 'bridge-filament' };

// One part per (color, height).
let parts = [];
for (const l of layers) {
  const hex = toHex(l.color);
  const height = optNum(heightOf[l.role]) ?? num('height');
  let part = parts.find((p) => p.hex === hex && p.height === height);
  if (!part) parts.push((part = { hex, color: hex, height, roles: [], shapes: [], filament: filamentOf?.(l) }));
  if (!part.roles.includes(l.role)) part.roles.push(l.role);
  part.shapes.push(l.shape);
  if (filamentOpt[l.role] && opt[filamentOpt[l.role]] != null) part.filament = num(filamentOpt[l.role]);
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
  const position = String(opt.position).split(',').map(Number);
  if (position.length !== 2 || position.some((v) => !Number.isFinite(v))) fail('--position must be "x,y"');
  data = write3mf(parts, text.replace(/\n/g, ' '), position, opt.flip);
  for (const p of parts) log(`part "${p.id}": filament ${p.filament}, height ${p.height}mm`);
} else if (format === 'svg') {
  const svgLayers = parts.map((p) => ({ ...p, id: p.id.replace(/[^\w-]+/g, '-') }));
  data = writeSvg(svgLayers, num('margin'), opt.units, Math.max(0, Math.round(num('precision'))), opt.flip);
} else {
  fail('--format must be svg or 3mf');
}

if (opt.output) {
  fs.writeFileSync(opt.output, data);
  log(`wrote ${opt.output}`);
} else {
  process.stdout.write(data);
}

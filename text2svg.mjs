#!/usr/bin/env node
/**
 * text2svg - render text to an SVG made purely of filled paths, for 3D-printing slicers.
 *
 * Glyph outlines are flattened to polygons and the stroke is computed geometrically
 * (polygon offsetting) instead of using SVG `stroke`, so every color region is a plain,
 * filled, non-overlapping shape that slicers can import directly.
 *
 * With --connect, disconnected islands (separate letters, dots on i/j, ...) are joined
 * by "bridges" so the print comes out as a single piece.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as fontkit from 'fontkit';
import ClipperLib from 'clipper-lib';
import libtess from 'libtess';
import { zipSync, strToU8 } from 'fflate';

const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;

// Clipper works on integers: 1 output unit (e.g. mm) = SCALE clipper units.
const SCALE = 10000;

const HELP = `Usage: text2svg <text> [options]

Render text to an SVG of filled paths for 3D-printing slicers.
Use "\\n" in the text for line breaks.

Font
  -f, --font <name|path>     Font file or installed font name        [Arial]
      --font-index <n>       Face index inside a .ttc/.otc collection
      --variation <a=v>      Variable font axis, e.g. wght=700 (repeatable)
      --list-fonts           List installed fonts and exit

Style
  -b, --bold                 Bold: uses the family's bold face or the variable
                             font's weight axis, else synthesizes it
  -i, --italic               Italic: uses the family's italic face or the
                             ital/slnt axis, else synthesizes a slant
      --synthetic            Always synthesize bold/italic (skip face lookup)
      --embolden <n>         Thicken (or thin, if negative) outlines by n
                             per side                   [0, or 2% of size for synthetic bold]
      --slant <deg>          Slant glyphs by deg       [0, or 12 for synthetic italic]
  -u, --underline            Underline each line
      --strikethrough        Strike through each line
      --decoration-thickness <n>  Underline/strikethrough thickness  [font metric]
      --underline-offset <n> Distance from baseline to top of underline [font metric]

Text
  -s, --size <n>             Font size (em height) in output units  [20]
  -c, --color <css>          Text fill color ("none" = hollow)       [#000000]
      --align <l|c|r>        left | center | right                   [left]
      --line-spacing <n>     Line height multiplier                  [1]
      --letter-spacing <n>   Extra space between glyphs              [0]

Stroke
  -w, --stroke-width <n>     Stroke width in output units (0 = none) [0]
      --stroke-color <css>   Stroke color                            [#ffffff]
      --stroke-align <a>     outside | center | inside               [outside]
      --stroke-join <j>      round | miter | square                  [round]
      --miter-limit <n>      Miter limit                             [4]

Connecting
      --connect              Bridge disconnected islands into one piece
      --bridge-width <n>     Bridge thickness   [stroke width, or 10% of size]
      --bridge-color <css>   Bridge color       [stroke color, or text color]

Output
  -o, --output <file>        Output file (default: stdout). A .3mf extension
                             implies --format 3mf
      --format <f>           svg | 3mf                    [from extension, else svg]
      --single-path          Merge everything into one region (single-material)
      --flip                 Mirror the design so it prints face-down: the text side
                             sits on the build plate for the smoothest finish
      --tolerance <n>        Max curve flattening error              [0.01]
      --precision <n>        Decimal places in output                [3]
  -h, --help                 Show this help

SVG only
      --margin <n>           Padding around the artwork              [1]
      --units <u>            SVG width/height unit                   [mm]

3MF only (units are mm; one part per color, each assigned its own filament)
      --height <n>           Height of every part                    [2]
      --text-height <n>      Height of the text part                 [--height]
      --stroke-height <n>    Height of the stroke part               [--height]
      --bridge-height <n>    Height of the bridges part              [--height]
      --text-filament <n>    Filament/extruder number for the text   [auto]
      --stroke-filament <n>  Filament/extruder number for the stroke [auto]
      --bridge-filament <n>  Filament/extruder number for bridges    [auto]
      --position <x,y>       Bed position of the object's center     [100,100]
                             (filaments are auto-numbered 1, 2, 3... by distinct color)

Examples
  text2svg "Hello" -f "Arial Black" -w 2 --connect --flip -o hello.3mf
  text2svg "Hello" -f Helvetica -s 30 -o hello.svg
  text2svg "Hello\\nWorld" -f ./MyFont.ttf -w 2 --connect --align center -o sign.svg
  text2svg "Tag" -f "Arial Black" -w 1.5 --connect --bridge-color red -o tag.svg
`;

// ------------------------------------------------------------------------- CLI

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    font: { type: 'string', short: 'f', default: 'Arial' },
    'font-index': { type: 'string' },
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
    output: { type: 'string', short: 'o' },
    format: { type: 'string' },
    'single-path': { type: 'boolean', default: false },
    height: { type: 'string', default: '2' },
    'text-height': { type: 'string' },
    'stroke-height': { type: 'string' },
    'bridge-height': { type: 'string' },
    'text-filament': { type: 'string' },
    'stroke-filament': { type: 'string' },
    'bridge-filament': { type: 'string' },
    position: { type: 'string', default: '100,100' },
    flip: { type: 'boolean', default: false },
    margin: { type: 'string', default: '1' },
    units: { type: 'string', default: 'mm' },
    tolerance: { type: 'string', default: '0.01' },
    precision: { type: 'string', default: '3' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function num(name) {
  const v = Number(opt[name]);
  if (!Number.isFinite(v)) fail(`--${name} must be a number`);
  return v;
}

function choice(name, allowed) {
  const v = opt[name];
  const match = allowed.find((a) => a === v || a[0] === v);
  if (!match) fail(`--${name} must be one of: ${allowed.join(', ')}`);
  return match;
}

// ----------------------------------------------------------------------- fonts

const FONT_DIRS = [
  '/System/Library/Fonts',
  '/Library/Fonts',
  path.join(os.homedir(), 'Library/Fonts'),
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  path.join(os.homedir(), '.fonts'),
  path.join(os.homedir(), '.local/share/fonts'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'),
].filter(Boolean);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fontNames(font) {
  const names = new Set([font.fullName, font.postscriptName].filter(Boolean));
  const fam = font.familyName;
  const sub = font.subfamilyName || '';
  if (fam) {
    names.add(`${fam} ${sub}`.trim());
    if (/^(regular|roman|book|normal)?$/i.test(sub)) names.add(fam);
  }
  return [...names];
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) yield p;
  }
}

function* systemFonts() {
  for (const dir of FONT_DIRS) {
    for (const file of walk(dir)) {
      let f;
      try {
        f = fontkit.openSync(file);
      } catch {
        continue;
      }
      const faces = f.fonts || [f];
      for (let i = 0; i < faces.length; i++) {
        try {
          yield { file, index: i, font: faces[i], names: fontNames(faces[i]) };
        } catch {
          /* unreadable face */
        }
      }
    }
  }
}

/** Returns { font, file } for a font file path or an installed font name. */
function loadFont(spec, index) {
  const pick = (f, i) => (f.fonts ? f.fonts[i ?? 0] : f);
  const p = spec.replace(/^~(?=$|\/)/, os.homedir());
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return { font: pick(fontkit.openSync(p), index), file: p };

  const target = norm(spec);
  let fallback = null;
  for (const { file, font, names } of systemFonts()) {
    if (names.some((n) => norm(n) === target)) return { font, file };
    if (!fallback && norm(path.parse(file).name) === target) fallback = { font, file };
  }
  if (fallback) return fallback;
  fail(`font "${spec}" not found (pass a font file path, or use --list-fonts)`);
}

function fontStyle(font) {
  const os2 = font['OS/2'];
  const sub = font.getName('preferredSubfamily') || font.subfamilyName || '';
  let weight = os2?.usWeightClass;
  if (!(weight >= 100 && weight <= 1000)) {
    weight = /black|heavy/i.test(sub) ? 900 : /extra ?bold|ultra ?bold/i.test(sub) ? 800
      : /semi ?bold|demi/i.test(sub) ? 600 : /bold/i.test(sub) ? 700 : /medium/i.test(sub) ? 500
      : /light/i.test(sub) ? 300 : 400;
  }
  const italic = Boolean(os2?.fsSelection?.italic || os2?.fsSelection?.oblique || font.italicAngle ||
    /italic|oblique/i.test(sub));
  const family = font.getName('preferredFamily') || font.familyName;
  return { weight, italic, family, condensed: /condensed|narrow|compressed/i.test(sub) };
}

/**
 * Find the bold and/or italic face of `base`'s family among installed fonts (and the base
 * font's own directory). Returns null if the family has no suitable face.
 */
function findStyledFace(base, baseFile, { bold, italic }) {
  const want = fontStyle(base);
  const targetWeight = bold ? (want.weight >= 600 ? 900 : 700) : want.weight;
  const targetItalic = italic || want.italic;
  const fams = new Set([norm(want.family), norm(base.familyName)]);

  function* candidates() {
    const dir = path.dirname(baseFile);
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(ttf|otf|ttc|otc)$/i.test(file)) continue;
      try {
        const f = fontkit.openSync(path.join(dir, file));
        yield* f.fonts || [f];
      } catch {
        /* unreadable */
      }
    }
    for (const { font } of systemFonts()) yield font;
  }

  let best = null;
  for (const f of candidates()) {
    let s;
    try {
      s = fontStyle(f);
    } catch {
      continue;
    }
    if (!fams.has(norm(s.family)) && !fams.has(norm(f.familyName))) continue;
    if (s.italic !== targetItalic || s.condensed !== want.condensed) continue;
    if (bold ? s.weight < want.weight + 150 : Math.abs(s.weight - want.weight) > 50) continue;
    const score = Math.abs(s.weight - targetWeight);
    if (!best || score < best.score) best = { font: f, score };
  }
  return best?.font ?? null;
}

// -------------------------------------------------------------- glyph outlines

/** Flatten fontkit path commands to closed polylines (font units, y-up). */
function flattenCommands(commands, tol) {
  const contours = [];
  let cur = null;
  let last = [0, 0];
  const close = () => {
    if (cur) {
      const a = cur[0];
      const b = cur[cur.length - 1];
      if (cur.length > 1 && a[0] === b[0] && a[1] === b[1]) cur.pop();
      if (cur.length >= 3) contours.push(cur);
    }
    cur = null;
  };
  for (const { command, args } of commands) {
    if (command === 'moveTo') {
      close();
      cur = [[args[0], args[1]]];
      last = cur[0];
    } else if (command === 'lineTo') {
      if (!cur) cur = [last];
      last = [args[0], args[1]];
      cur.push(last);
    } else if (command === 'quadraticCurveTo') {
      if (!cur) cur = [last];
      const [x0, y0] = last;
      const [x1, y1, x2, y2] = args;
      const m = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
      const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.25 * m) / tol))));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const a = (1 - t) ** 2;
        const b = 2 * (1 - t) * t;
        const c = t * t;
        cur.push([a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2]);
      }
      last = [x2, y2];
    } else if (command === 'bezierCurveTo') {
      if (!cur) cur = [last];
      const [x0, y0] = last;
      const [x1, y1, x2, y2, x3, y3] = args;
      const m = Math.max(
        Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
        Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3),
      );
      const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.75 * m) / tol))));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const a = (1 - t) ** 3;
        const b = 3 * (1 - t) ** 2 * t;
        const c = 3 * (1 - t) * t * t;
        const d = t ** 3;
        cur.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
      }
      last = [x3, y3];
    } else if (command === 'closePath') {
      close();
    }
  }
  close();
  return contours;
}

// -------------------------------------------------------------------- geometry
// A "shape" is an array of Clipper paths ([{X, Y}, ...]) using the nonzero fill rule.

function clip(type, subject, clipPaths = []) {
  const c = new Clipper();
  c.AddPaths(subject, PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(clipPaths, PolyType.ptClip, true);
  const out = [];
  c.Execute(type, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out;
}

const union = (...shapes) => clip(ClipType.ctUnion, shapes.flat());
const difference = (a, b) => (b.length ? clip(ClipType.ctDifference, a, b) : union(a));

function offset(shape, delta, join, miterLimit, tol) {
  const co = new ClipperOffset(miterLimit, tol * SCALE);
  co.AddPaths(shape, join, EndType.etClosedPolygon);
  const out = [];
  co.Execute(out, delta * SCALE);
  return out;
}

/** Drop specks/slivers smaller than minArea (in output units²). */
function clean(shape, minArea) {
  return union(shape.filter((p) => Math.abs(Clipper.Area(p)) > minArea * SCALE * SCALE));
}

/** Split a shape into connected components: [[outer, ...holes], ...]. */
function components(shape, strictlySimple = false) {
  const c = new Clipper();
  c.StrictlySimple = strictlySimple;
  c.AddPaths(shape, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const out = [];
  const visit = (node) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) {
        visit(child);
      } else {
        out.push([child.Contour(), ...child.Childs().map((h) => h.Contour())]);
        for (const h of child.Childs()) visit(h);
      }
    }
  };
  visit(tree);
  return out;
}

function bbox(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (const { X, Y } of p) {
      if (X < minX) minX = X;
      if (Y < minY) minY = Y;
      if (X > maxX) maxX = X;
      if (Y > maxY) maxY = Y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function bboxDist(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function closestOnSegment(p, a, b) {
  const dx = b.X - a.X;
  const dy = b.Y - a.Y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { X: a.X + t * dx, Y: a.Y + t * dy };
}

/** Closest pair of points between two components (vertex-to-edge, both directions). */
function nearest(compA, compB) {
  let best = { d: Infinity, p: null, q: null };
  const scan = (from, to, swap) => {
    for (const ring of from) {
      for (const v of ring) {
        for (const r of to) {
          for (let i = 0; i < r.length; i++) {
            const c = closestOnSegment(v, r[i], r[(i + 1) % r.length]);
            const d = Math.hypot(c.X - v.X, c.Y - v.Y);
            if (d < best.d) best = swap ? { d, p: c, q: v } : { d, p: v, q: c };
          }
        }
      }
    }
  };
  scan(compA, compB, false);
  scan(compB, compA, true);
  return best;
}

/** Bridge all components with bars along a minimum spanning tree of nearest gaps. */
function makeBridges(shape, width, tol) {
  const comps = components(shape);
  const n = comps.length;
  if (n <= 1) return { bridges: [], count: 0, islands: n };
  const boxes = comps.map(bbox);

  // Prim's MST; bounding boxes give a cheap lower bound to skip exact distance checks.
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const link = new Array(n).fill(null);
  best[0] = 0;
  const edges = [];
  for (let step = 0; step < n; step++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!inTree[k] && (i < 0 || best[k] < best[i])) i = k;
    inTree[i] = true;
    if (link[i]) edges.push(link[i]);
    for (let j = 0; j < n; j++) {
      if (inTree[j] || bboxDist(boxes[i], boxes[j]) >= best[j]) continue;
      const r = nearest(comps[i], comps[j]);
      if (r.d < best[j]) {
        best[j] = r.d;
        link[j] = { ...r, i, j };
      }
    }
  }

  const bridges = edges.flatMap((e) => placeBridge(comps[e.i], comps[e.j], e.p, e.q, width * SCALE, tol));
  return { bridges: union(bridges), count: edges.length, islands: n };
}

/**
 * Build a straight bar joining two components near their closest points. The bar is
 * slid sideways to whichever position still connects both pieces while adding the least
 * new material, so it sits inside the gap instead of poking out past corners.
 */
function placeBridge(compA, compB, p, q, w, tol) {
  let ux = q.X - p.X;
  let uy = q.Y - p.Y;
  const len = Math.hypot(ux, uy);
  if (len < 1) [ux, uy] = [1, 0];
  else [ux, uy] = [ux / len, uy / len];
  const [nx, ny] = [-uy, ux];
  const ext = w / 2; // overlap into each piece
  const pair = [...compA, ...compB];

  let best = null;
  for (const f of [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -1, 1]) {
    const t = f * w;
    const pt = (base, along, side) => ({
      X: Math.round(base.X + ux * along + nx * (t + side)),
      Y: Math.round(base.Y + uy * along + ny * (t + side)),
    });
    const bar = [pt(p, -ext, -w / 2), pt(q, ext, -w / 2), pt(q, ext, w / 2), pt(p, -ext, w / 2)];
    if (components(union(pair, [bar])).length !== 1) continue;
    const added = difference([bar], pair).reduce((s, r) => s + Math.abs(Clipper.Area(r)), 0);
    if (!best || added < best.added * 0.999) best = { bar, added };
  }
  if (best) return [best.bar];

  // Fallback: round-capped bar centered on the closest points.
  const co = new ClipperOffset(2, tol * SCALE);
  const a = { X: Math.round(p.X), Y: Math.round(p.Y) };
  const b = len < 1 ? { X: a.X + 1, Y: a.Y } : { X: Math.round(q.X), Y: Math.round(q.Y) };
  co.AddPath([a, b], JoinType.jtRound, EndType.etOpenRound);
  const out = [];
  co.Execute(out, w / 2 + tol * SCALE);
  return union(out);
}

// ---------------------------------------------------------------------- layout

function renderText(font, text, o) {
  const scale = o.size / font.unitsPerEm;
  const lineH = (font.ascent - font.descent + (font.lineGap || 0)) * scale * o.lineSpacing;
  const tolUnits = o.tolerance / scale;
  const cache = new Map();

  const glyphContours = (glyph) => {
    if (!cache.has(glyph.id)) cache.set(glyph.id, flattenCommands(glyph.path.commands, tolUnits));
    return cache.get(glyph.id);
  };

  const skew = Math.tan((o.slant * Math.PI) / 180);
  const paths = [];
  const decorations = [];
  text.split('\n').forEach((line, li) => {
    const run = font.layout(line);
    // Emboldening grows each glyph by `embolden` per side, so widen the advance to match.
    const spacing = (o.letterSpacing + 2 * o.embolden) / scale;
    let adv = 0;
    for (const pos of run.positions) adv += pos.xAdvance;
    const width = (adv + spacing * Math.max(0, run.glyphs.length - 1)) * scale;
    const shift = { left: 0, center: -width / 2, right: -width }[o.align];
    const baseline = li * lineH;

    const os2 = font['OS/2'];
    const bar = (topAboveBaseline, thickness) => {
      // Extend by the emboldening so the line covers the full (grown) glyph extents.
      const x0 = shift - o.embolden;
      const x1 = shift + width + o.embolden;
      const y0 = baseline - topAboveBaseline;
      const pts = [[x0, y0], [x1, y0], [x1, y0 + thickness], [x0, y0 + thickness]];
      decorations.push(pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
    };
    if (o.underline && width > 0) {
      const t = o.decorationThickness ?? ((font.underlineThickness || font.unitsPerEm * 0.05) * scale);
      const top = o.underlineOffset != null ? -o.underlineOffset
        : (font.underlinePosition || -font.unitsPerEm * 0.1) * scale;
      bar(top, t);
    }
    if (o.strikethrough && width > 0) {
      const t = o.decorationThickness ?? ((os2?.yStrikeoutSize || font.unitsPerEm * 0.05) * scale);
      const top = (os2?.yStrikeoutPosition || (font.xHeight || font.unitsPerEm * 0.5) * 0.5 + t / scale / 2) * scale;
      bar(top, t);
    }

    let x = 0;
    run.glyphs.forEach((glyph, gi) => {
      const pos = run.positions[gi];
      if (glyph.id === 0 && glyph.codePoints.some((cp) => !/\s/.test(String.fromCodePoint(cp)))) {
        console.error(`warning: font has no glyph for ${JSON.stringify(String.fromCodePoint(...glyph.codePoints))}`);
      }
      const ox = (x + pos.xOffset + gi * spacing) * scale + shift;
      const oy = baseline - pos.yOffset * scale;
      for (const c of glyphContours(glyph)) {
        paths.push(c.map(([gx, gy]) => ({
          X: Math.round((gx * scale + ox + skew * (gy + pos.yOffset) * scale) * SCALE),
          Y: Math.round((-gy * scale + oy) * SCALE),
        })));
      }
      x += pos.xAdvance;
    });
  });

  // Nonzero union resolves overlapping contours and overlapping glyphs (e.g. script fonts).
  let shape = union(paths);
  if (o.embolden) {
    shape = offset(shape, o.embolden, JoinType.jtMiter, 2, o.tolerance);
  }
  return decorations.length ? union(shape, decorations) : shape;
}

// ------------------------------------------------------------------------- SVG

function fmt(v, prec) {
  const s = v.toFixed(prec).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

function writeSvg(layers, margin, units, prec, mirror) {
  const all = layers.flatMap((l) => l.shape);
  const b = bbox(all);
  const minX = b.minX / SCALE - margin;
  const minY = b.minY / SCALE - margin;
  const w = (b.maxX - b.minX) / SCALE + 2 * margin;
  const h = (b.maxY - b.minY) / SCALE + 2 * margin;
  const px = (X) => (mirror ? w - (X / SCALE - minX) : X / SCALE - minX);
  const pt = ({ X, Y }) => `${fmt(px(X), prec)} ${fmt(Y / SCALE - minY, prec)}`;

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, prec)}${units}" height="${fmt(h, prec)}${units}" viewBox="0 0 ${fmt(w, prec)} ${fmt(h, prec)}">`,
  ];
  for (const { id, shape, color } of layers) {
    if (!shape.length) continue;
    const d = shape.map((p) => `M${p.map(pt).join(' L')} Z`).join(' ');
    out.push(`  <path id="${id}" fill="${color}" fill-rule="nonzero" stroke="none" d="${d}"/>`);
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------------- 3MF

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
};

/** Remove duplicate and exactly-collinear vertices. */
function cleanRing(ring) {
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = out.length ? out[out.length - 1] : pts[pts.length - 1];
      const c = pts[i];
      const n = pts[(i + 1) % pts.length];
      const cross = (c.X - p.X) * (n.Y - c.Y) - (c.Y - p.Y) * (n.X - c.X);
      if ((c.X === p.X && c.Y === p.Y) || cross === 0) changed = true;
      else out.push(c);
    }
    pts = out;
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * Triangulate a polygon with holes (rings of [x, y]) using the GLU tessellator, which keeps
 * every input vertex (unlike earcut, which drops collinear ones and leaves T-junctions).
 * Returns a flat list of vertex indices; `addPoint` is called for any new intersection vertex.
 */
function triangulate(rings, addPoint) {
  const { GluTesselator, gluEnum, windingRule, primitiveType } = libtess;
  const tess = new GluTesselator();
  const out = [];
  tess.gluTessCallback(gluEnum.GLU_TESS_VERTEX_DATA, (index, list) => list.push(index));
  tess.gluTessCallback(gluEnum.GLU_TESS_BEGIN, (type) => {
    if (type !== primitiveType.GL_TRIANGLES) throw new Error(`unexpected primitive ${type}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_ERROR, (err) => {
    throw new Error(`tessellation error ${err}`);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_COMBINE, (coords) => addPoint(coords[0], coords[1]));
  // Registering an edge-flag callback forces plain GL_TRIANGLES output (no fans/strips).
  tess.gluTessCallback(gluEnum.GLU_TESS_EDGE_FLAG, () => {});
  tess.gluTessProperty(gluEnum.GLU_TESS_WINDING_RULE, windingRule.GLU_TESS_WINDING_NONZERO);
  tess.gluTessNormal(0, 0, 1);
  tess.gluTessBeginPolygon(out);
  let index = 0;
  for (const ring of rings) {
    tess.gluTessBeginContour();
    for (const [x, y] of ring) tess.gluTessVertex([x, y, 0], index++);
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();
  return out;
}

/**
 * Extrude a 2D shape (SVG coordinates) into closed triangle meshes from z=0 to z=height.
 * With `mirror`, X is mirrored so the design reads correctly when viewed from below.
 */
function extrude(shape, height, cx, cy, mirror) {
  const verts = [];
  const tris = [];
  const sx = mirror ? -1 : 1;
  // Snap near-coincident vertices (< 2µm) and rebuild as strictly simple polygons.
  const snapped = Clipper.CleanPolygons(shape, 0.002 * SCALE);
  for (const raw of components(snapped, true)) {
    const comp = raw.map(cleanRing);
    if (!comp[0]) continue;
    // Flip Y so the text reads correctly from above; outer ring CCW, holes CW.
    const rings = comp.filter(Boolean).map((r, ri) => {
      const ring = r.map(({ X, Y }) => [sx * (X / SCALE - cx), -(Y / SCALE - cy)]);
      const ccw = signedArea(ring) > 0;
      return (ri === 0) !== ccw ? ring.reverse() : ring;
    });
    const pts = rings.flat();
    const caps = triangulate(rings, (x, y) => pts.push([x, y]) - 1);

    const n = pts.length;
    const base = verts.length;
    for (const [x, y] of pts) verts.push([x, y, 0]);
    for (const [x, y] of pts) verts.push([x, y, height]);
    const bot = (k) => base + k;
    const top = (k) => base + n + k;

    // Decide the orientation once for the whole cap: per-triangle checks could flip
    // zero-area slivers and break the mesh topology.
    let total = 0;
    for (let t = 0; t < caps.length; t += 3) {
      const [a, b, c] = [pts[caps[t]], pts[caps[t + 1]], pts[caps[t + 2]]];
      total += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }
    for (let t = 0; t < caps.length; t += 3) {
      let [a, b, c] = [caps[t], caps[t + 1], caps[t + 2]];
      if (total < 0) [b, c] = [c, b];
      tris.push([top(a), top(b), top(c)], [bot(a), bot(c), bot(b)]);
    }

    let start = 0;
    for (const ring of rings) {
      const m = ring.length;
      for (let i = 0; i < m; i++) {
        const a = start + i;
        const b = start + ((i + 1) % m);
        tris.push([bot(a), bot(b), top(b)], [bot(a), top(b), top(a)]);
      }
      start += m;
    }
  }
  return { verts, tris };
}

function write3mf(parts, name, position, mirror) {
  const b = bbox(parts.flatMap((p) => p.shape));
  const cx = (b.minX + b.maxX) / 2 / SCALE;
  const cy = (b.minY + b.maxY) / 2 / SCALE;
  const f = (v) => fmt(v, 4);

  const objects = parts.map((part, i) => {
    const { verts, tris } = extrude(part.shape, part.height, cx, cy, mirror);
    const v = verts.map(([x, y, z]) => `<vertex x="${f(x)}" y="${f(y)}" z="${f(z)}"/>`).join('');
    const t = tris.map(([a, b2, c]) => `<triangle v1="${a}" v2="${b2}" v3="${c}"/>`).join('');
    return `  <object id="${i + 1}" name="${xmlEsc(part.id)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
  });
  const asmId = parts.length + 1;
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <metadata name="Application">text2svg</metadata>',
    ' <resources>',
    ...objects,
    `  <object id="${asmId}" name="${xmlEsc(name)}" type="model"><components>` +
      parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('') +
      '</components></object>',
    ' </resources>',
    ` <build><item objectid="${asmId}" transform="1 0 0 0 1 0 0 0 1 ${f(position[0])} ${f(position[1])} 0"/></build>`,
    '</model>',
  ].join('\n');

  // Orca / Bambu Studio read per-part names and filament ("extruder") assignments from here.
  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${asmId}">`,
    `    <metadata key="name" value="${xmlEsc(name)}"/>`,
    `    <metadata key="extruder" value="${parts[0].filament}"/>`,
    ...parts.flatMap((p, i) => [
      `    <part id="${i + 1}" subtype="normal_part">`,
      `      <metadata key="name" value="${xmlEsc(p.id)}"/>`,
      `      <metadata key="extruder" value="${p.filament}"/>`,
      '    </part>',
    ]),
    '  </object>',
    '</config>',
  ].join('\n');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(settings),
  });
}

// ------------------------------------------------------------------------ main

if (opt.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opt['list-fonts']) {
  const rows = [];
  for (const { file, index, names } of systemFonts()) {
    rows.push(`${names.sort().join(' | ')}    (${file}${index ? `#${index}` : ''})`);
  }
  console.log(rows.sort().join('\n'));
  process.exit(0);
}
if (!positionals.length) {
  process.stderr.write(HELP);
  process.exit(1);
}

const o = {
  size: num('size'),
  align: choice('align', ['left', 'center', 'right']),
  lineSpacing: num('line-spacing'),
  letterSpacing: num('letter-spacing'),
  tolerance: num('tolerance'),
};
const strokeWidth = num('stroke-width');
const strokeAlign = choice('stroke-align', ['outside', 'center', 'inside']);
const join = { round: JoinType.jtRound, miter: JoinType.jtMiter, square: JoinType.jtSquare }[
  choice('stroke-join', ['round', 'miter', 'square'])
];
const miterLimit = num('miter-limit');
const minArea = (o.tolerance * 2) ** 2;
const textColor = opt.color;
const strokeColor = opt['stroke-color'];

let { font, file: fontFile } = loadFont(opt.font, opt['font-index'] != null ? Number(opt['font-index']) : undefined);

// Resolve bold/italic: a real face from the family, then variable-font axes, then synthetic.
const vars = {};
for (const v of opt.variation) {
  const [k, val] = v.split('=');
  vars[k.trim()] = Number(val);
}
let needBold = opt.bold;
let needItalic = opt.italic;
const baseStyle = fontStyle(font);
if (needItalic && baseStyle.italic) {
  console.error('note: font is already italic');
  needItalic = false;
}
if ((needBold || needItalic) && !opt.synthetic) {
  // Prefer a face with both styles; otherwise take a face with one of them and get the other
  // from a variable axis or synthesis below.
  const tries = [{ bold: needBold, italic: needItalic }];
  if (needBold && needItalic) tries.push({ bold: false, italic: true }, { bold: true, italic: false });
  for (const want of tries) {
    const face = findStyledFace(font, fontFile, want);
    if (face) {
      console.error(`using face "${face.fullName}"`);
      font = face;
      if (want.bold) needBold = false;
      if (want.italic) needItalic = false;
      break;
    }
  }
}
const axes = font.variationAxes || {};
if (needBold && !opt.synthetic && axes.wght && !('wght' in vars)) {
  const target = baseStyle.weight >= 600 ? 900 : 700;
  if (axes.wght.min <= target && target <= axes.wght.max && axes.wght.default < target) {
    vars.wght = target;
    needBold = false;
  }
}
if (needItalic && !opt.synthetic) {
  if (axes.ital && !('ital' in vars) && axes.ital.max >= 1) {
    vars.ital = 1;
    needItalic = false;
  } else if (axes.slnt && !('slnt' in vars) && axes.slnt.min < 0) {
    vars.slnt = Math.max(axes.slnt.min, -12);
    needItalic = false;
  }
}
if (Object.keys(vars).length) font = font.getVariation(vars);
if (needBold || needItalic) {
  console.error(`synthesizing ${[needBold && 'bold', needItalic && 'italic'].filter(Boolean).join(' + ')}`);
}
o.embolden = opt.embolden != null ? num('embolden') : needBold ? o.size * 0.02 : 0;
o.slant = opt.slant != null ? num('slant') : needItalic ? 12 : 0;
o.underline = opt.underline;
o.strikethrough = opt.strikethrough;
o.decorationThickness = opt['decoration-thickness'] != null ? num('decoration-thickness') : undefined;
o.underlineOffset = opt['underline-offset'] != null ? num('underline-offset') : undefined;

const text = positionals.join(' ').replace(/\\n/g, '\n');
const glyphs = renderText(font, text, o);
if (!glyphs.length) fail('nothing to render');

// Build non-overlapping color regions.
let fill = glyphs;
let stroke = [];
if (strokeWidth > 0) {
  const off = (s, d) => offset(s, d, join, miterLimit, o.tolerance);
  let outer;
  if (strokeAlign === 'outside') [outer, fill] = [off(glyphs, strokeWidth), glyphs];
  else if (strokeAlign === 'center') [outer, fill] = [off(glyphs, strokeWidth / 2), off(glyphs, -strokeWidth / 2)];
  else [outer, fill] = [glyphs, off(glyphs, -strokeWidth)];
  fill = clean(fill, minArea);
  stroke = clean(difference(outer, fill), minArea);
}

const layers = [];
if (textColor !== 'none' && fill.length) layers.push({ id: 'text', shape: fill, color: textColor });
if (strokeColor !== 'none' && stroke.length) layers.push({ id: 'stroke', shape: stroke, color: strokeColor });
if (!layers.length) fail('nothing visible (text and stroke colors are both "none")');

let connected = null;
if (opt.connect) {
  const solid = union(...layers.map((l) => l.shape));
  const width = opt['bridge-width'] != null ? num('bridge-width') : strokeWidth > 0 ? strokeWidth : o.size * 0.1;
  const { bridges, count, islands } = makeBridges(solid, width, o.tolerance);
  if (count) {
    const color = opt['bridge-color'] ?? layers[layers.length - 1].color;
    const target = layers.find((l) => l.color === color);
    if (target) {
      // Union with the full bar (which overlaps the target) so it fuses robustly,
      // then carve out the other color regions to keep everything non-overlapping.
      const others = layers.filter((l) => l !== target).flatMap((l) => l.shape);
      target.shape = clean(difference(union(target.shape, bridges), others), minArea);
    } else {
      layers.push({ id: 'bridges', shape: clean(difference(bridges, solid), minArea), color });
    }
    connected = union(solid, bridges);
    const remaining = components(connected).length;
    console.error(
      `connected ${islands} islands with ${count} bridge(s)` +
        (remaining > 1 ? ` (warning: ${remaining} pieces remain)` : ''),
    );
  }
}

const final = opt['single-path']
  ? [{ id: 'text', shape: connected ?? union(...layers.map((l) => l.shape)), color: layers[0].color }]
  : layers;

const format = opt.format ?? (/\.3mf$/i.test(opt.output || '') ? '3mf' : 'svg');
let data;
if (format === '3mf') {
  const colors = [...new Set(final.map((l) => l.color))];
  const kind = { text: 'text', stroke: 'stroke', bridges: 'bridge' };
  const parts = final.map((l) => {
    const k = kind[l.id];
    return {
      ...l,
      height: opt[`${k}-height`] != null ? num(`${k}-height`) : num('height'),
      filament: opt[`${k}-filament`] != null ? num(`${k}-filament`) : colors.indexOf(l.color) + 1,
    };
  });
  const position = opt.position.split(',').map(Number);
  if (position.length !== 2 || position.some((v) => !Number.isFinite(v))) fail('--position must be "x,y"');
  data = write3mf(parts, text.replace(/\n/g, ' '), position, opt.flip);
  for (const p of parts) console.error(`part "${p.id}": filament ${p.filament} (${p.color}), height ${p.height}mm`);
} else if (format === 'svg') {
  data = writeSvg(final, num('margin'), opt.units, Math.max(0, Math.round(num('precision'))), opt.flip);
} else {
  fail('--format must be svg or 3mf');
}

if (opt.output) {
  fs.writeFileSync(opt.output, data);
  console.error(`wrote ${opt.output}`);
} else {
  process.stdout.write(data);
}

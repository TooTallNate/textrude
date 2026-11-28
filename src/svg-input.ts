/**
 * Read an SVG file into filled 2D shapes (Clipper coordinates, mm × SCALE, Y down): paths (every
 * command, arcs included), rect, circle, ellipse, line, polyline and polygon, nested groups with
 * transforms, `<use>`, styles from attributes, `style=""` and simple `<style>` rules, both fill
 * rules, and strokes (turned into filled outlines with a Clipper offset). Units come from the
 * root's width/height and viewBox.
 */
import ClipperLib from 'clipper-lib';
import { SCALE, Clipper, ClipperOffset, ClipType, EndType, JoinType, PolyFillType, PolyType, union } from './geometry.js';
import type { Path, Shape } from './types.js';
import { flattenSubpaths, type PathCommand } from './outline.js';
import { parseXml, type XmlElement } from './xml.js';
import { TextrudeError } from './errors.js';

/** One painted element's geometry. */
export interface SvgShape {
  /** Element name, e.g. "path" or "circle". */
  tag: string;
  id?: string;
  /** Its fill and stroke together (nonzero rule). */
  shape: Shape;
  /** Just the filled area (empty without a fill). */
  fill: Shape;
  /** Just the stroke's area (empty without a stroke). */
  stroke: Shape;
}

export interface ParsedSvg {
  /** Every painted element, in paint order. */
  shapes: SvgShape[];
  /** The viewport size (mm). */
  width: number;
  height: number;
  /** Whether width/height were in absolute units (mm, cm, in, pt, pc, Q), as opposed to px or none. */
  physical: boolean;
  /** Problems worth telling the user about (text that isn't outlined, ignored images, ...). */
  warnings: string[];
}

export interface ParseSvgOptions {
  /** Max curve flattening error in mm, after `scale`. Default 0.01. */
  tolerance?: number;
  /**
   * The size the drawing will be scaled to (mm, its larger side), so curves are flattened finely
   * enough for it. Default: its own size.
   */
  targetSize?: number;
}

/** A 2D affine transform [a b c d e f], as in SVG's matrix(). */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
const numbers = (s: string | undefined): number[] => (s ? (s.match(NUMBER) ?? []).map(Number) : []);

/** Parse a `transform` attribute. */
export function parseTransform(s: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = numbers(args);
    let t: Matrix = IDENTITY;
    if (fn === 'matrix' && a.length >= 6) t = a.slice(0, 6) as Matrix;
    else if (fn === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      const [c, sn] = [Math.cos(r), Math.sin(r)];
      t = multiply(multiply([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = multiply(m, t);
  }
  return m;
}

/** mm per unit. */
const UNITS: Record<string, number> = { mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function parseLength(s: string | undefined): { mm: number; unit: string } | null {
  const m = s && /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s);
  if (!m) return null;
  const unit = m[2]!.toLowerCase();
  if (!(unit in UNITS)) return null;
  return { mm: Number(m[1]) * UNITS[unit]!, unit };
}

/** Convert an SVG arc to cubic Béziers (endpoint parameterization, SVG spec F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * y1p) / ry;
  const cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const kappa = (4 / 3) * Math.tan(delta / 4);
  const point = (t: number): [number, number] => {
    const [ct, st] = [Math.cos(t), Math.sin(t)];
    return [cx + rx * ct * cos - ry * st * sin, cy + rx * ct * sin + ry * st * cos];
  };
  const deriv = (t: number): [number, number] => {
    const [ct, st] = [Math.cos(t), Math.sin(t)];
    return [-rx * st * cos - ry * ct * sin, -rx * st * sin + ry * ct * cos];
  };
  const out: number[][] = [];
  for (let i = 0; i < segs; i++) {
    const a = t1 + i * delta;
    const b = a + delta;
    const [p0x, p0y] = point(a);
    const [d0x, d0y] = deriv(a);
    const [p1x, p1y] = i === segs - 1 ? [x2, y2] : point(b);
    const [d1x, d1y] = deriv(b);
    out.push([p0x + kappa * d0x, p0y + kappa * d0y, p1x - kappa * d1x, p1y - kappa * d1y, p1x, p1y]);
  }
  return out;
}

/** Parse path data into absolute moveTo / lineTo / quadraticCurveTo / bezierCurveTo / closePath commands. */
export function parsePathData(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let lastCtrl: [number, number] | null = null; // for S / T reflection
  let lastKind = '';
  const isCmd = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
  const num = () => {
    const t = tokens[i];
    if (t === undefined || isCmd(t)) throw new TextrudeError(`invalid path data near "${d.slice(0, 40)}"`);
    i++;
    return Number(t);
  };
  // Arc flags can be written without separators ("a1 1 0 0110 10"): split a token like "0110".
  const flag = () => {
    const t = tokens[i];
    if (t === undefined) throw new TextrudeError('invalid arc flags in path data');
    if (t[0] === '0' || t[0] === '1') {
      if (t.length === 1) i++;
      else tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    throw new TextrudeError('invalid arc flags in path data');
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]!;
    else if (!cmd) throw new TextrudeError('path data must start with a command');
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    let kind = C;
    switch (C) {
      case 'M':
        x = ox + num();
        y = oy + num();
        [sx, sy] = [x, y];
        out.push({ command: 'moveTo', args: [x, y] });
        cmd = rel ? 'l' : 'L'; // further pairs are lineTos
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        out.push({ command: 'lineTo', args: [x, y] });
        break;
      case 'H':
        x = ox + num();
        out.push({ command: 'lineTo', args: [x, y] });
        break;
      case 'V':
        y = oy + num();
        out.push({ command: 'lineTo', args: [x, y] });
        break;
      case 'C': {
        const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        out.push({ command: 'bezierCurveTo', args: a });
        lastCtrl = [a[2]!, a[3]!];
        [x, y] = [a[4]!, a[5]!];
        break;
      }
      case 'S': {
        const [c1x, c1y] = lastKind === 'C' && lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const a = [ox + num(), oy + num(), ox + num(), oy + num()];
        out.push({ command: 'bezierCurveTo', args: [c1x, c1y, ...a] });
        lastCtrl = [a[0]!, a[1]!];
        [x, y] = [a[2]!, a[3]!];
        kind = 'C';
        break;
      }
      case 'Q': {
        const a = [ox + num(), oy + num(), ox + num(), oy + num()];
        out.push({ command: 'quadraticCurveTo', args: a });
        lastCtrl = [a[0]!, a[1]!];
        [x, y] = [a[2]!, a[3]!];
        break;
      }
      case 'T': {
        const [cx, cy]: [number, number] = lastKind === 'Q' && lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
        const a = [ox + num(), oy + num()];
        out.push({ command: 'quadraticCurveTo', args: [cx, cy, a[0]!, a[1]!] });
        lastCtrl = [cx, cy];
        [x, y] = [a[0]!, a[1]!];
        kind = 'Q';
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const ex = ox + num();
        const ey = oy + num();
        for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) out.push({ command: 'bezierCurveTo', args: c });
        [x, y] = [ex, ey];
        break;
      }
      case 'Z':
        out.push({ command: 'closePath', args: [] });
        [x, y] = [sx, sy];
        break;
      default:
        throw new TextrudeError(`unknown path command "${cmd}"`);
    }
    lastKind = kind;
  }
  return out;
}

/** Commands for an ellipse (4 cubic arcs, starting at the right). */
function ellipseCommands(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const k = 0.5522847498307936;
  return [
    { command: 'moveTo', args: [cx + rx, cy] },
    { command: 'bezierCurveTo', args: [cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry] },
    { command: 'bezierCurveTo', args: [cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy] },
    { command: 'bezierCurveTo', args: [cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry] },
    { command: 'bezierCurveTo', args: [cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy] },
    { command: 'closePath', args: [] },
  ];
}

function rectCommands(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCommand[] {
  if (!rx || !ry) {
    return [
      { command: 'moveTo', args: [x, y] },
      { command: 'lineTo', args: [x + w, y] },
      { command: 'lineTo', args: [x + w, y + h] },
      { command: 'lineTo', args: [x, y + h] },
      { command: 'closePath', args: [] },
    ];
  }
  const k = 0.5522847498307936;
  const [kx, ky] = [k * rx, k * ry];
  return [
    { command: 'moveTo', args: [x + rx, y] },
    { command: 'lineTo', args: [x + w - rx, y] },
    { command: 'bezierCurveTo', args: [x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry] },
    { command: 'lineTo', args: [x + w, y + h - ry] },
    { command: 'bezierCurveTo', args: [x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h] },
    { command: 'lineTo', args: [x + rx, y + h] },
    { command: 'bezierCurveTo', args: [x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry] },
    { command: 'lineTo', args: [x, y + ry] },
    { command: 'bezierCurveTo', args: [x, y + ry - ky, x + rx - kx, y, x + rx, y] },
    { command: 'closePath', args: [] },
  ];
}

/** Style properties we use, and whether children inherit them. */
const PROPS: Record<string, boolean> = {
  fill: true,
  'fill-rule': true,
  'fill-opacity': true,
  stroke: true,
  'stroke-width': true,
  'stroke-linejoin': true,
  'stroke-linecap': true,
  'stroke-miterlimit': true,
  'stroke-opacity': true,
  visibility: true,
  display: false,
  opacity: false,
};

type Style = Record<string, string>;

interface CssRule {
  selector: { tag?: string; id?: string; classes: string[] };
  specificity: number;
  order: number;
  decls: Style;
}

function parseDecls(s: string): Style {
  const out: Style = {};
  for (const decl of s.split(';')) {
    const c = decl.indexOf(':');
    if (c < 0) continue;
    const k = decl.slice(0, c).trim().toLowerCase();
    const v = decl
      .slice(c + 1)
      .replace(/!important/i, '')
      .trim();
    if (k in PROPS) out[k] = v;
  }
  return out;
}

/** Simple `<style>` rules: tag, .class, #id and combinations like path.cls (no descendant selectors). */
function parseCss(css: string, rules: CssRule[]) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, sels, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decls = parseDecls(body!);
    for (const raw of sels!.split(',')) {
      const sel = raw.trim();
      const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel);
      if (!m || !sel) continue;
      const tag = m[1] && m[1] !== '*' ? m[1] : undefined;
      const parts = m[2]!.match(/[.#][\w-]+/g) ?? [];
      const id = parts.find((p) => p[0] === '#')?.slice(1);
      const classes = parts.filter((p) => p[0] === '.').map((p) => p.slice(1));
      rules.push({ selector: { tag, id, classes }, specificity: (id ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0), order: rules.length, decls });
    }
  }
}

const SKIP = new Set([
  'defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter', 'metadata',
  'title', 'desc', 'style', 'script', 'sodipodi:namedview', 'namedview', 'foreignObject',
]);
const TEXT = new Set(['text', 'tspan', 'textPath', 'flowRoot']);

interface DrawItem {
  tag: string;
  id?: string;
  commands: PathCommand[];
  fill: boolean;
  evenOdd: boolean;
  stroke: { width: number; join: ClipperLib.JoinType; cap: ClipperLib.EndType; miter: number } | null;
}

/**
 * Parse an SVG document into filled shapes, in mm (Y down, like the SVG). See {@link ParsedSvg}.
 */
export function parseSvg(source: string, options: ParseSvgOptions = {}): ParsedSvg {
  const root = parseXml(source);
  if (root.name !== 'svg') throw new TextrudeError(`not an SVG file (the root element is <${root.name}>)`);
  const warnings = new Set<string>();

  // Every element with an id, for <use>.
  const byId = new Map<string, XmlElement>();
  const rules: CssRule[] = [];
  const index = (el: XmlElement) => {
    if (el.attrs.id) byId.set(el.attrs.id, el);
    if (el.name === 'style') parseCss(el.text, rules);
    el.children.forEach(index);
  };
  index(root);
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  // The viewport (mm) and the viewBox → viewport transform.
  const vb = numbers(root.attrs.viewBox);
  const hasViewBox = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0;
  const wLen = parseLength(root.attrs.width);
  const hLen = parseLength(root.attrs.height);
  const px = UNITS.px!;
  let width = wLen?.mm ?? (hasViewBox ? (hLen ? (hLen.mm * vb[2]!) / vb[3]! : vb[2]! * px) : 100 * px);
  let height = hLen?.mm ?? (hasViewBox ? (wLen ? (wLen.mm * vb[3]!) / vb[2]! : vb[3]! * px) : 100 * px);
  const physical = !!wLen && !!hLen && wLen.unit !== 'px' && wLen.unit !== '' && hLen.unit !== 'px' && hLen.unit !== '';
  let rootMatrix: Matrix = [px, 0, 0, px, 0, 0];
  if (hasViewBox) {
    let sx = width / vb[2]!;
    let sy = height / vb[3]!;
    const par = (root.attrs.preserveAspectRatio ?? 'xMidYMid meet').trim();
    let tx = -vb[0]! * sx;
    let ty = -vb[1]! * sy;
    if (!par.startsWith('none')) {
      const s = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
      const align = par.split(/\s+/)[0]!;
      const fx = align.includes('xMin') ? 0 : align.includes('xMax') ? 1 : 0.5;
      const fy = align.includes('YMin') ? 0 : align.includes('YMax') ? 1 : 0.5;
      sx = sy = s;
      tx = -vb[0]! * s + (width - vb[2]! * s) * fx;
      ty = -vb[1]! * s + (height - vb[3]! * s) * fy;
    }
    rootMatrix = [sx, 0, 0, sy, tx, ty];
  }
  width = Math.abs(width);
  height = Math.abs(height);

  const styleOf = (el: XmlElement, inherited: Style): Style => {
    const own: Style = {};
    for (const k of Object.keys(PROPS)) if (el.attrs[k] != null) own[k] = el.attrs[k]!.trim();
    const classes = (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const r of rules) {
      const s = r.selector;
      if (s.tag && s.tag !== el.name) continue;
      if (s.id && s.id !== el.attrs.id) continue;
      if (s.classes.some((c) => !classes.includes(c))) continue;
      Object.assign(own, r.decls);
    }
    if (el.attrs.style) Object.assign(own, parseDecls(el.attrs.style));
    const out: Style = {};
    for (const [k, inh] of Object.entries(PROPS)) {
      const v = own[k];
      if (v != null && v !== 'inherit') out[k] = v;
      else if (inh && inherited[k] != null) out[k] = inherited[k]!;
    }
    return out;
  };

  const items: DrawItem[] = [];
  const visit = (el: XmlElement, parent: Matrix, inherited: Style, depth: number) => {
    if (depth > 64) throw new TextrudeError('SVG is nested too deeply (or a <use> refers to itself)');
    if (SKIP.has(el.name)) return;
    if (TEXT.has(el.name)) {
      if ((el.text + JSON.stringify(el.children)).trim()) {
        warnings.add('the SVG has text, which is ignored: convert text to outlines (paths) in your editor first, e.g. Inkscape "Path > Object to Path" or Illustrator "Create Outlines"');
      }
      return;
    }
    if (el.name === 'image') {
      warnings.add('the SVG has embedded images, which are ignored: only vector shapes become geometry');
      return;
    }
    const style = styleOf(el, inherited);
    if (style.display === 'none') return;
    if (el.attrs['clip-path'] || el.attrs.mask) warnings.add('clip paths and masks are ignored');
    let m = multiply(parent, parseTransform(el.attrs.transform));
    const a = (k: string, def = 0) => {
      const v = el.attrs[k];
      if (v == null) return def;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : def;
    };

    if (el.name === 'svg' || el.name === 'g' || el.name === 'a' || el.name === 'switch') {
      if (el.name === 'svg' && depth > 0) m = multiply(m, [1, 0, 0, 1, a('x'), a('y')]);
      for (const c of el.children) visit(c, m, style, depth + 1);
      return;
    }
    if (el.name === 'use') {
      const href = (el.attrs.href ?? el.attrs['xlink:href'] ?? '').replace(/^#/, '');
      const target = byId.get(href);
      if (!target) return;
      const um = multiply(m, [1, 0, 0, 1, a('x'), a('y')]);
      if (target.name === 'symbol') for (const c of target.children) visit(c, um, style, depth + 1);
      else visit(target, um, style, depth + 1);
      return;
    }

    let commands: PathCommand[];
    switch (el.name) {
      case 'path':
        commands = parsePathData(el.attrs.d ?? '');
        break;
      case 'rect': {
        const w = a('width');
        const h = a('height');
        if (w <= 0 || h <= 0) return;
        let rx = el.attrs.rx != null ? a('rx') : a('ry');
        let ry = el.attrs.ry != null ? a('ry') : rx;
        rx = Math.min(Math.max(rx, 0), w / 2);
        ry = Math.min(Math.max(ry, 0), h / 2);
        commands = rectCommands(a('x'), a('y'), w, h, rx, ry);
        break;
      }
      case 'circle': {
        const r = a('r');
        if (r <= 0) return;
        commands = ellipseCommands(a('cx'), a('cy'), r, r);
        break;
      }
      case 'ellipse': {
        const rx = a('rx');
        const ry = a('ry');
        if (rx <= 0 || ry <= 0) return;
        commands = ellipseCommands(a('cx'), a('cy'), rx, ry);
        break;
      }
      case 'line':
        commands = [
          { command: 'moveTo', args: [a('x1'), a('y1')] },
          { command: 'lineTo', args: [a('x2'), a('y2')] },
        ];
        break;
      case 'polyline':
      case 'polygon': {
        const p = numbers(el.attrs.points);
        if (p.length < 4) return;
        commands = [{ command: 'moveTo', args: [p[0]!, p[1]!] }];
        for (let k = 2; k + 1 < p.length; k += 2) commands.push({ command: 'lineTo', args: [p[k]!, p[k + 1]!] });
        if (el.name === 'polygon') commands.push({ command: 'closePath', args: [] });
        break;
      }
      default:
        return;
    }
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return;
    if (style.opacity != null && parseFloat(style.opacity) === 0) return;

    const none = (v: string | undefined) => v === 'none' || v === 'transparent';
    const fill = !none(style.fill) && !(style['fill-opacity'] != null && parseFloat(style['fill-opacity']) === 0) && el.name !== 'line';
    let stroke: DrawItem['stroke'] = null;
    if (style.stroke != null && !none(style.stroke) && !(style['stroke-opacity'] != null && parseFloat(style['stroke-opacity']) === 0)) {
      // In user units (scaled by the transforms below), like the geometry.
      const userWidth = style['stroke-width'] != null ? parseFloat(style['stroke-width']) || 0 : 1;
      const full = multiply(rootMatrix, m);
      const scale = Math.sqrt(Math.abs(full[0] * full[3] - full[1] * full[2]));
      const join = style['stroke-linejoin'];
      const cap = style['stroke-linecap'];
      const w = userWidth * scale;
      if (w > 0) {
        stroke = {
          width: w,
          join: join === 'round' ? JoinType.jtRound : join === 'bevel' ? JoinType.jtSquare : JoinType.jtMiter,
          cap: cap === 'round' ? EndType.etOpenRound : cap === 'square' ? EndType.etOpenSquare : EndType.etOpenButt,
          miter: parseFloat(style['stroke-miterlimit'] ?? '4') || 4,
        };
      }
    }
    if (!fill && !stroke) return;
    const full = multiply(rootMatrix, m);
    const transformed = commands.map(({ command, args }) => {
      const out: number[] = [];
      for (let k = 0; k + 1 < args.length; k += 2) out.push(...apply(full, args[k]!, args[k + 1]!));
      return { command, args: out };
    });
    items.push({ tag: el.name, id: el.attrs.id, commands: transformed, fill, evenOdd: style['fill-rule'] === 'evenodd', stroke });
  };
  visit(root, IDENTITY, { fill: 'black' }, 0);

  // Flatten finely enough for the size it'll be scaled to.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    for (const c of it.commands) {
      for (let k = 0; k + 1 < c.args.length; k += 2) {
        minX = Math.min(minX, c.args[k]!);
        maxX = Math.max(maxX, c.args[k]!);
        minY = Math.min(minY, c.args[k + 1]!);
        maxY = Math.max(maxY, c.args[k + 1]!);
      }
    }
  }
  const native = Math.max(maxX - minX, maxY - minY, 1e-6);
  const tol = (options.tolerance ?? 0.01) * (options.targetSize ? native / options.targetSize : 1);

  const toPath = (pts: [number, number][]): Path => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  const shapes: SvgShape[] = [];
  for (const it of items) {
    const lines = flattenSubpaths(it.commands, tol);
    let fill: Shape = [];
    if (it.fill) {
      const rings = lines.map((l) => toPath(l.points)).filter((p) => p.length >= 3);
      const c = new Clipper();
      c.AddPaths(rings, PolyType.ptSubject, true);
      const rule = it.evenOdd ? PolyFillType.pftEvenOdd : PolyFillType.pftNonZero;
      c.Execute(ClipType.ctUnion, fill, rule, rule);
    }
    let stroke: Shape = [];
    if (it.stroke) {
      const co = new ClipperOffset(it.stroke.miter, tol * SCALE);
      for (const l of lines) {
        const p = toPath(l.points);
        if (p.length < 2) continue;
        co.AddPath(p, it.stroke.join, l.closed ? EndType.etClosedLine : it.stroke.cap);
      }
      const out: Shape = [];
      co.Execute(out, (it.stroke.width / 2) * SCALE);
      stroke = union(out);
    }
    const shape = stroke.length ? union(fill, stroke) : fill;
    if (shape.length) shapes.push({ tag: it.tag, id: it.id, shape, fill, stroke });
  }
  return { shapes, width, height, physical, warnings: [...warnings] };
}

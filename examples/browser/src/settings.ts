import { parseColor, toHex } from 'textrude/colors';
import { PRINTERS } from 'textrude/printers';
import { BUNDLED, EMOJI_FONTS, bundledFile, type FontRef, type LocalFace, type UploadedFont } from './fonts';
import type { RenderOptions } from './protocol';

/** The design of one text (one object on the plate). */
export interface TextSettings {
  text: string;
  font: FontRef;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  lineSpacing: number;

  color: string;
  hollow: boolean;
  letterColors: string[] | null;

  strokeWidth: number;
  strokeColor: string;
  /** Use the background color for the stroke (when there's a background). */
  strokeMatchesBackground: boolean;
  strokeAlign: 'outside' | 'center' | 'inside';
  strokeJoin: 'round' | 'miter' | 'square';

  connect: boolean;
  bridgeWidth: number | null;
  /** Null: the outline's color, or the text's without an outline. */
  bridgeColor: string | null;

  background: boolean;
  backgroundColor: string;
  backgroundPadding: number | null;
  backgroundRadius: number;
  /** Text and outline on top of the plate, instead of inset into it. */
  raised: boolean;

  height: number;
  textHeight: number | null;
  strokeHeight: number | null;
  backgroundHeight: number | null;
}

/** The texts, plus the options for the whole plate. */
export interface Settings {
  texts: TextSettings[];
  emojiFont: string;
  palette: string[] | null;
  maxColors: number | null;
  printer: string;
  flip: boolean;
  /** The side that stays flat (null: the side on the bed). */
  flush: 'face' | 'back' | null;
  /** Space between texts on the plate (mm). */
  gap: number;
}

export const DEFAULT_FONT: FontRef = { kind: 'bundled', name: 'Archivo Black' };

export const DEFAULT_TEXT: TextSettings = {
  text: 'Hello 👋',
  font: DEFAULT_FONT,
  size: 20,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  align: 'center',
  letterSpacing: 0,
  lineSpacing: 1,

  color: '#111111',
  hollow: false,
  letterColors: null,

  strokeWidth: 1.5,
  strokeColor: '#ffffff',
  strokeMatchesBackground: true,
  strokeAlign: 'outside',
  strokeJoin: 'round',

  connect: true,
  bridgeWidth: null,
  bridgeColor: null,

  background: false,
  backgroundColor: '#1e3a8a',
  backgroundPadding: null,
  backgroundRadius: 3,
  raised: false,

  height: 2,
  textHeight: null,
  strokeHeight: null,
  backgroundHeight: null,
};

export const DEFAULTS: Settings = {
  texts: [DEFAULT_TEXT],
  emojiFont: 'Twemoji',
  palette: null,
  maxColors: null,
  printer: '',
  flip: false,
  flush: null,
  gap: 5,
};

/** The `textrude()` options for a text (fonts aside). */
export function renderOptions(t: TextSettings, s: Settings, style: { bold: boolean; italic: boolean }): RenderOptions {
  const strokeColor = t.background && t.strokeMatchesBackground ? undefined : t.strokeColor;
  return {
    size: t.size,
    bold: style.bold,
    italic: style.italic,
    underline: t.underline,
    strikethrough: t.strikethrough,
    align: t.align,
    letterSpacing: t.letterSpacing,
    lineSpacing: t.lineSpacing,
    color: t.hollow ? 'none' : t.color,
    letterColors: t.letterColors?.length ? t.letterColors : undefined,
    strokeWidth: t.strokeWidth,
    strokeColor,
    strokeAlign: t.strokeAlign,
    strokeJoin: t.strokeJoin,
    connect: t.connect && !t.background,
    bridgeWidth: t.bridgeWidth ?? undefined,
    bridgeColor: t.bridgeColor ?? undefined,
    background: t.background ? t.backgroundColor : undefined,
    backgroundPadding: t.backgroundPadding ?? undefined,
    backgroundRadius: t.backgroundRadius,
    raised: t.background && t.raised,
    height: t.height,
    textHeight: t.textHeight ?? undefined,
    strokeHeight: t.strokeHeight ?? undefined,
    backgroundHeight: t.backgroundHeight ?? undefined,
    palette: s.palette?.length ? s.palette : undefined,
    maxColors: s.maxColors ?? undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Config files: the same JSON the CLI reads with `--config` (camelCase option names, `text` or a
// `texts` array, with shared options at the top level). Options left out get the CLI's defaults.

export type Config = Record<string, unknown>;

/** What the app knows about fonts that don't have a URL (to name them, or to find them again). */
export interface FontContext {
  uploads: UploadedFont[];
  localFonts: Map<string, LocalFace[]> | null;
}

/** The CLI's defaults, which config files don't need to repeat. */
const CLI_DEFAULTS = {
  size: 20,
  color: '#000000',
  align: 'left',
  lineSpacing: 1,
  letterSpacing: 0,
  strokeWidth: 0,
  strokeColor: '#ffffff',
  strokeAlign: 'outside',
  strokeJoin: 'round',
  backgroundRadius: 0,
  height: 2,
  gap: 5,
} as const;

/** A font as it's written in a config file: a URL, an installed font's name, or a file name. */
function fontSpec(t: TextSettings, ctx: FontContext): { font: string; italic: boolean } {
  const f = t.font;
  if (f.kind === 'bundled') {
    const b = BUNDLED.find((x) => x.name === f.name) ?? BUNDLED[0]!;
    // The italic face is its own file; `italic` then just confirms it (nothing is synthesized).
    return { font: bundledFile(b, f.style, t.italic).url, italic: t.italic };
  }
  if (f.kind === 'url') return { font: f.url, italic: t.italic };
  if (f.kind === 'local') return { font: f.family, italic: t.italic };
  const u = ctx.uploads.find((x) => x.id === f.id);
  return { font: u?.fileName ?? 'font.ttf', italic: t.italic };
}

function textConfig(t: TextSettings, ctx: FontContext): Config {
  const o: Config = {};
  const { font, italic } = fontSpec(t, ctx);
  o.font = font;
  if (t.bold) o.bold = true;
  if (italic) o.italic = true;
  if (t.underline) o.underline = true;
  if (t.strikethrough) o.strikethrough = true;
  if (t.size !== CLI_DEFAULTS.size) o.size = t.size;
  if (t.hollow) o.color = 'none';
  else if (t.color !== CLI_DEFAULTS.color) o.color = t.color;
  if (t.letterColors?.length) o.letterColors = t.letterColors;
  if (t.text.includes('\n') && t.align !== CLI_DEFAULTS.align) o.align = t.align;
  if (t.text.includes('\n') && t.lineSpacing !== CLI_DEFAULTS.lineSpacing) o.lineSpacing = t.lineSpacing;
  if (t.letterSpacing !== CLI_DEFAULTS.letterSpacing) o.letterSpacing = t.letterSpacing;
  if (t.strokeWidth > 0) {
    o.strokeWidth = t.strokeWidth;
    // Without a stroke color, the CLI uses the background color (or white).
    if (t.background ? !t.strokeMatchesBackground : t.strokeColor !== CLI_DEFAULTS.strokeColor) o.strokeColor = t.strokeColor;
    if (t.strokeAlign !== CLI_DEFAULTS.strokeAlign) o.strokeAlign = t.strokeAlign;
    if (t.strokeJoin !== CLI_DEFAULTS.strokeJoin) o.strokeJoin = t.strokeJoin;
  }
  if (t.background) {
    o.background = t.backgroundColor;
    if (t.backgroundPadding != null) o.backgroundPadding = t.backgroundPadding;
    if (t.backgroundRadius !== CLI_DEFAULTS.backgroundRadius) o.backgroundRadius = t.backgroundRadius;
    if (t.raised) o.raised = true;
  } else if (t.connect) {
    o.connect = true;
    if (t.bridgeWidth != null) o.bridgeWidth = t.bridgeWidth;
    if (t.bridgeColor != null) o.bridgeColor = t.bridgeColor;
  }
  if (t.height !== CLI_DEFAULTS.height) o.height = t.height;
  if (t.textHeight != null) o.textHeight = t.textHeight;
  if (t.strokeWidth > 0 && t.strokeHeight != null) o.strokeHeight = t.strokeHeight;
  if (t.background && t.backgroundHeight != null) o.backgroundHeight = t.backgroundHeight;
  return o;
}

/**
 * The settings as a CLI config file. Options every text has in common go at the top level, and
 * each entry in `texts` only lists what's different.
 */
export function toConfig(s: Settings, ctx: FontContext): Config {
  const items = s.texts.map((t) => textConfig(t, ctx));
  const shared: Config = {};
  for (const key of Object.keys(items[0]!)) {
    const value = JSON.stringify(items[0]![key]);
    if (items.every((item) => key in item && JSON.stringify(item[key]) === value)) shared[key] = items[0]![key];
  }
  for (const item of items) for (const key of Object.keys(shared)) delete item[key];

  const emoji = EMOJI_FONTS.find((e) => e.name === s.emojiFont);
  if (emoji) shared.fallbackFont = [emoji.url];
  if (s.palette?.length) shared.palette = s.palette;
  else if (s.maxColors != null) shared.maxColors = s.maxColors;
  if (s.printer) shared.printer = s.printer;
  if (s.flip) shared.flip = true;
  if (s.flush) shared.flush = s.flush;
  if (s.texts.length > 1 && s.gap !== CLI_DEFAULTS.gap) shared.gap = s.gap;

  if (s.texts.length === 1) return { text: s.texts[0]!.text, ...shared };
  return {
    ...shared,
    texts: s.texts.map((t, i) => (Object.keys(items[i]!).length ? { text: t.text, ...items[i] } : t.text)),
  };
}

const camel = (key: string) => key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Options this app understands (anything else in a config file is reported and ignored). */
const TEXT_KEYS = new Set([
  'text', 'font', 'bold', 'italic', 'underline', 'strikethrough', 'size', 'color', 'letterColors', 'align', 'lineSpacing',
  'letterSpacing', 'strokeWidth', 'strokeColor', 'strokeAlign', 'strokeJoin', 'connect', 'bridgeWidth', 'bridgeColor', 'background',
  'backgroundPadding', 'backgroundRadius', 'raised', 'height', 'textHeight', 'strokeHeight', 'backgroundHeight',
  // Read from the top level, but the CLI also allows them per text.
  'fallbackFont', 'maxColors',
]);
const PLATE_KEYS = new Set(['palette', 'printer', 'flip', 'flush', 'gap', 'fallbackFont', 'maxColors']);
/** CLI options about where and how output is written, which don't apply here. */
const CLI_ONLY_KEYS = new Set(['output', 'format', 'preview', 'previewPng', 'quiet', 'config', 'listFonts', 'version', 'help']);

/** Read a CLI config file into settings, with notes about anything that couldn't be used. */
export function fromConfig(raw: unknown, ctx: FontContext): { settings: Settings; notes: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a config file must be a JSON object');
  const notes: string[] = [];
  const ignored = new Set<string>();
  const missingFonts = new Set<string>();
  const top: Config = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]));
  const { text, texts, ...shared } = top;

  const num = (key: string, v: unknown, min = -Infinity): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= min) return n;
    notes.push(`"${key}" must be a number`);
    return undefined;
  };
  const color = (key: string, v: unknown): string | null | undefined => {
    try {
      const c = parseColor(String(v));
      return c && toHex(c);
    } catch {
      notes.push(`"${key}": invalid color "${String(v)}"`);
      return undefined;
    }
  };
  const colors = (key: string, v: unknown): string[] | undefined => {
    const list = (Array.isArray(v) ? v : String(v).split(',')).map((c) => color(key, String(c).trim()));
    return list.every((c): c is string => typeof c === 'string') && list.length ? list : undefined;
  };
  // Like the CLI, a choice can be abbreviated to its first letter.
  const choice = <T extends string>(key: string, v: unknown, allowed: readonly T[]): T | undefined => {
    const match = allowed.find((a) => a === v || a[0] === v);
    if (!match) notes.push(`"${key}" must be one of: ${allowed.join(', ')}`);
    return match;
  };
  const bool = (v: unknown) => v === true || v === 'true';

  const fontRef = (spec: string): { font: FontRef; italic?: boolean } | null => {
    for (const b of BUNDLED) {
      const style = b.styles?.find((s) => spec === s.url || spec.endsWith(`/${s.file}`));
      if (style) return { font: { kind: 'bundled', name: b.name, style: style.name } };
      if (spec === b.url || spec.endsWith(`/${b.file}`)) return { font: { kind: 'bundled', name: b.name } };
      if (b.italic && (spec === b.italic.url || spec.endsWith(`/${b.italic.file}`))) return { font: { kind: 'bundled', name: b.name }, italic: true };
    }
    if (/^https?:\/\//i.test(spec)) return { font: { kind: 'url', url: spec } };
    const bundled = BUNDLED.find((b) => norm(b.name) === norm(spec));
    if (bundled) return { font: { kind: 'bundled', name: bundled.name } };
    const base = spec.replace(/^.*[\\/]/, '');
    const upload = ctx.uploads.find((u) => u.fileName === base || norm(u.name) === norm(base.replace(/\.[^.]*$/, '')));
    if (upload) return { font: { kind: 'upload', id: upload.id } };
    const family = [...(ctx.localFonts?.keys() ?? [])].find((f) => norm(f) === norm(spec));
    if (family) return { font: { kind: 'local', family } };
    return null;
  };

  const readText = (item: Config): TextSettings => {
    // Start from the CLI's defaults: whatever the file leaves out is what the CLI would use.
    const { gap: _, ...cliDefaults } = CLI_DEFAULTS;
    const t: TextSettings = { ...DEFAULT_TEXT, ...cliDefaults, text: '', connect: false };
    for (const [key, v] of Object.entries(item)) {
      if (!TEXT_KEYS.has(key)) {
        if (!PLATE_KEYS.has(key) && !CLI_ONLY_KEYS.has(key)) ignored.add(key);
        continue;
      }
      switch (key) {
        case 'text':
          t.text = String(v);
          break;
        case 'font': {
          const ref = fontRef(String(v));
          if (ref) {
            t.font = ref.font;
            if (ref.italic) t.italic = true;
          } else {
            missingFonts.add(String(v));
          }
          break;
        }
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strikethrough':
        case 'connect':
        case 'raised':
          t[key] = bool(v) || (key === 'italic' && t.italic);
          break;
        case 'size':
        case 'height':
        case 'strokeWidth':
        case 'backgroundRadius':
        case 'letterSpacing':
        case 'lineSpacing': {
          const n = num(key, v, key === 'letterSpacing' ? -Infinity : 0);
          if (n != null) t[key] = n;
          break;
        }
        case 'bridgeWidth':
        case 'backgroundPadding':
        case 'textHeight':
        case 'strokeHeight':
        case 'backgroundHeight': {
          const n = num(key, v, 0);
          if (n != null) t[key] = n;
          break;
        }
        case 'color': {
          const c = color(key, v);
          if (c === null) t.hollow = true;
          else if (c) t.color = c;
          break;
        }
        case 'letterColors':
          t.letterColors = colors(key, v) ?? null;
          break;
        case 'bridgeColor': {
          const c = color(key, v);
          if (c) t.bridgeColor = c;
          break;
        }
        case 'strokeColor': {
          const c = color(key, v);
          if (c) {
            t.strokeColor = c;
            t.strokeMatchesBackground = false;
          }
          break;
        }
        case 'background': {
          const c = color(key, v);
          if (c) {
            t.background = true;
            t.backgroundColor = c;
          }
          break;
        }
        case 'align':
          t.align = choice(key, v, ['left', 'center', 'right'] as const) ?? t.align;
          break;
        case 'strokeAlign':
          t.strokeAlign = choice(key, v, ['outside', 'center', 'inside'] as const) ?? t.strokeAlign;
          break;
        case 'strokeJoin':
          t.strokeJoin = choice(key, v, ['round', 'miter', 'square'] as const) ?? t.strokeJoin;
          break;
      }
    }
    // A background without its own stroke color takes the background's.
    if (t.background && t.strokeMatchesBackground) t.strokeColor = t.backgroundColor;
    return t;
  };

  let items: Config[];
  if (texts !== undefined) {
    if (!Array.isArray(texts) || !texts.length) throw new Error('"texts" must be a non-empty array');
    items = texts.map((entry, i) => {
      if (typeof entry === 'string') return { ...shared, text: entry };
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`"texts": entry ${i + 1} must be a string or an object`);
      const own = Object.fromEntries(Object.entries(entry).map(([k, v]) => [camel(k), v]));
      if (own.text === undefined) throw new Error(`"texts": entry ${i + 1} has no "text"`);
      return { ...shared, ...own };
    });
  } else {
    items = [{ ...shared, text: text ?? '' }];
  }
  const settings: Settings = { ...DEFAULTS, texts: items.map(readText) };
  for (const font of missingFonts) {
    notes.push(`font "${font}" isn't available here, so the default font is used (drop the font file together with the config to use it)`);
  }

  if (shared.palette !== undefined) settings.palette = colors('palette', shared.palette) ?? null;
  if (shared.maxColors !== undefined) settings.maxColors = num('maxColors', shared.maxColors, 1) ?? null;
  if (shared.flip !== undefined) settings.flip = bool(shared.flip);
  if (shared.flush !== undefined) settings.flush = choice('flush', shared.flush, ['face', 'back'] as const) ?? null;
  if (shared.gap !== undefined) settings.gap = num('gap', shared.gap, 0) ?? DEFAULTS.gap;
  if (shared.printer !== undefined) {
    if (PRINTERS[String(shared.printer)]) settings.printer = String(shared.printer);
    else notes.push(`unknown printer "${String(shared.printer)}"`);
  }
  if (shared.fallbackFont !== undefined) {
    const specs = ([] as unknown[]).concat(shared.fallbackFont).map(String);
    const emoji = specs
      .map((spec) => EMOJI_FONTS.find((e) => spec === e.url || spec.endsWith(`/${e.file}`) || norm(spec).includes(norm(e.name))))
      .find(Boolean);
    if (emoji) settings.emojiFont = emoji.name;
    else notes.push(`fallback font${specs.length > 1 ? 's' : ''} ${specs.map((f) => `"${f}"`).join(', ')} aren't available here, so ${settings.emojiFont} is used for emoji`);
  }
  if (ignored.size) notes.push(`not supported here, so ignored: ${[...ignored].join(', ')}`);
  return { settings, notes };
}

// The URL hash holds the config (base64url), so designs survive reloads and can be shared.
const NO_FONTS: FontContext = { uploads: [], localFonts: null };

export function encodeSettings(s: Settings, ctx: FontContext): string {
  const json = JSON.stringify(toConfig(s, ctx));
  if (json === JSON.stringify(toConfig(DEFAULTS, NO_FONTS))) return '';
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSettings(hash: string): { settings: Settings; notes: string[] } {
  const s = hash.replace(/^#/, '');
  if (!s) return { settings: DEFAULTS, notes: [] };
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return fromConfig(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))), NO_FONTS);
  } catch {
    return { settings: DEFAULTS, notes: ["the link's design couldn't be read"] };
  }
}

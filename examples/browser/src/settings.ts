import type { FontRef } from './fonts';
import type { RenderOptions } from './protocol';

export interface Settings {
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
  emojiFont: string;

  strokeWidth: number;
  strokeColor: string;
  /** Use the background color for the stroke (when there's a background). */
  strokeMatchesBackground: boolean;
  strokeAlign: 'outside' | 'center' | 'inside';
  strokeJoin: 'round' | 'miter' | 'square';

  connect: boolean;
  bridgeWidth: number | null;

  background: boolean;
  backgroundColor: string;
  backgroundPadding: number | null;
  backgroundRadius: number;

  height: number;
  textHeight: number | null;
  strokeHeight: number | null;
  backgroundHeight: number | null;

  palette: string[] | null;
  maxColors: number | null;

  printer: string;
  flip: boolean;
}

export const DEFAULTS: Settings = {
  text: 'Hello 👋',
  font: { kind: 'bundled', name: 'Archivo Black' },
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
  emojiFont: 'Twemoji',

  strokeWidth: 1.5,
  strokeColor: '#ffffff',
  strokeMatchesBackground: true,
  strokeAlign: 'outside',
  strokeJoin: 'round',

  connect: true,
  bridgeWidth: null,

  background: false,
  backgroundColor: '#1e3a8a',
  backgroundPadding: null,
  backgroundRadius: 3,

  height: 2,
  textHeight: null,
  strokeHeight: null,
  backgroundHeight: null,

  palette: null,
  maxColors: null,

  printer: '',
  flip: false,
};

/** The `textrude()` options for these settings (fonts aside). */
export function renderOptions(s: Settings, style: { bold: boolean; italic: boolean }): RenderOptions {
  const strokeColor = s.background && s.strokeMatchesBackground ? undefined : s.strokeColor;
  return {
    size: s.size,
    bold: style.bold,
    italic: style.italic,
    underline: s.underline,
    strikethrough: s.strikethrough,
    align: s.align,
    letterSpacing: s.letterSpacing,
    lineSpacing: s.lineSpacing,
    color: s.hollow ? 'none' : s.color,
    letterColors: s.letterColors?.length ? s.letterColors : undefined,
    strokeWidth: s.strokeWidth,
    strokeColor,
    strokeAlign: s.strokeAlign,
    strokeJoin: s.strokeJoin,
    connect: s.connect && !s.background,
    bridgeWidth: s.bridgeWidth ?? undefined,
    background: s.background ? s.backgroundColor : undefined,
    backgroundPadding: s.backgroundPadding ?? undefined,
    backgroundRadius: s.backgroundRadius,
    height: s.height,
    textHeight: s.textHeight ?? undefined,
    strokeHeight: s.strokeHeight ?? undefined,
    backgroundHeight: s.backgroundHeight ?? undefined,
    palette: s.palette?.length ? s.palette : undefined,
    maxColors: s.maxColors ?? undefined,
  };
}

/** Settings that differ from the defaults, for the URL. */
export function encodeSettings(s: Settings): string {
  const diff: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    // Uploaded and installed fonts can't be shared, so they aren't saved.
    if (key === 'font' && s.font.kind !== 'bundled') continue;
    if (JSON.stringify(s[key]) !== JSON.stringify(DEFAULTS[key])) diff[key] = s[key];
  }
  if (!Object.keys(diff).length) return '';
  const bytes = new TextEncoder().encode(JSON.stringify(diff));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSettings(hash: string): Settings {
  const s = hash.replace(/^#/, '');
  if (!s) return DEFAULTS;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (!(key in parsed)) continue;
      const value = parsed[key];
      if (DEFAULTS[key] === null || typeof value === typeof DEFAULTS[key]) (out as Record<string, unknown>)[key] = value;
    }
    return out;
  } catch {
    return DEFAULTS;
  }
}

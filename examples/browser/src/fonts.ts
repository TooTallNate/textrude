import manifest from '../fonts.json';

/**
 * Where a font comes from: one of the bundled fonts (by name), an installed font family (via
 * the Local Font Access API), an uploaded file, or a URL (from a config file).
 */
export type FontRef =
  | { kind: 'bundled'; name: string; /** One of the font's `styles` (default: the first). */ style?: string }
  | { kind: 'local'; family: string }
  | { kind: 'upload'; id: string }
  | { kind: 'url'; url: string };

export interface BundledFont {
  name: string;
  category: string;
  file: string;
  /** Where the font comes from (also used for it in config files, so they work with the CLI). */
  url: string;
  italic?: { file: string; url: string };
  /** Variants that are separate font files (like Geist Pixel's Square, Grid, ...). */
  styles?: { name: string; file: string; url: string }[];
}

/** The file of a bundled font for a style and italic. `italic` is whether that file is italic. */
export function bundledFile(b: BundledFont, style: string | undefined, italic: boolean): { file: string; url: string; italic: boolean } {
  const variant = b.styles?.find((s) => s.name === style) ?? b.styles?.[0];
  if (variant) return { file: variant.file, url: variant.url, italic: false };
  if (italic && b.italic) return { ...b.italic, italic: true };
  return { file: b.file, url: b.url, italic: false };
}

export const BUNDLED: BundledFont[] = manifest.fonts;
export const EMOJI_FONTS = manifest.emoji;
export const CATEGORIES = [...new Set(BUNDLED.map((f) => f.category))];

export const fontUrl = (file: string) => new URL(`${import.meta.env.BASE_URL}fonts/${encodeURIComponent(file)}`, location.href).href;

export interface UploadedFont {
  id: string;
  /** The file name without its extension. */
  name: string;
  fileName: string;
  data: Uint8Array;
}

/** An installed font face, from `queryLocalFonts()`. */
export interface LocalFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFace[]>;
  }
}

export const canUseLocalFonts = typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';

/** Installed fonts grouped by family (asks for permission the first time). */
export async function localFamilies(): Promise<Map<string, LocalFace[]>> {
  const faces = await window.queryLocalFonts!();
  const families = new Map<string, LocalFace[]>();
  for (const face of faces) {
    let list = families.get(face.family);
    if (!list) families.set(face.family, (list = []));
    list.push(face);
  }
  return new Map([...families].sort(([a], [b]) => a.localeCompare(b)));
}

const isBold = (style: string) => /bold|black|heavy/i.test(style) && !/semi|demi/i.test(style);
const isItalic = (style: string) => /italic|oblique/i.test(style);

/**
 * Pick the face of an installed family for the requested style. Returns the face and which
 * styles it already provides (the rest are left to textrude: variable axes or synthesis).
 */
export function pickLocalFace(faces: LocalFace[], bold: boolean, italic: boolean) {
  const score = (f: LocalFace) => {
    const s = f.style;
    let n = 0;
    if (isItalic(s) !== italic) n += 10;
    if (isBold(s) !== bold) n += 5;
    if (/condensed|narrow|compressed|expanded|wide/i.test(s)) n += 3;
    if (!bold && /light|thin|medium|semi|demi/i.test(s)) n += 2;
    if (bold && /black|heavy|extra|ultra/i.test(s)) n += 1;
    return n;
  };
  const face = [...faces].sort((a, b) => score(a) - score(b))[0]!;
  return { face, bold: bold && isBold(face.style), italic: italic && isItalic(face.style) };
}

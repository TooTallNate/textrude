import manifest from '../fonts.json';

/**
 * Where a font comes from: one of the bundled fonts (by name), an installed font family (via
 * the Local Font Access API), or an uploaded file.
 */
export type FontRef = { kind: 'bundled'; name: string } | { kind: 'local'; family: string } | { kind: 'upload'; id: string };

export interface BundledFont {
  name: string;
  category: string;
  file: string;
  italic?: { file: string };
}

export const BUNDLED: BundledFont[] = manifest.fonts;
export const EMOJI_FONTS = manifest.emoji;
export const CATEGORIES = [...new Set(BUNDLED.map((f) => f.category))];

export const fontUrl = (file: string) => new URL(`${import.meta.env.BASE_URL}fonts/${encodeURIComponent(file)}`, location.href).href;

export interface UploadedFont {
  id: string;
  name: string;
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

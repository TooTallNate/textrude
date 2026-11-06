/**
 * A small PNG decoder (every color type, bit depth, and interlacing) and RGBA encoder, built on
 * fflate's zlib so it runs anywhere.
 */
import { unzlibSync, zlibSync } from 'fflate';

export interface Image {
  width: number;
  height: number;
  /** 8-bit RGBA pixels, row by row. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(png: Uint8Array): Image {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error('not a PNG image');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlaced = false;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length; ) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      depth = body[8]!;
      colorType = body[9]!;
      interlaced = body[12] === 1;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels) throw new Error('unsupported PNG image');
  if (colorType === 3 && !palette) throw new Error('PNG image is missing its palette');

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (compressed.set(c, o), o + c.length), 0);
  const raw = unzlibSync(compressed);

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const max = (1 << depth) - 1;
  const out = new Uint8Array(width * height * 4);
  // Transparent color for gray / RGB images, compared at the image's own bit depth.
  const key = trns && (colorType === 0 || colorType === 2)
    ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => (trns![i * 2]! << 8) | trns![i * 2 + 1]!)
    : null;

  let offset = 0;
  for (const [x0, y0, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1] as const]) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      const filter = raw[offset]!;
      const row = raw.slice(offset + 1, offset + 1 + rowBytes);
      offset += 1 + rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        row[i] = (row[i]! + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0)) & 0xff;
      }
      prev = row;

      const sample = (x: number, ch: number): number => {
        if (depth === 8) return row[x * channels + ch]!;
        if (depth === 16) return (row[(x * channels + ch) * 2]! << 8) | row[(x * channels + ch) * 2 + 1]!;
        const bit = (x * channels + ch) * depth;
        return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
      };
      const to8 = (v: number) => (depth === 8 ? v : Math.round((v * 255) / max));
      for (let x = 0; x < pw; x++) {
        const o = ((y0 + y * dy) * width + x0 + x * dx) * 4;
        let r: number, g: number, b: number, alpha: number;
        if (colorType === 3) {
          const i = sample(x, 0);
          [r, g, b] = [palette![i * 3] ?? 0, palette![i * 3 + 1] ?? 0, palette![i * 3 + 2] ?? 0];
          alpha = trns?.[i] ?? 255;
        } else {
          const s = Array.from({ length: channels }, (_, ch) => sample(x, ch));
          const gray = colorType === 0 || colorType === 4;
          const color = gray ? [s[0]!] : s.slice(0, 3);
          [r, g, b] = gray ? [to8(s[0]!), to8(s[0]!), to8(s[0]!)] : [to8(s[0]!), to8(s[1]!), to8(s[2]!)];
          alpha = colorType === 4 ? to8(s[1]!) : colorType === 6 ? to8(s[3]!) : key && key.every((k, i) => k === color[i]) ? 0 : 255;
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = alpha;
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode 8-bit RGBA pixels as a PNG. */
export function encodePng({ width, height, data }: Image): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  // Each row is filtered with "up" (filter type 2), which compresses flat images well.
  const rowBytes = width * 4;
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1);
    filtered[o] = 2;
    for (let i = 0; i < rowBytes; i++) {
      const v = data[y * rowBytes + i]!;
      filtered[o + 1 + i] = (v - (y ? data[(y - 1) * rowBytes + i]! : 0)) & 0xff;
    }
  }
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(filtered, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

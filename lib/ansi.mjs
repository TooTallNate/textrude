// ANSI escape sequences: SGR foreground colors become per-character colors; everything else
// (cursor movement, OSC titles/links, other SGR attributes) is stripped.

// xterm's default 16 colors.
const BASIC = [
  '000000', 'cd0000', '00cd00', 'cdcd00', '0000ee', 'cd00cd', '00cdcd', 'e5e5e5',
  '7f7f7f', 'ff0000', '00ff00', 'ffff00', '5c5cff', 'ff00ff', '00ffff', 'ffffff',
].map((h) => ({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }));

/** One of the 256 xterm colors: 16 basic, a 6x6x6 cube, then 24 grays. */
function color256(n) {
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const v = (c) => (c ? 55 + c * 40 : 0);
    const i = n - 16;
    return { r: v(Math.floor(i / 36)), g: v(Math.floor(i / 6) % 6), b: v(i % 6) };
  }
  const g = 8 + (n - 232) * 10;
  return { r: g, g, b: g };
}

// CSI sequences, OSC sequences (ended by BEL or ST), and other two-character escapes.
const ESCAPE = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/**
 * Strip escape sequences from `input`. Returns { text, colors }, where colors[i] is the
 * foreground color ({ r, g, b }) of text[i] (UTF-16 index), or null for the default color.
 * `hasColor` tells whether any color was set at all.
 */
export function parseAnsi(input) {
  let text = '';
  const colors = [];
  let current = null;
  let hasColor = false;
  let last = 0;
  for (const m of input.matchAll(ESCAPE)) {
    const chunk = input.slice(last, m.index);
    text += chunk;
    for (let i = 0; i < chunk.length; i++) colors.push(current);
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue; // only SGR ("ESC [ ... m") matters
    const params = (m[1] || '0').split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0 || p === 39) current = null;
      else if (p >= 30 && p <= 37) current = BASIC[p - 30];
      else if (p >= 90 && p <= 97) current = BASIC[p - 90 + 8];
      else if (p === 38 && params[i + 1] === 5) {
        current = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (p === 38 && params[i + 1] === 2) {
        current = { r: params[i + 2] ?? 0, g: params[i + 3] ?? 0, b: params[i + 4] ?? 0 };
        i += 4;
      } else if ((p === 48 || p === 58) && params[i + 1] === 5) {
        i += 2; // background / underline color: ignored
      } else if ((p === 48 || p === 58) && params[i + 1] === 2) {
        i += 4;
      }
      if (current) hasColor = true;
    }
  }
  const rest = input.slice(last);
  text += rest;
  for (let i = 0; i < rest.length; i++) colors.push(current);
  return { text, colors, hasColor };
}

import { describe, expect, it } from 'vitest';
import { color256, parseAnsi } from '../src/ansi.js';

describe('parseAnsi', () => {
  it('passes plain text through', () => {
    const r = parseAnsi('Hello\nWorld');
    expect(r.text).toBe('Hello\nWorld');
    expect(r.hasColor).toBe(false);
    expect(r.colors).toHaveLength(r.text.length);
    expect(r.colors.every((c) => c === null)).toBe(true);
  });

  it('maps basic and bright colors to xterm values', () => {
    const r = parseAnsi('\x1b[31mR\x1b[92mG\x1b[0mx');
    expect(r.text).toBe('RGx');
    expect(r.hasColor).toBe(true);
    expect(r.colors[0]).toEqual({ r: 0xcd, g: 0, b: 0 });
    expect(r.colors[1]).toEqual({ r: 0, g: 0xff, b: 0 });
    expect(r.colors[2]).toBeNull();
  });

  it('supports 256-color and truecolor codes', () => {
    const r = parseAnsi('\x1b[38;5;27mA\x1b[38;2;255;140;0mB\x1b[39mC');
    expect(r.colors[0]).toEqual(color256(27));
    expect(r.colors[1]).toEqual({ r: 255, g: 140, b: 0 });
    expect(r.colors[2]).toBeNull();
  });

  it('accepts colon separators and combined parameters', () => {
    const r = parseAnsi('\x1b[1;38:2:10:20:30mX');
    expect(r.colors[0]).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('ignores background colors and other attributes', () => {
    const r = parseAnsi('\x1b[44;1;4mA\x1b[48;2;1;2;3mB');
    expect(r.text).toBe('AB');
    expect(r.hasColor).toBe(false);
  });

  it('strips non-SGR escapes (cursor movement, OSC hyperlinks)', () => {
    const r = parseAnsi('\x1b[2K\x1b]8;;https://x.y\x07link\x1b]8;;\x07!');
    expect(r.text).toBe('link!');
  });

  it('keeps colors aligned with UTF-16 indices', () => {
    const r = parseAnsi('\x1b[31m😀\x1b[34mx');
    expect(r.text).toBe('😀x');
    expect(r.colors).toHaveLength(3);
    expect(r.colors[0]).toEqual(r.colors[1]);
    expect(r.colors[2]).toEqual({ r: 0, g: 0, b: 0xee });
  });
});

describe('color256', () => {
  it('covers the cube and grays', () => {
    expect(color256(16)).toEqual({ r: 0, g: 0, b: 0 });
    expect(color256(231)).toEqual({ r: 255, g: 255, b: 255 });
    expect(color256(232)).toEqual({ r: 8, g: 8, b: 8 });
    expect(color256(255)).toEqual({ r: 238, g: 238, b: 238 });
  });
});

/** A closed polyline in font units (y up). */
export type Contour = [number, number][];

export interface PathCommand {
  command: string;
  args: number[];
}

/**
 * Flatten fontkit path commands to closed polylines (font units, y up). Curves are split into
 * enough segments to stay within `tol` (font units) of the true curve.
 */
export function flattenCommands(commands: PathCommand[], tol: number): Contour[] {
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let last: [number, number] = [0, 0];
  const close = () => {
    if (cur) {
      const a = cur[0]!;
      const b = cur[cur.length - 1]!;
      if (cur.length > 1 && a[0] === b[0] && a[1] === b[1]) cur.pop();
      if (cur.length >= 3) contours.push(cur);
    }
    cur = null;
  };
  for (const { command, args } of commands) {
    const a = args as number[];
    if (command === 'moveTo') {
      close();
      last = [a[0]!, a[1]!];
      cur = [last];
    } else if (command === 'lineTo') {
      cur ??= [last];
      last = [a[0]!, a[1]!];
      cur.push(last);
    } else if (command === 'quadraticCurveTo') {
      cur ??= [last];
      const [x0, y0] = last;
      const [x1, y1, x2, y2] = a as [number, number, number, number];
      const m = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
      const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.25 * m) / tol))));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const p = (1 - t) ** 2;
        const q = 2 * (1 - t) * t;
        const r = t * t;
        cur.push([p * x0 + q * x1 + r * x2, p * y0 + q * y1 + r * y2]);
      }
      last = [x2, y2];
    } else if (command === 'bezierCurveTo') {
      cur ??= [last];
      const [x0, y0] = last;
      const [x1, y1, x2, y2, x3, y3] = a as [number, number, number, number, number, number];
      const m = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
      const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.75 * m) / tol))));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const p = (1 - t) ** 3;
        const q = 3 * (1 - t) ** 2 * t;
        const r = 3 * (1 - t) * t * t;
        const s = t ** 3;
        cur.push([p * x0 + q * x1 + r * x2 + s * x3, p * y0 + q * y1 + r * y2 + s * y3]);
      }
      last = [x3, y3];
    } else if (command === 'closePath') {
      close();
    }
  }
  close();
  return contours;
}

/** Flatten fontkit path commands to closed polylines (font units, y-up). */
export function flattenCommands(commands, tol) {
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

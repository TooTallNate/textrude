/** Terminal output. Everything goes to stderr (stdout may carry the SVG / 3MF data). */
import { chalkStderr as chalk } from 'chalk';
import type { LogEvent } from './render.js';

let quiet = false;
export const setQuiet = (q: boolean) => {
  quiet = q;
};

const out = (...lines: string[]) => {
  if (!quiet) console.error(...lines);
};

export const ui = {
  chalk,
  /** The banner, showing the (first) text, and how many more texts there are. */
  header(text: string, moreTexts = 0) {
    const lines = text.split('\n');
    let first = lines[0]!;
    if (first.length > 60) first = `${first.slice(0, 59)}…`;
    const more = moreTexts
      ? chalk.dim(` (+${moreTexts} more text${moreTexts > 1 ? 's' : ''})`)
      : lines.length > 1
        ? chalk.dim(` (+${lines.length - 1} more line${lines.length > 2 ? 's' : ''})`)
        : '';
    out(`\n${chalk.bold.bgHex('#e8590c').hex('#ffffff')(' textrude ')} ${chalk.bold(JSON.stringify(first))}${more}\n`);
  },
  /** A "label  value" detail line. */
  detail(label: string, value: string) {
    out(`  ${chalk.dim(label.padEnd(9))}${value}`);
  },
  success(msg: string) {
    out(`  ${chalk.green('✔')} ${msg}`);
  },
  info(msg: string) {
    out(`  ${chalk.cyan('•')} ${msg}`);
  },
  warn(msg: string) {
    out(`  ${chalk.yellow('⚠')} ${chalk.yellow(msg)}`);
  },
  error(msg: string) {
    console.error(`${chalk.red.bold('✖ error:')} ${msg}`);
  },
  blank() {
    out('');
  },
  raw(text: string) {
    out(text);
  },
  swatch(hex: string) {
    return chalk.hex(hex)('██');
  },
  log({ level, message, label }: LogEvent) {
    if (level === 'detail') ui.detail(label ?? '', message.replace(/ \((color|installed[^)]*)\)/g, (m) => chalk.dim(m)));
    else if (level === 'warn') ui.warn(message);
    else if (level === 'success') ui.success(message);
    else if (level === 'note') ui.info(chalk.dim(message));
    else ui.info(message);
  },
};

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

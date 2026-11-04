// Terminal output. Everything goes to stderr (stdout may carry the SVG / 3MF data).
import { chalkStderr as chalk } from 'chalk';

let quiet = false;
export const setQuiet = (q) => {
  quiet = q;
};

const out = (...lines) => {
  if (!quiet) console.error(...lines);
};

export const ui = {
  chalk,
  header(text) {
    const lines = text.split('\n');
    let first = lines[0];
    if (first.length > 60) first = `${first.slice(0, 59)}…`;
    const more = lines.length > 1 ? chalk.dim(` (+${lines.length - 1} more line${lines.length > 2 ? 's' : ''})`) : '';
    out(`\n${chalk.bold.bgHex('#e8590c').hex('#ffffff')(' textrude ')} ${chalk.bold(JSON.stringify(first))}${more}\n`);
  },
  /** A "label  value" detail line. */
  detail(label, value) {
    out(`  ${chalk.dim(label.padEnd(9))}${value}`);
  },
  success(msg) {
    out(`  ${chalk.green('✔')} ${msg}`);
  },
  info(msg) {
    out(`  ${chalk.cyan('•')} ${msg}`);
  },
  warn(msg) {
    out(`  ${chalk.yellow('⚠')} ${chalk.yellow(msg)}`);
  },
  error(msg) {
    console.error(`${chalk.red.bold('✖ error:')} ${msg}`);
  },
  blank() {
    out('');
  },
  raw(text) {
    out(text);
  },
  swatch(hex) {
    return chalk.hex(hex)('██');
  },
  /** Logger for library code: styles messages by their "warning:" / "note:" prefix. */
  log(msg) {
    if (/^warning: /.test(msg)) ui.warn(msg.slice(9));
    else if (/^note: /.test(msg)) ui.info(chalk.dim(msg.slice(6)));
    else ui.info(msg);
  },
};

export function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

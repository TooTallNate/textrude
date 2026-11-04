import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { INTER, TWEMOJI, checkMeshes, unzip3mf } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'textrude-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
});

/** Run the CLI quietly; returns the exit code and anything written to stdout. */
async function cli(args: string[], stdin?: string) {
  let stdout = '';
  const code = await run([...args, '--no-preview'], {
    stdin: stdin === undefined ? undefined : Readable.from([stdin]),
    stdout: (d) => (stdout += typeof d === 'string' ? d : Buffer.from(d).toString()),
    env: {},
  });
  return { code, stdout };
}

describe('cli', () => {
  it('writes an SVG to stdout', async () => {
    const { code, stdout } = await cli(['Hi', '-f', INTER, '-q']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^<\?xml[\s\S]*<path /);
  });

  it('writes a 3MF when the output ends in .3mf', async () => {
    const out = path.join(tmp, 'hi.3mf');
    const { code } = await cli(['Hi 😀', '-f', INTER, '--fallback-font', TWEMOJI, '-w', '1', '--connect', '--printer', 'snapmaker-u1', '-q', '-o', out]);
    expect(code).toBe(0);
    const data = fs.readFileSync(out);
    expect(unzip3mf(data)['Metadata/project_settings.config']).toBeDefined();
    expect(checkMeshes(data).every((m) => m.badEdges === 0)).toBe(true);
  });

  it('reads text from stdin, with newlines and ANSI colors', async () => {
    const { code, stdout } = await cli(['-f', INTER, '-q'], '\x1b[31mRed\n\x1b[34mBlue\n');
    expect(code).toBe(0);
    expect(stdout).toMatch(/fill="#cd0000"/);
    expect(stdout).toMatch(/fill="#0000ee"/);
  });

  it('reads stdin for "-"', async () => {
    const { code, stdout } = await cli(['-', '-f', INTER, '-q'], 'Hi');
    expect(code).toBe(0);
    expect(stdout).toMatch(/<path /);
  });

  it('reads options (camelCase or kebab-case) from a config file, with flags overriding', async () => {
    const config = path.join(tmp, 'sign.json');
    fs.writeFileSync(config, JSON.stringify({ text: 'Cfg', font: INTER, strokeWidth: 1, 'stroke-color': 'red', letterColors: ['gold', 'blue'] }));
    const { code, stdout } = await cli(['--config', config, '--stroke-color', 'lime', '-q']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/fill="#00ff00"/);
    expect(stdout).toMatch(/fill="#ffd700"/);
    expect(stdout).not.toMatch(/fill="#ff0000"/);
  });

  it('saves a preview PNG', async () => {
    const png = path.join(tmp, 'preview.png');
    expect((await cli(['Hi', '-f', INTER, '-q', '--preview-png', png])).code).toBe(0);
    expect(fs.readFileSync(png).subarray(1, 4).toString()).toBe('PNG');
  });

  it('prints the version', async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect((await cli(['--version'])).stdout.trim()).toBe(pkg.version);
  });

  it.each([
    [['Hi', '-f', INTER, '--size', 'big'], /--size must be a number/],
    [['Hi', '-f', INTER, '--align', 'middle'], /--align must be one of/],
    [['Hi', '-f', INTER, '-c', 'nope'], /invalid color "nope"/],
    [['Hi', '-f', INTER, '--palette', 'red,nope'], /invalid color/],
    [['Hi', '-f', INTER, '--printer', 'nope', '-o', path.join(tmp, 'x.3mf')], /unknown printer "nope"/],
    [['Hi', '-f', INTER, '--position', '1', '-o', path.join(tmp, 'x.3mf')], /--position must be/],
    [['Hi', '--font', 'Not A Real Font 123'], /font "Not A Real Font 123" not found/],
    [['Hi', '--bogus'], /Unknown option '--bogus'/],
  ])('fails cleanly for %j', async (args, message) => {
    const { code } = await cli(args as string[]);
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(message);
  });

  it('rejects unknown config keys', async () => {
    const config = path.join(tmp, 'bad.json');
    fs.writeFileSync(config, JSON.stringify({ text: 'x', colour: 'red' }));
    expect((await cli(['--config', config])).code).toBe(1);
    expect(errors.join('\n')).toMatch(/unknown option "colour"/);
  });
});

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

  it('makes one object per --text, with per-text options after each', async () => {
    const out = path.join(tmp, 'names.3mf');
    const { code } = await cli(['-f', INTER, '-w', '1', '-t', 'Alice', '-c', 'red', '-t', 'Bob', '-t', 'Carol', '-c', 'blue', '-o', out, '--printer', 'snapmaker-u1', '-q']);
    expect(code).toBe(0);
    const files = unzip3mf(fs.readFileSync(out));
    const model = files['3D/3dmodel.model']!;
    expect([...model.matchAll(/name="([^"]*)" type="model"><components>/g)].map((m) => m[1])).toEqual(['Alice', 'Bob', 'Carol']);
    expect(model.match(/<item /g)).toHaveLength(3);
    // Shared stroke color, per-text fill colors, one filament per color.
    expect(JSON.parse(files['Metadata/project_settings.config']!).filament_colour).toEqual(['#FF0000', '#FFFFFF', '#000000', '#0000FF']);
  });

  it('reads a "texts" array from a config file', async () => {
    const config = path.join(tmp, 'names.json');
    fs.writeFileSync(config, JSON.stringify({ font: INTER, color: 'red', texts: ['One', { text: 'Two', color: 'blue' }] }));
    const { code, stdout } = await cli(['--config', config, '-q']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/<path id="t1-text-ff0000" fill="#ff0000"/);
    expect(stdout).toMatch(/<path id="t2-text-0000ff" fill="#0000ff"/);
  });

  it('replaces the config\'s texts with --text, keeping its options', async () => {
    const config = path.join(tmp, 'names2.json');
    fs.writeFileSync(config, JSON.stringify({ font: INTER, color: 'red', texts: ['One', 'Two'] }));
    const { code, stdout } = await cli(['--config', config, '-t', 'A', '-t', 'B', '-t', 'C', '-q']);
    expect(code).toBe(0);
    expect(stdout.match(/<path /g)).toHaveLength(3);
    expect(stdout).toMatch(/fill="#ff0000"/);
  });

  it('reads stdin for --text -', async () => {
    const { code, stdout } = await cli(['-f', INTER, '-t', 'A', '-t', '-', '-c', 'blue', '-q'], 'B');
    expect(code).toBe(0);
    expect(stdout).toMatch(/<path id="t2-text-0000ff"/);
  });

  it('rejects shared-only options inside a config\'s texts', async () => {
    const config = path.join(tmp, 'bad-texts.json');
    fs.writeFileSync(config, JSON.stringify({ font: INTER, texts: [{ text: 'x', palette: 'red' }] }));
    expect((await cli(['--config', config])).code).toBe(1);
    expect(errors.join('\n')).toMatch(/"palette" applies to every text/);
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
    [['Hi', '-f', INTER, '-t', 'There'], /give every text its own --text/],
    [['-f', INTER, '-t', 'Hello', 'World'], /unexpected argument "World" after --text "Hello"/],
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

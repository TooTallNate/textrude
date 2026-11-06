/**
 * File system access for installed fonts and font files. Node's modules are loaded with
 * `process.getBuiltinModule()` rather than imported, so the library also runs in browsers (and
 * bundles without any configuration), where there are no installed fonts or font files and
 * fonts are passed as URLs or bytes.
 */
type NodeModules = {
  fs: typeof import('node:fs');
  os: typeof import('node:os');
  path: typeof import('node:path');
};

const node: NodeModules | null =
  typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
    ? { fs: process.getBuiltinModule('node:fs'), os: process.getBuiltinModule('node:os'), path: process.getBuiltinModule('node:path') }
    : null;

export const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?|dfont)$/i;

/** Directories searched for installed fonts: ./fonts first, then the system's font folders. */
export function fontDirs(): string[] {
  if (!node) return [];
  const { os, path } = node;
  return [
    path.resolve('fonts'),
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library/Fonts'),
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local/share/fonts'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Windows/Fonts'),
  ].filter((d): d is string => Boolean(d));
}

/** Every font file under `dir`, recursively. */
export function* fontFiles(dir: string, recursive = true): Generator<string> {
  if (!node) return;
  const { fs, path } = node;
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) yield* fontFiles(p);
    } else if (FONT_EXT.test(e.name)) yield p;
  }
}

/** The file at `spec` (with `~` expanded) if it exists, else null. */
export function findFile(spec: string): string | null {
  if (!node) return null;
  const p = spec.replace(/^~(?=$|\/)/, node.os.homedir());
  try {
    return node.fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

export function readFile(file: string): Uint8Array {
  if (!node) throw new Error('reading files is not supported here');
  return node.fs.readFileSync(file);
}

export const dirname = (file: string): string => (node ? node.path.dirname(file) : file.replace(/[\\/][^\\/]*$/, ''));

/** A file's name without directory or extension. */
export const basename = (file: string): string => (node ? node.path.parse(file).name : file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''));

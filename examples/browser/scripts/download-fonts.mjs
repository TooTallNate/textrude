#!/usr/bin/env node
/**
 * Download the fonts listed in fonts.json into public/fonts, so the app serves them itself.
 * Fonts that are already there are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'fonts');
const { fonts, emoji } = JSON.parse(fs.readFileSync(path.join(root, 'fonts.json'), 'utf8'));

const all = [...fonts.flatMap((f) => [f, f.italic, ...(f.styles ?? [])].filter(Boolean)), ...emoji];
const files = [...new Map(all.map((f) => [f.file, f])).values()];
fs.mkdirSync(outDir, { recursive: true });

const missing = files.filter((f) => !fs.existsSync(path.join(outDir, f.file)));
let failed = 0;
await Promise.all(
  missing.map(async ({ file, url }) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const tmp = path.join(outDir, `${file}.download`);
      fs.writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()));
      fs.renameSync(tmp, path.join(outDir, file));
      console.error(`downloaded ${file}`);
    } catch (err) {
      failed++;
      console.error(`could not download ${file} from ${url}: ${err.message}`);
    }
  }),
);
if (failed) process.exit(1);

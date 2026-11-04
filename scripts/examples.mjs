#!/usr/bin/env node
/**
 * Render the README examples to examples/*.svg and rewrite the README's examples section
 * (between the `<!-- examples:start -->` / `<!-- examples:end -->` markers).
 *
 *   npm run examples
 *
 * The emoji fonts are downloaded into ./fonts when missing. The other fonts are macOS system
 * fonts (and one is loaded from a URL), so the images are generated on macOS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'examples');

const FONTS = {
  'fonts/twemoji.ttf': 'https://github.com/mozilla/twemoji-colr/releases/download/v0.7.0/Twemoji.Mozilla.ttf',
  'fonts/openmoji.ttf': 'https://github.com/hfg-gmuend/openmoji/raw/15.1.0/font/OpenMoji-color-glyf_colr_0/OpenMoji-color-glyf_colr_0.ttf',
};

// Backdrop for the README copies only, so black and white parts both show up on GitHub's
// light and dark themes.
const BACKDROP = '#9ca3af';

const EXAMPLES = [
  {
    name: 'sign',
    hero: true, // shown at the top of the README, not in the examples list
    title: 'Text and color emoji, outlined, as one piece, printed face-down',
    args: ['I ❤️ 3D printing 🎉', '-f', 'Helvetica', '--fallback-font', './fonts/twemoji.ttf', '-w', '1.5', '--connect', '--flip', '--printer', 'snapmaker-u1', '-o', 'sign.3mf'],
  },
  {
    name: 'hello',
    title: 'Black text on a 2mm white outline, connected into one piece',
    args: ['Hello', '-f', 'Arial Black', '-s', '20', '-w', '2', '--connect', '--flip', '-o', 'hello.3mf'],
  },
  {
    name: 'emoji',
    title: 'Skin tones, flags, and an outline around everything',
    args: ['Hi 😀👍🏽🇺🇸', '-f', 'Helvetica', '--fallback-font', './fonts/twemoji.ttf', '-w', '1.5', '--connect', '-o', 'hi.3mf'],
  },
  {
    name: 'palette',
    title: 'Map every color onto the filaments loaded in slots 1-6',
    args: ['🦄🌈', '-f', './fonts/openmoji.ttf', '-s', '40', '--palette', 'white,black,pink,purple,gold,skyblue', '-o', 'unicorn.3mf'],
  },
  {
    name: 'max-colors',
    title: 'Merge similar colors to fit a 4-toolhead printer',
    args: ['Party 🎉🎂', '-f', 'Arial Black', '--fallback-font', './fonts/twemoji.ttf', '--max-colors', '4', '-w', '1.5', '--connect', '-o', 'party.3mf'],
  },
  {
    name: 'pill',
    title: 'White text on a pill-shaped navy plate',
    args: ['Hello 😀', '-f', 'Arial Black', '--fallback-font', './fonts/twemoji.ttf', '-c', 'white', '--background', 'navy', '--background-radius', '999', '-o', 'pill.3mf'],
  },
  {
    name: 'outlined',
    title: 'A separately colored outline on the plate',
    args: ['Stroke', '-f', 'Arial Black', '-c', 'white', '-w', '2', '--stroke-color', 'gold', '--background', 'navy', '--background-radius', '999', '-o', 'outlined.3mf'],
  },
  {
    name: 'raised',
    title: 'Raised text (3mm) on a 2mm plate with rounded corners',
    args: ['Raised', '-f', 'Arial Black', '--background', 'gold', '--background-radius', '3', '--height', '2', '--text-height', '3', '-o', 'raised.3mf'],
  },
  {
    name: 'rainbow',
    title: 'A different color per letter',
    args: ['Rainbow', '-f', 'Arial Black', '--letter-colors', 'red,orange,gold,green,blue,purple', '-w', '1.5', '--connect', '-o', 'rainbow.3mf'],
  },
  {
    name: 'multiline',
    title: 'Multiple lines, centered',
    args: ['Hello\nWorld', '-f', 'Helvetica', '-b', '-w', '2', '--connect', '--align', 'center', '-o', 'hello-world.3mf'],
  },
  {
    name: 'code',
    title: 'Syntax-highlighted code: ANSI colors on stdin become filament colors',
    pipe: 'FORCE_COLOR=1 npx cli-highlight examples/hello.c',
    args: ['-f', 'Menlo', '-s', '8', '-c', '#d4d4d4', '--background', '#1e1e1e', '--background-radius', '3', '--background-padding', '4', '-o', 'hello-c.3mf'],
  },
  {
    name: 'ansi',
    title: 'Any ANSI-colored text works, including 256-color and truecolor codes',
    pipe: "printf '\\033[91mRed \\033[92mGreen \\033[94mBlue \\033[38;2;255;140;0mOrange'",
    args: ['-f', 'Arial Black', '-w', '1.5', '--connect', '-o', 'ansi.3mf'],
  },
  {
    name: 'styles',
    title: 'Bold, italic, and underlined',
    args: ['Hello', '-f', 'Helvetica', '-b', '-i', '-u', '-w', '1.5', '--connect', '-o', 'hello.3mf'],
  },
  {
    name: 'hollow',
    title: 'Outline only (hollow letters), one piece',
    args: ['Wavy', '-f', 'Snell Roundhand', '-s', '25', '-c', 'none', '-w', '1', '--stroke-color', 'black', '--connect', '-o', 'wavy.3mf'],
  },
  {
    name: 'url-font',
    title: 'A font loaded straight from a URL',
    args: ['Hello', '-f', 'https://github.com/google/fonts/raw/main/ofl/pacifico/Pacifico-Regular.ttf', '-w', '1.5', '--connect', '-o', 'hello.3mf'],
  },
];

/** Shell-quote an argument (newlines as $'...\n...', otherwise double quotes). */
function quote(arg) {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (arg.includes('\n')) return `$'${arg.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n')}'`;
  return `"${arg.replace(/(["$`\\])/g, '\\$1')}"`;
}

// Download any missing emoji fonts.
for (const [file, url] of Object.entries(FONTS)) {
  const dest = path.join(root, file);
  if (fs.existsSync(dest)) continue;
  console.error(`downloading ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url}: ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

fs.mkdirSync(outDir, { recursive: true });
const sections = [];
for (const ex of EXAMPLES) {
  // Render an SVG instead of the 3MF; --flip would mirror it, so leave that out.
  const args = [];
  for (let i = 0; i < ex.args.length; i++) {
    if (ex.args[i] === '-o') i++;
    else if (ex.args[i] !== '--flip') args.push(ex.args[i]);
  }
  const svgPath = path.join(outDir, `${ex.name}.svg`);
  console.error(`rendering examples/${ex.name}.svg`);
  const cliArgs = [...args, '--margin', '3', '--no-preview', '-q', '-o', svgPath];
  if (ex.pipe) {
    // Text from a shell pipeline on stdin.
    execSync(`${ex.pipe} | ${[process.execPath, path.join(root, 'dist', 'bin.js'), ...cliArgs].map(quote).join(' ')}`, {
      cwd: root,
      shell: '/bin/sh',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } else {
    execFileSync(process.execPath, [path.join(root, 'dist', 'bin.js'), ...cliArgs], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  const svg = fs.readFileSync(svgPath, 'utf8').replace(/(<svg [^>]*>)/, `$1\n  <rect width="100%" height="100%" rx="2" fill="${BACKDROP}"/>`);
  fs.writeFileSync(svgPath, svg);

  if (ex.hero) continue;
  const command = (ex.pipe ? `${ex.pipe} | ` : '') + ['textrude', ...ex.args.map(quote)].join(' ');
  sections.push(`### ${ex.title}\n\n\`\`\`sh\n${command}\n\`\`\`\n\n![${ex.title}](examples/${ex.name}.svg)\n`);
}

const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const start = '<!-- examples:start -->';
const end = '<!-- examples:end -->';
if (!readme.includes(start) || !readme.includes(end)) throw new Error('README.md is missing the examples markers');
const generated = `${start}\n<!-- Generated by \`npm run examples\` (scripts/examples.mjs); edit the examples there. -->\n\n${sections.join('\n')}\n${end}`;
// (A replacement function, since `$'` in a replacement string has a special meaning.)
fs.writeFileSync(readmePath, readme.replace(new RegExp(`${start}[\\s\\S]*${end}`), () => generated));
console.error(`updated README.md with ${EXAMPLES.length} examples`);

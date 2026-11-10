# textrude in the browser

A single-page web app for designing textrude prints, with a live 3D preview (three.js) of the exact meshes that go into the 3MF. Everything runs client-side: textrude renders in a Web Worker, and downloads (3MF, SVG, PNG) are generated in the browser.

- **Fonts**: a set of bundled Google Fonts, any font file you upload or drop on the page (including BMFont bitmap fonts: a `.zip`, or the `.fnt` together with its page images), or your installed fonts (Chromium browsers, through the [Local Font Access API](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API)).
- **Emoji**: Twemoji or OpenMoji, loaded only when the text has non-ASCII characters.
- **Multiple texts**: each one is a separate object on the plate, with its own style (a new text starts with the selected one's), laid out in rows that fit the printer's bed.
- **Config files**: save the design as the same JSON the CLI reads (`textrude --config design.json`), and load one back. Bundled fonts are saved as URLs, so a saved config works with the CLI anywhere. To load a config that uses font files, drop them on the page together with the config.
- **Shareable designs**: the config is also kept in the URL hash, so designs survive reloads and can be shared (fonts that aren't bundled or from a URL have to be added again).

## Development

From the repository root:

```sh
pnpm install
pnpm -F textrude-browser-demo dev
```

The app imports the library's TypeScript source directly (see the aliases in `vite.config.ts`), so library changes show up without a build step.

`dev` and `build` first run `scripts/download-fonts.mjs`, which downloads the fonts listed in `fonts.json` into `public/fonts` (skipping ones already there).

```sh
pnpm -F textrude-browser-demo build       # static site in examples/browser/dist
pnpm -F textrude-browser-demo typecheck
```

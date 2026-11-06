# textrude in the browser

A single-page web app for designing textrude prints, with a live 3D preview (three.js) of the exact meshes that go into the 3MF. Everything runs client-side: textrude renders in a Web Worker, and downloads (3MF, SVG, PNG) are generated in the browser.

- **Fonts**: a set of bundled Google Fonts, any font file you upload or drop on the page, or your installed fonts (Chromium browsers, through the [Local Font Access API](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API)).
- **Emoji**: Twemoji or OpenMoji, loaded only when the text has non-ASCII characters.
- **Shareable designs**: the settings are kept in the URL hash (bundled fonts only).

## Development

From the repository root:

```sh
npm install
npm run dev -w examples/browser
```

The app imports the library's TypeScript source directly (see the aliases in `vite.config.ts`), so library changes show up without a build step.

`npm run dev` and `npm run build` first run `scripts/download-fonts.mjs`, which downloads the fonts listed in `fonts.json` into `public/fonts` (skipping ones already there).

```sh
npm run build -w examples/browser   # static site in examples/browser/dist
npm run typecheck -w examples/browser
```

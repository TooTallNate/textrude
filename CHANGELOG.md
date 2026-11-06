# textrude

## 0.3.0

### Minor Changes

- 50a0423: Run in browsers: fonts can be passed as bytes (`font` / `fallbackFonts` accept a `Uint8Array` or `ArrayBuffer`), Node's file system is only used when it's available, and PNGs are encoded and decoded without `pngjs`. Adds `toMeshes()` to results and plates, returning each part's triangle mesh (the same geometry as the 3MF) for 3D previews. There's also a web app in `examples/browser` with a live three.js preview.

## 0.2.0

### Minor Changes

- aa66ad0: Add multiple texts per plate: each `-t/--text` (or entry in a config file's `texts` array) becomes a separate 3MF object, spaced `--gap` mm apart in rows that fit the printer's bed, with filament slots shared by color. Also adds `arrange()` to the JavaScript API.

## 0.1.0

### Minor Changes

- 84407eb: Initial release: turn text and color emoji into multi-color 3MF models and SVGs for 3D printing.

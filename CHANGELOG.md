# textrude

## 0.3.0

### Minor Changes

- 54b1c15: Bitmap fonts in AngelCode BMFont format: pass a `.fnt` file or URL (its page images are read from beside it) or a `.zip` of the `.fnt` and its pages, as `--font`, `font` or `fallbackFonts`. The glyphs are traced into outlines with `@tootallnate/bitmap-font`. The browser demo accepts a `.zip`, or a `.fnt` picked or dropped together with its pages.
- 50a0423: Run in browsers: fonts can be passed as bytes (`font` / `fallbackFonts` accept a `Uint8Array` or `ArrayBuffer`), Node's file system is only used when it's available, and PNGs are encoded and decoded without `pngjs`. Adds `toMeshes()` to results and plates, returning each part's triangle mesh (the same geometry as the 3MF) for 3D previews. There's also a web app in `examples/browser` with a live three.js preview.
- b41ed07: `--raised` (`raised: true`) puts the text and outline on top of a solid background plate instead of inset into it, so the back of the print shows only the plate. `--flush face|back` (`flush` in `to3MF()` / `toMeshes()`) picks which side stays flat when parts have different heights, so with `--flip --flush back` a shorter background sits behind the text instead of on the build plate. It defaults to the side on the build plate, as before. `--flip` now turns the model over rather than only mirroring it, so raised designs print face-down with the text on the bed. Parts have a new `z` field: where their bottom sits.

## 0.2.0

### Minor Changes

- aa66ad0: Add multiple texts per plate: each `-t/--text` (or entry in a config file's `texts` array) becomes a separate 3MF object, spaced `--gap` mm apart in rows that fit the printer's bed, with filament slots shared by color. Also adds `arrange()` to the JavaScript API.

## 0.1.0

### Minor Changes

- 84407eb: Initial release: turn text and color emoji into multi-color 3MF models and SVGs for 3D printing.

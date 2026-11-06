# textrude

## 0.2.0

### Minor Changes

- aa66ad0: Add multiple texts per plate: each `-t/--text` (or entry in a config file's `texts` array) becomes a separate 3MF object, spaced `--gap` mm apart in rows that fit the printer's bed, with filament slots shared by color. Also adds `arrange()` to the JavaScript API.

## 0.1.0

### Minor Changes

- 84407eb: Initial release: turn text and color emoji into multi-color 3MF models and SVGs for 3D printing.

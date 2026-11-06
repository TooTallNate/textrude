---
"textrude": minor
---

Add multiple texts per plate: each `-t/--text` (or entry in a config file's `texts` array) becomes a separate 3MF object, spaced `--gap` mm apart in rows that fit the printer's bed, with filament slots shared by color. Also adds `arrange()` to the JavaScript API.

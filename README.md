# text2svg

Turns text into a multi-color model for 3D printing. It can output:

- **3MF** (recommended for multi-color): each color is a separate 3D part, already assigned to its own filament. Opens directly in OrcaSlicer, Snapmaker Orca, and Bambu Studio.
- **SVG**: only filled paths, one `<path>` per color. Note that Orca-based slicers import an SVG as a single part in one color.

Features:

- The stroke is built as real geometry (by offsetting the polygon outline), so the color regions never overlap.
- `--connect` joins islands that aren't connected (separate letters, the dots on i/j, the inside of ®, ...) with bars so the print comes out as one piece.
- `--flip` mirrors the design so it prints face-down. The text side is then the surface that touches the build plate, which gives the smoothest finish.
- Kerning and ligatures come from fontkit. Variable fonts work via `--variation`.

## Setup

```sh
npm install
```

## Usage

```sh
# Multi-color 3MF: black text on a 2mm white outline, one piece, printed face-down
./text2svg.mjs "Hello" -f "Arial Black" -s 20 -w 2 --connect --flip -o hello.3mf

# Raised text (3mm) on a 2mm outline
./text2svg.mjs "Hello\nWorld" -f Helvetica -w 2 --connect --align center \
  --height 2 --text-height 3 -o sign.3mf

# Bridges in a third color/filament
./text2svg.mjs "Name" -f "Arial Black" -w 1.5 --connect --bridge-color red -o tag.3mf

# Bold italic, underlined
./text2svg.mjs "Hello" -f Helvetica -b -i -u -w 1.5 --connect -o hello.3mf

# Synthetic styles with custom amounts (works with any font)
./text2svg.mjs "Hello" -f "Snell Roundhand" --embolden 0.5 --slant 8 -o hello.3mf

# SVG output
./text2svg.mjs "Hello" -f Helvetica -s 30 -w 1.5 --connect -o hello.svg
```

Run `./text2svg.mjs --help` for all options, and `--list-fonts` for installed font names.

## Notes

- Sizes are in mm. `--size` is the font's em size.
- For `--bold` and `--italic`, the script tries these in order:
  1. the family's real Bold/Italic face (searching installed fonts and the font file's own folder)
  2. the variable font's `wght`, `ital`, or `slnt` axis
  3. a synthetic style: outlines thickened by 2% of the size, or a 12° slant

  It prints which one it used. `--synthetic` forces the synthetic version, and `--embolden` and `--slant` set the amounts directly.
- `--underline` and `--strikethrough` use the font's own position and thickness metrics. You can override them with `--underline-offset` and `--decoration-thickness`. These lines are part of the text color, and they join the letters in each line into one piece.
- Filaments are numbered 1, 2, 3, ... in order of distinct color (text, then stroke, then bridges). Override them with `--text-filament`, `--stroke-filament`, and `--bridge-filament`. The slicer uses whatever colors are loaded in those filament slots.
- If the bridges are the same color as the stroke (the default), they are merged into the stroke part.
- With `--flip`, all parts start flat on the bed, so different heights only change the back of the print.
- The object is placed at `--position` (default `100,100`). Press **A** (Arrange) in the slicer to re-center it.

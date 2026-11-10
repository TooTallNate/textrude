---
"textrude": minor
---

`--raised` (`raised: true`) puts the text and outline on top of a solid background plate instead of inset into it, so the back of the print shows only the plate. `--flush face|back` (`flush` in `to3MF()` / `toMeshes()`) picks which side stays flat when parts have different heights, so with `--flip --flush back` a shorter background sits behind the text instead of on the build plate. It defaults to the side on the build plate, as before. `--flip` now turns the model over rather than only mirroring it, so raised designs print face-down with the text on the bed. Parts have a new `z` field: where their bottom sits.

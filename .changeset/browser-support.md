---
"textrude": minor
---

Run in browsers: fonts can be passed as bytes (`font` / `fallbackFonts` accept a `Uint8Array` or `ArrayBuffer`), Node's file system is only used when it's available, and PNGs are encoded and decoded without `pngjs`. Adds `toMeshes()` to results and plates, returning each part's triangle mesh (the same geometry as the 3MF) for 3D previews. There's also a web app in `examples/browser` with a live three.js preview.

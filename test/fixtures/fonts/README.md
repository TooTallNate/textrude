# Test fonts

Small subsets of openly licensed fonts, so the tests run anywhere (no system fonts needed).
They were made with [fontTools](https://github.com/fonttools/fonttools):
`fonttools varLib.instancer` for the static Inter instances, and `pyftsubset` for the subsets.

| File | Source | License | Contents |
| --- | --- | --- | --- |
| `inter-static/Inter-{Regular,Bold,Italic}.ttf` | [Inter](https://github.com/rsms/inter) 4 (via Google Fonts), static instances at opsz 14 | SIL OFL 1.1 ([Inter-OFL.txt](Inter-OFL.txt)) | Printable ASCII |
| `Inter-Variable.ttf` | Inter 4 variable (`opsz`, `wght` 100–900) | SIL OFL 1.1 ([Inter-OFL.txt](Inter-OFL.txt)) | Printable ASCII |
| `twemoji-subset.ttf` | [Twemoji Mozilla](https://github.com/mozilla/twemoji-colr) 0.7.0 (COLR v0) | Graphics [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), © Twitter, Inc and other contributors | 😀 🔥 👍 👍🏽 🇺🇸 ❤️ 🎉 👨‍👩‍👧 |
| `blobmoji-subset.ttf` | [Blobmoji](https://github.com/C1710/blobmoji) (CBDT bitmaps) | SIL OFL 1.1 (fonts) | 😀 👍 👍🏽 🇺🇸 |

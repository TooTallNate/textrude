---
'textrude': minor
---

Cookie stamps: `textrude stamp <file.svg>` (`cookieStamp()` in the API) turns an SVG into a cookie stamp with a handle and a matching cookie cutter, as a 3MF (each part its own object) or STL files. The SVG's outermost shape is the outline, and a solid background shape behind the artwork only sets the outline. The design is pressed into the cookie (`--style imprinted`, the default) or left standing on it (`--style embossed`), `--depth` mm deep, mirrored so it reads correctly on the cookie. The handle prints with the stamp face-down in one piece (`--handle attached`), or on its own, plugged into a keyed socket in a stamp printed face-up (`--handle separate`, the default for imprinted designs, so a raised design needs no bridging). Every part prints without supports. Lines and gaps thinner than 1 mm get a warning. SVG input supports paths, basic shapes, transforms, `<use>`, styles, both fill rules, and strokes. The web app has a Stamp tab with a 3D preview.

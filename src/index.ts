/**
 * textrude: turn text (including color emoji) into multi-color 3MF models and SVGs for 3D
 * printing.
 *
 * ```ts
 * import { textrude } from 'textrude';
 *
 * const result = await textrude('Hello 😀', { font: 'Arial Black', strokeWidth: 1.5, connect: true });
 * fs.writeFileSync('hello.3mf', result.to3MF({ printer: 'snapmaker-u1' }));
 * ```
 */
export { textrude, plainName } from './render.js';
export type {
  TextrudeOptions, TextrudeResult, Part, Role, UsedFont, LogEvent, LogLevel, ThreeMfExportOptions, MeshOptions, PartMesh, Flush,
} from './render.js';
export { arrange } from './plate.js';
export { cookieStamp, splitOutline } from './stamp.js';
export type {
  CookieStampOptions, CookieStampResult, ResolvedStampOptions, StampPart, StampPartMesh, StampPartName, StampStyle, HandleMode,
  StampMeshOptions, StampThreeMfOptions,
} from './stamp.js';
export { parseSvg } from './svg-input.js';
export type { ParsedSvg, ParseSvgOptions, SvgShape } from './svg-input.js';
export { writeStl, checkManifold } from './mesh.js';
export type { ManifoldReport } from './mesh.js';
export type { Mesh } from './threemf.js';
export type { ArrangeOptions, Plate, PlateObject } from './plate.js';
export { PRINTERS, projectSettings } from './printers.js';
export type { PrinterProfile } from './printers.js';
export { parseAnsi } from './ansi.js';
export type { AnsiText } from './ansi.js';
export { parseColor, toHex } from './colors.js';
export type { RGB } from './colors.js';
export { systemFonts } from './fonts.js';
export type { FontEntry, FontSource } from './fonts.js';
export { TextrudeError } from './errors.js';
export type { SvgOptions } from './svg.js';
export type { PngOptions } from './raster.js';
export type { Shape, Path, Point } from './types.js';
export type { BridgePlacement } from './geometry.js';

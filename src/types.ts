/** Public geometry types (structural, so the published typings have no dependencies). */

/** A point in Clipper integer coordinates (output units × SCALE). */
export interface Point {
  X: number;
  Y: number;
}

/** A closed ring of points. */
export type Path = Point[];

/** A region: outer rings and holes with opposite orientations (nonzero fill rule). */
export type Shape = Path[];

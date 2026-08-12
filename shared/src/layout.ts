/**
 * Layout reconstruction from bounding boxes.
 *
 * The vision model is asked only for *where things are*, never for HTML or a
 * grid description — position is the one thing it can report reliably. The row /
 * column structure of the rendered form is then derived here, deterministically,
 * so that Mode A (HTML form) resembles the printed page without the model having
 * to describe a layout language.
 */
import type { BBox, FormField, FormSection } from './types.js';

export interface LayoutRow {
  /** Fields sharing a printed line, left to right. */
  fields: FormField[];
  /** Fraction of the section's height where the row starts (for stable keys). */
  y: number;
}

/** Vertical mid-point of a box. */
function midY(b: BBox): number {
  return b.y + b.height / 2;
}

/**
 * Two fields share a row when their vertical extents overlap by more than half
 * of the shorter box. That tolerates the ragged baselines of a scan while still
 * separating genuinely stacked fields.
 */
function sameRow(a: BBox, b: BBox): boolean {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = bottom - top;
  if (overlap <= 0) return false;
  const shorter = Math.min(a.height, b.height);
  if (shorter <= 0) return Math.abs(midY(a) - midY(b)) < 0.01;
  return overlap / shorter > 0.5;
}

/** Group a section's fields into printed rows, ordered top-to-bottom. */
export function groupIntoRows(fields: FormField[]): LayoutRow[] {
  const sorted = [...fields].sort((a, b) => midY(a.bbox) - midY(b.bbox) || a.bbox.x - b.bbox.x);
  const rows: FormField[][] = [];

  for (const field of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.some((f) => sameRow(f.bbox, field.bbox))) {
      last.push(field);
    } else {
      rows.push([field]);
    }
  }

  return rows.map((fieldsInRow) => ({
    fields: [...fieldsInRow].sort((a, b) => a.bbox.x - b.bbox.x),
    y: Math.min(...fieldsInRow.map((f) => f.bbox.y)),
  }));
}

/**
 * Flex weights for the fields of one row.
 *
 * Printed line width is a good proxy for how much room a value needs (a long
 * ruled blank means a long answer), so the widths carry over rather than every
 * field getting an equal share. Weights are clamped so one very wide field can
 * not squeeze its neighbours into unusable slivers.
 */
export function rowWeights(row: LayoutRow, min = 0.6, max = 4): number[] {
  const widths = row.fields.map((f) => Math.max(f.bbox.width, 0.001));
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  return widths.map((w) => Math.min(max, Math.max(min, w / mean)));
}

/** Sections ordered as printed: top-to-bottom, then left-to-right. */
export function orderSections(sections: FormSection[]): FormSection[] {
  return [...sections].sort((a, b) => {
    if (!sameRow(a.bbox, b.bbox)) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });
}

/**
 * Split top-level sections into side-by-side column groups.
 *
 * Real forms put blocks next to each other (on the sample page, "Baby details"
 * sits left of "Baby's foot print"). Sections whose vertical extents overlap are
 * emitted as one group and rendered as columns.
 */
export function groupSectionsIntoBands(sections: FormSection[]): FormSection[][] {
  const ordered = orderSections(sections);
  const bands: FormSection[][] = [];
  for (const section of ordered) {
    const last = bands[bands.length - 1];
    if (last && last.some((s) => sameRow(s.bbox, section.bbox))) last.push(section);
    else bands.push([section]);
  }
  return bands.map((band) => [...band].sort((a, b) => a.bbox.x - b.bbox.x));
}

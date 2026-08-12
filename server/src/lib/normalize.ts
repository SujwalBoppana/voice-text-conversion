/**
 * Turn raw model output into a trusted FormSchema.
 *
 * Everything the model returns is treated as a proposal. This module parses it
 * with zod, converts the coordinate convention, forces ids to be unique and
 * slug-shaped, and repairs the type/options combinations that are internally
 * inconsistent (a "select" with no printed options, a "boolean" whose options
 * are not yes/no). A field that survives this is safe to render and to validate
 * values against.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FIELD_TYPES, type BBox, type FieldType, type FormField, type FormSection, type PageSchema } from '@formfill/shared';
import { AppError } from './errors.js';

const box2d = z.array(z.number()).length(4);

const columnSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
});

const fieldSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
  unit: z.string().optional(),
  required: z.boolean().optional(),
  context: z.string().optional(),
  box_2d: box2d.optional(),
  label_box_2d: box2d.optional(),
  related_field_ids: z.array(z.string()).optional(),
  columns: z.array(columnSchema).optional(),
  confidence: z.number().optional(),
});

const sectionSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  box_2d: box2d.optional(),
  fields: z.array(fieldSchema).default([]),
});

export const analysisPayloadSchema = z.object({
  title: z.string().optional(),
  sections: z.array(sectionSchema).default([]),
});

export type AnalysisPayload = z.infer<typeof analysisPayloadSchema>;

const YES_NO = new Set(['yes', 'no', 'y', 'n', 'true', 'false']);

export function slugify(input: string, fallback = 'field'): string {
  const slug = input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** [ymin, xmin, ymax, xmax] on a 0..1000 grid -> normalized top-left BBox. */
export function boxToBBox(box: number[] | undefined, fallback?: BBox): BBox {
  if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return fallback ?? { x: 0, y: 0, width: 0.2, height: 0.02 };
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n / 1000));
  const y1 = clamp(Math.min(box[0]!, box[2]!));
  const x1 = clamp(Math.min(box[1]!, box[3]!));
  const y2 = clamp(Math.max(box[0]!, box[2]!));
  const x2 = clamp(Math.max(box[1]!, box[3]!));
  const width = Math.max(x2 - x1, 0.01);
  const height = Math.max(y2 - y1, 0.008);
  return {
    x: round(x1),
    y: round(y1),
    width: round(Math.min(width, 1 - x1)),
    height: round(Math.min(height, 1 - y1)),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function coerceType(raw: string | undefined, options: string[]): FieldType {
  const candidate = (raw ?? '').toLowerCase().trim() as FieldType;
  const known = (FIELD_TYPES as readonly string[]).includes(candidate) ? candidate : 'text';

  const optionTypes: FieldType[] = ['radio', 'select', 'multiselect', 'checkbox'];

  // Options were promised but none are printed: it is a free-text blank.
  if (optionTypes.includes(known) && options.length === 0) return 'text';

  // A yes/no pair is a boolean regardless of what the model called it.
  if (
    options.length === 2 &&
    options.every((o) => YES_NO.has(o.toLowerCase().replace(/[^a-z]/g, '')))
  ) {
    return 'boolean';
  }

  // A "boolean" with real choices is a radio.
  if (known === 'boolean' && options.length > 0) return 'radio';

  // Options are printed but the model chose a non-option type: honour the page.
  if (!optionTypes.includes(known) && known !== 'boolean' && known !== 'table' && options.length >= 2) {
    return options.length > 6 ? 'select' : 'radio';
  }

  return known;
}

export interface NormalizeArgs {
  payload: AnalysisPayload;
  pageNumber: number;
  dimensions: { width: number; height: number };
}

export function normalizePage(args: NormalizeArgs): { page: PageSchema; title: string } {
  const { payload, pageNumber, dimensions } = args;
  const usedFieldIds = new Set<string>();
  const usedSectionIds = new Set<string>();
  const sections: FormSection[] = [];

  for (const rawSection of payload.sections) {
    const sectionTitle = (rawSection.title ?? '').trim() || 'General';
    const sectionId = unique(
      slugify(rawSection.id?.trim() || sectionTitle, 'section'),
      usedSectionIds,
    );
    const sectionBBox = boxToBBox(rawSection.box_2d, { x: 0, y: 0, width: 1, height: 1 });

    const fields: FormField[] = [];
    for (const rawField of rawSection.fields) {
      const label = (rawField.label ?? '').trim();
      if (!label && !rawField.id) continue; // nothing to render or address

      const options = (rawField.options ?? [])
        .map((o) => o.trim())
        .filter((o) => o.length > 0 && o.length < 80);
      const type = coerceType(rawField.type, options);
      const optionBearing = ['radio', 'select', 'multiselect', 'checkbox'].includes(type);
      const id = unique(slugify(rawField.id?.trim() || label, 'field'), usedFieldIds);

      const field: FormField = {
        id,
        label: label || id.replace(/_/g, ' '),
        type,
        required: rawField.required ?? false,
        sectionId,
        bbox: boxToBBox(rawField.box_2d, sectionBBox),
        detectionConfidence: clamp01(rawField.confidence),
      };
      if (optionBearing && options.length) field.options = dedupe(options);
      const unit = rawField.unit?.trim();
      if (unit) field.unit = unit;
      const context = rawField.context?.trim();
      if (context) field.context = context;
      if (rawField.label_box_2d) field.labelBBox = boxToBBox(rawField.label_box_2d);
      if (rawField.related_field_ids?.length) {
        field.relatedFieldIds = rawField.related_field_ids.map((r) => slugify(r));
      }
      if (type === 'table' && rawField.columns?.length) {
        const usedColumnIds = new Set<string>();
        field.columns = rawField.columns.map((c, i) => {
          const columnLabel = (c.label ?? c.id ?? `Column ${i + 1}`).trim();
          const columnOptions = (c.options ?? []).map((o) => o.trim()).filter(Boolean);
          return {
            id: unique(slugify(c.id?.trim() || columnLabel, `col_${i + 1}`), usedColumnIds),
            label: columnLabel,
            type: coerceType(c.type, columnOptions),
            ...(columnOptions.length ? { options: dedupe(columnOptions) } : {}),
          };
        });
      }

      fields.push(field);
    }

    if (!fields.length) continue; // a section with nothing to fill is decoration
    sections.push({ id: sectionId, title: sectionTitle, bbox: sectionBBox, fields });
  }

  if (!sections.length) {
    throw new AppError(
      'NO_FIELDS_DETECTED',
      'No fillable fields were found on this page. If the page is a scan, try a higher-resolution copy.',
      422,
    );
  }

  // Cross-section reference cleanup: drop related ids that did not survive.
  for (const section of sections) {
    for (const field of section.fields) {
      if (!field.relatedFieldIds) continue;
      field.relatedFieldIds = field.relatedFieldIds.filter(
        (r) => r !== field.id && usedFieldIds.has(r),
      );
      if (!field.relatedFieldIds.length) delete field.relatedFieldIds;
    }
  }

  return {
    page: { pageNumber, dimensions, sections },
    title: (payload.title ?? '').trim() || 'Untitled form',
  };
}

function unique(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}_${n++}`;
  used.add(candidate);
  return candidate;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clamp01(n: number | undefined): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

export function newFormId(): string {
  return `form_${randomUUID().slice(0, 8)}`;
}

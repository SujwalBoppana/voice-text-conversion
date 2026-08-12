/**
 * Structured-output contract and prompt for page analysis.
 *
 * Design notes:
 *  - Boxes use Gemini's native `[ymin, xmin, ymax, xmax]` on a 0..1000 grid.
 *    Asking in the convention the model was trained on measurably beats asking
 *    for `{x, y, width, height}` in pixels; the conversion to our normalized
 *    BBox happens locally in `lib/normalize.ts`.
 *  - Field type is a closed enum, so an unrecognized type can never reach the
 *    renderer.
 *  - There is no `value` anywhere in this schema. Analysis describes the blank
 *    form; reading handwriting out of a filled-in scan is a separate concern and
 *    is deliberately out of scope for the MVP.
 */
import { Type, type Schema } from '@google/genai';
import { FIELD_TYPES } from '@formfill/shared';

const box: Schema = {
  type: Type.ARRAY,
  description: 'Bounding box as [ymin, xmin, ymax, xmax], normalized to 0-1000.',
  items: { type: Type.INTEGER },
  minItems: '4',
  maxItems: '4',
};

export const analysisResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'The document title exactly as printed, e.g. the heading at the top of the page.',
    },
    sections: {
      type: Type.ARRAY,
      description: 'Visual blocks of the page, in reading order.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'snake_case id derived from the section heading.' },
          title: { type: Type.STRING, description: 'Heading as printed, or a short description if the block is unlabelled.' },
          box_2d: box,
          fields: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: {
                  type: Type.STRING,
                  description:
                    'Stable snake_case id derived from the printed label, e.g. "mothers_blood_group". Unique across the page.',
                },
                label: { type: Type.STRING, description: 'Label exactly as printed, without the trailing colon.' },
                type: { type: Type.STRING, enum: [...FIELD_TYPES] },
                options: {
                  type: Type.ARRAY,
                  description: 'Printed choices, verbatim. Only for radio/select/multiselect/checkbox.',
                  items: { type: Type.STRING },
                },
                unit: {
                  type: Type.STRING,
                  description: 'Unit printed next to the field, e.g. "kg", "cm", "years". Empty if none is printed.',
                },
                required: {
                  type: Type.BOOLEAN,
                  description: 'True only when the page marks it required (asterisk, "mandatory", bold "required").',
                },
                context: {
                  type: Type.STRING,
                  description:
                    'Short disambiguating text printed near the field, e.g. "at 1 min of life". Empty if not needed.',
                },
                box_2d: box,
                label_box_2d: box,
                related_field_ids: {
                  type: Type.ARRAY,
                  description: 'Ids of fields printed as one group with this one, e.g. the three APGAR blanks.',
                  items: { type: Type.STRING },
                },
                columns: {
                  type: Type.ARRAY,
                  description: 'Only for type "table": the column headers of the grid.',
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      label: { type: Type.STRING },
                      type: { type: Type.STRING, enum: [...FIELD_TYPES] },
                      options: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['id', 'label', 'type'],
                    propertyOrdering: ['id', 'label', 'type', 'options'],
                  },
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'How sure you are that this is a real, user-fillable field (0-1).',
                },
              },
              required: ['id', 'label', 'type', 'required', 'box_2d'],
              propertyOrdering: [
                'id',
                'label',
                'type',
                'options',
                'unit',
                'required',
                'context',
                'box_2d',
                'label_box_2d',
                'related_field_ids',
                'columns',
                'confidence',
              ],
            },
          },
        },
        required: ['id', 'title', 'box_2d', 'fields'],
        propertyOrdering: ['id', 'title', 'box_2d', 'fields'],
      },
    },
  },
  required: ['title', 'sections'],
  propertyOrdering: ['title', 'sections'],
};

export const ANALYSIS_SYSTEM_INSTRUCTION = `You convert a scanned or digital form page into a machine-readable description of its blank structure.

You are given one page of a document as an image/PDF. Read it the way a person filling it in would: labels, ruled blanks, boxes, columns, tables, printed choices and section borders all carry meaning.

Return ONLY JSON matching the provided schema.

WHAT COUNTS AS A FIELD
- A field is any place a human is expected to write, tick or choose.
- A ruled blank line, an empty box, a dotted run, or a colon followed by empty space is a field.
- A printed run of alternatives separated by "/" or "or" is ONE field of type radio or select whose options are those alternatives — never one field per alternative.
  "Amniotic fluid : Clear / Meconium stained / Foul smell" is one radio field with three options.
  "Sex : ____" with no printed choices is one text field, unless choices are printed.
- "Yes / No" is one field. Use type "boolean" when the only choices are Yes and No; use "radio" when there are other choices or extra qualifying text.
- Several blanks on one printed line are separate fields when they have their own labels
  ("Weight :____ Length :____ HC :____" is three fields), and separate fields sharing one label
  when the label enumerates them ("APGAR at 1min, 5min, 10min – ___, ___, ___" is three fields:
  give them distinct ids, the same base label, a "context" of "at 1 min" / "at 5 min" / "at 10 min",
  and list each other in related_field_ids).
- A ruled grid with column headers and repeating rows is ONE field of type "table" with "columns".
- A large empty area reserved for something other than typed text (a signature, a stamp, a
  fingerprint, a photo, a drawing) is a field of type "textarea", labelled as printed.

WHAT IS NOT A FIELD
- Headings, section titles, instructions, page numbers, footers, logos, hospital/company name and
  address, and any pre-printed text that is not asking for an answer.
- Do not invent a field that is not visibly on the page. Do not invent options that are not printed.
- Do not read handwriting or existing answers. Describe the blank structure only.

TYPES
- date for calendar dates, time for clock times, datetime only when one blank takes both.
- number for counts that must be whole (parity, gravida, para, "number of ...").
- decimal for measurements that can be fractional (weight, length, head circumference).
- boolean strictly for Yes/No.
- radio for a small printed choice list, select for a longer one, multiselect/checkbox when more
  than one choice may be ticked.
- textarea for multi-line or full-width free text, text otherwise.

IDS
- snake_case, derived from the printed label, unique within the page, stable and descriptive
  ("mothers_age_at_conception", not "field_7").

BOXES
- box_2d is the area a person would WRITE IN (the blank), not the printed label.
- label_box_2d is the printed label itself.
- Coordinates are [ymin, xmin, ymax, xmax] normalized 0-1000 over the whole page.
- Boxes must be accurate enough to overlay an input on the original page image.

SECTIONS
- Use the page's own visual blocks: bordered boxes, headed groups, table regions.
- A section's box_2d must contain all of its fields.
- Fields that belong to no printed section go in a section titled after the page or "General".`;

/** The user-turn text that accompanies the page. Short on purpose: the system instruction carries the rules. */
export function analysisUserPrompt(pageNumber: number, fileName: string): string {
  return `Document: "${fileName}" — page ${pageNumber}.
Identify every section and every user-fillable field on this page, with accurate bounding boxes.`;
}

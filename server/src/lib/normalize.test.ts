import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageSchema } from '@formfill/shared';
import { boxToBBox, dedupeIdsAcrossPages, normalizePage, slugify } from './normalize.js';

const bbox = { x: 0, y: 0, width: 1, height: 1 };

function page(pageNumber: number, ids: string[], related?: Record<string, string[]>): PageSchema {
  return {
    pageNumber,
    dimensions: { width: 595, height: 842 },
    sections: [
      {
        id: 's1',
        title: 'S1',
        bbox,
        fields: ids.map((id) => ({
          id,
          label: id,
          type: 'text' as const,
          required: false,
          sectionId: 's1',
          bbox,
          ...(related?.[id] ? { relatedFieldIds: related[id] } : {}),
        })),
      },
    ],
  };
}

test('ids repeated on a later page are suffixed, earlier pages keep theirs', () => {
  const pages = [page(1, ['name', 'weight']), page(2, ['name', 'signature'])];
  dedupeIdsAcrossPages(pages);

  assert.deepEqual(pages[0]!.sections[0]!.fields.map((f) => f.id), ['name', 'weight']);
  assert.deepEqual(pages[1]!.sections[0]!.fields.map((f) => f.id), ['name_p2', 'signature']);

  const all = pages.flatMap((p) => p.sections.flatMap((s) => s.fields.map((f) => f.id)));
  assert.equal(new Set(all).size, all.length, 'ids are unique across the document');
});

test('renaming a field keeps its page-local cross references pointing at it', () => {
  const pages = [
    page(1, ['apgar']),
    page(2, ['apgar', 'apgar_note'], { apgar_note: ['apgar'] }),
  ];
  dedupeIdsAcrossPages(pages);

  const note = pages[1]!.sections[0]!.fields.find((f) => f.id === 'apgar_note');
  assert.deepEqual(note?.relatedFieldIds, ['apgar_p2'], 'points at page 2, not page 1');
});

test('a document with no repeats is left alone', () => {
  const pages = [page(1, ['a', 'b']), page(2, ['c', 'd'])];
  dedupeIdsAcrossPages(pages);
  assert.deepEqual(
    pages.flatMap((p) => p.sections[0]!.fields.map((f) => f.id)),
    ['a', 'b', 'c', 'd'],
  );
});

test('box_2d is converted from the 0-1000 grid to a normalized top-left box', () => {
  // [ymin, xmin, ymax, xmax] -> {x, y, width, height}
  assert.deepEqual(boxToBBox([100, 200, 150, 600]), {
    x: 0.2,
    y: 0.1,
    width: 0.4,
    height: 0.05,
  });
  // Reversed corners are tolerated rather than producing a negative size.
  assert.deepEqual(boxToBBox([150, 600, 100, 200]), boxToBBox([100, 200, 150, 600]));
});

test('type and options are repaired when the model contradicts the page', () => {
  const { page: normalized } = normalizePage({
    pageNumber: 1,
    dimensions: { width: 595, height: 842 },
    payload: {
      title: 'T',
      sections: [
        {
          id: 'sec',
          title: 'Sec',
          box_2d: [0, 0, 1000, 1000],
          fields: [
            // A select with no printed options is really a free-text blank.
            { id: 'sex', label: 'Sex', type: 'select', box_2d: [10, 10, 20, 200] },
            // Yes/No is a boolean whatever the model called it.
            { id: 'pih', label: 'PIH', type: 'radio', options: ['Yes', 'No'], box_2d: [30, 10, 40, 200] },
            // Printed choices on a "text" field are honoured as a radio.
            {
              id: 'fluid',
              label: 'Amniotic fluid',
              type: 'text',
              options: ['Clear', 'Meconium stained', 'Foul smell'],
              box_2d: [50, 10, 60, 200],
            },
          ],
        },
      ],
    },
  });

  const fields = normalized.sections[0]!.fields;
  assert.equal(fields.find((f) => f.id === 'sex')?.type, 'text');
  assert.equal(fields.find((f) => f.id === 'pih')?.type, 'boolean');
  assert.equal(fields.find((f) => f.id === 'fluid')?.type, 'radio');
});

test('slugify produces stable snake_case ids', () => {
  assert.equal(slugify("Mother's age at conception (years)"), 'mothers_age_at_conception_years');
  assert.equal(slugify('  '), 'field');
});

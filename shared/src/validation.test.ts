import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOption, parseDate, parseTime, validateValue } from './validation.js';
import { applyUpdates } from './apply.js';
import { isLikelyRelevant } from './gate.js';
import { groupIntoRows } from './layout.js';
import type { FormField, FormSchema } from './types.js';
import { buildInitialState } from './schema.js';

const bbox = (x: number, y: number, width = 0.2, height = 0.02) => ({ x, y, width, height });

function field(partial: Partial<FormField> & { id: string; type: FormField['type'] }): FormField {
  return {
    label: partial.id,
    required: false,
    sectionId: 's1',
    bbox: bbox(0.1, 0.1),
    ...partial,
  } as FormField;
}

function schemaWith(fields: FormField[]): FormSchema {
  return {
    formId: 'f1',
    title: 'Test',
    documentName: 'test.pdf',
    sourceMimeType: 'application/pdf',
    pageCount: 1,
    analyzedPages: [1],
    createdAt: new Date().toISOString(),
    analysisModel: 'test',
    pages: [
      {
        pageNumber: 1,
        dimensions: { width: 595, height: 842 },
        sections: [{ id: 's1', title: 'S1', bbox: bbox(0, 0, 1, 1), fields }],
      },
    ],
  };
}

test('dates parse unambiguous forms and reject ambiguous numeric ones', () => {
  assert.deepEqual(parseDate('2026-08-12'), { iso: '2026-08-12' });
  assert.deepEqual(parseDate('12 Aug 2026'), { iso: '2026-08-12' });
  assert.deepEqual(parseDate('Aug 12, 2026'), { iso: '2026-08-12' });
  assert.deepEqual(parseDate('25/12/2026'), { iso: '2026-12-25' });
  assert.ok('error' in parseDate('03/04/2025'), 'day/month order is unknowable here');
  assert.ok('error' in parseDate('2026-02-30'));
});

test('times normalize to 24h and reject bare numbers', () => {
  assert.deepEqual(parseTime('10:35 am'), { hhmm: '10:35' });
  assert.deepEqual(parseTime('1035'), { hhmm: '10:35' });
  assert.deepEqual(parseTime('7 pm'), { hhmm: '19:00' });
  assert.ok('error' in parseTime('7'));
});

test('enum values must match the printed options', () => {
  const f = field({ id: 'amniotic_fluid', type: 'radio', options: ['Clear', 'Meconium stained', 'Foul smell'] });
  assert.deepEqual(validateValue(f, 'meconium-stained.'), { ok: true, value: 'Meconium stained' });
  assert.equal(validateValue(f, 'greenish').ok, false);
  assert.equal(matchOption('male', ['Male', 'Female']), 'Male');
});

test('a number without its unit asks for clarification instead of guessing', () => {
  const f = field({ id: 'weight', type: 'decimal', unit: 'kg', label: 'Weight' });
  const bare = validateValue(f, 'two and a half');
  assert.equal(bare.ok, 'clarify');
  const withUnit = validateValue(f, '2.4', 'kg');
  assert.deepEqual(withUnit, { ok: true, value: 2.4, unit: 'kg' });
});

test('an existing value is never silently overwritten', () => {
  const schema = schemaWith([field({ id: 'age', type: 'number', label: 'Age' })]);
  let state = buildInitialState(schema);
  ({ state } = applyUpdates(schema, state, [{ fieldId: 'age', valueText: '31', certainty: 'explicit' }]));
  const second = applyUpdates(schema, state, [{ fieldId: 'age', valueText: '30', certainty: 'explicit' }]);
  assert.equal(second.applied.length, 0);
  assert.equal(second.pending[0]?.conflict, true);
  assert.equal(second.pending[0]?.existingValue, 31);
  assert.equal(second.pending[0]?.suggestedValue, 30);
  assert.equal(second.state.pages[1]?.age?.value, 31, 'state keeps the original value');
});

test('updates naming a field that is not in the schema are dropped', () => {
  const schema = schemaWith([field({ id: 'name', type: 'text' })]);
  const state = buildInitialState(schema);
  const res = applyUpdates(schema, state, [
    { fieldId: 'diagnosis', valueText: 'sepsis', certainty: 'explicit' },
  ]);
  assert.equal(res.applied.length, 0);
  assert.equal(res.rejected.length, 1);
});

test('the gate lets data through and stops small talk', () => {
  assert.equal(isLikelyRelevant('ok thanks').relevant, false);
  assert.equal(isLikelyRelevant('born at 10:35 am').relevant, true);
  assert.equal(isLikelyRelevant('the mother is O positive', ['Mother Blood Group']).relevant, true);
});

test('fields on the same printed line are grouped into one row', () => {
  const rows = groupIntoRows([
    field({ id: 'a', type: 'text', bbox: bbox(0.1, 0.5) }),
    field({ id: 'b', type: 'text', bbox: bbox(0.5, 0.505) }),
    field({ id: 'c', type: 'text', bbox: bbox(0.1, 0.6) }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.fields.map((f) => f.id), ['a', 'b']);
});

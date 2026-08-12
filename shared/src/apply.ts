/**
 * Applying validated extraction results to form state.
 *
 * Two rules dominate this file, both from the clinical-safety requirement:
 *   1. A value that is already present is never silently replaced. Any
 *      disagreement becomes a conflict for a human to resolve.
 *   2. An under-specified statement never becomes a confirmed value. It is
 *      parked as `needs_clarification` with the reason attached.
 */
import { validateValue, valuesEqual } from './validation.js';
import { findField, getFieldState } from './schema.js';
import type {
  AppliedUpdate,
  FieldState,
  FormSchema,
  FormState,
  RawFieldUpdate,
  RejectedUpdate,
} from './types.js';

export interface ApplyResult {
  applied: AppliedUpdate[];
  pending: AppliedUpdate[];
  rejected: RejectedUpdate[];
  state: FormState;
}

function setField(
  state: FormState,
  pageNumber: number,
  fieldId: string,
  next: FieldState,
): void {
  const page = state.pages[pageNumber] ?? (state.pages[pageNumber] = {});
  page[fieldId] = next;
}

export function applyUpdates(
  schema: FormSchema,
  state: FormState,
  updates: RawFieldUpdate[],
  now = new Date(),
): ApplyResult {
  const applied: AppliedUpdate[] = [];
  const pending: AppliedUpdate[] = [];
  const rejected: RejectedUpdate[] = [];
  const nextState: FormState = {
    ...state,
    pages: Object.fromEntries(
      Object.entries(state.pages).map(([page, fields]) => [Number(page), { ...fields }]),
    ),
    updatedAt: now.toISOString(),
  };

  for (const update of updates) {
    const hit = findField(schema, update.fieldId);
    if (!hit) {
      // The model invented a field id. Dropping it is the whole point of
      // validating against the schema locally.
      rejected.push({
        fieldId: update.fieldId,
        valueText: update.valueText,
        reason: 'field id is not present in this form schema',
      });
      continue;
    }

    const { field, pageNumber } = hit;
    const result = validateValue(field, update.valueText, update.unit, now);

    if (result.ok === false) {
      rejected.push({ fieldId: field.id, valueText: update.valueText, reason: result.reason });
      continue;
    }

    const current = getFieldState(nextState, pageNumber, field.id);
    const isClarify = result.ok === 'clarify';
    const value = isClarify ? result.suggested : result.value;
    const unit = result.unit ?? field.unit ?? null;

    // Ambiguous phrasing ("around two and a half") never lands as a value.
    if (isClarify || update.certainty === 'ambiguous') {
      const note = isClarify
        ? result.reason
        : 'the statement was not definite; confirm before saving';
      const record: AppliedUpdate = {
        fieldId: field.id,
        pageNumber,
        value: current.value,
        status: 'needs_clarification',
        suggestedValue: value,
        evidence: update.evidence ?? null,
        unit,
        note,
      };
      pending.push(record);
      setField(nextState, pageNumber, field.id, {
        ...current,
        status: 'needs_clarification',
        note,
        pending: { value, evidence: update.evidence ?? null, unit, at: now.toISOString() },
      });
      continue;
    }

    // An existing value is never overwritten from conversation — not even one
    // that conversation itself wrote. A restatement that differs is a conflict.
    if (current.value !== null && !valuesEqual(current.value, value)) {
      const record: AppliedUpdate = {
        fieldId: field.id,
        pageNumber,
        value: current.value,
        status: 'conflict',
        conflict: true,
        existingValue: current.value,
        suggestedValue: value,
        evidence: update.evidence ?? null,
        unit,
        note: current.editedByUser
          ? 'this field was edited by hand'
          : 'a different value was recorded earlier',
      };
      pending.push(record);
      setField(nextState, pageNumber, field.id, {
        ...current,
        status: 'conflict',
        note: record.note ?? null,
        pending: { value, evidence: update.evidence ?? null, unit, at: now.toISOString() },
      });
      continue;
    }

    if (current.value !== null && valuesEqual(current.value, value)) continue; // no-op restatement

    const next: FieldState = {
      value,
      source: 'conversation',
      status: 'confirmed',
      unit,
      lastUpdated: now.toISOString(),
      editedByUser: false,
      evidence: update.evidence ?? null,
      pending: null,
      note: null,
    };
    setField(nextState, pageNumber, field.id, next);
    applied.push({
      fieldId: field.id,
      pageNumber,
      value,
      unit,
      status: 'confirmed',
      evidence: update.evidence ?? null,
    });
  }

  return { applied, pending, rejected, state: nextState };
}

/** A manual edit from the UI. Marks the field as human-owned from then on. */
export function applyManualEdit(
  schema: FormSchema,
  state: FormState,
  pageNumber: number,
  fieldId: string,
  value: FieldState['value'],
  now = new Date(),
): { state: FormState; error?: string } {
  const hit = findField(schema, fieldId);
  if (!hit || hit.pageNumber !== pageNumber) return { state, error: 'unknown field' };

  const current = getFieldState(state, pageNumber, fieldId);
  const next: FieldState = {
    ...current,
    value,
    source: 'user',
    status: value === null || value === '' ? 'missing' : 'confirmed',
    lastUpdated: now.toISOString(),
    editedByUser: true,
    evidence: null,
    pending: null,
    note: null,
  };
  if (next.status === 'missing') next.value = null;

  const nextState: FormState = {
    ...state,
    pages: { ...state.pages, [pageNumber]: { ...state.pages[pageNumber], [fieldId]: next } },
    updatedAt: now.toISOString(),
  };
  return { state: nextState };
}

/** Resolve a conflict / clarification by keeping or replacing the current value. */
export function resolvePending(
  state: FormState,
  pageNumber: number,
  fieldId: string,
  choice: 'keep' | 'accept',
  now = new Date(),
): { state: FormState; error?: string } {
  const current = state.pages[pageNumber]?.[fieldId];
  if (!current) return { state, error: 'unknown field' };
  if (!current.pending) return { state, error: 'nothing pending on this field' };

  const next: FieldState =
    choice === 'accept'
      ? {
          ...current,
          value: current.pending.value,
          unit: current.pending.unit ?? current.unit ?? null,
          evidence: current.pending.evidence ?? null,
          source: 'conversation',
          status: 'confirmed',
          lastUpdated: now.toISOString(),
          editedByUser: false,
          pending: null,
          note: null,
        }
      : {
          ...current,
          status: current.value === null ? 'missing' : 'confirmed',
          pending: null,
          note: null,
          lastUpdated: now.toISOString(),
        };

  return {
    state: {
      ...state,
      pages: { ...state.pages, [pageNumber]: { ...state.pages[pageNumber], [fieldId]: next } },
      updatedAt: now.toISOString(),
    },
  };
}

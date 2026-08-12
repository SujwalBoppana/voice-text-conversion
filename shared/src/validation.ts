/**
 * Deterministic, local validation of every value the model proposes.
 *
 * The model is treated as an *untrusted* source of strings. Nothing reaches form
 * state until this file has parsed it against the field's declared type and,
 * where the document printed a closed list of choices, against those choices.
 * Model confidence is deliberately not an input here.
 */
import type { FieldValue, FormField } from './types.js';

export type ValidationResult =
  | { ok: true; value: FieldValue; unit?: string | null }
  | { ok: false; reason: string }
  | { ok: 'clarify'; reason: string; suggested: FieldValue; unit?: string | null };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const TRUTHY = new Set(['yes', 'y', 'true', 'present', 'positive', 'done']);
const FALSY = new Set(['no', 'n', 'false', 'absent', 'negative', 'nil', 'none', 'not done']);

/** Strip punctuation/casing so "Meconium-stained." matches "Meconium stained". */
export function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  const table = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[m - 1] ?? 0;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Parse a date to ISO `YYYY-MM-DD`.
 *
 * Ambiguous all-numeric forms are rejected rather than guessed: "03/04/2025" is
 * 3 April or 4 March depending on locale, and silently choosing one would
 * fabricate a date. Rejection surfaces as a clarification request instead.
 */
export function parseDate(input: string, now = new Date()): { iso: string } | { error: string } {
  const raw = input.trim();
  const lower = canon(raw);

  if (lower === 'today') return { iso: toISODate(now) };
  if (lower === 'yesterday') return { iso: toISODate(new Date(now.getTime() - 86400000)) };
  if (lower === 'tomorrow') return { iso: toISODate(new Date(now.getTime() + 86400000)) };

  // ISO: 2026-08-12
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return checkYMD(+iso[1]!, +iso[2]!, +iso[3]!);

  // "12 Aug 2026" / "Aug 12, 2026" / "12 August 2026"
  const dmy = raw.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})[\s,-]+(\d{4})$/);
  if (dmy) {
    const m = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    if (!m) return { error: `unknown month "${dmy[2]}"` };
    return checkYMD(+dmy[3]!, m, +dmy[1]!);
  }
  const mdy = raw.match(/^([A-Za-z]{3,})[\s-]+(\d{1,2})\s*(?:st|nd|rd|th)?[\s,-]+(\d{4})$/);
  if (mdy) {
    const m = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    if (!m) return { error: `unknown month "${mdy[1]}"` };
    return checkYMD(+mdy[3]!, m, +mdy[2]!);
  }

  // Numeric with separators. Only accept when one component is unambiguously > 12.
  const num = raw.match(/^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/);
  if (num) {
    const a = +num[1]!;
    const b = +num[2]!;
    const c = +num[3]!;
    if (num[1]!.length === 4) return checkYMD(a, b, c);
    const year = num[3]!.length === 4 ? c : 2000 + c;
    if (a > 12 && b <= 12) return checkYMD(year, b, a); // D/M/Y
    if (b > 12 && a <= 12) return checkYMD(year, a, b); // M/D/Y
    return { error: `ambiguous date "${raw}" (day/month order unclear)` };
  }

  return { error: `unrecognized date "${raw}"` };
}

function checkYMD(y: number, m: number, d: number): { iso: string } | { error: string } {
  if (m < 1 || m > 12) return { error: `month out of range in ${y}-${m}-${d}` };
  if (d < 1 || d > daysInMonth(y, m)) return { error: `day out of range in ${y}-${m}-${d}` };
  if (y < 1900 || y > 2200) return { error: `year out of range: ${y}` };
  return { iso: `${y}-${pad(m)}-${pad(d)}` };
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a clock time to 24h `HH:MM`. */
export function parseTime(input: string): { hhmm: string } | { error: string } {
  const raw = input.trim().toLowerCase().replace(/\./g, '');
  const m = raw.match(/^(\d{1,2})[:\s]?(\d{2})?\s*(am|pm|hrs|hours)?$/);
  if (!m) return { error: `unrecognized time "${input}"` };
  let h = +m[1]!;
  const min = m[2] ? +m[2] : 0;
  const suffix = m[3];
  if (min > 59) return { error: `minutes out of range in "${input}"` };
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  if (h > 23) return { error: `hours out of range in "${input}"` };
  // Bare 1-2 digit numbers with no minutes and no am/pm are not a time.
  if (!m[2] && !suffix) return { error: `"${input}" is not a complete time` };
  return { hhmm: `${pad(h)}:${pad(min)}` };
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Parse a number, including a few spelled-out and fractional forms. */
export function parseNumber(input: string): { n: number } | { error: string } {
  // Decimal points must survive normalization, so digits are matched on the raw
  // string; only the spelled-out branch below uses the aggressive canon().
  const direct = input.trim().match(/^[^\d-]*(-?\d+(?:[.,]\d+)?)/);
  if (direct) return { n: parseFloat(direct[1]!.replace(',', '.')) };

  const raw = canon(input);

  const half = raw.match(/^([a-z]+)(?: point (\w+)| and a half| and a quarter)?$/);
  if (half) {
    const base = WORD_NUMBERS[half[1]!];
    if (base === undefined) return { error: `unrecognized number "${input}"` };
    if (/half/.test(raw)) return { n: base + 0.5 };
    if (/quarter/.test(raw)) return { n: base + 0.25 };
    if (half[2]) {
      const dec = WORD_NUMBERS[half[2]];
      if (dec === undefined) return { error: `unrecognized number "${input}"` };
      return { n: parseFloat(`${base}.${dec}`) };
    }
    return { n: base };
  }
  return { error: `unrecognized number "${input}"` };
}

/** Match free text against the closed option list printed on the document. */
export function matchOption(input: string, options: string[]): string | null {
  const target = canon(input);
  if (!target) return null;
  const exact = options.find((o) => canon(o) === target);
  if (exact) return exact;

  // Full-word containment in either direction ("male" vs "Male / M").
  const contained = options.filter((o) => {
    const c = canon(o);
    return c.split(' ').includes(target) || target.split(' ').includes(c);
  });
  if (contained.length === 1) return contained[0]!;

  const prefix = options.filter((o) => canon(o).startsWith(target) || target.startsWith(canon(o)));
  if (prefix.length === 1) return prefix[0]!;
  return null;
}

/**
 * Coerce and validate one proposed value against one field definition.
 *
 * Returns `ok: 'clarify'` (rather than accepting or rejecting) when the value is
 * plausible but under-specified — most importantly a bare number for a field
 * that carries a unit. Guessing "kg" there would invent information.
 */
export function validateValue(
  field: Pick<FormField, 'type' | 'options' | 'unit' | 'label'>,
  valueText: string,
  proposedUnit?: string | null,
  now = new Date(),
): ValidationResult {
  const raw = (valueText ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty value' };
  if (/^(unknown|not (known|stated|mentioned)|n\/?a|tbd|\?+)$/i.test(raw)) {
    return { ok: false, reason: 'value is a non-answer' };
  }

  switch (field.type) {
    case 'text':
    case 'textarea':
      return { ok: true, value: raw };

    case 'number':
    case 'decimal': {
      const parsed = parseNumber(raw);
      if ('error' in parsed) return { ok: false, reason: parsed.error };
      if (field.type === 'number' && !Number.isInteger(parsed.n)) {
        return { ok: false, reason: `"${raw}" is not a whole number` };
      }
      const unit = proposedUnit?.trim() || null;
      if (field.unit && !unit) {
        // The document prints a unit for this field but the speaker gave none.
        return {
          ok: 'clarify',
          reason: `no unit stated; "${field.label}" is recorded in ${field.unit}`,
          suggested: parsed.n,
          unit: null,
        };
      }
      if (field.unit && unit && canon(unit) !== canon(field.unit)) {
        return {
          ok: 'clarify',
          reason: `unit "${unit}" does not match the form's unit "${field.unit}"`,
          suggested: parsed.n,
          unit,
        };
      }
      return { ok: true, value: parsed.n, unit: unit ?? field.unit ?? null };
    }

    case 'date': {
      const d = parseDate(raw, now);
      if ('error' in d) return { ok: false, reason: d.error };
      return { ok: true, value: d.iso };
    }

    case 'time': {
      const t = parseTime(raw);
      if ('error' in t) return { ok: false, reason: t.error };
      return { ok: true, value: t.hhmm };
    }

    case 'datetime': {
      const [datePart, ...rest] = raw.split(/\s+(?=\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)?$)/i);
      const d = parseDate((datePart ?? raw).trim(), now);
      if ('error' in d) return { ok: false, reason: d.error };
      if (!rest.length) return { ok: true, value: `${d.iso}T00:00` };
      const t = parseTime(rest.join(' '));
      if ('error' in t) return { ok: false, reason: t.error };
      return { ok: true, value: `${d.iso}T${t.hhmm}` };
    }

    case 'boolean': {
      const c = canon(raw);
      if (TRUTHY.has(c)) return { ok: true, value: true };
      if (FALSY.has(c)) return { ok: true, value: false };
      return { ok: false, reason: `"${raw}" is not a yes/no answer` };
    }

    case 'radio':
    case 'select': {
      const options = field.options ?? [];
      if (!options.length) return { ok: true, value: raw };
      const hit = matchOption(raw, options);
      if (!hit) return { ok: false, reason: `"${raw}" is not one of: ${options.join(', ')}` };
      return { ok: true, value: hit };
    }

    case 'multiselect':
    case 'checkbox': {
      const options = field.options ?? [];
      const parts = raw.split(/\s*(?:,|;|\band\b|\+|\/)\s*/i).filter(Boolean);
      if (!options.length) return { ok: true, value: parts };
      const hits: string[] = [];
      for (const p of parts) {
        const hit = matchOption(p, options);
        if (!hit) return { ok: false, reason: `"${p}" is not one of: ${options.join(', ')}` };
        if (!hits.includes(hit)) hits.push(hit);
      }
      if (!hits.length) return { ok: false, reason: 'no option matched' };
      return { ok: true, value: hits };
    }

    case 'table':
      // Tables are filled through the grid editor, not through free conversation.
      return { ok: false, reason: 'table fields are not populated from conversation' };

    default:
      return { ok: false, reason: `unsupported field type "${field.type}"` };
  }
}

/** True when two validated values are the same as far as the form is concerned. */
export function valuesEqual(a: FieldValue, b: FieldValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
  }
  if (typeof a === 'string' && typeof b === 'string') return canon(a) === canon(b);
  return false;
}

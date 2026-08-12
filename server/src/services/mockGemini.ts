/**
 * Offline stand-ins for the two Gemini calls, active only when MOCK_GEMINI=true.
 *
 * They exist so the UI, the normalizer, the validator, the conflict rules and
 * the whole HTTP surface can be developed and demonstrated without an API key.
 * Both feed the *same* downstream pipeline as the real calls — the mock analysis
 * is a raw model-shaped payload that still goes through normalizePage(), and the
 * mock extraction still goes through applyUpdates() and local validation.
 *
 * Nothing here is imported when a real key is configured.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, type CatalogField, type RawFieldUpdate } from '@formfill/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

let cached: unknown;

export async function mockAnalysisPayload(): Promise<unknown> {
  if (!cached) {
    const file = path.join(here, '../fixtures/paramitha-page1.analysis.json');
    cached = JSON.parse(await fs.readFile(file, 'utf8'));
  }
  return cached;
}

const HEDGES = /\b(about|around|roughly|approximately|maybe|probably|i think|or so|nearly|almost)\b/i;

/**
 * A crude keyword matcher — enough to demo the pipeline end to end, and
 * deliberately much dumber than the real model. It works off the same catalogue
 * the model would receive, so it stays form-agnostic.
 */
export function mockExtraction(
  catalog: CatalogField[],
  message: string,
): { updates: RawFieldUpdate[]; reply: string } {
  const updates: RawFieldUpdate[] = [];
  const hedged = HEDGES.test(message);
  const text = message.toLowerCase();

  for (const field of catalog) {
    if (updates.some((u) => u.fieldId === field.id)) continue;

    // Option fields: does the message name one of the printed options?
    if (field.options?.length) {
      const hit = field.options.find((o) => canon(text).includes(canon(o)));
      const labelMentioned = canon(text).includes(canon(field.label));
      if (hit && (labelMentioned || field.options.length > 2)) {
        updates.push({
          fieldId: field.id,
          valueText: hit,
          evidence: hit,
          certainty: hedged ? 'ambiguous' : 'explicit',
        });
        continue;
      }
      if (labelMentioned && field.type === 'boolean') {
        const negated = new RegExp(`(no|not|denies|without)[^.]{0,20}${escapeRe(field.label)}`, 'i').test(message);
        updates.push({
          fieldId: field.id,
          valueText: negated ? 'No' : 'Yes',
          evidence: field.label,
          certainty: hedged ? 'ambiguous' : 'explicit',
        });
        continue;
      }
    }

    // "<label> is/was/: <value>" / "<label> of <value>"
    const pattern = new RegExp(
      `${escapeRe(field.label)}\\s*(?:is|was|are|of|:|=|-)?\\s*([^,;\\n]{1,60})`,
      'i',
    );
    const match = message.match(pattern);
    if (match?.[1]) {
      // Keep decimal points ("2.4") but drop a sentence-ending one ("LSCS.").
      const value = match[1].trim().replace(/\.(?!\d)\s*.*$/, '').trim();
      if (value) {
        const unit = value.match(/\b(kg|kgs|kilograms?|grams?|g|cm|centimet(?:re|er)s?|mm|weeks?|years?|days?)\b/i)?.[1];
        updates.push({
          fieldId: field.id,
          valueText: value,
          unit: unit ?? null,
          evidence: match[0],
          certainty: hedged ? 'ambiguous' : 'explicit',
        });
      }
    }
  }

  return {
    updates,
    reply: updates.length
      ? `[mock] Picked up ${updates.length} value${updates.length === 1 ? '' : 's'}.`
      : '[mock] Nothing matched a field on this page.',
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

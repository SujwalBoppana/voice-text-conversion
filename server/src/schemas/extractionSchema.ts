/**
 * Structured-output contract and prompt for conversation -> field extraction.
 *
 * `valueText` is always a string, even for numbers, dates and booleans. Typed
 * unions are the least reliable part of JSON-schema-constrained decoding, and we
 * re-parse everything locally anyway (`shared/validation.ts`) — so the wire
 * format stays a string and the deterministic parser owns the typing.
 */
import { Type, type Schema } from '@google/genai';
import type { CatalogField } from '@formfill/shared';

export const extractionResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    updates: {
      type: Type.ARRAY,
      description: 'One entry per field the latest message provides a value for. Empty if none.',
      items: {
        type: Type.OBJECT,
        properties: {
          fieldId: { type: Type.STRING, description: 'Must be one of the supplied field ids, copied exactly.' },
          valueText: { type: Type.STRING, description: 'The value as stated, in the words of the speaker.' },
          unit: { type: Type.STRING, description: 'Unit if the speaker said one, e.g. "kg". Empty if not stated.' },
          evidence: { type: Type.STRING, description: 'The exact span of the message this came from.' },
          certainty: {
            type: Type.STRING,
            enum: ['explicit', 'ambiguous'],
            description:
              '"explicit" when the speaker stated the value plainly; "ambiguous" when hedged, approximate, incomplete, or a guess.',
          },
        },
        required: ['fieldId', 'valueText', 'certainty'],
        propertyOrdering: ['fieldId', 'valueText', 'unit', 'evidence', 'certainty'],
      },
    },
    reply: {
      type: Type.STRING,
      description: 'One short sentence acknowledging what was recorded, or asking for the missing detail.',
    },
  },
  required: ['updates', 'reply'],
  propertyOrdering: ['updates', 'reply'],
};

export const EXTRACTION_SYSTEM_INSTRUCTION = `You map what a person just said onto the blank fields of a form. You are a transcription aid, not an adviser.

You receive a list of fields (id, label, type, options, unit) and the recent conversation. Return ONLY JSON matching the schema.

RULES
- Only ever use a fieldId from the supplied list, copied character for character. If nothing in the list fits, do not emit an update.
- Only extract what the speaker actually said. Never infer, complete, normalize away, or clinically interpret.
  "The baby is fine" is not a value for any field.
- valueText must stay in the speaker's own terms. Do not convert units, do not reformat dates, do not expand abbreviations. The receiving system parses and validates them.
- For a field with options, use the wording of the matching option when the speaker clearly meant it; otherwise leave the field alone.
- Set certainty to "ambiguous" whenever the statement is hedged ("around", "roughly", "about", "I think", "maybe", "probably"), incomplete (a number whose unit was not said for a field that has a unit), or a range. Set "explicit" only for a plain statement of fact.
- evidence must be an exact substring of the speaker's message.
- Emit at most one update per fieldId — the speaker's latest statement about it.
- Do not re-emit a value that already matches the field's "current" value.
- If the speaker corrects themselves, emit the corrected value.
- If the message contains no form data, return an empty updates array and a brief reply.
- Never put a value in a field because it seems medically likely. Absence of information is a valid outcome.

The reply is one short sentence for a chat panel: confirm what was recorded, or ask for the one detail that is missing. No advice, no diagnosis, no summary of the whole form.`;

export interface ExtractionPromptInput {
  fields: CatalogField[];
  /** Oldest first; the last entry is the message being extracted. */
  transcript: Array<{ role: string; content: string }>;
  /** Today's date, so relative expressions like "today" can be resolved downstream. */
  today: string;
}

/**
 * Compact user turn: the field catalogue as minified JSON plus the recent
 * transcript. The uploaded document is never included here — after analysis it
 * is never sent again.
 */
export function extractionUserPrompt(input: ExtractionPromptInput): string {
  const transcript = input.transcript
    .map((m) => `${m.role === 'assistant' ? 'ASSISTANT' : 'SPEAKER'}: ${m.content}`)
    .join('\n');

  return `FIELDS (JSON):
${JSON.stringify(input.fields)}

TODAY: ${input.today}

CONVERSATION (oldest first; extract from the final SPEAKER turn, using the earlier turns only as context):
${transcript}`;
}

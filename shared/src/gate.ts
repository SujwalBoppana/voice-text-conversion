/**
 * Local relevance gate.
 *
 * Runs before every extraction call and costs nothing. A turn that plainly
 * carries no form data ("ok", "thanks", "what's left?") is answered locally and
 * never reaches the model — the cheapest possible token optimization, and it
 * also removes a round-trip of latency from the most common chat noise.
 *
 * The gate is deliberately biased towards *letting things through*: a false
 * "relevant" costs one call, a false "irrelevant" loses real clinical data.
 */

const SMALL_TALK =
  /^(ok(ay)?|k|thanks?|thank you|ty|got it|sure|yes|no|yep|nope|hi|hello|hey|good (morning|afternoon|evening)|bye|cool|nice|great|perfect|done|next|continue|go on|hmm+|\.\.\.)[.!?]*$/i;

const QUESTION_ABOUT_FORM =
  /^(what|which|how many|how much|is|are|do|does|did|can|could|show|tell|list|why|when will)\b.*\?$/i;

export interface GateResult {
  relevant: boolean;
  reason: string;
}

/**
 * @param text        the user's message
 * @param fieldLabels labels of the fields still open, used as a weak keyword signal
 */
export function isLikelyRelevant(text: string, fieldLabels: string[] = []): GateResult {
  const trimmed = text.trim();

  if (trimmed.length < 3) return { relevant: false, reason: 'message too short' };
  if (SMALL_TALK.test(trimmed)) return { relevant: false, reason: 'small talk' };

  // Contains a number, a date-ish token or a unit -> almost certainly data.
  if (/\d/.test(trimmed)) return { relevant: true, reason: 'contains numeric data' };

  // Mentions a field label word (>3 chars) from the schema.
  const words = new Set(
    trimmed
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter((w) => w.length > 3),
  );
  for (const label of fieldLabels) {
    for (const part of label.toLowerCase().split(/[^a-z']+/)) {
      if (part.length > 3 && words.has(part)) {
        return { relevant: true, reason: `mentions field term "${part}"` };
      }
    }
  }

  // A pure question with no numbers and no field terms is a query, not data.
  if (QUESTION_ABOUT_FORM.test(trimmed)) {
    return { relevant: false, reason: 'question about the form, not form data' };
  }

  // Anything with a reasonable amount of prose could carry a name or a choice.
  if (trimmed.split(/\s+/).length >= 4) return { relevant: true, reason: 'substantive message' };

  return { relevant: false, reason: 'no recognizable form data' };
}

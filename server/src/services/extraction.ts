/**
 * Conversation -> field extraction.
 *
 * The expensive input (the document) is gone by this point: this call sees only
 * a compact catalogue of the fields that are still open plus the last few chat
 * turns. Cost per turn therefore scales with how much of the form is left, not
 * with the size of the document or the length of the session.
 */
import { z } from 'zod';
import {
  applyUpdates,
  buildFieldCatalog,
  fieldsOfPage,
  isLikelyRelevant,
  recentMessages,
  type ExtractionResponse,
  type RawFieldUpdate,
} from '@formfill/shared';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import {
  EXTRACTION_SYSTEM_INSTRUCTION,
  extractionResponseSchema,
  extractionUserPrompt,
} from '../schemas/extractionSchema.js';
import { generateJson } from './geminiClient.js';
import type { FormRecord } from './store.js';
import { mockExtraction } from './mockGemini.js';

const rawUpdateSchema = z.object({
  fieldId: z.string().min(1),
  valueText: z.string(),
  unit: z.string().optional(),
  evidence: z.string().optional(),
  certainty: z.enum(['explicit', 'ambiguous']).catch('ambiguous'),
});

const extractionPayloadSchema = z.object({
  updates: z.array(rawUpdateSchema).default([]),
  reply: z.string().default(''),
});

/** Fields touched in the last few minutes stay in the catalogue so corrections land. */
const PIN_WINDOW_MS = 5 * 60 * 1000;

function pinnedFieldIds(record: FormRecord, pageNumber: number, now: number): string[] {
  const page = record.state.pages[pageNumber] ?? {};
  return Object.entries(page)
    .filter(([, fs]) => {
      if (fs.pending) return true; // unresolved conflict / clarification
      if (!fs.lastUpdated) return false;
      return now - Date.parse(fs.lastUpdated) < PIN_WINDOW_MS;
    })
    .map(([id]) => id);
}

export async function runExtraction(
  record: FormRecord,
  pageNumber: number,
  message: string,
): Promise<ExtractionResponse> {
  const now = new Date();
  const fields = fieldsOfPage(record.schema, pageNumber);
  if (!fields.length) {
    throw new AppError('PAGE_NOT_ANALYZED', `Page ${pageNumber} has not been analyzed.`, 400);
  }

  // Gate first: a turn with no form data never reaches the model.
  const gate = isLikelyRelevant(message, fields.map((f) => f.label));
  if (!gate.relevant) {
    return {
      formId: record.formId,
      applied: [],
      pending: [],
      rejected: [],
      reply: '',
      skipped: true,
    };
  }

  const catalog = buildFieldCatalog(record.schema, record.state, {
    pageNumber,
    maxFields: config.maxCatalogFields,
    pinned: pinnedFieldIds(record, pageNumber, now.getTime()),
  });

  if (!catalog.length) {
    return {
      formId: record.formId,
      applied: [],
      pending: [],
      rejected: [],
      reply: 'Every field on this page already has a value — edit one directly to change it.',
      skipped: true,
    };
  }

  const transcript = recentMessages(record.messages, config.maxConversationTurns).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let updates: RawFieldUpdate[];
  let reply: string;
  let usage: ExtractionResponse['usage'];

  if (config.mockGemini) {
    const mock = mockExtraction(catalog, message);
    updates = mock.updates;
    reply = mock.reply;
    usage = { model: 'mock', latencyMs: 0 };
  } else {
    const result = await generateJson<unknown>({
      model: config.extractionModel,
      systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
      parts: [
        {
          text: extractionUserPrompt({
            fields: catalog,
            transcript,
            today: now.toISOString().slice(0, 10),
          }),
        },
      ],
      responseSchema: extractionResponseSchema,
      thinkingBudget: config.extractionThinkingBudget,
      temperature: 0,
      maxOutputTokens: 2048,
      label: 'extraction',
    });

    const parsed = extractionPayloadSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new AppError(
        'EXTRACTION_SCHEMA_INVALID',
        'The model returned an extraction result that does not match the expected shape.',
        502,
        parsed.error.issues.slice(0, 5),
      );
    }
    updates = parsed.data.updates.map((u) => ({
      fieldId: u.fieldId,
      valueText: u.valueText,
      unit: u.unit ?? null,
      evidence: u.evidence ?? null,
      certainty: u.certainty,
    }));
    reply = parsed.data.reply;
    usage = result.usage;
  }

  // Ids outside the catalogue are dropped before validation: the model was told
  // exactly which fields exist, so anything else is a hallucination.
  const allowed = new Set(catalog.map((c) => c.id));
  const inScope = updates.filter((u) => allowed.has(u.fieldId));
  const outOfScope = updates.filter((u) => !allowed.has(u.fieldId));

  const result = applyUpdates(record.schema, record.state, inScope, now);
  record.state = result.state;

  return {
    formId: record.formId,
    applied: result.applied,
    pending: result.pending,
    rejected: [
      ...result.rejected,
      ...outOfScope.map((u) => ({
        fieldId: u.fieldId,
        valueText: u.valueText,
        reason: 'field id was not among the fields offered to the model',
      })),
    ],
    reply: reply.trim() || defaultReply(result.applied.length, result.pending.length),
    skipped: false,
    usage,
  };
}

function defaultReply(applied: number, pending: number): string {
  if (!applied && !pending) return 'Nothing in that mapped to a field on this page.';
  const parts: string[] = [];
  if (applied) parts.push(`Recorded ${applied} field${applied === 1 ? '' : 's'}.`);
  if (pending) parts.push(`${pending} need${pending === 1 ? 's' : ''} your confirmation.`);
  return parts.join(' ');
}

/**
 * Helpers over a generated FormSchema: traversal, initial state, and the compact
 * catalogue that conversation extraction sends instead of the document.
 */
import type {
  ChatMessage,
  FieldState,
  FormField,
  FormSchema,
  FormState,
  PageSchema,
} from './types.js';

export function pageOf(schema: FormSchema, pageNumber: number): PageSchema | undefined {
  return schema.pages.find((p) => p.pageNumber === pageNumber);
}

export function fieldsOfPage(schema: FormSchema, pageNumber: number): FormField[] {
  return pageOf(schema, pageNumber)?.sections.flatMap((s) => s.fields) ?? [];
}

export function allFields(schema: FormSchema): Array<FormField & { pageNumber: number }> {
  return schema.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.fields.map((field) => ({ ...field, pageNumber: page.pageNumber })),
    ),
  );
}

export function findField(
  schema: FormSchema,
  fieldId: string,
): { field: FormField; pageNumber: number } | undefined {
  for (const page of schema.pages) {
    for (const section of page.sections) {
      const field = section.fields.find((f) => f.id === fieldId);
      if (field) return { field, pageNumber: page.pageNumber };
    }
  }
  return undefined;
}

export function emptyFieldState(): FieldState {
  return {
    value: null,
    source: null,
    status: 'missing',
    unit: null,
    lastUpdated: null,
    editedByUser: false,
    evidence: null,
    pending: null,
    note: null,
  };
}

export function buildInitialState(schema: FormSchema): FormState {
  const pages: FormState['pages'] = {};
  for (const page of schema.pages) {
    const fields: Record<string, FieldState> = {};
    for (const section of page.sections) {
      for (const field of section.fields) fields[field.id] = emptyFieldState();
    }
    pages[page.pageNumber] = fields;
  }
  return { formId: schema.formId, pages, updatedAt: new Date().toISOString() };
}

export function getFieldState(state: FormState, pageNumber: number, fieldId: string): FieldState {
  return state.pages[pageNumber]?.[fieldId] ?? emptyFieldState();
}

/* ---------------------------- extraction payload --------------------------- */

/** The minimal description of a field that extraction needs. */
export interface CatalogField {
  id: string;
  label: string;
  type: string;
  options?: string[];
  unit?: string;
  section?: string;
  context?: string;
  /** Present only when the field already holds a value. */
  current?: string;
}

export interface CatalogOptions {
  pageNumber: number;
  /** Cap on fields sent. Empty fields are kept first. */
  maxFields?: number;
  /** Ids to always include (e.g. fields touched in the last few turns). */
  pinned?: string[];
}

/**
 * Build the compact field catalogue for one extraction call.
 *
 * This is the core token optimization: the uploaded document is never re-sent
 * after analysis, and filled fields are dropped unless pinned, so a long
 * form-filling session gets *cheaper* per turn rather than more expensive.
 * Filled-and-pinned fields carry their current value so the model can spot a
 * correction ("actually it was 2.6").
 */
export function buildFieldCatalog(
  schema: FormSchema,
  state: FormState,
  opts: CatalogOptions,
): CatalogField[] {
  const { pageNumber, maxFields = 120, pinned = [] } = opts;
  const page = pageOf(schema, pageNumber);
  if (!page) return [];

  const entries: Array<{ field: FormField; section: string; filled: boolean; pinned: boolean }> = [];
  for (const section of page.sections) {
    for (const field of section.fields) {
      if (field.type === 'table') continue; // not conversation-fillable
      const fs = state.pages[pageNumber]?.[field.id];
      entries.push({
        field,
        section: section.title,
        filled: fs?.value !== null && fs?.value !== undefined,
        pinned: pinned.includes(field.id),
      });
    }
  }

  entries.sort((a, b) => {
    const rank = (e: typeof a) => (!e.filled ? 0 : e.pinned ? 1 : 2);
    return rank(a) - rank(b);
  });

  const selected = entries.filter((e) => !e.filled || e.pinned).slice(0, maxFields);

  return selected.map(({ field, section, filled }) => {
    const fs = state.pages[pageNumber]?.[field.id];
    const out: CatalogField = {
      id: field.id,
      label: field.label,
      type: field.type,
      section,
    };
    if (field.options?.length) out.options = field.options;
    if (field.unit) out.unit = field.unit;
    if (field.context) out.context = field.context;
    if (filled && fs) out.current = String(Array.isArray(fs.value) ? fs.value.join(', ') : fs.value);
    return out;
  });
}

/** Keep only the tail of the conversation; older turns rarely add new facts. */
export function recentMessages(messages: ChatMessage[], turns = 6): ChatMessage[] {
  return messages.slice(-turns);
}

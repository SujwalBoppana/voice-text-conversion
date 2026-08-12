/**
 * Domain types shared by the server and the web client.
 *
 * Nothing in this file knows anything about hospitals, babies or clinical data.
 * Every concept here is generic: documents, pages, sections, fields, values.
 * A form's structure is data produced at runtime by the vision model, never code.
 */

/** Field types the renderer and the validator both understand. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'decimal',
  'date',
  'time',
  'datetime',
  'boolean',
  'radio',
  'select',
  'multiselect',
  'checkbox',
  'table',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Normalized bounding box in page space.
 *
 * All four numbers are fractions of the page (0..1) with the origin at the
 * top-left corner. Normalizing at ingest time means the same schema drives the
 * HTML renderer (Mode A) and the pixel-accurate document overlay (Mode B) at any
 * zoom level or raster DPI, without a re-analysis.
 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A column of a `table` field. */
export interface TableColumn {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  unit?: string | null;
}

export interface FormField {
  /** Stable, snake_case, unique within the page. Used as the conversation mapping key. */
  id: string;
  /** Human label exactly as printed on the document. */
  label: string;
  type: FieldType;
  /** Present for radio/select/multiselect/checkbox. Verbatim from the document. */
  options?: string[];
  /** Unit printed on or implied by the document, e.g. "kg", "cm", "years". */
  unit?: string | null;
  required: boolean;
  /** Id of the owning section. */
  sectionId: string;
  /** Where the *input area* sits on the page (not the label). */
  bbox: BBox;
  /** Bounding box of the printed label, when the model could isolate it. */
  labelBBox?: BBox | null;
  /** Nearby printed text that disambiguates the field, e.g. "at 1 min of life". */
  context?: string | null;
  /** Ids of fields that belong to the same printed group, e.g. APGAR 1/5/10 min. */
  relatedFieldIds?: string[];
  /** Columns, only for `type: "table"`. */
  columns?: TableColumn[];
  /** Model's own confidence in the detection of this field (0..1). Never used to auto-confirm a value. */
  detectionConfidence?: number;
}

export interface FormSection {
  id: string;
  title: string;
  bbox: BBox;
  fields: FormField[];
}

export interface PageSchema {
  pageNumber: number;
  /** Page size in points, as printed. Used for aspect ratio in overlay mode. */
  dimensions: { width: number; height: number };
  sections: FormSection[];
}

/**
 * The full generated schema for a document.
 *
 * `pages` is an array from day one even though the MVP only ever analyzes page
 * 1: adding pages 2..n later is an append, not a migration.
 */
export interface FormSchema {
  formId: string;
  title: string;
  documentName: string;
  /** Source media type of the upload, e.g. "application/pdf". */
  sourceMimeType: string;
  /** Total pages in the uploaded document; only `analyzedPages` were processed. */
  pageCount: number;
  analyzedPages: number[];
  pages: PageSchema[];
  createdAt: string;
  /** Model id that produced this schema, for cache invalidation and audit. */
  analysisModel: string;
}

/* --------------------------------- state --------------------------------- */

export type FieldStatus =
  | 'missing' // never populated
  | 'confirmed' // a validated value is present
  | 'needs_clarification' // heard, but ambiguous (e.g. a number with no unit)
  | 'conflict'; // a new extraction disagrees with a value already present

export type FieldSource = 'conversation' | 'user' | null;

export type FieldValue = string | number | boolean | string[] | Array<Record<string, string>> | null;

export interface PendingSuggestion {
  value: FieldValue;
  /** Verbatim snippet the value came from. Shown to the user when resolving. */
  evidence?: string | null;
  unit?: string | null;
  at: string;
}

export interface FieldState {
  value: FieldValue;
  source: FieldSource;
  status: FieldStatus;
  unit?: string | null;
  lastUpdated: string | null;
  /** Once true, extraction may only *suggest* — never overwrite. */
  editedByUser: boolean;
  /** Verbatim conversation snippet supporting the current value. */
  evidence?: string | null;
  /** Populated when status is 'conflict' or 'needs_clarification'. */
  pending?: PendingSuggestion | null;
  /** Why clarification is needed, e.g. "no unit stated". */
  note?: string | null;
}

/**
 * Centralized, UI-framework-independent form state. Keyed page -> field id so
 * that later pages slot in without touching the shape.
 */
export interface FormState {
  formId: string;
  pages: Record<number, Record<string, FieldState>>;
  updatedAt: string;
}

/* ------------------------------ conversation ------------------------------ */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  at: string;
}

/** One proposed change coming back from extraction, before local validation. */
export interface RawFieldUpdate {
  fieldId: string;
  /** Always a string on the wire; coerced locally against the field's type. */
  valueText: string;
  unit?: string | null;
  /** Verbatim snippet from the user's message that supports this value. */
  evidence?: string | null;
  /** The model's own read on whether the statement was definite. */
  certainty: 'explicit' | 'ambiguous';
}

/** A change after local validation, ready to be applied or surfaced. */
export interface AppliedUpdate {
  fieldId: string;
  pageNumber: number;
  value: FieldValue;
  unit?: string | null;
  status: FieldStatus;
  evidence?: string | null;
  /** Set when the update did not overwrite an existing value. */
  conflict?: boolean;
  existingValue?: FieldValue;
  suggestedValue?: FieldValue;
  note?: string | null;
}

export interface RejectedUpdate {
  fieldId: string;
  valueText: string;
  reason: string;
}

export interface ExtractionResponse {
  formId: string;
  /** Changes that were written into form state. */
  applied: AppliedUpdate[];
  /** Changes that need a human decision (conflict / ambiguity). */
  pending: AppliedUpdate[];
  /** Dropped by local validation; never shown as form data. */
  rejected: RejectedUpdate[];
  /** Short assistant acknowledgement for the chat panel. */
  reply: string;
  /** True when the local gate decided the message carried no form data. */
  skipped: boolean;
  usage?: {
    model: string;
    promptTokens?: number;
    responseTokens?: number;
    totalTokens?: number;
    latencyMs: number;
  };
}

/* --------------------------------- API IO --------------------------------- */

export interface UploadResponse {
  schema: FormSchema;
  state: FormState;
  /** Relative URL to the extracted page image/PDF used as the overlay background. */
  pageAssetUrl: string;
  usage?: {
    model: string;
    promptTokens?: number;
    responseTokens?: number;
    totalTokens?: number;
    latencyMs: number;
    cached: boolean;
  };
}

export interface FormEnvelope {
  schema: FormSchema;
  state: FormState;
  messages: ChatMessage[];
  pageAssetUrl: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

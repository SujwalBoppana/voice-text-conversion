/**
 * The form session: schema, field state, transcript and the request lifecycle.
 *
 * Deliberately a plain class with a subscribe/getSnapshot pair rather than
 * anything React-specific — §17 of the brief asks for state that does not depend
 * on the UI framework, and this keeps the same object usable from a voice
 * pipeline, a test harness or a different renderer.
 *
 * It also owns the two client-side latency levers:
 *   - debouncing: turns that arrive in a burst (a live transcript, a fast
 *     typist) are coalesced into one extraction call;
 *   - optimistic edits: a manual edit paints immediately and reconciles with the
 *     server response, so typing never waits on a round-trip.
 */
import {
  emptyFieldState,
  isLikelyRelevant,
  type ChatMessage,
  type ExtractionResponse,
  type FieldState,
  type FieldValue,
  type FormSchema,
  type FormState,
} from '@formfill/shared';
import { api, ApiError } from '../api';

export type RenderMode = 'form' | 'overlay';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  /** Optional one-click follow-up, e.g. "Open settings". */
  action?: { label: string; run: () => void };
}

/** What one conversation turn did, shown as chips under the reply. */
export interface TurnResult {
  applied: Array<{ fieldId: string; label: string }>;
  pending: Array<{ fieldId: string; label: string }>;
  rejected: Array<{ fieldId: string; reason: string }>;
  skipped: boolean;
}

export interface SessionSnapshot {
  schema: FormSchema | null;
  state: FormState | null;
  messages: ChatMessage[];
  /** Keyed by assistant message id. */
  turnResults: Record<string, TurnResult>;
  pageAssetUrl: string | null;
  pageNumber: number;
  mode: RenderMode;
  /** Ids updated by the most recent extraction, for the flash highlight. */
  justUpdated: string[];
  /** Field the UI should scroll to and focus; cleared once handled. */
  focusFieldId: string | null;
  status: 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error';
  busy: boolean;
  /** Draft lines waiting for the debounce window to close. */
  queuedLines: number;
  error: string | null;
  /** Set when a call failed for a reason Settings can fix. */
  keyProblem: string | null;
  toasts: Toast[];
  lastUsage: ExtractionResponse['usage'] | null;
  analysisUsage: { model: string; totalTokens?: number; latencyMs: number; cached: boolean } | null;
  savedAt: string | null;
}

const DEBOUNCE_MS = 600;
const FLASH_MS = 2400;
const TOAST_MS = 6000;

export class FormSession {
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = {
    schema: null,
    state: null,
    messages: [],
    turnResults: {},
    pageAssetUrl: null,
    pageNumber: 1,
    mode: 'form',
    justUpdated: [],
    focusFieldId: null,
    status: 'idle',
    busy: false,
    queuedLines: 0,
    error: null,
    keyProblem: null,
    toasts: [],
    lastUsage: null,
    analysisUsage: null,
    savedAt: null,
  };

  private queue: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private set(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* --------------------------------- toasts -------------------------------- */

  toast(kind: Toast['kind'], message: string, action?: Toast['action']): void {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.set({ toasts: [...this.snapshot.toasts, { id, kind, message, action }] });
    if (kind !== 'error') setTimeout(() => this.dismissToast(id), TOAST_MS);
  }

  dismissToast(id: string): void {
    this.set({ toasts: this.snapshot.toasts.filter((t) => t.id !== id) });
  }

  /* ------------------------------- lifecycle ------------------------------ */

  async upload(file: File): Promise<void> {
    this.set({ status: 'uploading', error: null, keyProblem: null, busy: true });
    try {
      // The status flips to "analyzing" straight away: the upload itself is
      // milliseconds on a LAN, the model call is the wait worth naming.
      this.set({ status: 'analyzing' });
      const result = await api.upload(file);
      const fieldCount = result.schema.pages[0]?.sections.flatMap((s) => s.fields).length ?? 0;
      this.set({
        schema: result.schema,
        state: result.state,
        messages: [],
        turnResults: {},
        pageAssetUrl: result.pageAssetUrl,
        pageNumber: result.schema.analyzedPages[0] ?? 1,
        status: 'ready',
        busy: false,
        analysisUsage: result.usage ?? null,
        savedAt: null,
        justUpdated: [],
      });
      history.replaceState(null, '', `#${result.schema.formId}`);
      this.toast(
        'success',
        `Read ${fieldCount} field${fieldCount === 1 ? '' : 's'} from page 1${
          result.usage?.cached ? ' (from cache)' : ''
        }.`,
      );
    } catch (error) {
      this.fail(error, 'The document could not be analyzed.');
    }
  }

  async load(formId: string): Promise<void> {
    this.set({ status: 'analyzing', busy: true, error: null });
    try {
      const envelope = await api.get(formId);
      this.set({
        schema: envelope.schema,
        state: envelope.state,
        messages: envelope.messages,
        pageAssetUrl: envelope.pageAssetUrl,
        pageNumber: envelope.schema.analyzedPages[0] ?? 1,
        status: 'ready',
        busy: false,
      });
    } catch (error) {
      // A stale deep link is not an error worth a red banner; drop to upload.
      history.replaceState(null, '', ' ');
      this.set({ status: 'idle', busy: false });
      if (error instanceof ApiError && error.status !== 404) {
        this.fail(error, 'That form could not be loaded.');
      }
    }
  }

  reset(): void {
    this.cancelPending();
    history.replaceState(null, '', ' ');
    this.set({
      schema: null,
      state: null,
      messages: [],
      turnResults: {},
      pageAssetUrl: null,
      status: 'idle',
      busy: false,
      error: null,
      keyProblem: null,
      justUpdated: [],
      focusFieldId: null,
      queuedLines: 0,
      lastUsage: null,
      analysisUsage: null,
      savedAt: null,
    });
  }

  setMode(mode: RenderMode): void {
    this.set({ mode });
  }

  focusField(fieldId: string | null): void {
    this.set({ focusFieldId: fieldId });
  }

  clearKeyProblem(): void {
    this.set({ keyProblem: null });
  }

  /* ------------------------------ conversation ---------------------------- */

  /**
   * Queue a turn. Lines that arrive within the debounce window are sent as one
   * message, which is what makes a live transcript cheap: five dictated
   * fragments cost one call, not five.
   */
  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Show the user's turn immediately; the server echoes the canonical copy.
    this.appendLocalMessage({
      id: `local_${Date.now()}_${this.queue.length}`,
      role: 'user',
      content: trimmed,
      at: new Date().toISOString(),
    });

    const gate = isLikelyRelevant(trimmed, this.fieldLabels());
    if (!gate.relevant) {
      // Answered locally: no network, no tokens, no latency.
      const id = `local_ack_${Date.now()}`;
      this.appendLocalMessage({
        id,
        role: 'assistant',
        content: 'Nothing in that to record.',
        at: new Date().toISOString(),
      });
      this.set({
        turnResults: {
          ...this.snapshot.turnResults,
          [id]: { applied: [], pending: [], rejected: [], skipped: true },
        },
      });
      return;
    }

    this.queue.push(trimmed);
    this.set({ queuedLines: this.queue.length });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Send whatever is queued right now (used when the user hits send explicitly). */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.queue.length || !this.snapshot.schema) return;

    // One in-flight extraction at a time; a newer burst supersedes an older one.
    if (this.inFlight) this.inFlight.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const message = this.queue.join(' ');
    this.queue = [];
    this.set({ busy: true, queuedLines: 0, error: null });

    try {
      const result = await api.sendMessage(
        this.snapshot.schema.formId,
        message,
        this.snapshot.pageNumber,
        controller.signal,
      );
      const assistant = result.messages.find((m) => m.role === 'assistant');
      const { applied, pending, rejected } = result.extraction;
      const touched = [...applied.map((u) => u.fieldId), ...pending.map((u) => u.fieldId)];

      this.set({
        state: result.state,
        busy: false,
        lastUsage: result.extraction.usage ?? null,
        justUpdated: touched,
        // Scroll to the first thing that needs a decision, else the first fill.
        focusFieldId: pending[0]?.fieldId ?? applied[0]?.fieldId ?? null,
        messages: assistant ? [...this.snapshot.messages, assistant] : this.snapshot.messages,
        turnResults: assistant
          ? {
              ...this.snapshot.turnResults,
              [assistant.id]: {
                applied: applied.map((u) => ({ fieldId: u.fieldId, label: this.labelOf(u.fieldId) })),
                pending: pending.map((u) => ({ fieldId: u.fieldId, label: this.labelOf(u.fieldId) })),
                rejected: rejected.map((r) => ({ fieldId: r.fieldId, reason: r.reason })),
                skipped: result.extraction.skipped,
              },
            }
          : this.snapshot.turnResults,
      });
      this.scheduleFlashClear();
      // No toast for `pending` on purpose: the chat chip, the "to review" count
      // in the toolbar and the auto-scroll already say it three ways.
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      this.fail(error, 'That message could not be processed.');
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /* -------------------------------- editing ------------------------------- */

  /** Manual edit. Paints locally first, then persists. */
  async edit(fieldId: string, value: FieldValue): Promise<void> {
    const { schema, state, pageNumber } = this.snapshot;
    if (!schema || !state) return;

    const previous = state.pages[pageNumber]?.[fieldId] ?? emptyFieldState();
    const optimistic: FieldState = {
      ...previous,
      value,
      source: 'user',
      status: value === null || value === '' ? 'missing' : 'confirmed',
      editedByUser: true,
      lastUpdated: new Date().toISOString(),
      pending: null,
      note: null,
      evidence: null,
    };
    this.patchField(fieldId, optimistic);

    try {
      const result = await api.editField(schema.formId, fieldId, pageNumber, value);
      this.set({ state: result.state });
    } catch (error) {
      this.patchField(fieldId, previous); // roll back to what the server still holds
      this.fail(error, 'That edit could not be saved.');
    }
  }

  async resolve(fieldId: string, choice: 'keep' | 'accept'): Promise<void> {
    const { schema, pageNumber } = this.snapshot;
    if (!schema) return;
    try {
      const result = await api.resolveField(schema.formId, fieldId, pageNumber, choice);
      this.set({ state: result.state, justUpdated: [fieldId] });
      this.scheduleFlashClear();
    } catch (error) {
      this.fail(error, 'That conflict could not be resolved.');
    }
  }

  async save(): Promise<void> {
    const { schema } = this.snapshot;
    if (!schema) return;
    this.set({ busy: true, error: null });
    try {
      const result = await api.save(schema.formId);
      this.set({ state: result.state, savedAt: result.savedAt, busy: false });
      this.toast('success', 'Form saved.');
    } catch (error) {
      this.fail(error, 'The form could not be saved.');
    }
  }

  /** Download the filled form as JSON — schema, values and provenance together. */
  exportJson(): void {
    const { schema, state } = this.snapshot;
    if (!schema || !state) return;
    const blob = new Blob([JSON.stringify({ schema, state }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${schema.formId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('success', 'Exported as JSON.');
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /* -------------------------------- internals ----------------------------- */

  private fieldLabels(): string[] {
    return this.page()?.sections.flatMap((s) => s.fields.map((f) => f.label)) ?? [];
  }

  private page() {
    return this.snapshot.schema?.pages.find((p) => p.pageNumber === this.snapshot.pageNumber);
  }

  private labelOf(fieldId: string): string {
    for (const section of this.page()?.sections ?? []) {
      const field = section.fields.find((f) => f.id === fieldId);
      if (field) return field.label;
    }
    return fieldId;
  }

  private appendLocalMessage(message: ChatMessage): void {
    this.set({ messages: [...this.snapshot.messages, message] });
  }

  private patchField(fieldId: string, next: FieldState): void {
    const { state, pageNumber } = this.snapshot;
    if (!state) return;
    this.set({
      state: {
        ...state,
        pages: { ...state.pages, [pageNumber]: { ...state.pages[pageNumber], [fieldId]: next } },
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private scheduleFlashClear(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.set({ justUpdated: [] }), FLASH_MS);
  }

  private cancelPending(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.inFlight?.abort();
    this.queue = [];
    this.debounceTimer = null;
    this.inFlight = null;
  }

  private fail(error: unknown, fallback: string): void {
    const isApi = error instanceof ApiError;
    const message = isApi ? error.message : fallback;

    // A key or model problem is routed to Settings rather than shown as a dead
    // end — it is the one class of failure the user can fix in two clicks.
    if (isApi && error.isKeyProblem) {
      this.set({
        keyProblem: message,
        busy: false,
        status: this.snapshot.schema ? 'ready' : 'idle',
        error: null,
      });
      return;
    }

    this.set({ error: message, busy: false, status: this.snapshot.schema ? 'ready' : 'error' });
    this.toast('error', message);
  }
}

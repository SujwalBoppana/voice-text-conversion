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

export interface SessionSnapshot {
  schema: FormSchema | null;
  state: FormState | null;
  messages: ChatMessage[];
  pageAssetUrl: string | null;
  pageNumber: number;
  mode: RenderMode;
  /** Ids updated by the most recent extraction, for the flash highlight. */
  justUpdated: string[];
  status: 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error';
  busy: boolean;
  /** Draft lines waiting for the debounce window to close. */
  queuedLines: number;
  error: string | null;
  lastUsage: ExtractionResponse['usage'] | null;
  analysisUsage: { model: string; totalTokens?: number; latencyMs: number; cached: boolean } | null;
  savedAt: string | null;
}

const DEBOUNCE_MS = 600;
const FLASH_MS = 2200;

export class FormSession {
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = {
    schema: null,
    state: null,
    messages: [],
    pageAssetUrl: null,
    pageNumber: 1,
    mode: 'form',
    justUpdated: [],
    status: 'idle',
    busy: false,
    queuedLines: 0,
    error: null,
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

  /* ------------------------------- lifecycle ------------------------------ */

  async upload(file: File): Promise<void> {
    this.set({ status: 'uploading', error: null, busy: true });
    try {
      // The status flips to "analyzing" straight away: the upload itself is
      // milliseconds on a LAN, the model call is the wait worth naming.
      this.set({ status: 'analyzing' });
      const result = await api.upload(file);
      this.set({
        schema: result.schema,
        state: result.state,
        messages: [],
        pageAssetUrl: result.pageAssetUrl,
        pageNumber: result.schema.analyzedPages[0] ?? 1,
        status: 'ready',
        busy: false,
        analysisUsage: result.usage ?? null,
        savedAt: null,
        justUpdated: [],
      });
      history.replaceState(null, '', `#${result.schema.formId}`);
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
      this.fail(error, 'That form could not be loaded.');
    }
  }

  reset(): void {
    this.cancelPending();
    history.replaceState(null, '', ' ');
    this.set({
      schema: null,
      state: null,
      messages: [],
      pageAssetUrl: null,
      status: 'idle',
      busy: false,
      error: null,
      justUpdated: [],
      queuedLines: 0,
      lastUsage: null,
      analysisUsage: null,
      savedAt: null,
    });
  }

  setMode(mode: RenderMode): void {
    this.set({ mode });
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

    const labels = this.fieldLabels();
    const gate = isLikelyRelevant(trimmed, labels);
    if (!gate.relevant) {
      // Answered locally: no network, no tokens, no latency.
      this.appendLocalMessage({
        id: `local_ack_${Date.now()}`,
        role: 'assistant',
        content: 'Nothing to record from that.',
        at: new Date().toISOString(),
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
      const touched = [
        ...result.extraction.applied.map((u) => u.fieldId),
        ...result.extraction.pending.map((u) => u.fieldId),
      ];
      this.set({
        state: result.state,
        busy: false,
        lastUsage: result.extraction.usage ?? null,
        justUpdated: touched,
        messages: assistant
          ? [...this.snapshot.messages, assistant]
          : this.snapshot.messages,
      });
      this.scheduleFlashClear();
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
    } catch (error) {
      this.fail(error, 'The form could not be saved.');
    }
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /* -------------------------------- internals ----------------------------- */

  private fieldLabels(): string[] {
    const page = this.snapshot.schema?.pages.find((p) => p.pageNumber === this.snapshot.pageNumber);
    return page?.sections.flatMap((s) => s.fields.map((f) => f.label)) ?? [];
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
    const message = error instanceof ApiError ? error.message : fallback;
    this.set({ error: message, busy: false, status: this.snapshot.schema ? 'ready' : 'error' });
  }
}

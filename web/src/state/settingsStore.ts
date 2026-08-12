/**
 * App-owned Gemini settings: the API key and the two model choices.
 *
 * The key lives in this browser only. It is put in `localStorage` so a reload
 * does not lose it, sent on the requests that need it, and never persisted by
 * the server. That is a deliberate trade: `localStorage` is readable by any
 * script on this origin, which is acceptable for a locally run tool holding the
 * user's own key, and is the reason the UI always shows the key masked and
 * offers a one-click Forget.
 */
const KEY_STORAGE = 'formfill.geminiApiKey';
const ANALYSIS_STORAGE = 'formfill.analysisModel';
const EXTRACTION_STORAGE = 'formfill.extractionModel';

export interface ModelOption {
  id: string;
  label: string;
  note: string;
  roles: string[];
}

export interface ServerSettings {
  serverHasKey: boolean;
  mockGemini: boolean;
  defaults: { analysisModel: string; extractionModel: string };
  models: ModelOption[];
  maxAnalyzedPages: number;
  maxUploadBytes: number;
  apiKeyUrl: string;
}

export interface SettingsSnapshot {
  apiKey: string;
  analysisModel: string;
  extractionModel: string;
  server: ServerSettings | null;
  /** True when a call can be made: the app has a key, or the server does, or mock. */
  ready: boolean;
}

function read(storage: string): string {
  try {
    return localStorage.getItem(storage) ?? '';
  } catch {
    return ''; // private mode, storage disabled — the app still works for this session
  }
}

function write(storage: string, value: string): void {
  try {
    if (value) localStorage.setItem(storage, value);
    else localStorage.removeItem(storage);
  } catch {
    /* non-fatal */
  }
}

export class SettingsStore {
  private listeners = new Set<() => void>();
  private snapshot: SettingsSnapshot = {
    apiKey: read(KEY_STORAGE),
    analysisModel: read(ANALYSIS_STORAGE),
    extractionModel: read(EXTRACTION_STORAGE),
    server: null,
    ready: Boolean(read(KEY_STORAGE)),
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SettingsSnapshot => this.snapshot;

  private set(patch: Partial<SettingsSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    next.ready = Boolean(next.apiKey || next.server?.serverHasKey || next.server?.mockGemini);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Headers for any request that may reach a model. */
  headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.snapshot.apiKey) h['x-gemini-api-key'] = this.snapshot.apiKey;
    if (this.snapshot.analysisModel) h['x-gemini-analysis-model'] = this.snapshot.analysisModel;
    if (this.snapshot.extractionModel) h['x-gemini-extraction-model'] = this.snapshot.extractionModel;
    return h;
  }

  async loadServerSettings(): Promise<void> {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) return;
      const server = (await response.json()) as ServerSettings;
      this.set({
        server,
        analysisModel: this.snapshot.analysisModel || server.defaults.analysisModel,
        extractionModel: this.snapshot.extractionModel || server.defaults.extractionModel,
      });
    } catch {
      /* the settings panel falls back to sensible defaults */
    }
  }

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    write(KEY_STORAGE, trimmed);
    this.set({ apiKey: trimmed });
  }

  setModel(role: 'analysis' | 'extraction', model: string): void {
    if (role === 'analysis') {
      write(ANALYSIS_STORAGE, model);
      this.set({ analysisModel: model });
    } else {
      write(EXTRACTION_STORAGE, model);
      this.set({ extractionModel: model });
    }
  }

  forget(): void {
    write(KEY_STORAGE, '');
    this.set({ apiKey: '' });
  }

  /** Ask the server whether a key works. Free — it uses countTokens. */
  async verify(apiKey: string): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await fetch('/api/settings/verify-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), model: this.snapshot.extractionModel }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        message?: string;
        error?: { message?: string };
      };
      if (response.ok && body.ok) return { ok: true, message: body.message ?? 'Key works.' };
      return { ok: false, message: body.error?.message ?? body.message ?? 'That key was rejected.' };
    } catch {
      return { ok: false, message: 'Could not reach the server to check the key.' };
    }
  }
}

/** Masked form for display: never render a key in full. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(24, key.length - 8))}${key.slice(-4)}`;
}

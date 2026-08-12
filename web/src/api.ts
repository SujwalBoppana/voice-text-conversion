import type {
  ChatMessage,
  ExtractionResponse,
  FormEnvelope,
  FormState,
  UploadResponse,
} from '@formfill/shared';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the server. Is it running?', 0);
  }

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `Request failed with ${response.status}`,
      response.status,
    );
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  health: () =>
    request<{ ok: boolean; mockGemini: boolean; analysisModel: string; extractionModel: string }>(
      '/api/health',
    ),

  upload: (file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.append('file', file);
    return request<UploadResponse>('/api/forms', { method: 'POST', body, signal });
  },

  get: (formId: string) => request<FormEnvelope>(`/api/forms/${formId}`),

  sendMessage: (formId: string, message: string, pageNumber: number, signal?: AbortSignal) =>
    request<{ extraction: ExtractionResponse; state: FormState; messages: ChatMessage[] }>(
      `/api/forms/${formId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, pageNumber }),
        signal,
      },
    ),

  editField: (formId: string, fieldId: string, pageNumber: number, value: unknown) =>
    request<{ state: FormState }>(`/api/forms/${formId}/fields/${fieldId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageNumber, value }),
    }),

  resolveField: (formId: string, fieldId: string, pageNumber: number, choice: 'keep' | 'accept') =>
    request<{ state: FormState }>(`/api/forms/${formId}/fields/${fieldId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageNumber, choice }),
    }),

  save: (formId: string) =>
    request<{ formId: string; savedAt: string; state: FormState }>(`/api/forms/${formId}/save`, {
      method: 'POST',
    }),
};

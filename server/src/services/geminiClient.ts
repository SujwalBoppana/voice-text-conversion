/**
 * Thin wrapper over the official Google GenAI SDK (`@google/genai`).
 *
 * Everything model-facing goes through `generateJson`, so token accounting,
 * retries, JSON repair, key redaction and the structured-output contract are
 * enforced in one place rather than at each call site.
 *
 * The API key is passed in per call rather than read from configuration: it
 * normally arrives from the browser on the request that needs it (see
 * `lib/apiKey.ts`), so there is no single process-wide key to close over.
 */
import { GoogleGenAI, type GenerateContentResponse, type Schema } from '@google/genai';
import { AppError, withRetry } from '../lib/errors.js';
import { redact } from '../lib/apiKey.js';

/**
 * Clients are cached per key so a session does not rebuild one per request.
 * Bounded, because keys arrive from clients and an unbounded map would be a
 * slow leak on a shared deployment.
 */
const clients = new Map<string, GoogleGenAI>();
const MAX_CLIENTS = 32;

export function getClient(apiKey: string): GoogleGenAI {
  if (!apiKey) throw new AppError('GEMINI_NOT_CONFIGURED', 'No Gemini API key was supplied.', 401);

  const existing = clients.get(apiKey);
  if (existing) return existing;

  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest) clients.delete(oldest);
  }
  const client = new GoogleGenAI({ apiKey });
  clients.set(apiKey, client);
  return client;
}

export interface Usage {
  model: string;
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
  latencyMs: number;
}

export interface GenerateJsonArgs {
  apiKey: string;
  model: string;
  systemInstruction: string;
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
  responseSchema: Schema;
  /** 0 disables thinking (2.5 flash family); -1 lets the model choose. */
  thinkingBudget?: number;
  temperature?: number;
  maxOutputTokens?: number;
  label: string;
}

export interface GenerateJsonResult<T> {
  data: T;
  usage: Usage;
  raw: string;
}

export async function generateJson<T>(args: GenerateJsonArgs): Promise<GenerateJsonResult<T>> {
  const started = Date.now();

  let response: GenerateContentResponse;
  try {
    response = await withRetry(
      () =>
        getClient(args.apiKey).models.generateContent({
          model: args.model,
          contents: [{ role: 'user', parts: args.parts }],
          config: {
            systemInstruction: args.systemInstruction,
            // Structured output: the model is constrained to this shape, which
            // removes the "model wrote prose around the JSON" failure mode.
            responseMimeType: 'application/json',
            responseSchema: args.responseSchema,
            temperature: args.temperature ?? 0,
            ...(args.maxOutputTokens ? { maxOutputTokens: args.maxOutputTokens } : {}),
            ...(args.thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget: args.thinkingBudget } }
              : {}),
          },
        }),
      { label: args.label },
    );
  } catch (error) {
    throw toAppError(error, args.apiKey, args.model);
  }

  const usage: Usage = {
    model: args.model,
    promptTokens: response.usageMetadata?.promptTokenCount,
    responseTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount,
    latencyMs: Date.now() - started,
  };

  const text = response.text ?? '';
  if (!text.trim()) {
    const finish = response.candidates?.[0]?.finishReason;
    throw new AppError(
      'EMPTY_MODEL_RESPONSE',
      finish === 'MAX_TOKENS'
        ? 'The model ran out of output tokens before finishing. Try a smaller page or a simpler form.'
        : `The model returned no content${finish ? ` (finishReason: ${finish})` : ''}.`,
      502,
      { usage },
    );
  }

  return { data: parseJson<T>(text, args.label), usage, raw: text };
}

/**
 * Validate a key without spending output tokens.
 *
 * `countTokens` is free, requires a working key, and fails with the same auth
 * errors a real call would — so it answers "will this key work?" honestly.
 */
export async function verifyApiKey(
  apiKey: string,
  model: string,
): Promise<{ ok: true; model: string } | { ok: false; code: string; message: string }> {
  try {
    await getClient(apiKey).models.countTokens({
      model,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    });
    return { ok: true, model };
  } catch (error) {
    const appError = toAppError(error, apiKey, model);
    return { ok: false, code: appError.code, message: appError.message };
  }
}

/** Map SDK/HTTP failures onto messages that tell the user what to do next. */
function toAppError(error: unknown, apiKey: string, model: string): AppError {
  const status = (error as { status?: number })?.status;
  const raw = String((error as Error)?.message ?? error ?? '');
  const message = redact(raw, apiKey);

  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(message)) {
    return new AppError(
      'GEMINI_KEY_REJECTED',
      'Google rejected that API key. Check that it is correct and that the Generative Language API is enabled for its project.',
      401,
    );
  }
  if (status === 404 || /not found|NOT_FOUND|is not supported/i.test(message)) {
    return new AppError(
      'GEMINI_MODEL_UNAVAILABLE',
      `The model "${model}" is not available to this key. Pick a different one below.`,
      400,
    );
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return new AppError(
      'GEMINI_RATE_LIMITED',
      'Gemini rate limit or quota reached for this key. Wait a moment and try again.',
      429,
    );
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return new AppError(
      'GEMINI_UNREACHABLE',
      'Could not reach the Gemini API. Check the network connection or proxy.',
      502,
    );
  }
  return new AppError('GEMINI_CALL_FAILED', message || 'The Gemini call failed.', status ?? 502);
}

/**
 * Parse the model's JSON, tolerating the two artifacts that still slip past
 * structured output: a fenced code block, and trailing text after the object.
 */
export function parseJson<T>(text: string, label: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new AppError('MALFORMED_MODEL_JSON', `${label}: the model did not return valid JSON.`, 502, {
      preview: cleaned.slice(0, 400),
    });
  }
}

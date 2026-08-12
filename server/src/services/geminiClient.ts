/**
 * Thin wrapper over the official Google GenAI SDK (`@google/genai`).
 *
 * Everything model-facing goes through `generateJson`, so token accounting,
 * retries, JSON repair and the structured-output contract are enforced in one
 * place rather than at each call site.
 */
import { GoogleGenAI, type GenerateContentResponse, type Schema } from '@google/genai';
import { config } from '../config.js';
import { AppError, withRetry } from '../lib/errors.js';

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  if (!client) {
    if (!config.apiKey) {
      throw new AppError('GEMINI_NOT_CONFIGURED', 'GEMINI_API_KEY is not set.', 503);
    }
    client = new GoogleGenAI({ apiKey: config.apiKey });
  }
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

  const response: GenerateContentResponse = await withRetry(
    () =>
      getClient().models.generateContent({
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
      `The model returned no content${finish ? ` (finishReason: ${finish})` : ''}.`,
      502,
      { usage },
    );
  }

  return { data: parseJson<T>(text, args.label), usage, raw: text };
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

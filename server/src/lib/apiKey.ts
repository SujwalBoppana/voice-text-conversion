/**
 * Where the Gemini API key comes from.
 *
 * The key is supplied by the *client*, per request, in the `x-gemini-api-key`
 * header. `GEMINI_API_KEY` in the environment remains a fallback so that curl,
 * the smoke test and any headless deployment still work without a browser.
 *
 * The key is never written to disk, never stored in a form record, never logged
 * and never echoed back to the client — only ever held for the duration of the
 * request that carried it.
 */
import type { Request } from 'express';
import { config } from '../config.js';
import { AppError } from './errors.js';

export const API_KEY_HEADER = 'x-gemini-api-key';

export interface ResolvedKey {
  key: string;
  source: 'request' | 'environment';
}

/** Cheap shape check, so an obviously wrong paste fails locally and instantly. */
export function looksLikeApiKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,120}$/.test(value.trim());
}

export function readRequestKey(req: Request): string | null {
  const raw = req.header(API_KEY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Resolve the key for this request, or explain precisely what is missing.
 * In mock mode no key is required at all.
 */
export function resolveApiKey(req: Request): ResolvedKey {
  if (config.mockGemini) return { key: '', source: 'environment' };

  const fromRequest = readRequestKey(req);
  if (fromRequest) {
    if (!looksLikeApiKey(fromRequest)) {
      throw new AppError(
        'INVALID_API_KEY_FORMAT',
        'That does not look like a Gemini API key. Keys are 20+ characters of letters, digits, hyphens and underscores.',
        400,
      );
    }
    return { key: fromRequest, source: 'request' };
  }

  if (config.apiKey) return { key: config.apiKey, source: 'environment' };

  throw new AppError(
    'GEMINI_NOT_CONFIGURED',
    'No Gemini API key. Add one in Settings, or set GEMINI_API_KEY on the server.',
    401,
  );
}

/** Never let a key reach a log line or an error body. */
export function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join('***');
}

/**
 * Everything a model call needs, resolved from one request.
 *
 * Model ids may also be chosen in the app; the environment supplies the
 * defaults. Only ids that look like model names are accepted — the value ends
 * up in a URL path, so it is not passed through unchecked.
 */
export interface RequestContext {
  apiKey: string;
  keySource: 'request' | 'environment';
  analysisModel: string;
  extractionModel: string;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.\-_]{2,60}$/i;

function pickModel(header: string | undefined, fallback: string): string {
  const value = header?.trim();
  return value && MODEL_ID.test(value) ? value : fallback;
}

export function resolveContext(req: Request): RequestContext {
  const { key, source } = resolveApiKey(req);
  return {
    apiKey: key,
    keySource: source,
    analysisModel: pickModel(req.header('x-gemini-analysis-model'), config.analysisModel),
    extractionModel: pickModel(req.header('x-gemini-extraction-model'), config.extractionModel),
  };
}

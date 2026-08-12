/**
 * Settings the app owns rather than the environment.
 *
 * The API key lives in the browser and travels on the request that needs it, so
 * these endpoints only ever *check* a key — they never store one.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { looksLikeApiKey, readRequestKey } from '../lib/apiKey.js';
import { verifyApiKey } from '../services/geminiClient.js';

export const settingsRouter = Router();

/**
 * Models offered in the app. Kept as a short curated list with a plain-language
 * note on each, because "which model?" is otherwise an unanswerable question for
 * someone who just wants their form read. Any other id can still be set through
 * the environment.
 */
const MODEL_OPTIONS = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    note: 'Most accurate on scans and dense forms. Slower.',
    roles: ['analysis'],
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    note: 'Fast and cheap. Good for clean digital PDFs and for conversation.',
    roles: ['analysis', 'extraction'],
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    note: 'Lowest latency. Best only for short, plain dictation.',
    roles: ['extraction'],
  },
] as const;

/** GET /api/settings — what the app needs to render its settings panel. */
settingsRouter.get('/', (_req, res) => {
  res.json({
    // True when the server has its own key, in which case the app can work
    // without the user supplying one.
    serverHasKey: Boolean(config.apiKey),
    mockGemini: config.mockGemini,
    defaults: {
      analysisModel: config.analysisModel,
      extractionModel: config.extractionModel,
    },
    models: MODEL_OPTIONS,
    maxAnalyzedPages: config.maxAnalyzedPages,
    maxUploadBytes: config.maxUploadBytes,
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  });
});

/**
 * POST /api/settings/verify-key — does this key work?
 *
 * Uses countTokens, which is free, so checking a key costs the user nothing.
 */
settingsRouter.post('/verify-key', async (req, res, next) => {
  try {
    if (config.mockGemini) {
      res.json({ ok: true, mock: true, message: 'Mock mode is on — no key is needed.' });
      return;
    }

    const key = readRequestKey(req) ?? (typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '');
    if (!key) throw new AppError('NO_API_KEY', 'Supply a key to check.', 400);
    if (!looksLikeApiKey(key)) {
      throw new AppError(
        'INVALID_API_KEY_FORMAT',
        'That does not look like a Gemini API key. Keys are 20+ characters of letters, digits, hyphens and underscores.',
        400,
      );
    }

    const model =
      typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : config.extractionModel;

    const result = await verifyApiKey(key, model);
    if (result.ok) {
      res.json({ ok: true, model: result.model, message: `Key works with ${result.model}.` });
      return;
    }
    res.status(400).json({ ok: false, error: { code: result.code, message: result.message } });
  } catch (error) {
    next(error);
  }
});

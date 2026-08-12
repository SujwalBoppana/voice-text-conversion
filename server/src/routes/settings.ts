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
import { listModels } from '../services/modelCatalog.js';

export const settingsRouter = Router();

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
    maxAnalyzedPages: config.maxAnalyzedPages,
    maxUploadBytes: config.maxUploadBytes,
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  });
});

/**
 * GET /api/settings/models — the models this key can actually use.
 *
 * Queried live from Google so the picker never offers something the user's
 * project cannot run. Falls back to a small static list if the call fails, so
 * the picker is never empty.
 */
settingsRouter.get('/models', async (req, res, next) => {
  try {
    const key = readRequestKey(req) ?? config.apiKey;
    const { models, live } = await listModels(key);
    res.json({ models, live, defaults: { analysisModel: config.analysisModel, extractionModel: config.extractionModel } });
  } catch (error) {
    next(error);
  }
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
      // Warm the model list so the picker is populated the moment the key lands.
      const { models } = await listModels(key);
      res.json({
        ok: true,
        model: result.model,
        message: `Key works. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
        models,
      });
      return;
    }
    res.status(400).json({ ok: false, error: { code: result.code, message: result.message } });
  } catch (error) {
    next(error);
  }
});

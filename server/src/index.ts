import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import type { ApiError } from '@formfill/shared';
import { config } from './config.js';
import { AppError, isAppError } from './lib/errors.js';
import { formsRouter } from './routes/forms.js';
import { initStore } from './services/store.js';

const app = express();

app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(config.apiKey),
    mockGemini: config.mockGemini,
    analysisModel: config.mockGemini ? 'mock' : config.analysisModel,
    extractionModel: config.mockGemini ? 'mock' : config.extractionModel,
    maxAnalyzedPages: config.maxAnalyzedPages,
  });
});

app.use('/api/forms', formsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } } satisfies ApiError);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } } satisfies ApiError);
    return;
  }

  if (isAppError(error)) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    } satisfies ApiError);
    return;
  }

  // Upstream SDK errors carry a status; surface it rather than flattening to 500.
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message ?? 'Unexpected error';
  console.error('[error]', error);
  res.status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500).json({
    error: { code: 'INTERNAL_ERROR', message },
  } satisfies ApiError);
});

async function main() {
  await initStore();
  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(
      `[server] analysis=${config.mockGemini ? 'MOCK' : config.analysisModel} ` +
        `extraction=${config.mockGemini ? 'MOCK' : config.extractionModel} ` +
        `pages=1..${config.maxAnalyzedPages}`,
    );
    if (!config.apiKey && !config.mockGemini) {
      console.warn('[server] GEMINI_API_KEY is not set — uploads will return 503.');
    }
  });
}

main().catch((error) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});

export { app, AppError };

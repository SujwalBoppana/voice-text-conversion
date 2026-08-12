import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './lib/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(process.env.PORT, 4000),
  apiKey: process.env.GEMINI_API_KEY ?? '',

  /**
   * Model split.
   *
   * Analysis runs once per page and is the hard visual task — reading a ruled,
   * possibly scanned page and locating every blank. It gets the stronger model.
   *
   * Extraction runs on every meaningful chat turn and sits in the user's
   * critical path. It gets the fast model with thinking turned off: the work is
   * shallow (map a sentence onto a supplied list of field ids) and thinking
   * tokens would add hundreds of milliseconds for no accuracy gain.
   */
  analysisModel: process.env.GEMINI_ANALYSIS_MODEL ?? 'gemini-2.5-pro',
  extractionModel: process.env.GEMINI_EXTRACTION_MODEL ?? 'gemini-2.5-flash',

  /** Thinking budget for extraction. 0 disables thinking on the 2.5 flash family. */
  extractionThinkingBudget: int(process.env.GEMINI_EXTRACTION_THINKING_BUDGET, 0),
  /** Thinking budget for analysis. -1 lets the model decide. */
  analysisThinkingBudget: int(process.env.GEMINI_ANALYSIS_THINKING_BUDGET, -1),

  /** Serve fixtures instead of calling Gemini. For UI work and offline demos. */
  mockGemini: bool(process.env.MOCK_GEMINI, false),

  /** Only page 1 is analyzed in the MVP; raise this to widen the window. */
  maxAnalyzedPages: int(process.env.MAX_ANALYZED_PAGES, 1),

  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
  maxCatalogFields: int(process.env.MAX_CATALOG_FIELDS, 120),
  maxConversationTurns: int(process.env.MAX_CONVERSATION_TURNS, 6),

  /** Where uploads, extracted pages and saved forms live. */
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(here, '../.data'),

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
} as const;

export function assertGeminiConfigured(): void {
  if (!config.apiKey && !config.mockGemini) {
    throw new AppError(
      'GEMINI_NOT_CONFIGURED',
      'GEMINI_API_KEY is not set. Add it to server/.env, or set MOCK_GEMINI=true to run against the offline fixture.',
      503,
    );
  }
}

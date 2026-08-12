/**
 * Page analysis: uploaded document -> FormSchema.
 *
 * One model call per page, cached on the document's content hash. The MVP calls
 * this with `[1]`; the loop over pages is already here, so enabling pages 2..n
 * is a config change (`MAX_ANALYZED_PAGES`), not a rewrite.
 */
import type { FormSchema, PageSchema } from '@formfill/shared';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { analysisPayloadSchema, newFormId, normalizePage } from '../lib/normalize.js';
import {
  ANALYSIS_SYSTEM_INSTRUCTION,
  analysisResponseSchema,
  analysisUserPrompt,
} from '../schemas/analysisSchema.js';
import { generateJson, type Usage } from './geminiClient.js';
import { ingestDocument, type ExtractedPage } from './documentService.js';
import { analysisCacheKey, contentHash, getCachedAnalysis, setCachedAnalysis } from './store.js';
import { mockAnalysisPayload } from './mockGemini.js';

export interface AnalyzeResult {
  schema: FormSchema;
  pages: ExtractedPage[];
  usage: Usage & { cached: boolean };
}

export async function analyzeDocument(
  buffer: Buffer,
  opts: { filename: string; declaredMimeType?: string },
): Promise<AnalyzeResult> {
  if (buffer.byteLength > config.maxUploadBytes) {
    throw new AppError(
      'UPLOAD_TOO_LARGE',
      `The upload is ${(buffer.byteLength / 1e6).toFixed(1)} MB; the limit is ${(config.maxUploadBytes / 1e6).toFixed(0)} MB.`,
      413,
    );
  }

  const pageNumbers = Array.from({ length: config.maxAnalyzedPages }, (_, i) => i + 1);
  const ingested = await ingestDocument(buffer, {
    filename: opts.filename,
    declaredMimeType: opts.declaredMimeType,
    pageNumbers,
  });

  const hash = contentHash(buffer);
  const pages: PageSchema[] = [];
  let title = '';
  let cachedAll = true;
  const usage: Usage = { model: config.analysisModel, latencyMs: 0, promptTokens: 0, responseTokens: 0, totalTokens: 0 };

  for (const page of ingested.pages) {
    const key = analysisCacheKey(hash, page.pageNumber, config.analysisModel);
    const cached = getCachedAnalysis(key);
    if (cached) {
      pages.push(cached.schemaPage);
      title ||= cached.title;
      continue;
    }
    cachedAll = false;

    const analyzed = await analyzePage(page, opts.filename);
    usage.latencyMs += analyzed.usage.latencyMs;
    usage.promptTokens = (usage.promptTokens ?? 0) + (analyzed.usage.promptTokens ?? 0);
    usage.responseTokens = (usage.responseTokens ?? 0) + (analyzed.usage.responseTokens ?? 0);
    usage.totalTokens = (usage.totalTokens ?? 0) + (analyzed.usage.totalTokens ?? 0);

    pages.push(analyzed.page);
    title ||= analyzed.title;
    setCachedAnalysis(key, { schemaPage: analyzed.page, title: analyzed.title });
  }

  const schema: FormSchema = {
    formId: newFormId(),
    title: title || opts.filename.replace(/\.[^.]+$/, ''),
    documentName: opts.filename,
    sourceMimeType: ingested.sourceMimeType,
    pageCount: ingested.pageCount,
    analyzedPages: pages.map((p) => p.pageNumber),
    pages,
    createdAt: new Date().toISOString(),
    analysisModel: config.mockGemini ? 'mock' : config.analysisModel,
  };

  return { schema, pages: ingested.pages, usage: { ...usage, cached: cachedAll } };
}

async function analyzePage(
  page: ExtractedPage,
  filename: string,
): Promise<{ page: PageSchema; title: string; usage: Usage }> {
  if (config.mockGemini) {
    const payload = await mockAnalysisPayload();
    const { page: normalized, title } = normalizePage({
      payload: analysisPayloadSchema.parse(payload),
      pageNumber: page.pageNumber,
      dimensions: page.dimensions,
    });
    return { page: normalized, title, usage: { model: 'mock', latencyMs: 0 } };
  }

  const { data, usage } = await generateJson<unknown>({
    model: config.analysisModel,
    systemInstruction: ANALYSIS_SYSTEM_INSTRUCTION,
    parts: [
      { inlineData: { mimeType: page.mimeType, data: page.bytes.toString('base64') } },
      { text: analysisUserPrompt(page.pageNumber, filename) },
    ],
    responseSchema: analysisResponseSchema,
    thinkingBudget: config.analysisThinkingBudget,
    temperature: 0,
    label: `analysis:page${page.pageNumber}`,
  });

  const parsed = analysisPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(
      'ANALYSIS_SCHEMA_INVALID',
      'The model returned a page analysis that does not match the expected shape.',
      502,
      parsed.error.issues.slice(0, 5),
    );
  }

  const { page: normalized, title } = normalizePage({
    payload: parsed.data,
    pageNumber: page.pageNumber,
    dimensions: page.dimensions,
  });
  return { page: normalized, title, usage };
}

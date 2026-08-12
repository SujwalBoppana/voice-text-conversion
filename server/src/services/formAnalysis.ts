/**
 * Page analysis: uploaded document -> FormSchema.
 *
 * One model call per page, run concurrently and cached on the document's content
 * hash. How many leading pages are analyzed is `MAX_ANALYZED_PAGES`; everything
 * downstream is keyed by page number, so that number is the only thing that
 * changes when the scope widens.
 */
import type { FormSchema, PageSchema } from '@formfill/shared';
import { config } from '../config.js';
import type { RequestContext } from '../lib/apiKey.js';
import { AppError } from '../lib/errors.js';
import {
  analysisPayloadSchema,
  dedupeIdsAcrossPages,
  newFormId,
  normalizePage,
} from '../lib/normalize.js';
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
  opts: { filename: string; declaredMimeType?: string; ctx: RequestContext },
): Promise<AnalyzeResult> {
  const { ctx } = opts;
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
  const usage: Usage = { model: config.mockGemini ? 'mock' : ctx.analysisModel, latencyMs: 0, promptTokens: 0, responseTokens: 0, totalTokens: 0 };

  // Pages are independent, so they are analyzed concurrently: two pages cost
  // twice the tokens but roughly the same wall-clock time as one, which is what
  // keeps a multi-page scope usable. Cache hits never reach the model at all.
  const started = Date.now();
  const analyzed = await Promise.all(
    ingested.pages.map(async (page) => {
      const key = analysisCacheKey(hash, page.pageNumber, ctx.analysisModel);
      // Clones, because ids are rewritten below for cross-page uniqueness and
      // that must not reach back into the cached copy — a second upload would
      // otherwise see already-suffixed ids and suffix them again.
      const cached = getCachedAnalysis(key);
      if (cached) {
        return { page: structuredClone(cached.schemaPage), title: cached.title, usage: null };
      }

      cachedAll = false;
      const result = await analyzePage(page, opts.filename, ctx);
      setCachedAnalysis(key, { schemaPage: structuredClone(result.page), title: result.title });
      return result;
    }),
  );

  for (const result of analyzed.sort((a, b) => a.page.pageNumber - b.page.pageNumber)) {
    pages.push(result.page);
    title ||= result.title;
    if (!result.usage) continue;
    usage.promptTokens = (usage.promptTokens ?? 0) + (result.usage.promptTokens ?? 0);
    usage.responseTokens = (usage.responseTokens ?? 0) + (result.usage.responseTokens ?? 0);
    usage.totalTokens = (usage.totalTokens ?? 0) + (result.usage.totalTokens ?? 0);
  }
  // Wall-clock, not the sum of the calls — they overlapped.
  usage.latencyMs = cachedAll ? 0 : Date.now() - started;

  // Ids must be unique across the document, not just within a page.
  dedupeIdsAcrossPages(pages);

  const schema: FormSchema = {
    formId: newFormId(),
    title: title || opts.filename.replace(/\.[^.]+$/, ''),
    documentName: opts.filename,
    sourceMimeType: ingested.sourceMimeType,
    pageCount: ingested.pageCount,
    analyzedPages: pages.map((p) => p.pageNumber),
    pages,
    createdAt: new Date().toISOString(),
    analysisModel: config.mockGemini ? 'mock' : ctx.analysisModel,
  };

  return { schema, pages: ingested.pages, usage: { ...usage, cached: cachedAll } };
}

async function analyzePage(
  page: ExtractedPage,
  filename: string,
  ctx: RequestContext,
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
    apiKey: ctx.apiKey,
    model: ctx.analysisModel,
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

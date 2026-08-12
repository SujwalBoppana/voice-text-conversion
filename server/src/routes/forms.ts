import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import {
  applyManualEdit,
  buildInitialState,
  resolvePending,
  type ChatMessage,
  type FormEnvelope,
  type UploadResponse,
} from '@formfill/shared';
import { config } from '../config.js';
import { resolveContext } from '../lib/apiKey.js';
import { AppError } from '../lib/errors.js';
import { analyzeDocument } from '../services/formAnalysis.js';
import { runExtraction } from '../services/extraction.js';
import {
  getForm,
  listForms,
  putForm,
  readAsset,
  saveAsset,
  withForm,
  type FormRecord,
} from '../services/store.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

export const formsRouter = Router();

const assetUrl = (formId: string, pageNumber: number) =>
  `/api/forms/${formId}/pages/${pageNumber}/asset`;

function envelope(record: FormRecord): FormEnvelope {
  const first = record.schema.analyzedPages[0] ?? 1;
  return {
    schema: record.schema,
    state: record.state,
    messages: record.messages,
    pageAssetUrl: assetUrl(record.formId, first),
  };
}

/** POST /api/forms — upload a document and generate its schema. */
formsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('NO_FILE', 'Attach the document as the "file" field.', 400);
    const ctx = resolveContext(req);

    const { schema, pages, usage } = await analyzeDocument(req.file.buffer, {
      filename: req.file.originalname || 'upload',
      declaredMimeType: req.file.mimetype,
      ctx,
    });

    const assets: FormRecord['assets'] = {};
    for (const page of pages) {
      const file = await saveAsset(schema.formId, page.pageNumber, page.bytes, page.mimeType);
      assets[page.pageNumber] = { file, mimeType: page.mimeType };
    }

    const record = await putForm({
      formId: schema.formId,
      schema,
      state: buildInitialState(schema),
      messages: [],
      assets,
      createdAt: new Date().toISOString(),
    });

    const body: UploadResponse = {
      schema: record.schema,
      state: record.state,
      pageAssetUrl: assetUrl(record.formId, schema.analyzedPages[0] ?? 1),
      usage,
    };
    res.status(201).json(body);
  } catch (error) {
    next(error);
  }
});

/** GET /api/forms — recently created forms. */
formsRouter.get('/', (_req, res) => {
  res.json({ forms: listForms() });
});

/** GET /api/forms/:formId — schema + state + transcript. */
formsRouter.get('/:formId', (req, res, next) => {
  try {
    res.json(envelope(getForm(req.params.formId!)));
  } catch (error) {
    next(error);
  }
});

/** GET /api/forms/:formId/pages/:pageNumber/asset — the extracted page, for overlay mode. */
formsRouter.get('/:formId/pages/:pageNumber/asset', async (req, res, next) => {
  try {
    const record = getForm(req.params.formId!);
    const pageNumber = Number(req.params.pageNumber);
    const asset = record.assets[pageNumber];
    if (!asset) throw new AppError('ASSET_NOT_FOUND', `No stored page ${pageNumber}.`, 404);
    const bytes = await readAsset(asset.file);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/forms/:formId/fields/:fieldId — a manual edit. Marks the field human-owned. */
formsRouter.patch('/:formId/fields/:fieldId', async (req, res, next) => {
  try {
    const { pageNumber = 1, value } = req.body ?? {};
    const result = await withForm(req.params.formId!, (record) => {
      const next = applyManualEdit(
        record.schema,
        record.state,
        Number(pageNumber),
        req.params.fieldId!,
        value ?? null,
      );
      if (next.error) throw new AppError('FIELD_NOT_FOUND', next.error, 404);
      record.state = next.state;
      return record.state;
    });
    res.json({ state: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/forms/:formId/fields/:fieldId/resolve — settle a conflict or a clarification. */
formsRouter.post('/:formId/fields/:fieldId/resolve', async (req, res, next) => {
  try {
    const { pageNumber = 1, choice } = req.body ?? {};
    if (choice !== 'keep' && choice !== 'accept') {
      throw new AppError('BAD_CHOICE', 'choice must be "keep" or "accept".', 400);
    }
    const result = await withForm(req.params.formId!, (record) => {
      const next = resolvePending(record.state, Number(pageNumber), req.params.fieldId!, choice);
      if (next.error) throw new AppError('RESOLVE_FAILED', next.error, 400);
      record.state = next.state;
      return record.state;
    });
    res.json({ state: result });
  } catch (error) {
    next(error);
  }
});

/** POST /api/forms/:formId/messages — a conversation turn; runs extraction. */
formsRouter.post('/:formId/messages', async (req, res, next) => {
  try {
    const ctx = resolveContext(req);
    const { message, pageNumber = 1 } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      throw new AppError('EMPTY_MESSAGE', 'message must be a non-empty string.', 400);
    }
    if (message.length > 4000) {
      throw new AppError('MESSAGE_TOO_LONG', 'message must be under 4000 characters.', 413);
    }

    const result = await withForm(req.params.formId!, async (record) => {
      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: message.trim(),
        at: new Date().toISOString(),
      };
      record.messages.push(userMessage);

      const extraction = await runExtraction(record, Number(pageNumber), userMessage.content, ctx);

      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: extraction.reply || acknowledge(extraction.applied.length),
        at: new Date().toISOString(),
      };
      record.messages.push(assistantMessage);

      return { extraction, state: record.state, messages: [userMessage, assistantMessage] };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/** POST /api/forms/:formId/save — freeze the current values as a submission. */
formsRouter.post('/:formId/save', async (req, res, next) => {
  try {
    const record = await withForm(req.params.formId!, (r) => {
      r.savedAt = new Date().toISOString();
      return r;
    });
    res.json({
      formId: record.formId,
      savedAt: record.savedAt,
      state: record.state,
      schema: record.schema,
    });
  } catch (error) {
    next(error);
  }
});

function acknowledge(count: number): string {
  return count ? `Recorded ${count} field${count === 1 ? '' : 's'}.` : 'Noted.';
}

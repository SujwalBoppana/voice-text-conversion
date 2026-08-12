/**
 * Form persistence and the analysis cache.
 *
 * Two layers, both behind this one module so a real database can replace them
 * without touching a route:
 *   - a per-form record (schema + state + transcript + page assets) held in
 *     memory and mirrored to disk as JSON, so a restart does not lose a session;
 *   - an analysis cache keyed by (document content hash, page, model). Uploading
 *     the same document twice costs zero model calls, which matters because
 *     analysis is by far the most expensive call in the system.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, FormSchema, FormState } from '@formfill/shared';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface FormRecord {
  formId: string;
  schema: FormSchema;
  state: FormState;
  messages: ChatMessage[];
  /** Page assets on disk, keyed by page number. */
  assets: Record<number, { file: string; mimeType: string }>;
  savedAt?: string;
  createdAt: string;
}

const forms = new Map<string, FormRecord>();
const analysisCache = new Map<string, { schemaPage: FormSchema['pages'][number]; title: string }>();

export function contentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

export function analysisCacheKey(hash: string, pageNumber: number, model: string): string {
  return `${hash}:${pageNumber}:${model}`;
}

export function getCachedAnalysis(key: string) {
  return analysisCache.get(key);
}

export function setCachedAnalysis(
  key: string,
  value: { schemaPage: FormSchema['pages'][number]; title: string },
): void {
  analysisCache.set(key, value);
}

/* ------------------------------- form records ------------------------------ */

export async function initStore(): Promise<void> {
  await fs.mkdir(path.join(config.dataDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, 'forms'), { recursive: true });
  await hydrate();
}

async function hydrate(): Promise<void> {
  const dir = path.join(config.dataDir, 'forms');
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as FormRecord;
      forms.set(record.formId, record);
    } catch (error) {
      console.warn(`[store] skipping unreadable record ${file}: ${(error as Error).message}`);
    }
  }
  if (forms.size) console.log(`[store] restored ${forms.size} form(s) from disk`);
}

export function getForm(formId: string): FormRecord {
  const record = forms.get(formId);
  if (!record) throw new AppError('FORM_NOT_FOUND', `No form with id "${formId}".`, 404);
  return record;
}

export function listForms(): Array<{ formId: string; title: string; createdAt: string; savedAt?: string }> {
  return [...forms.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({ formId: r.formId, title: r.schema.title, createdAt: r.createdAt, savedAt: r.savedAt }));
}

export async function putForm(record: FormRecord): Promise<FormRecord> {
  forms.set(record.formId, record);
  await persist(record);
  return record;
}

/**
 * Read-modify-write under a per-form promise chain.
 *
 * Two chat turns can land in the same tick (a debounced extraction plus a manual
 * edit); serializing here keeps one from overwriting the other's field state.
 */
const locks = new Map<string, Promise<unknown>>();

export function withForm<T>(formId: string, fn: (record: FormRecord) => Promise<T> | T): Promise<T> {
  const previous = locks.get(formId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const record = getForm(formId);
    const result = await fn(record);
    await persist(record);
    return result;
  });
  locks.set(
    formId,
    next.catch(() => undefined),
  );
  return next;
}

async function persist(record: FormRecord): Promise<void> {
  const file = path.join(config.dataDir, 'forms', `${record.formId}.json`);
  try {
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    // Persistence is a convenience; the in-memory record is still authoritative.
    console.warn(`[store] could not persist ${record.formId}: ${(error as Error).message}`);
  }
}

export async function saveAsset(
  formId: string,
  pageNumber: number,
  bytes: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1] ?? 'bin';
  const file = `${formId}_p${pageNumber}.${ext}`;
  await fs.writeFile(path.join(config.dataDir, 'assets', file), bytes);
  return file;
}

export async function readAsset(file: string): Promise<Buffer> {
  const safe = path.basename(file);
  return fs.readFile(path.join(config.dataDir, 'assets', safe));
}

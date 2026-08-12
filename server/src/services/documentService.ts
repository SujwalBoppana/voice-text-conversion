/**
 * Document ingest: identify the upload, isolate the page(s) to analyze, and
 * report page geometry.
 *
 * Page extraction uses pdf-lib to copy the wanted page into a fresh single-page
 * PDF, which is then handed to Gemini as-is. Two reasons for keeping it a PDF
 * rather than rasterizing here:
 *   - the API accepts PDFs natively and renders them at its own resolution, so
 *     no native binaries (poppler / canvas) enter the deployment;
 *   - vector text stays vector text, which reads far better than a re-encoded
 *     bitmap on a digitally generated form like the sample.
 * Scanned/image-only PDFs are unaffected: their page is a bitmap either way, and
 * the model OCRs it.
 */
import { PDFDocument } from 'pdf-lib';
import { AppError } from '../lib/errors.js';

export interface ExtractedPage {
  pageNumber: number;
  /** Bytes to send to the model and to store as the overlay background. */
  bytes: Buffer;
  mimeType: string;
  /** Page size in points (PDF) or pixels (image). */
  dimensions: { width: number; height: number };
}

export interface IngestResult {
  sourceMimeType: string;
  pageCount: number;
  pages: ExtractedPage[];
}

const PDF_MAGIC = '%PDF-';

export function detectMimeType(buffer: Buffer, declared?: string, filename?: string): string {
  if (buffer.subarray(0, 5).toString('latin1') === PDF_MAGIC) return 'application/pdf';
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (declared && /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(declared)) return declared;
  const ext = filename?.toLowerCase().match(/\.(pdf|png|jpe?g|webp)$/)?.[1];
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  throw new AppError(
    'UNSUPPORTED_MEDIA_TYPE',
    'Upload must be a PDF, PNG, JPEG or WebP document.',
    415,
  );
}

/**
 * Extract the requested pages.
 *
 * `pageNumbers` defaults to `[1]` for the MVP, but the signature is plural on
 * purpose: widening to `[1,2,3,4]` later is a caller-side change only, and every
 * layer downstream is already keyed by page number.
 */
export async function ingestDocument(
  buffer: Buffer,
  opts: { declaredMimeType?: string; filename?: string; pageNumbers?: number[] } = {},
): Promise<IngestResult> {
  const mimeType = detectMimeType(buffer, opts.declaredMimeType, opts.filename);
  const wanted = opts.pageNumbers ?? [1];

  if (mimeType !== 'application/pdf') {
    const dimensions = imageDimensions(buffer, mimeType) ?? { width: 1000, height: 1414 };
    return {
      sourceMimeType: mimeType,
      pageCount: 1,
      pages: [{ pageNumber: 1, bytes: buffer, mimeType, dimensions }],
    };
  }

  let source: PDFDocument;
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (error) {
    throw new AppError('PDF_PARSE_FAILED', `Could not read the PDF: ${(error as Error).message}`, 422);
  }

  const pageCount = source.getPageCount();
  if (pageCount === 0) throw new AppError('EMPTY_PDF', 'The PDF has no pages.', 422);

  const pages: ExtractedPage[] = [];
  for (const pageNumber of wanted) {
    if (pageNumber < 1 || pageNumber > pageCount) continue;
    const single = await PDFDocument.create();
    const [copied] = await single.copyPages(source, [pageNumber - 1]);
    if (!copied) continue;
    single.addPage(copied);
    const { width, height } = copied.getSize();
    pages.push({
      pageNumber,
      bytes: Buffer.from(await single.save()),
      mimeType: 'application/pdf',
      dimensions: { width: round(width), height: round(height) },
    });
  }

  if (!pages.length) {
    throw new AppError('PAGE_OUT_OF_RANGE', `The document has ${pageCount} page(s).`, 422);
  }

  return { sourceMimeType: mimeType, pageCount, pages };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Minimal header readers, enough for the aspect ratio used by overlay mode. */
function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1]!;
        const size = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15, skipping the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + size;
      }
    }
    if (mimeType === 'image/webp' && buffer.subarray(12, 16).toString('latin1') === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    // Fall through to the caller's default aspect ratio.
  }
  return null;
}

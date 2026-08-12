/**
 * Mode B — the original page as background, with live inputs positioned over the
 * detected blanks.
 *
 * This mode needs nothing the schema does not already carry: because every bbox
 * was normalized to 0..1 of the page at analysis time, the same numbers place an
 * input correctly at any rendered width. That is the reason coordinates were in
 * the schema from the first commit rather than added later.
 *
 * The page is rasterized in the browser (pdf.js), so the server stays free of
 * native rendering dependencies.
 */
import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  emptyFieldState,
  type FieldValue,
  type FormSchema,
  type FormState,
} from '@formfill/shared';
import { FieldControl } from './FieldControl';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  schema: FormSchema;
  state: FormState;
  pageNumber: number;
  assetUrl: string;
  justUpdated: string[];
  onChange: (fieldId: string, value: FieldValue) => void;
  onResolve: (fieldId: string, choice: 'keep' | 'accept') => void;
}

export function OverlayRenderer({
  schema,
  state,
  pageNumber,
  assetUrl,
  justUpdated,
  onChange,
  onResolve,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const isPdf = schema.sourceMimeType === 'application/pdf';
  const page = schema.pages.find((p) => p.pageNumber === pageNumber);

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;

    (async () => {
      try {
        task = pdfjs.getDocument({ url: assetUrl, withCredentials: true });
        const doc = await task.promise;
        if (cancelled) return;
        // The stored asset is the single extracted page, so it is always page 1.
        const pdfPage = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        const scale = Math.min(2, (window.devicePixelRatio || 1) * 1.5);
        const viewport = pdfPage.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        if (!context) return;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        if (!cancelled) setRendered(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [assetUrl, isPdf]);

  if (!page) return <p className="empty">Page {pageNumber} has not been analyzed.</p>;

  const aspect = page.dimensions.height / page.dimensions.width;
  const flash = new Set(justUpdated);

  return (
    <div className="overlay-scroll">
      <div className="overlay-page" style={{ aspectRatio: `${page.dimensions.width} / ${page.dimensions.height}` }}>
        {isPdf ? (
          <canvas ref={canvasRef} className="overlay-bg" />
        ) : (
          <img className="overlay-bg" src={assetUrl} alt={`Page ${pageNumber}`} />
        )}

        {!rendered && isPdf && !error && <div className="overlay-loading">Rendering page…</div>}
        {error && <div className="overlay-loading error">Could not render the page: {error}</div>}

        {page.sections.map((section) => (
          <div
            key={section.id}
            className="overlay-section"
            title={section.title}
            style={{
              left: `${section.bbox.x * 100}%`,
              top: `${section.bbox.y * 100}%`,
              width: `${section.bbox.width * 100}%`,
              height: `${section.bbox.height * 100}%`,
            }}
          />
        ))}

        {page.sections.flatMap((section) =>
          section.fields.map((field) => (
            <div
              key={field.id}
              className="overlay-field"
              style={{
                left: `${field.bbox.x * 100}%`,
                top: `${field.bbox.y * 100}%`,
                width: `${field.bbox.width * 100}%`,
                // Very thin blanks are hard to click; give every box a floor.
                minHeight: `${Math.max(field.bbox.height, 0.018) * 100 * aspect * 0.01}%`,
              }}
            >
              <FieldControl
                field={field}
                state={state.pages[pageNumber]?.[field.id] ?? emptyFieldState()}
                flash={flash.has(field.id)}
                compact
                onChange={(value) => onChange(field.id, value)}
                onResolve={(choice) => onResolve(field.id, choice)}
              />
            </div>
          )),
        )}
      </div>
    </div>
  );
}

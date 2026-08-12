/**
 * Mode A — the dynamic HTML form.
 *
 * Layout comes from the detected geometry, not from a fixed template: sections
 * whose boxes overlap vertically are rendered as side-by-side columns, and
 * fields that shared a printed line are rendered on one row with widths
 * proportional to the printed blanks. The result reads like the original page
 * instead of a generic stack of labelled inputs.
 */
import { useEffect, useRef } from 'react';
import {
  emptyFieldState,
  groupIntoRows,
  groupSectionsIntoBands,
  rowWeights,
  type FieldValue,
  type FormSchema,
  type FormState,
} from '@formfill/shared';
import { FieldControl } from './FieldControl';

interface Props {
  schema: FormSchema;
  state: FormState;
  pageNumber: number;
  justUpdated: string[];
  /** Field to scroll into view and highlight, set after an extraction. */
  focusFieldId?: string | null;
  onFocusHandled?: () => void;
  onChange: (fieldId: string, value: FieldValue) => void;
  onResolve: (fieldId: string, choice: 'keep' | 'accept') => void;
}

export const fieldAnchorId = (fieldId: string) => `field-${fieldId}`;

export function FormRenderer({
  schema,
  state,
  pageNumber,
  justUpdated,
  focusFieldId,
  onFocusHandled,
  onChange,
  onResolve,
}: Props) {
  const container = useRef<HTMLElement | null>(null);

  // Bring the field the conversation just touched into view. Without this the
  // user watches a chat reply say "recorded 6 fields" while looking at a part of
  // the form where nothing changed.
  useEffect(() => {
    if (!focusFieldId) return;
    const node = document.getElementById(fieldAnchorId(focusFieldId));
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('targeted');
      setTimeout(() => node.classList.remove('targeted'), 2000);
    }
    onFocusHandled?.();
  }, [focusFieldId, onFocusHandled]);

  const page = schema.pages.find((p) => p.pageNumber === pageNumber);
  if (!page) return <p className="empty">Page {pageNumber} has not been analyzed.</p>;

  const bands = groupSectionsIntoBands(page.sections);
  const flash = new Set(justUpdated);

  return (
    <article className="paper" aria-label={schema.title} ref={container}>
      <header className="paper-head">
        <h1>{schema.title}</h1>
        <p className="paper-sub">
          {schema.documentName} · page {pageNumber} of {schema.pageCount}
        </p>
      </header>

      {bands.map((band, bandIndex) => (
        <div
          className="band"
          key={band.map((s) => s.id).join('_') || bandIndex}
          style={{ gridTemplateColumns: band.map((s) => `${Math.max(s.bbox.width, 0.1)}fr`).join(' ') }}
        >
          {band.map((section) => (
            <section className="section" key={section.id} aria-label={section.title}>
              <h2 className="section-title">{section.title}</h2>
              {groupIntoRows(section.fields).map((row, rowIndex) => {
                const weights = rowWeights(row);
                return (
                  <div className="row" key={row.fields.map((f) => f.id).join('_') || rowIndex}>
                    {row.fields.map((field, i) => (
                      <div
                        className="cell"
                        key={field.id}
                        id={fieldAnchorId(field.id)}
                        style={{ flexGrow: weights[i] ?? 1 }}
                      >
                        <FieldControl
                          field={field}
                          state={state.pages[pageNumber]?.[field.id] ?? emptyFieldState()}
                          flash={flash.has(field.id)}
                          onChange={(value) => onChange(field.id, value)}
                          onResolve={(choice) => onResolve(field.id, choice)}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ))}
    </article>
  );
}

/**
 * Mode A — the dynamic HTML form.
 *
 * Layout comes from the detected geometry, not from a fixed template: sections
 * whose boxes overlap vertically are rendered as side-by-side columns, and
 * fields that shared a printed line are rendered on one row with widths
 * proportional to the printed blanks. The result reads like the original page
 * instead of a generic stack of labelled inputs.
 */
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
  onChange: (fieldId: string, value: FieldValue) => void;
  onResolve: (fieldId: string, choice: 'keep' | 'accept') => void;
}

export function FormRenderer({ schema, state, pageNumber, justUpdated, onChange, onResolve }: Props) {
  const page = schema.pages.find((p) => p.pageNumber === pageNumber);
  if (!page) return <p className="empty">Page {pageNumber} has not been analyzed.</p>;

  const bands = groupSectionsIntoBands(page.sections);
  const flash = new Set(justUpdated);

  return (
    <article className="paper" aria-label={schema.title}>
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
            <section className="section" key={section.id}>
              <h2 className="section-title">{section.title}</h2>
              {groupIntoRows(section.fields).map((row, rowIndex) => {
                const weights = rowWeights(row);
                return (
                  <div className="row" key={row.fields.map((f) => f.id).join('_') || rowIndex}>
                    {row.fields.map((field, i) => (
                      <div className="cell" key={field.id} style={{ flexGrow: weights[i] ?? 1 }}>
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

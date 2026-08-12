/**
 * ⌘K / Ctrl-K jump-to-field.
 *
 * A real form page runs to dozens of fields — the sample is 50 — and scrolling
 * to find one is the slowest thing in the app. Typing two letters and pressing
 * Enter is the fastest, so it gets a keyboard-first surface with no mouse path
 * required.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormSchema, FormState } from '@formfill/shared';

interface Props {
  schema: FormSchema;
  state: FormState;
  pageNumber: number;
  onPick: (fieldId: string) => void;
  onClose: () => void;
}

interface Row {
  id: string;
  label: string;
  /** Printed qualifier, e.g. "at 1 min of life" — the only thing separating
      three fields that share a label. */
  context: string;
  section: string;
  status: string;
  filled: boolean;
  needsReview: boolean;
}

export function FieldFinder({ schema, state, pageNumber, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const rows = useMemo<Row[]>(() => {
    const page = schema.pages.find((p) => p.pageNumber === pageNumber);
    const values = state.pages[pageNumber] ?? {};
    return (
      page?.sections.flatMap((section) =>
        section.fields.map((field) => {
          const fs = values[field.id];
          return {
            id: field.id,
            label: field.label,
            context: field.context ?? '',
            section: section.title,
            status: fs?.status ?? 'missing',
            filled: fs?.value !== null && fs?.value !== undefined,
            needsReview: Boolean(fs?.pending),
          };
        }),
      ) ?? []
    );
  }, [schema, state, pageNumber]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      // With no query, lead with anything awaiting a decision, then empties.
      return [...rows].sort((a, b) => {
        const rank = (r: Row) => (r.needsReview ? 0 : r.filled ? 2 : 1);
        return rank(a) - rank(b);
      });
    }
    return rows
      .map((row) => {
        const haystack = `${row.label} ${row.context} ${row.section}`.toLowerCase();
        const index = haystack.indexOf(needle);
        return { row, score: index < 0 ? Infinity : index };
      })
      .filter((r) => r.score !== Infinity)
      .sort((a, b) => a.score - b.score)
      .map((r) => r.row);
  }, [rows, query]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Keep the highlighted row inside the scroll viewport during arrow paging.
  useEffect(() => {
    listRef.current?.querySelector('.finder-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    onPick(row.id);
    onClose();
  };

  return (
    <div
      className="modal-backdrop finder-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finder" role="dialog" aria-modal="true" aria-label="Find a field">
        <input
          ref={input}
          className="finder-input"
          type="text"
          placeholder="Jump to a field…"
          aria-label="Field name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              choose(results[cursor]);
            }
          }}
        />

        <ul className="finder-list" ref={listRef}>
          {results.slice(0, 60).map((row, i) => (
            <li key={row.id}>
              <button
                className={`finder-row ${i === cursor ? 'active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(row)}
              >
                <span className="finder-label">
                  {row.label}
                  {row.context && <em className="finder-context">{row.context}</em>}
                </span>
                <span className="finder-section">{row.section}</span>
                {row.needsReview ? (
                  <span className="chip pending">review</span>
                ) : row.filled ? (
                  <span className="chip filled">filled</span>
                ) : (
                  <span className="chip muted">empty</span>
                )}
              </button>
            </li>
          ))}
          {!results.length && <li className="finder-empty">No field matches “{query}”.</li>}
        </ul>

        <footer className="finder-foot">
          <span>↑↓ move · ↵ jump · esc close</span>
          <span>{results.length} fields</span>
        </footer>
      </div>
    </div>
  );
}

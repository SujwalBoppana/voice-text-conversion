/**
 * Renders one field from its schema definition. Every branch here is driven by
 * `field.type` and `field.options` — there is no field-name knowledge anywhere,
 * which is what lets an entirely different document render tomorrow.
 */
import { useEffect, useRef, useState } from 'react';
import type { FieldState, FieldValue, FormField } from '@formfill/shared';

interface Props {
  field: FormField;
  state: FieldState;
  flash: boolean;
  compact?: boolean;
  onChange: (value: FieldValue) => void;
  onResolve: (choice: 'keep' | 'accept') => void;
}

/** Local text state so typing is not throttled by the persistence round-trip. */
function useDraft(value: FieldValue): [string, (v: string) => void, () => void] {
  const asText = value === null || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(asText);
  }, [asText]);

  return [
    draft,
    (v: string) => {
      dirty.current = true;
      setDraft(v);
    },
    () => {
      dirty.current = false;
    },
  ];
}

export function FieldControl({ field, state, flash, compact, onChange, onResolve }: Props) {
  const [draft, setDraft, settle] = useDraft(state.value);
  const commitText = () => {
    settle();
    const next = draft.trim();
    const current = state.value === null ? '' : String(state.value);
    if (next !== current) onChange(next === '' ? null : next);
  };

  const inputId = `f_${field.id}`;
  const classes = [
    'control',
    `status-${state.status}`,
    state.source === 'conversation' ? 'from-conversation' : '',
    flash ? 'flash' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const common = {
    id: inputId,
    className: classes,
    'aria-label': field.label,
    'aria-invalid': state.status === 'conflict' || undefined,
  };

  let control: JSX.Element;

  switch (field.type) {
    case 'textarea':
      control = (
        <textarea
          {...common}
          rows={compact ? 2 : 3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
        />
      );
      break;

    case 'boolean': {
      const options = field.options?.length === 2 ? field.options : ['Yes', 'No'];
      const current = state.value === null ? '' : state.value ? options[0]! : options[1]!;
      // Over the original page a blank is only a few millimetres tall, so chips
      // would spill across neighbouring printed text. A select fits the blank.
      if (compact) {
        control = (
          <select
            {...common}
            value={current}
            onChange={(e) =>
              onChange(e.target.value === '' ? null : e.target.value === options[0])
            }
          >
            <option value="">—</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
        break;
      }
      control = (
        <div className={`${classes} choices`} role="radiogroup" aria-label={field.label}>
          {options.map((option, i) => (
            <label key={option} className={current === option ? 'choice selected' : 'choice'}>
              <input
                type="radio"
                name={inputId}
                checked={current === option}
                onChange={() => onChange(i === 0)}
              />
              {option}
            </label>
          ))}
          {state.value !== null && (
            <button type="button" className="clear" title="Clear" onClick={() => onChange(null)}>
              ×
            </button>
          )}
        </div>
      );
      break;
    }

    case 'radio': {
      const options = field.options ?? [];
      // A long option list is unusable as chips; fall back to a dropdown.
      if (options.length > 5 || compact) {
        control = (
          <select
            {...common}
            value={typeof state.value === 'string' ? state.value : ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">—</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      } else {
        control = (
          <div className={`${classes} choices`} role="radiogroup" aria-label={field.label}>
            {options.map((option) => (
              <label key={option} className={state.value === option ? 'choice selected' : 'choice'}>
                <input
                  type="radio"
                  name={inputId}
                  checked={state.value === option}
                  onChange={() => onChange(option)}
                />
                {option}
              </label>
            ))}
            {state.value !== null && (
              <button type="button" className="clear" title="Clear" onClick={() => onChange(null)}>
                ×
              </button>
            )}
          </div>
        );
      }
      break;
    }

    case 'select':
      control = (
        <select
          {...common}
          value={typeof state.value === 'string' ? state.value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;

    case 'multiselect':
    case 'checkbox': {
      const selected = Array.isArray(state.value) ? (state.value as string[]) : [];
      control = (
        <div className={`${classes} choices`}>
          {(field.options ?? []).map((option) => (
            <label key={option} className={selected.includes(option) ? 'choice selected' : 'choice'}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, option]
                    : selected.filter((s) => s !== option);
                  onChange(next.length ? next : null);
                }}
              />
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }

    case 'table': {
      const columns = field.columns ?? [];
      const rows = Array.isArray(state.value) ? (state.value as Array<Record<string, string>>) : [];
      const update = (rowIndex: number, columnId: string, value: string) => {
        const next = rows.map((r, i) => (i === rowIndex ? { ...r, [columnId]: value } : r));
        onChange(next);
      };
      control = (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.id}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(rows.length ? rows : [Object.fromEntries(columns.map((c) => [c.id, '']))]).map(
                (row, rowIndex) => (
                  <tr key={rowIndex}>
                    {columns.map((c) => (
                      <td key={c.id}>
                        <input
                          value={row[c.id] ?? ''}
                          onChange={(e) => {
                            if (!rows.length) onChange([{ [c.id]: e.target.value }]);
                            else update(rowIndex, c.id, e.target.value);
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ),
              )}
            </tbody>
          </table>
          <button
            type="button"
            className="ghost small"
            onClick={() => onChange([...rows, Object.fromEntries(columns.map((c) => [c.id, '']))])}
          >
            + row
          </button>
        </div>
      );
      break;
    }

    default: {
      const inputType =
        field.type === 'date'
          ? 'date'
          : field.type === 'time'
            ? 'time'
            : field.type === 'datetime'
              ? 'datetime-local'
              : field.type === 'number' || field.type === 'decimal'
                ? 'number'
                : 'text';
      control = (
        <input
          {...common}
          type={inputType}
          step={field.type === 'decimal' ? 'any' : field.type === 'number' ? '1' : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      );
    }
  }

  const pendingText = formatValue(state.pending?.value);

  // In overlay mode the page itself prints the label, so repeating it would
  // cover the document. Only the status affordances are drawn over the scan.
  if (compact) {
    return (
      <div className="field compact" title={`${field.label}${field.unit ? ` (${field.unit})` : ''}`}>
        <div className="field-control">{control}</div>
        {state.pending && (
          <div className={`resolve floating ${state.status}`}>
            <div className="resolve-text">
              {state.status === 'conflict' ? (
                <>
                  Heard <b>{pendingText}</b>, form holds <b>{formatValue(state.value)}</b>.
                </>
              ) : (
                <>
                  Heard <b>{pendingText}</b> — {state.note}
                </>
              )}
            </div>
            <div className="resolve-actions">
              <button type="button" className="ghost small" onClick={() => onResolve('keep')}>
                {state.value === null ? 'Dismiss' : 'Keep'}
              </button>
              <button type="button" className="primary small" onClick={() => onResolve('accept')}>
                Use {pendingText}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        <span>{field.label}</span>
        {field.required && <span className="req" title="Marked required on the document">*</span>}
        {field.unit && <span className="unit">({field.unit})</span>}
        {field.context && <span className="context">{field.context}</span>}
        {state.source === 'conversation' && state.status === 'confirmed' && (
          <span className="badge auto" title={state.evidence ?? 'Filled from the conversation'}>
            auto
          </span>
        )}
      </label>

      <div className="field-control">{control}</div>

      {state.pending && (
        <div className={`resolve ${state.status}`}>
          <div className="resolve-text">
            {state.status === 'conflict' ? (
              <>
                Conversation says <b>{pendingText}</b>, the form holds{' '}
                <b>{formatValue(state.value)}</b>.
              </>
            ) : (
              <>
                Heard <b>{pendingText}</b> — {state.note}
              </>
            )}
            {state.pending.evidence && <em className="evidence">“{state.pending.evidence}”</em>}
          </div>
          <div className="resolve-actions">
            <button type="button" className="ghost small" onClick={() => onResolve('keep')}>
              {state.value === null ? 'Dismiss' : 'Keep current'}
            </button>
            <button type="button" className="primary small" onClick={() => onResolve('accept')}>
              Use {pendingText}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatValue(value: FieldValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  }
  return String(value);
}

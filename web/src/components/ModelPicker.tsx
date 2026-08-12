/**
 * Model selection as a list of cards rather than a dropdown.
 *
 * The choice has consequences a user cannot guess from an id — one model runs
 * once and decides how well the form is read, the other runs on every message
 * and decides how fast the app feels. The card carries that trade-off next to
 * the name, so the decision can be made without leaving the dialog.
 */
import { useMemo, useState } from 'react';
import type { ModelChoice, ModelRole } from '../state/settingsStore';

interface Props {
  role: ModelRole;
  title: string;
  subtitle: string;
  models: ModelChoice[];
  selected: string;
  loading: boolean;
  live: boolean;
  onSelect: (modelId: string) => void;
}

const SHOW_INITIALLY = 4;

export function ModelPicker({
  role,
  title,
  subtitle,
  models,
  selected,
  loading,
  live,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
    );
  }, [models, filter]);

  // The selected model is always visible, even when it sorts below the cut.
  const visible = useMemo(() => {
    if (expanded || filter) return filtered;
    const head = filtered.slice(0, SHOW_INITIALLY);
    if (selected && !head.some((m) => m.id === selected)) {
      const chosen = filtered.find((m) => m.id === selected);
      if (chosen) return [...head, chosen];
    }
    return head;
  }, [filtered, expanded, filter, selected]);

  const hidden = filtered.length - visible.length;

  return (
    <section className="setting model-picker">
      <div className="model-picker-head">
        <div>
          <span className="setting-label">{title}</span>
          <p className="setting-hint">{subtitle}</p>
        </div>
        {models.length > SHOW_INITIALLY && (
          <input
            className="text-input filter"
            type="search"
            placeholder="Filter…"
            aria-label={`Filter models for ${title}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>

      {loading && !models.length && <div className="model-card skeleton" aria-hidden="true" />}

      {!loading && !models.length && (
        <p className="callout">
          No model list yet — add a working API key and the models your project can use will appear
          here.
        </p>
      )}

      <div className="model-list" role="radiogroup" aria-label={title}>
        {visible.map((model) => {
          const isSelected = model.id === selected;
          return (
            <label key={model.id} className={`model-card ${isSelected ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`model-${role}`}
                checked={isSelected}
                onChange={() => onSelect(model.id)}
              />
              <span className="model-body">
                <span className="model-title">
                  <b>{model.label}</b>
                  {model.recommendedFor === role && <span className="badge ok">recommended</span>}
                  {isSelected && <span className="check" aria-hidden="true">✓</span>}
                </span>
                <span className="model-note">{model.note}</span>
                <span className="model-id mono">{model.id}</span>
              </span>
            </label>
          );
        })}
      </div>

      {hidden > 0 && !filter && (
        <button type="button" className="ghost small" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      )}
      {expanded && !filter && (
        <button type="button" className="ghost small" onClick={() => setExpanded(false)}>
          Show fewer
        </button>
      )}
      {filter && !filtered.length && <p className="setting-hint">No model matches “{filter}”.</p>}

      {!live && models.length > 0 && (
        <p className="setting-hint">
          Showing built-in defaults — the live list loads once a working key is saved.
        </p>
      )}
    </section>
  );
}

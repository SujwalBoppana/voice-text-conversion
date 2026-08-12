import type { Toast } from '../state/formSession';

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const ICON: Record<Toast['kind'], string> = {
  info: 'ℹ',
  success: '✓',
  warn: '⚠',
  error: '✕',
};

export function Toasts({ toasts, onDismiss }: Props) {
  if (!toasts.length) return null;

  return (
    // Errors are assertive; everything else should not interrupt a screen reader
    // mid-sentence, so the region is polite and the list is short-lived.
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span className="toast-icon" aria-hidden="true">
            {ICON[toast.kind]}
          </span>
          <span className="toast-message">{toast.message}</span>
          {toast.action && (
            <button className="toast-action" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

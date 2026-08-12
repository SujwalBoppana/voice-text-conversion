/**
 * Where the Gemini API key and model choices are set — in the app, not in a
 * .env file. The key is checked before it is accepted, so a bad paste is caught
 * here rather than surfacing as a failed upload thirty seconds later.
 */
import { useEffect, useRef, useState } from 'react';
import { maskKey, type SettingsSnapshot, type SettingsStore } from '../state/settingsStore';

interface Props {
  store: SettingsStore;
  settings: SettingsSnapshot;
  onClose: () => void;
  /** Shown when the dialog was opened because something needed a key. */
  reason?: string | null;
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

export function SettingsDialog({ store, settings, onClose, reason }: Props) {
  const { server } = settings;
  const [draft, setDraft] = useState(settings.apiKey);
  const [revealed, setRevealed] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const input = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = draft.trim() !== settings.apiKey;

  const saveKey = async () => {
    const value = draft.trim();
    if (!value) {
      store.forget();
      setCheck({ kind: 'idle' });
      return;
    }
    setCheck({ kind: 'checking' });
    const result = await store.verify(value);
    if (result.ok) {
      store.setApiKey(value);
      setCheck({ kind: 'ok', message: result.message });
    } else {
      setCheck({ kind: 'error', message: result.message });
    }
  };

  const analysisModels = server?.models.filter((m) => m.roles.includes('analysis')) ?? [];
  const extractionModels = server?.models.filter((m) => m.roles.includes('extraction')) ?? [];

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialog}>
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <div className="modal-body">
          {reason && <p className="callout warn">{reason}</p>}

          {server?.mockGemini && (
            <p className="callout">
              The server is running in <b>mock mode</b>, so no key is needed. Uploads return a
              captured sample instead of calling Gemini.
            </p>
          )}

          <section className="setting">
            <label className="setting-label" htmlFor="api-key">
              Gemini API key
            </label>
            <p className="setting-hint">
              Get one free at{' '}
              <a href={server?.apiKeyUrl ?? 'https://aistudio.google.com/apikey'} target="_blank" rel="noreferrer">
                aistudio.google.com/apikey
              </a>
              . It is stored in this browser and sent only to your own server — never saved there.
            </p>

            <div className="key-row">
              <input
                id="api-key"
                ref={input}
                className="text-input mono"
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder="AIza…"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCheck({ kind: 'idle' });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) void saveKey();
                }}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => setRevealed((v) => !v)}
                aria-pressed={revealed}
              >
                {revealed ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!dirty || check.kind === 'checking'}
                onClick={() => void saveKey()}
              >
                {check.kind === 'checking' ? 'Checking…' : 'Check & save'}
              </button>
            </div>

            {check.kind === 'ok' && <p className="callout ok">✓ {check.message}</p>}
            {check.kind === 'error' && <p className="callout error">{check.message}</p>}

            {settings.apiKey && !dirty && (
              <div className="key-status">
                <span className="badge ok">saved in this browser</span>
                <code className="mono">{maskKey(settings.apiKey)}</code>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    store.forget();
                    setDraft('');
                    setCheck({ kind: 'idle' });
                  }}
                >
                  Forget key
                </button>
              </div>
            )}

            {!settings.apiKey && server?.serverHasKey && (
              <p className="setting-hint">
                No key set here — the server has its own and will use that.
              </p>
            )}
          </section>

          {analysisModels.length > 0 && (
            <section className="setting">
              <label className="setting-label" htmlFor="analysis-model">
                Model for reading the page
              </label>
              <p className="setting-hint">Runs once per upload. This is the hard visual task.</p>
              <select
                id="analysis-model"
                className="text-input"
                value={settings.analysisModel}
                onChange={(e) => store.setModel('analysis', e.target.value)}
              >
                {analysisModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </section>
          )}

          {extractionModels.length > 0 && (
            <section className="setting">
              <label className="setting-label" htmlFor="extraction-model">
                Model for the conversation
              </label>
              <p className="setting-hint">
                Runs on every message you send, so it is chosen for speed.
              </p>
              <select
                id="extraction-model"
                className="text-input"
                value={settings.extractionModel}
                onChange={(e) => store.setModel('extraction', e.target.value)}
              >
                {extractionModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </section>
          )}

          {server && (
            <p className="setting-hint">
              This server processes <b>page {server.maxAnalyzedPages === 1 ? '1 only' : `1–${server.maxAnalyzedPages}`}</b>{' '}
              and accepts uploads up to {Math.round(server.maxUploadBytes / 1e6)} MB.
            </p>
          )}
        </div>

        <footer className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

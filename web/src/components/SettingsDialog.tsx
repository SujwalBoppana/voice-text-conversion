/**
 * Where the Gemini API key and model choices are set — in the app, not in a
 * .env file. The key is checked before it is accepted, so a bad paste is caught
 * here rather than surfacing as a failed upload thirty seconds later.
 *
 * Two tabs, because the two decisions are unrelated and the key one is a
 * prerequisite: no point showing an empty model list to someone who has not
 * pasted a key yet.
 */
import { useEffect, useRef, useState } from 'react';
import { maskKey, type SettingsSnapshot, type SettingsStore } from '../state/settingsStore';
import { ModelPicker } from './ModelPicker';

export type SettingsTab = 'key' | 'models';

interface Props {
  store: SettingsStore;
  settings: SettingsSnapshot;
  onClose: () => void;
  /** Shown when the dialog was opened because something needed a key. */
  reason?: string | null;
  initialTab?: SettingsTab;
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

export function SettingsDialog({ store, settings, onClose, reason, initialTab = 'key' }: Props) {
  const { server } = settings;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [draft, setDraft] = useState(settings.apiKey);
  const [revealed, setRevealed] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const input = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, [tab]);

  // Escape closes; Tab is trapped inside the dialog so focus cannot wander
  // behind the backdrop, which is the usual way a modal becomes unusable by
  // keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog.current) return;
      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = draft.trim() !== settings.apiKey;
  const hasKey = Boolean(settings.apiKey || server?.serverHasKey || server?.mockGemini);

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
      store.setApiKey(value, result.models);
      setCheck({ kind: 'ok', message: result.message });
    } else {
      setCheck({ kind: 'error', message: result.message });
    }
  };

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

        <div className="tabs" role="tablist" aria-label="Settings sections">
          <button
            role="tab"
            aria-selected={tab === 'key'}
            className={tab === 'key' ? 'tab active' : 'tab'}
            onClick={() => setTab('key')}
          >
            API key
            {hasKey && <span className="dot ok" aria-label="configured" />}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'models'}
            className={tab === 'models' ? 'tab active' : 'tab'}
            onClick={() => setTab('models')}
          >
            Models
            {settings.models.length > 0 && <span className="tab-count">{settings.models.length}</span>}
          </button>
        </div>

        <div className="modal-body">
          {reason && <p className="callout warn">{reason}</p>}

          {server?.mockGemini && (
            <p className="callout">
              The server is running in <b>mock mode</b>, so no key is needed. Uploads return a
              captured sample instead of calling Gemini.
            </p>
          )}

          {tab === 'key' && (
            <section className="setting">
              <label className="setting-label" htmlFor="api-key">
                Gemini API key
              </label>
              <p className="setting-hint">
                Get one free at{' '}
                <a
                  href={server?.apiKeyUrl ?? 'https://aistudio.google.com/apikey'}
                  target="_blank"
                  rel="noreferrer"
                >
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

              {check.kind === 'ok' && (
                <p className="callout ok">
                  ✓ {check.message}{' '}
                  <button type="button" className="link" onClick={() => setTab('models')}>
                    Choose models →
                  </button>
                </p>
              )}
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

              {server && (
                <p className="setting-hint spaced">
                  This server processes{' '}
                  <b>
                    page {server.maxAnalyzedPages === 1 ? '1 only' : `1–${server.maxAnalyzedPages}`}
                  </b>{' '}
                  and accepts uploads up to {Math.round(server.maxUploadBytes / 1e6)} MB.
                </p>
              )}
            </section>
          )}

          {tab === 'models' && (
            <>
              <ModelPicker
                role="analysis"
                title="Reading the page"
                subtitle="Runs once per upload. This is the hard visual task, and it decides how well the form is understood."
                models={store.modelsFor('analysis')}
                selected={settings.analysisModel}
                loading={settings.modelsLoading}
                live={settings.modelsLive}
                onSelect={(id) => store.setModel('analysis', id)}
              />
              <ModelPicker
                role="extraction"
                title="Filling from conversation"
                subtitle="Runs on every message you send, so this one decides how fast the app feels."
                models={store.modelsFor('extraction')}
                selected={settings.extractionModel}
                loading={settings.modelsLoading}
                live={settings.modelsLive}
                onSelect={(id) => store.setModel('extraction', id)}
              />
              <div className="model-foot">
                <button
                  type="button"
                  className="ghost small"
                  disabled={settings.modelsLoading}
                  onClick={() => void store.loadModels()}
                >
                  {settings.modelsLoading ? 'Refreshing…' : 'Refresh model list'}
                </button>
                {settings.modelsLive && (
                  <span className="setting-hint">Live from your key’s project.</span>
                )}
              </div>
            </>
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

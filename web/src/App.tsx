import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { fieldsOfPage } from '@formfill/shared';
import { FormSession } from './state/formSession';
import { SettingsStore } from './state/settingsStore';
import { setAuthHeaderSource } from './api';
import { UploadScreen } from './components/UploadScreen';
import { FormRenderer } from './components/FormRenderer';
import { ConversationPanel } from './components/ConversationPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Toasts } from './components/Toasts';

// Overlay mode pulls in pdf.js (~1.4 MB with its worker). Mode A is the default
// and does not need it, so it is fetched only when the user asks for it.
const OverlayRenderer = lazy(() =>
  import('./components/OverlayRenderer').then((m) => ({ default: m.OverlayRenderer })),
);

export default function App() {
  const session = useMemo(() => new FormSession(), []);
  const settingsStore = useMemo(() => new SettingsStore(), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The API layer takes the key and model choice from the settings store.
  useEffect(() => {
    setAuthHeaderSource(() => settingsStore.headers());
    void settingsStore.loadServerSettings();
  }, [settingsStore]);

  // Deep-link back into a session after a reload.
  useEffect(() => {
    const formId = location.hash.replace(/^#/, '');
    if (formId) void session.load(formId);
  }, [session]);

  // A failure Settings can fix opens Settings, with the reason shown inside.
  useEffect(() => {
    if (snapshot.keyProblem) setSettingsOpen(true);
  }, [snapshot.keyProblem]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    session.clearKeyProblem();
  }, [session]);

  const { schema, state, pageNumber } = snapshot;

  const progress = useMemo(() => {
    if (!schema || !state) return { filled: 0, total: 0, pending: [] as string[], required: 0, requiredFilled: 0 };
    const fields = fieldsOfPage(schema, pageNumber);
    const page = state.pages[pageNumber] ?? {};
    const required = fields.filter((f) => f.required);
    return {
      total: fields.length,
      filled: fields.filter((f) => page[f.id]?.value !== null && page[f.id]?.value !== undefined).length,
      pending: fields.filter((f) => Boolean(page[f.id]?.pending)).map((f) => f.id),
      required: required.length,
      requiredFilled: required.filter((f) => page[f.id]?.value !== null && page[f.id]?.value !== undefined)
        .length,
    };
  }, [schema, state, pageNumber]);

  const settingsDialog = settingsOpen ? (
    <SettingsDialog
      store={settingsStore}
      settings={settings}
      reason={snapshot.keyProblem}
      onClose={closeSettings}
    />
  ) : null;

  const toasts = (
    <Toasts toasts={snapshot.toasts} onDismiss={(id) => session.dismissToast(id)} />
  );

  if (!schema || !state) {
    return (
      <>
        <UploadScreen
          status={snapshot.status}
          error={snapshot.error}
          settings={settings}
          onUpload={(file) => void session.upload(file)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsDialog}
        {toasts}
      </>
    );
  }

  const percent = progress.total ? Math.round((progress.filled / progress.total) * 100) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <strong className="doc-title" title={schema.documentName}>
            {schema.title}
          </strong>
          <span className="meta">
            page {pageNumber} of {schema.pageCount}
            {schema.pageCount > 1 && <span className="pill">page 1 only in this version</span>}
          </span>
        </div>

        <div className="topbar-right">
          <div className="progress-block" title={`${progress.filled} of ${progress.total} fields have a value`}>
            <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className="progress-text">
              {progress.filled}/{progress.total}
              {progress.required > 0 && (
                <span className="req-count">
                  {' '}
                  · {progress.requiredFilled}/{progress.required} required
                </span>
              )}
            </span>
          </div>

          {progress.pending.length > 0 && (
            <button
              className="review-button"
              onClick={() => session.focusField(progress.pending[0] ?? null)}
              title="Jump to the next value awaiting your decision"
            >
              ⚠ {progress.pending.length} to review
            </button>
          )}

          <div className="modes" role="tablist" aria-label="Rendering mode">
            <button
              role="tab"
              aria-selected={snapshot.mode === 'form'}
              className={snapshot.mode === 'form' ? 'active' : ''}
              onClick={() => session.setMode('form')}
            >
              Form
            </button>
            <button
              role="tab"
              aria-selected={snapshot.mode === 'overlay'}
              className={snapshot.mode === 'overlay' ? 'active' : ''}
              onClick={() => session.setMode('overlay')}
            >
              Original
            </button>
          </div>

          <button className="icon-button" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <button className="ghost" onClick={() => session.exportJson()}>
            Export
          </button>
          <button className="ghost" onClick={() => session.reset()}>
            New
          </button>
          <button className="primary" disabled={snapshot.busy} onClick={() => void session.save()}>
            {snapshot.savedAt ? 'Saved ✓' : 'Save form'}
          </button>
        </div>
      </header>

      {snapshot.error && (
        <div className="error-banner top" role="alert">
          <span>{snapshot.error}</span>
          <button className="ghost small" onClick={() => session.dismissError()}>
            dismiss
          </button>
        </div>
      )}

      <main className="workspace">
        <div className="form-pane">
          {snapshot.mode === 'form' ? (
            <FormRenderer
              schema={schema}
              state={state}
              pageNumber={pageNumber}
              justUpdated={snapshot.justUpdated}
              focusFieldId={snapshot.focusFieldId}
              onFocusHandled={() => session.focusField(null)}
              onChange={(fieldId, value) => void session.edit(fieldId, value)}
              onResolve={(fieldId, choice) => void session.resolve(fieldId, choice)}
            />
          ) : (
            <Suspense fallback={<p className="empty">Loading the document viewer…</p>}>
              <OverlayRenderer
                schema={schema}
                state={state}
                pageNumber={pageNumber}
                assetUrl={snapshot.pageAssetUrl ?? ''}
                justUpdated={snapshot.justUpdated}
                onChange={(fieldId, value) => void session.edit(fieldId, value)}
                onResolve={(fieldId, choice) => void session.resolve(fieldId, choice)}
              />
            </Suspense>
          )}
        </div>

        <ConversationPanel
          messages={snapshot.messages}
          turnResults={snapshot.turnResults}
          busy={snapshot.busy}
          queuedLines={snapshot.queuedLines}
          usage={snapshot.lastUsage}
          onSay={(text) => session.say(text)}
          onFlush={() => void session.flush()}
          onJumpToField={(fieldId) => session.focusField(fieldId)}
        />
      </main>

      <footer className="statusbar">
        <span>
          Schema by <code>{schema.analysisModel}</code>
          {snapshot.analysisUsage &&
            ` · ${
              snapshot.analysisUsage.cached
                ? 'cached'
                : `${snapshot.analysisUsage.totalTokens ?? '–'} tokens, ${(
                    snapshot.analysisUsage.latencyMs / 1000
                  ).toFixed(1)}s`
            }`}
        </span>
        <span className="disclaimer">
          Extracted values are unverified. Review before saving — this is not a clinical decision
          tool.
        </span>
      </footer>

      {settingsDialog}
      {toasts}
    </div>
  );
}

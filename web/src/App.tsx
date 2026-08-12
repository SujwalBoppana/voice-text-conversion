import { lazy, Suspense, useEffect, useMemo, useSyncExternalStore } from 'react';
import { fieldsOfPage } from '@formfill/shared';
import { FormSession } from './state/formSession';
import { UploadScreen } from './components/UploadScreen';
import { FormRenderer } from './components/FormRenderer';
import { ConversationPanel } from './components/ConversationPanel';

// Overlay mode pulls in pdf.js (~1.4 MB with its worker). Mode A is the default
// and does not need it, so it is fetched only when the user asks for it.
const OverlayRenderer = lazy(() =>
  import('./components/OverlayRenderer').then((m) => ({ default: m.OverlayRenderer })),
);

export default function App() {
  const session = useMemo(() => new FormSession(), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Deep-link back into a session after a reload.
  useEffect(() => {
    const formId = location.hash.replace(/^#/, '');
    if (formId) void session.load(formId);
  }, [session]);

  const { schema, state, pageNumber } = snapshot;

  const progress = useMemo(() => {
    if (!schema || !state) return { filled: 0, total: 0, pending: 0 };
    const fields = fieldsOfPage(schema, pageNumber);
    const page = state.pages[pageNumber] ?? {};
    return {
      total: fields.length,
      filled: fields.filter((f) => page[f.id]?.value !== null && page[f.id]?.value !== undefined)
        .length,
      pending: fields.filter((f) => Boolean(page[f.id]?.pending)).length,
    };
  }, [schema, state, pageNumber]);

  if (!schema || !state) {
    return (
      <UploadScreen
        status={snapshot.status}
        error={snapshot.error}
        onUpload={(file) => void session.upload(file)}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <strong>{schema.title}</strong>
          <span className="meta">
            page {pageNumber} of {schema.pageCount}
            {schema.pageCount > 1 && <span className="pill">page 1 only in this version</span>}
          </span>
        </div>

        <div className="topbar-right">
          <span className="progress" title="Fields with a value on this page">
            {progress.filled}/{progress.total} filled
            {progress.pending > 0 && (
              <b className="needs-review"> · {progress.pending} to review</b>
            )}
          </span>

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

          <button className="ghost" onClick={() => session.reset()}>
            New form
          </button>
          <button className="primary" disabled={snapshot.busy} onClick={() => void session.save()}>
            {snapshot.savedAt ? 'Saved ✓' : 'Save form'}
          </button>
        </div>
      </header>

      {snapshot.error && (
        <div className="error-banner top" role="alert">
          {snapshot.error}
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
          busy={snapshot.busy}
          queuedLines={snapshot.queuedLines}
          usage={snapshot.lastUsage}
          onSay={(text) => session.say(text)}
          onFlush={() => void session.flush()}
        />
      </main>

      <footer className="statusbar">
        <span>
          Schema generated by <code>{schema.analysisModel}</code>
          {snapshot.analysisUsage &&
            ` · ${snapshot.analysisUsage.cached ? 'cached' : `${snapshot.analysisUsage.totalTokens ?? '–'} tokens, ${snapshot.analysisUsage.latencyMs} ms`}`}
        </span>
        <span className="disclaimer">
          Extracted values are unverified. Review before saving — this is not a clinical decision
          tool.
        </span>
      </footer>
    </div>
  );
}

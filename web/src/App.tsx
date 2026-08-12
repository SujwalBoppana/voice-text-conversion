import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { fieldsOfPage } from '@formfill/shared';
import { FormSession } from './state/formSession';
import { SettingsStore } from './state/settingsStore';
import { setAuthHeaderSource } from './api';
import { UploadScreen } from './components/UploadScreen';
import { FormRenderer } from './components/FormRenderer';
import { ConversationPanel } from './components/ConversationPanel';
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog';
import { FieldFinder } from './components/FieldFinder';
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);

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
    if (snapshot.keyProblem) setSettingsTab('key');
  }, [snapshot.keyProblem]);

  const { schema, state, pageNumber } = snapshot;

  // Global shortcuts. Everything reachable by mouse is reachable by keyboard,
  // and the two things done most often — jumping to a field and saving — are one
  // chord away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

      if (mod && e.key.toLowerCase() === 'k' && schema) {
        e.preventDefault();
        setFinderOpen(true);
      } else if (mod && e.key.toLowerCase() === 's' && schema) {
        e.preventDefault();
        void session.save();
      } else if (mod && e.key === '/' && schema) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('.chat-input textarea')?.focus();
      } else if (e.key === 'Escape' && !typing) {
        setFinderOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [schema, session]);

  // Losing unsaved values to a stray reload is the one irreversible mistake the
  // app can allow, so the browser asks first.
  useEffect(() => {
    if (!snapshot.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [snapshot.dirty]);

  const closeSettings = useCallback(() => {
    setSettingsTab(null);
    session.clearKeyProblem();
  }, [session]);

  /**
   * Counted across every analyzed page, not just the one on screen: the
   * conversation fills the whole document, so a per-page total would understate
   * what is left and hide review items on the other page.
   */
  const progress = useMemo(() => {
    const empty = {
      filled: 0,
      total: 0,
      pending: [] as Array<{ id: string; page: number }>,
      required: 0,
      requiredFilled: 0,
      byPage: new Map<number, { filled: number; total: number; pending: number }>(),
    };
    if (!schema || !state) return empty;

    const result = { ...empty, pending: [] as Array<{ id: string; page: number }>, byPage: new Map() };
    for (const page of schema.analyzedPages) {
      const fields = fieldsOfPage(schema, page);
      const values = state.pages[page] ?? {};
      const has = (id: string) => values[id]?.value !== null && values[id]?.value !== undefined;
      const filled = fields.filter((f) => has(f.id)).length;
      const pending = fields.filter((f) => Boolean(values[f.id]?.pending));
      const required = fields.filter((f) => f.required);

      result.total += fields.length;
      result.filled += filled;
      result.required += required.length;
      result.requiredFilled += required.filter((f) => has(f.id)).length;
      result.pending.push(...pending.map((f) => ({ id: f.id, page })));
      result.byPage.set(page, { filled, total: fields.length, pending: pending.length });
    }
    return result;
  }, [schema, state]);

  const settingsDialog = settingsTab ? (
    <SettingsDialog
      store={settingsStore}
      settings={settings}
      reason={snapshot.keyProblem}
      initialTab={settingsTab}
      onClose={closeSettings}
    />
  ) : null;

  const toasts = <Toasts toasts={snapshot.toasts} onDismiss={(id) => session.dismissToast(id)} />;

  if (!schema || !state) {
    return (
      <>
        <UploadScreen
          status={snapshot.status}
          uploadProgress={snapshot.uploadProgress}
          uploadingName={snapshot.uploadingName}
          error={snapshot.error}
          settings={settings}
          modelLabel={settingsStore.labelFor(settings.analysisModel)}
          onUpload={(file) => void session.upload(file)}
          onOpenSettings={(tab) => setSettingsTab(tab ?? 'key')}
        />
        {settingsDialog}
        {toasts}
      </>
    );
  }

  const percent = progress.total ? Math.round((progress.filled / progress.total) * 100) : 0;
  const saveLabel = snapshot.savedAt && !snapshot.dirty ? 'Saved ✓' : 'Save form';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <strong className="doc-title" title={schema.documentName}>
            {schema.title}
          </strong>
          <span className="meta">
            {schema.analyzedPages.length > 1 ? (
              <span className="pages" role="tablist" aria-label="Page">
                {schema.analyzedPages.map((n) => {
                  const stats = progress.byPage.get(n);
                  return (
                    <button
                      key={n}
                      role="tab"
                      aria-selected={n === pageNumber}
                      className={n === pageNumber ? 'page-tab active' : 'page-tab'}
                      onClick={() => session.setPage(n)}
                      title={
                        stats ? `${stats.filled}/${stats.total} filled on page ${n}` : `Page ${n}`
                      }
                    >
                      Page {n}
                      {stats && stats.pending > 0 && <i className="dot warn" aria-hidden="true" />}
                    </button>
                  );
                })}
              </span>
            ) : (
              <>page {pageNumber} of {schema.pageCount}</>
            )}
            {schema.pageCount > schema.analyzedPages.length && (
              <span className="pill">
                {schema.analyzedPages.length} of {schema.pageCount} pages analyzed
              </span>
            )}
            <button
              className="model-chip"
              title="Models in use — click to change"
              onClick={() => setSettingsTab('models')}
            >
              {settingsStore.labelFor(settings.extractionModel)}
            </button>
          </span>
        </div>

        <div className="topbar-right">
          <button className="finder-button" onClick={() => setFinderOpen(true)} title="Jump to a field">
            <span aria-hidden="true">⌕</span> Find field <kbd>⌘K</kbd>
          </button>

          <div
            className="progress-block"
            title={`${progress.filled} of ${progress.total} fields have a value`}
          >
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Fields filled"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className="progress-text">
              {progress.filled}/{progress.total}
              {schema.analyzedPages.length > 1 && <span className="req-count"> all pages</span>}
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
              onClick={() =>
                session.focusField(
                  progress.pending[0]?.id ?? null,
                  progress.pending[0]?.page,
                )
              }
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

          <button
            className="icon-button"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsTab('key')}
          >
            ⚙
          </button>
          <button className="ghost" onClick={() => session.exportJson()} title="Download as JSON">
            Export
          </button>
          <button className="ghost" onClick={() => session.reset()}>
            New
          </button>
          <button
            className="primary"
            disabled={snapshot.busy}
            onClick={() => void session.save()}
            title="Save (⌘S)"
          >
            {saveLabel}
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
                assetUrl={`/api/forms/${schema.formId}/pages/${pageNumber}/asset`}
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
          modelLabel={settingsStore.labelFor(settings.extractionModel)}
          onSay={(text) => session.say(text)}
          onFlush={() => void session.flush()}
          onJumpToField={(fieldId, page) => session.focusField(fieldId, page)}
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
          <span className={`save-state ${snapshot.dirty ? 'dirty' : 'clean'}`}>
            {snapshot.dirty ? '● unsaved changes' : snapshot.savedAt ? '✓ saved' : 'no changes yet'}
          </span>
        </span>
        <span className="disclaimer">
          Extracted values are unverified. Review before saving — this is not a clinical decision
          tool.
        </span>
      </footer>

      {finderOpen && (
        <FieldFinder
          schema={schema}
          state={state}
          pageNumber={pageNumber}
          onPick={(fieldId, page) => session.focusField(fieldId, page)}
          onClose={() => setFinderOpen(false)}
        />
      )}
      {settingsDialog}
      {toasts}
    </div>
  );
}

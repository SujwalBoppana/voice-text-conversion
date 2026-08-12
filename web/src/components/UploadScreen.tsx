import { useRef, useState } from 'react';
import type { SettingsSnapshot } from '../state/settingsStore';
import type { SettingsTab } from './SettingsDialog';
import { AnalysisProgress } from './AnalysisProgress';

interface Props {
  status: 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error';
  uploadProgress: number | null;
  uploadingName: string | null;
  error: string | null;
  settings: SettingsSnapshot;
  modelLabel: string;
  onUpload: (file: File) => void;
  onOpenSettings: (tab?: SettingsTab) => void;
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const MAX_MB = 25;

export function UploadScreen({
  status,
  uploadProgress,
  uploadingName,
  error,
  settings,
  modelLabel,
  onUpload,
  onOpenSettings,
}: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = status === 'uploading' || status === 'analyzing';
  const blocked = !settings.ready;

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setLocalError(null);

    // Fail fast in the browser rather than after a 25 MB round trip.
    if (!/\.(pdf|png|jpe?g|webp)$/i.test(file.name) && !/^(application\/pdf|image\/)/.test(file.type)) {
      setLocalError(`"${file.name}" is not a PDF or image.`);
      return;
    }
    if (file.size > MAX_MB * 1e6) {
      setLocalError(`That file is ${(file.size / 1e6).toFixed(1)} MB — the limit is ${MAX_MB} MB.`);
      return;
    }
    onUpload(file);
  };

  const open = () => {
    if (busy) return;
    if (blocked) {
      onOpenSettings('key');
      return;
    }
    input.current?.click();
  };

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Dynamic form autofill</h1>
        </div>
        <p className="lede">
          Upload any form — a scanned clinic sheet, an onboarding pack, an account opening form.
          Page&nbsp;1 is read visually, turned into an editable form that keeps the original layout,
          and filled from what you dictate.
        </p>

        {blocked ? (
          <div className="key-gate">
            <h2>Add your Gemini API key to begin</h2>
            <p className="hint">
              The key stays in this browser. Getting one is free and takes about a minute.
            </p>
            <button className="primary large" onClick={() => onOpenSettings('key')}>
              Add API key
            </button>
          </div>
        ) : (
          <div
            className={`dropzone ${dragging ? 'over' : ''} ${busy ? 'busy' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) pick(e.dataTransfer.files);
            }}
            onClick={open}
            role="button"
            tabIndex={0}
            aria-busy={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            }}
          >
            {busy ? (
              <AnalysisProgress
                phase={status === 'uploading' ? 'uploading' : 'analyzing'}
                uploadProgress={uploadProgress}
                fileName={uploadingName ?? ''}
                modelLabel={modelLabel}
              />
            ) : (
              <>
                <div className="drop-icon" aria-hidden="true">
                  ⇪
                </div>
                <p>
                  <b>Drop a PDF or image here</b>
                </p>
                <p className="hint">or click to choose · PDF, PNG, JPEG, WebP · up to {MAX_MB} MB</p>
                <p className="hint small">Only page 1 is processed in this version.</p>
              </>
            )}
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = ''; // allow re-picking the same file
              }}
            />
          </div>
        )}

        {(localError || error) && (
          <p className="callout error" role="alert">
            {localError ?? error}
          </p>
        )}

        <div className="upload-foot">
          <button className="ghost small" onClick={() => onOpenSettings('key')}>
            ⚙ Settings
          </button>
          <span className="hint small">
            {settings.server?.mockGemini ? (
              'Mock mode — no API calls'
            ) : (
              <>
                {settings.apiKey
                  ? 'Key set in this browser'
                  : settings.server?.serverHasKey
                    ? 'Using the server key'
                    : 'No key set'}
                {settings.ready && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => onOpenSettings('models')}>
                      {modelLabel}
                    </button>
                  </>
                )}
              </>
            )}
          </span>
        </div>

        <p className="disclaimer">
          Extraction records what you say — it does not interpret, infer or advise. Every value is
          shown for review before you save.
        </p>
      </div>
    </div>
  );
}

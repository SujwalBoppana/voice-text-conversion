import { useRef, useState } from 'react';

interface Props {
  status: 'idle' | 'uploading' | 'analyzing' | 'ready' | 'error';
  error: string | null;
  onUpload: (file: File) => void;
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';

export function UploadScreen({ status, error, onUpload }: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = status === 'uploading' || status === 'analyzing';

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onUpload(file);
  };

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <h1>Dynamic form autofill</h1>
        <p className="lede">
          Upload any form — a scanned clinic sheet, an onboarding pack, an account opening form.
          Page 1 is read visually, turned into an editable form, and filled from what you dictate.
        </p>

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
          onClick={() => !busy && input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !busy) input.current?.click();
          }}
        >
          {busy ? (
            <>
              <div className="spinner" />
              <p>
                <b>{status === 'uploading' ? 'Uploading…' : 'Reading page 1…'}</b>
              </p>
              <p className="hint">
                The page is being analyzed visually — sections, blanks, printed choices and their
                positions. This takes a few seconds and happens once per document.
              </p>
            </>
          ) : (
            <>
              <p>
                <b>Drop a PDF or image here</b>
              </p>
              <p className="hint">or click to choose · PDF, PNG, JPEG, WebP · up to 25 MB</p>
              <p className="hint small">Only page 1 is processed in this version.</p>
            </>
          )}
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => pick(e.target.files)}
          />
        </div>

        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        <p className="disclaimer">
          Extraction records what you say — it does not interpret, infer or advise. Every value is
          shown for review before you save.
        </p>
      </div>
    </div>
  );
}

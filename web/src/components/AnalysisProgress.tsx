/**
 * What the app is doing while a page is being read.
 *
 * Analysis can take 10–30 seconds on a Pro model, which is long enough that a
 * bare spinner reads as "stuck". This shows the real phase, real upload
 * progress, and an elapsed counter — no invented percentages for the model call,
 * because the server genuinely cannot report progress inside it.
 */
import { useEffect, useState } from 'react';

interface Props {
  phase: 'uploading' | 'analyzing';
  /** 0..1 from the real XHR upload event, or null once the body is sent. */
  uploadProgress: number | null;
  fileName: string;
  modelLabel: string;
}

const STEPS = [
  { key: 'upload', label: 'Sending the document' },
  { key: 'extract', label: 'Taking page 1 out of the file' },
  { key: 'read', label: 'Reading the layout' },
  { key: 'build', label: 'Building the form' },
] as const;

export function AnalysisProgress({ phase, uploadProgress, fileName, modelLabel }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, []);

  // Only the first step has measurable progress. Beyond it the app knows the
  // request is in flight and nothing more, so later steps show as "in progress"
  // rather than pretending to advance.
  const activeIndex = phase === 'uploading' ? 0 : 2;

  return (
    <div className="analysis">
      <div className="analysis-head">
        <div className="spinner" />
        <div>
          <p className="analysis-title">
            {phase === 'uploading' ? 'Uploading' : 'Reading page 1'}
            <span className="elapsed">{elapsed}s</span>
          </p>
          <p className="hint truncate" title={fileName}>
            {fileName}
          </p>
        </div>
      </div>

      <ol className="steps">
        {STEPS.map((step, i) => {
          const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'todo';
          return (
            <li key={step.key} className={`step ${state}`}>
              <span className="step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'active' ? '●' : '○'}
              </span>
              <span className="step-label">{step.label}</span>
              {step.key === 'upload' && uploadProgress !== null && uploadProgress < 1 && (
                <span className="step-meta">{Math.round(uploadProgress * 100)}%</span>
              )}
            </li>
          );
        })}
      </ol>

      {phase === 'uploading' && uploadProgress !== null && (
        <div className="progress-bar wide">
          <span style={{ width: `${Math.round(uploadProgress * 100)}%` }} />
        </div>
      )}

      <p className="hint small">
        {phase === 'uploading'
          ? 'Only page 1 is sent for analysis.'
          : `${modelLabel} is finding sections, blanks and printed choices, and where each one sits. This happens once per document — usually 10–30 seconds.`}
      </p>
    </div>
  );
}

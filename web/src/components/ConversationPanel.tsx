import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ExtractionResponse } from '@formfill/shared';
import type { TurnResult } from '../state/formSession';

interface Props {
  messages: ChatMessage[];
  turnResults: Record<string, TurnResult>;
  busy: boolean;
  queuedLines: number;
  usage: ExtractionResponse['usage'] | null;
  modelLabel: string;
  onSay: (text: string) => void;
  onFlush: () => void;
  onJumpToField: (fieldId: string, pageNumber: number) => void;
}

const EXAMPLES = [
  'The baby is Rahul Kumar, born today at 10:35 am, weight 2.4 kg.',
  'Amniotic fluid was clear and he cried immediately after birth.',
  'Mother is 30, gravida 2 para 1, delivery was by LSCS.',
];

export function ConversationPanel({
  messages,
  turnResults,
  busy,
  queuedLines,
  usage,
  modelLabel,
  onSay,
  onFlush,
  onJumpToField,
}: Props) {
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSay(trimmed);
    setDraft('');
    // Explicit send skips the debounce window — the user is done talking.
    onFlush();
    input.current?.focus();
  };

  return (
    <aside className="chat" aria-label="Conversation">
      <header className="chat-head">
        <h2>Conversation</h2>
        <p className="hint">
          Describe the case in your own words. Values are extracted into the form and marked{' '}
          <span className="badge auto">auto</span> for review.
        </p>
      </header>

      <div className="chat-log" ref={scroller}>
        {messages.length === 0 && (
          <div className="examples">
            <p className="hint">Try one of these:</p>
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="example" onClick={() => submit(example)}>
                {example}
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => {
          const result = turnResults[message.id];
          return (
            <div key={message.id} className={`bubble ${message.role}`}>
              <span className="who">{message.role === 'user' ? 'You' : 'Assistant'}</span>
              <p>{message.content}</p>

              {result && (
                <div className="turn-result">
                  {result.applied.map((f) => (
                    <button
                      key={f.fieldId}
                      className="chip filled"
                      onClick={() => onJumpToField(f.fieldId, f.pageNumber)}
                      title="Go to this field"
                    >
                      ✓ {f.label}
                    </button>
                  ))}
                  {result.pending.map((f) => (
                    <button
                      key={f.fieldId}
                      className="chip pending"
                      onClick={() => onJumpToField(f.fieldId, f.pageNumber)}
                      title="Needs your decision"
                    >
                      ⚠ {f.label}
                    </button>
                  ))}
                  {result.rejected.map((r) => (
                    <span key={r.fieldId + r.reason} className="chip rejected" title={r.reason}>
                      ✕ {r.fieldId}
                    </span>
                  ))}
                  {result.skipped && <span className="chip muted">no form data</span>}
                </div>
              )}
            </div>
          );
        })}

        {queuedLines > 0 && !busy && (
          <div className="bubble system">
            <p>
              Batching {queuedLines} line{queuedLines === 1 ? '' : 's'}…
            </p>
          </div>
        )}
        {busy && (
          <div className="bubble system">
            <p className="typing">
              <i /> <i /> <i /> extracting
            </p>
          </div>
        )}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <textarea
          ref={input}
          value={draft}
          placeholder="e.g. Born today at 10:35 am, weight 2.4 kg, cried immediately."
          rows={2}
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(draft);
            }
          }}
        />
        <button type="submit" className="primary" disabled={!draft.trim()}>
          Send
        </button>
      </form>

      <footer className="usage">
        <span className="hint small">Enter to send · Shift+Enter for a new line</span>
        <span title="Tokens and latency of the last extraction call">
          {usage
            ? `${usage.totalTokens ?? '–'} tok · ${usage.latencyMs} ms`
            : modelLabel}
        </span>
      </footer>
    </aside>
  );
}

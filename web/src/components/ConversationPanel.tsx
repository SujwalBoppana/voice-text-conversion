import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ExtractionResponse } from '@formfill/shared';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  queuedLines: number;
  usage: ExtractionResponse['usage'] | null;
  onSay: (text: string) => void;
  onFlush: () => void;
}

const EXAMPLES = [
  'The baby is Rahul Kumar, born today at 10:35 am, weight 2.4 kg.',
  'Amniotic fluid was clear and he cried immediately after birth.',
  'Mother is 30, blood group O positive, gravida 2 para 1.',
];

export function ConversationPanel({ messages, busy, queuedLines, usage, onSay, onFlush }: Props) {
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

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

        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            <span className="who">{message.role === 'user' ? 'You' : 'Assistant'}</span>
            <p>{message.content}</p>
          </div>
        ))}

        {queuedLines > 0 && !busy && (
          <div className="bubble system">
            <p>Batching {queuedLines} line{queuedLines === 1 ? '' : 's'}…</p>
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
          value={draft}
          placeholder="e.g. Born today at 10:35 am, weight 2.4 kg, cried immediately."
          rows={2}
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

      {usage && (
        <footer className="usage" title="Tokens used by the last extraction call">
          {usage.model} · {usage.totalTokens ?? '–'} tokens · {usage.latencyMs} ms
        </footer>
      )}
    </aside>
  );
}

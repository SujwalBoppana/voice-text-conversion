# Screenshots

Captured from the running app with Playwright, not mocked up. The script lives
in the repo history; to regenerate, start the app and drive it through the same
flow.

| File | Screen |
|---|---|
| `01-key-gate.png` | Upload gated until an API key is present |
| `02-settings-key.png` | Settings — API key, checked before it is accepted |
| `03-settings-models.png` | Settings — model selection, per role |
| `04-upload.png` | Upload screen once a key is set |
| `05-form-rendered.png` | The generated form (Mode A) |
| `06-filled-from-conversation.png` | Values extracted from a dictated sentence |
| `07-conflict.png` | A disagreeing restatement parked for a human decision |
| `08-field-finder.png` | ⌘K jump-to-field |
| `09-overlay-mode.png` | Live fields over the original page (Mode B) |

Shots `05`–`09` were taken against the offline fixture mode (`MOCK_GEMINI=true`),
so assistant replies read `[mock] …`. With a real key that line is a sentence
from the model; nothing else differs.

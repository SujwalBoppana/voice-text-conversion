# Dynamic form autofill

Upload **any** form — a scanned clinic sheet, an onboarding pack, an account
opening form. Gemini reads page 1 visually, the page becomes an editable digital
form that keeps the original layout, and dictating the case fills the fields.

The application has **no built-in knowledge of any form**. There is no
`patientName`, no `dateOfBirth`, no clinical vocabulary in the code. Structure is
data produced at runtime by the model and consumed by generic renderers,
validators and state machinery. A different document tomorrow needs zero code
changes.

```
        ANY FORM ──► page 1 ──► Gemini vision ──► JSON schema ──► dynamic UI
                                                        │
                        conversation ──► gate ──► Gemini extraction ──► validate
                                                        │
                                          conflicts ──► human review ──► save
```

---

## Run it locally

**Prerequisites:** Node 20.11+ and a Gemini API key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

```bash
npm install

cp .env.example server/.env
$EDITOR server/.env          # set GEMINI_API_KEY

npm run dev                  # API on :4000, UI on :5173
```

Open <http://localhost:5173>.

**Without an API key** — the whole UI, validator, conflict logic and HTTP surface
run against a captured fixture:

```bash
MOCK_GEMINI=true npm run dev
```

Mock mode renders the sample form regardless of what you upload (it is a
fixture), and its stand-in extractor is a crude keyword matcher — deliberately
much dumber than the real model. It is for UI work and offline demos.

Other commands:

```bash
npm test          # validation, conflict, gate and layout unit tests
npm run build     # typecheck + build all three workspaces
npm start         # run the built server
```

## Test it with the attached PDF

The document is committed at `samples/paramitha-initial-assessment.pdf` (4 pages;
**only page 1 is processed**, as specified for the MVP).

**In the UI:** drop the PDF on the upload screen, wait for the analysis, then
paste into the conversation panel:

> The baby is Rahul Kumar, born today at 10:35 AM. He is male and weighs 2.4
> kilograms. He cried immediately after birth.

Fields fill and are badged `auto`. Then try each guard:

| Say this | What should happen |
|---|---|
| `Amniotic fluid was meconium-stained.` | Matches the printed option `Meconium stained` |
| `Mother's age at conception is about 30.` | **Not** filled — hedged speech parks as *needs clarification* |
| `Correction, the weight is 2.6 kg.` | **Conflict** — the old value stays until you choose |
| `The amniotic fluid was greenish.` | Rejected — not one of the printed choices |
| `Start him on ampicillin.` | Dropped — page 1 has no such field |
| `ok thanks` | Gated locally — no API call at all |

Switch to **Original** in the toolbar to see the same live fields overlaid on the
real page (Mode B). Every field is editable by hand; a hand-edited field can
never be silently overwritten.

**From the shell:**

```bash
./scripts/smoke-test.sh                  # against a server on :4000
BASE=http://localhost:4000 FILE=my-form.pdf ./scripts/smoke-test.sh
```

---

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Pipeline, technology choices, model selection and why it is fast, coordinates, layout reconstruction, trust boundary |
| [`docs/API.md`](docs/API.md) | Every endpoint with example requests and responses |
| [`docs/PROMPTS.md`](docs/PROMPTS.md) | Both prompts, both structured-output schemas, the validation table, the gate |
| [`docs/example-schema.paramitha-page1.json`](docs/example-schema.paramitha-page1.json) | The real generated schema for the attached form: 9 sections, 50 fields |
| [`docs/example-conversation.md`](docs/example-conversation.md) | Seven worked conversation → field examples, including a non-clinical form |

## Layout

```
shared/     types, deterministic validation, layout reconstruction,
            state transitions, the relevance gate   ← no framework, no I/O
server/     Express API, document ingest, Gemini calls, prompts,
            response schemas, normalization, storage and caching
web/        React UI: upload, Mode A form renderer, Mode B overlay,
            conversation panel, framework-independent session store
```

Validation, conflict rules and layout live in `shared/` because both the server
and the client need them — the client runs the same gate before spending a
request, and would run the same validators for optimistic updates.

## What it does

**Understands the page visually.** Sections, ruled blanks, printed choice lists,
tables, borders, several fields per line, and the position of every one of them.
`Amniotic fluid : Clear / Meconium stained / Foul smell` becomes one radio field
with three options, not three fields. `Cried immediately after birth : Yes / No`
becomes a boolean.

**Keeps the layout.** The model reports positions; row and column structure is
derived from them deterministically. On the sample, *Baby details* renders beside
*Baby's foot print*, and `Parity / Gravida / Para / Live Born / Abortions /
Death` render on one row — as printed.

**Two rendering modes.** Mode A is the dynamic HTML form (primary). Mode B keeps
the original page as the background with live inputs over the detected blanks.
Mode B needed no schema change to build, because coordinates were normalized into
the schema from the first commit.

**Fills from conversation, cheaply.** The document is sent to a model exactly
once. Every later turn sends a compact catalogue of the fields that are still
open plus the last few turns — so a session gets *cheaper* per turn as the form
fills, not more expensive.

**Never invents a clinical value.** Hedged speech is parked, not confirmed.
Ambiguous dates are rejected, not guessed. A number for a field whose document
prints a unit asks for the unit rather than assuming one. An existing value is
never overwritten from conversation. Every automatic value shows the verbatim
phrase it came from, and a human reviews before saving.

> This is an information-extraction and form-completion tool. It is not a
> clinical decision-support system, and it makes no findings of its own.

## Token and latency strategy

| Lever | Effect |
|---|---|
| Document sent once, never re-sent | The dominant cost is paid once per document |
| Analysis cached on `(content hash, page, model)` | Re-uploading the same file costs zero model calls |
| Local relevance gate | Small talk never reaches the API — no tokens, no round trip |
| Catalogue holds open fields only | Per-turn input **shrinks** as the form fills |
| Last 6 turns, not the whole transcript | Bounded context growth |
| Client-side debounce (600 ms) + batching | A burst of dictated lines is one call, not five |
| `thinkingBudget: 0` on extraction | The biggest single lever on time-to-first-token |
| `maxOutputTokens: 2048`, one short string per field | Small responses by construction |
| Optimistic manual edits | Typing never waits on a round trip |
| In-flight request superseding | A newer burst aborts a stale one |
| pdf.js code-split out of the main bundle | 168 KB initial JS instead of 534 KB |

## Error handling

Malformed model JSON is repaired then rejected locally; a response that does not
match the expected shape is a `502` with the zod issues attached, never a broken
form. Transient upstream failures (429/5xx/network) retry with exponential
backoff. Field ids the model invents are dropped before validation. Values that
fail type parsing are reported as `rejected` with a reason and never displayed as
form data. Uploads that are not PDF/PNG/JPEG/WebP are refused by content sniffing,
not by file extension. Encrypted and malformed PDFs, empty pages and pages where
no field was found each get their own status and message. Manual edits roll back
in the UI if the write fails.

## Scope: page 1 only

As specified, exactly one page is analyzed. The data model is page-aware
throughout — `schema.pages[]`, `state.pages[pageNumber][fieldId]`, per-page
assets, a page-keyed analysis cache, and an ingest function that takes a list of
page numbers. Widening to pages 2–4 is `MAX_ANALYZED_PAGES=4` plus a page
switcher in the UI. No migration, no redesign.

## Configuration

See [`.env.example`](.env.example). The essentials:

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | — | required unless `MOCK_GEMINI=true` |
| `GEMINI_ANALYSIS_MODEL` | `gemini-2.5-pro` | once per page; the hard visual task |
| `GEMINI_EXTRACTION_MODEL` | `gemini-2.5-flash` | every turn; in the critical path |
| `GEMINI_EXTRACTION_THINKING_BUDGET` | `0` | thinking off for latency |
| `MAX_ANALYZED_PAGES` | `1` | MVP scope |
| `MOCK_GEMINI` | `false` | offline fixture mode |

Uses the official **`@google/genai`** SDK (v2) with multimodal input and
structured outputs on both calls. The deprecated `@google/generative-ai` package
is not used.

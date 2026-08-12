# Architecture

## The one rule everything else follows

The application has no knowledge of any form. There is no `patientName`, no
`dateOfBirth`, no clinical vocabulary anywhere in the code. A form's structure is
**data produced at runtime by a vision model** and consumed by generic renderers,
validators and state machinery. Uploading an employee onboarding sheet or a bank
account opening form tomorrow requires zero code changes.

The one place a document-specific artifact exists is
`server/src/fixtures/paramitha-page1.analysis.json`, and it is a *captured model
response* used only when `MOCK_GEMINI=true`. It is fed through the same
`normalizePage()` pipeline as a live response, and nothing in application code
branches on any id inside it.

## Pipeline

```
                            upload (PDF / PNG / JPEG / WebP)
                                        │
                       ┌────────────────▼─────────────────┐
                       │ documentService                  │
                       │ sniff type, copy page 1 out with │
                       │ pdf-lib into a 1-page PDF        │
                       └────────────────┬─────────────────┘
                                        │
                        content hash ───┤── cache hit? ──► skip the model call
                                        │
                       ┌────────────────▼─────────────────┐
                       │ Gemini (analysis model)          │
                       │ multimodal: page bytes + prompt  │
                       │ structured output: analysisSchema│
                       └────────────────┬─────────────────┘
                                        │ raw payload (untrusted)
                       ┌────────────────▼─────────────────┐
                       │ lib/normalize.ts                 │
                       │ zod parse · box_2d → BBox 0..1   │
                       │ unique slug ids · repair types   │
                       └────────────────┬─────────────────┘
                                        │ FormSchema  ──► CACHE (hash, page, model)
                       ┌────────────────▼─────────────────┐
                       │ buildInitialState → FormState    │
                       └────────────────┬─────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                                                               │
┌───────▼─────────┐                                          ┌──────────▼────────┐
│ Mode A          │                                          │ Mode B            │
│ FormRenderer    │  layout derived from bboxes              │ OverlayRenderer   │
│ bands→rows→cells│                                          │ pdf.js + absolute │
└───────┬─────────┘                                          └──────────┬────────┘
        └───────────────────────────────┬───────────────────────────────┘
                                        │
                       ┌────────────────▼─────────────────┐
                       │ conversation turn                │
                       │ local gate: does it carry data?  │──no──► answered locally,
                       └────────────────┬─────────────────┘        0 tokens, 0 ms
                                        │ yes
                       ┌────────────────▼─────────────────┐
                       │ buildFieldCatalog                │
                       │ open fields + pinned only        │  ← the document is
                       │ + last N turns                   │    NEVER re-sent
                       └────────────────┬─────────────────┘
                       ┌────────────────▼─────────────────┐
                       │ Gemini (extraction model)        │
                       │ thinking off · structured output │
                       └────────────────┬─────────────────┘
                                        │ {fieldId, valueText, certainty}[]
                       ┌────────────────▼─────────────────┐
                       │ id ∈ catalog? → validateValue()  │
                       │ deterministic parse per type     │
                       └────────────────┬─────────────────┘
                       ┌────────────────▼─────────────────┐
                       │ applyUpdates()                   │
                       │ applied / pending / rejected     │
                       └────────────────┬─────────────────┘
                                        ▼
                              FormState → UI → human review → save
```

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | The schema is the contract between analysis, validation, state and both renderers. One `FormField` type, checked in all three packages. |
| Backend | Node 20+ / Express 4 | Small surface, no framework ceremony, trivially replaceable. |
| Model SDK | `@google/genai` v2 | The current official Google GenAI SDK. The deprecated `@google/generative-ai` is not used. |
| Page extraction | `pdf-lib` | Pure JavaScript. No poppler, no canvas, no native build step in the deployment. |
| Page rasterization | `pdf.js`, in the browser | Keeps rendering out of the server entirely; the client already has to draw the page for overlay mode. |
| Response validation | `zod` | The model's JSON is untrusted input. Parse, don't assume. |
| Frontend | React 18 + Vite | Standard, fast dev loop. The state layer is framework-independent, so React is swappable. |
| Storage | in-memory + JSON on disk | Behind `services/store.ts`. Swap for Postgres/S3 without touching a route. |

## Why the PDF page is sent as a PDF, not an image

Gemini accepts PDFs natively and renders them at its own resolution. Sending the
extracted page as a one-page PDF means:

- **no native rendering dependency** on the server (no poppler, no `node-canvas`);
- **vector text stays vector text**, which reads far more accurately on a
  digitally generated form like the sample than a re-encoded bitmap would;
- **scans are unaffected** — an image-only page is a bitmap either way, and the
  model OCRs it.

Uploaded images (PNG/JPEG/WebP) are passed through as images.

## Model selection

| Call | Model | Frequency | Why |
|---|---|---|---|
| Page analysis | `gemini-2.5-pro` | once per page, cached | Reading a ruled form and placing accurate boxes over every blank is the hardest visual reasoning in the system, and it happens once. Accuracy here determines the quality of everything downstream, so it is worth the latency and cost. |
| Conversation extraction | `gemini-2.5-flash`, thinking budget **0** | every meaningful turn | This call is in the user's critical path. The task is shallow: map a sentence onto an explicit list of field ids. Flash with thinking disabled is the right point on the latency curve — thinking tokens would add hundreds of milliseconds and buy nothing on a task this constrained. |

Both are `GEMINI_ANALYSIS_MODEL` / `GEMINI_EXTRACTION_MODEL` in the environment.
If your forms are clean digital PDFs rather than scans, `gemini-2.5-flash` for
analysis works well and is markedly cheaper.

### Why low latency actually holds

1. **The document is sent once.** After analysis it never appears in a prompt
   again. Per-turn input is a few hundred tokens of field catalogue, not a
   multi-megabyte page.
2. **Thinking is off for extraction.** The largest single lever on time-to-first
   token for a 2.5-family model.
3. **The gate short-circuits.** "ok thanks" is answered client-side with no
   request at all.
4. **The catalogue shrinks as the form fills.** A session gets *cheaper and
   faster* per turn, not slower.
5. **Output is bounded.** `maxOutputTokens: 2048` and a schema that emits one
   short string per field — extraction responses are small by construction.

## Coordinates

The model is asked for `box_2d` as `[ymin, xmin, ymax, xmax]` normalized to a
0–1000 grid. That is the convention Gemini is trained on, and asking in it is
measurably more accurate than asking for pixel `{x, y, w, h}`.

`lib/normalize.ts` converts once, to a fraction-of-page `BBox` with a top-left
origin. Normalizing at ingest is what lets one schema drive:

- **Mode A**, where boxes are used only for *relative* structure — which fields
  shared a printed line, which sections sat side by side, how wide each blank was;
- **Mode B**, where the same numbers are CSS percentages over a rendered page at
  any zoom or DPI.

Mode B needed no schema change to build, because the coordinates were there from
the first commit. That was the point of §8 of the brief.

## Layout reconstruction (Mode A)

The model is never asked to produce HTML, a grid spec or a layout language — only
positions, which is the thing it reports reliably. Structure is then derived
deterministically in `shared/src/layout.ts`:

1. `groupSectionsIntoBands` — sections whose vertical extents overlap become one
   band, rendered as columns. This is what puts *Baby details* beside *Baby's
   foot print*, as printed.
2. `groupIntoRows` — within a section, fields whose vertical extents overlap by
   more than half the shorter box share a printed line and render as one row.
   The tolerance absorbs the ragged baselines of a scan.
3. `rowWeights` — printed blank width is a good proxy for expected answer length,
   so widths carry over as clamped flex weights.

The result reads like the original page instead of a generic vertical stack, and
it degrades gracefully: a form the model boxes poorly still renders, just less
faithfully.

## Trust boundary

Everything the model returns is a **proposal**. The boundary is enforced twice:

**At analysis** (`lib/normalize.ts`) — zod parse; ids slugified and de-duplicated;
type/options combinations repaired (a `select` with no printed options becomes
`text`; a `boolean` with real choices becomes `radio`; a two-option yes/no list
becomes `boolean` whatever it was called); sections with no fillable fields
dropped; dangling `relatedFieldIds` removed.

**At extraction** (`shared/src/validation.ts` + `apply.ts`) — field ids outside
the catalogue are discarded before validation; every value is re-parsed against
its declared type; enum values must match a printed option. Model confidence is
deliberately *not* an input to any of this.

## Page-awareness without page navigation

The MVP analyzes page 1 only, as specified. But the data model is page-keyed
end to end: `FormSchema.pages[]`, `FormState.pages[pageNumber][fieldId]`, assets
stored per page, the analysis cache keyed on `(hash, page, model)`, and
`ingestDocument` taking a `pageNumbers` array. Enabling pages 2–n is
`MAX_ANALYZED_PAGES=4` plus a page switcher in the UI — no migration, no
redesign.

## Clinical safety

Implemented as mechanism, not as prompt instructions alone:

- Analysis never reads values, only blank structure, so a filled scan cannot leak
  someone else's handwriting into a new form.
- Hedged speech ("around two and a half") is marked `ambiguous` by the model and
  parked as `needs_clarification` — never confirmed.
- A bare number for a field whose document prints a unit asks for the unit rather
  than assuming one.
- Ambiguous numeric dates (`03/04/2025`) are **rejected**, not guessed.
- An existing value is never overwritten from conversation. Any disagreement
  becomes a conflict a human resolves.
- Extracted values carry an `auto` badge and the verbatim `evidence` snippet.
- The extraction prompt forbids inference, interpretation and advice; the reply
  is one sentence of acknowledgement.

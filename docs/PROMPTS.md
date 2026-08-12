# Prompts, structured output schemas and validation

Both prompts live in code and are the source of truth:

- `server/src/schemas/analysisSchema.ts`
- `server/src/schemas/extractionSchema.ts`

---

## 1. Page analysis

**Model** `gemini-2.5-pro` · **temperature** 0 · **thinking** model-decided ·
**input** page bytes (`inlineData`) + one short user turn · **output**
`responseMimeType: application/json` constrained by `analysisResponseSchema`.

### Design decisions

**Ask for position, not layout.** The model is never asked for HTML, a grid spec
or column counts. It reports where things are; `shared/src/layout.ts` derives
rows and columns deterministically. Position is what a vision model reports
reliably; layout description is what it hallucinates.

**Use the native box convention.** `box_2d` is `[ymin, xmin, ymax, xmax]`
normalized 0–1000 — what Gemini is trained on. Converting to our `{x, y, w, h}`
happens locally.

**Box the blank, not the label.** `box_2d` is the area a person writes in;
`label_box_2d` is the printed label. Overlay mode is unusable if these are
conflated.

**A closed type enum.** `type` is constrained to the 13 supported types, so an
unrecognized type can never reach the renderer.

**No values, anywhere.** The schema has no field for a value. Analysis describes
blank structure; reading handwriting out of a filled-in scan is a separate
problem and is out of scope. This also means uploading a *completed* form cannot
leak one patient's data into a new record.

### Rules the prompt encodes

The full system instruction is in `analysisSchema.ts`. The load-bearing parts:

- A printed run of alternatives separated by `/` is **one** field whose options
  are those alternatives — never one field per alternative. `Amniotic fluid :
  Clear / Meconium stained / Foul smell` is one radio field with three options.
- `Yes / No` alone is `boolean`; with extra choices or qualifying text it is
  `radio`.
- Several labelled blanks on one line are separate fields (`Weight :__ Length :__
  HC :__` → three). One label enumerating several blanks is also several fields,
  distinguished by `context` and cross-linked via `related_field_ids` (`APGAR at
  1min, 5min, 10min – ___, ___, ___`).
- A ruled grid with headers is one `table` field with `columns`.
- Headings, instructions, logos, addresses and page furniture are **not** fields.
- **Do not invent a field. Do not invent options.** See the note on `Sex` below.

### A deliberate deviation from the brief

§6 of the brief suggests `Sex : ______` could become
`{"type": "select", "options": ["Male", "Female"]}`. The prompt forbids this,
because the document prints no options there, and the same instruction that
would permit inventing them everywhere else is the one that keeps the system
honest on a form nobody has seen. Concretely, an invented two-option enum would
make "ambiguous genitalia" — a real and clinically important neonatal finding —
unrecordable. `Sex` is therefore `text`, and only genuinely printed choices
become options. Where a form *does* print `Sex : M / F`, it becomes a radio,
because the page said so.

---

## 2. Conversation extraction

**Model** `gemini-2.5-flash` · **temperature** 0 · **thinking budget 0** ·
**maxOutputTokens** 2048 · **input** compact field catalogue + last 6 turns ·
**output** constrained by `extractionResponseSchema`.

### Design decisions

**`valueText` is always a string** — even for numbers, dates and booleans. Typed
unions are the least reliable part of schema-constrained decoding, and every
value is re-parsed locally regardless. The wire format stays a string; the
deterministic parser owns typing.

**`certainty` is a required enum**, not a probability. `explicit` vs `ambiguous`
is a judgement the model can make well; a calibrated 0–1 confidence is not, and
would invite thresholding — which is exactly what §16 of the brief warns against.

**`evidence` must be an exact substring** of the speaker's message. It is shown
to the user during conflict resolution and makes an invented value obvious.

**The catalogue is the only vocabulary.** The model is told exactly which field
ids exist. Anything else it emits is dropped before validation.

### The request payload

```
FIELDS (JSON):
[{"id":"name","label":"Name","type":"text","section":"Patient Details"},
 {"id":"weight","label":"Weight","type":"decimal","section":"BABY DETAILS"},
 {"id":"amniotic_fluid","label":"Amniotic fluid","type":"radio",
  "options":["Clear","Meconium stained","Foul smell"],"section":"Resuscitation details"}]

TODAY: 2026-08-12

CONVERSATION (oldest first; extract from the final SPEAKER turn, using the earlier turns only as context):
SPEAKER: The baby is Rahul Kumar, born today at 10:35 AM.
ASSISTANT: Recorded the name and time of birth.
SPEAKER: He weighs 2.4 kilograms and the fluid was clear.
```

Fields that already hold a value are omitted unless pinned; pinned ones carry
`"current"` so the model can recognise a correction.

**The uploaded document never appears here.**

---

## 3. Local validation

`shared/src/validation.ts` re-parses every proposed value. Model confidence is
not an input.

| Type | Accepted | Rejected / escalated |
|---|---|---|
| `date` | `2026-08-12`, `12 Aug 2026`, `Aug 12, 2026`, `25/12/2026`, `today`/`yesterday`/`tomorrow` | **`03/04/2025` → rejected as ambiguous.** Day/month order is unknowable; guessing would fabricate a date. Also rejects `2026-02-30`. |
| `time` | `10:35 am`, `1035`, `7 pm`, `19:00` | bare `7` (not a complete time), minutes > 59 |
| `number` | integers, `two`, `twelve` | non-integers on a `number` field |
| `decimal` | `2.4`, `2,4`, `two and a half`, `two point five` | unparseable text |
| `boolean` | yes/y/true/present/positive/done and their negatives | anything else |
| `radio` / `select` | exact, word-containment or unique-prefix match against a **printed** option | anything not on the list |
| `multiselect` | splits on `,`/`;`/`and`/`+`/`/`, each part matched | any part not on the list |
| any | — | `unknown`, `n/a`, `tbd`, `?` are non-answers |

**Units.** A number offered for a field whose document prints a unit, with no
unit stated, returns `ok: 'clarify'` — not an accepted value. A stated unit that
disagrees with the printed one also escalates. Assuming "kg" would invent
information.

**Conflicts.** `apply.ts` never overwrites a non-null value from conversation —
not even one conversation itself wrote. A restatement that differs becomes
`status: "conflict"` with both values preserved for the user. This is stricter
than §15 of the brief, which only protects `editedByUser` fields; on a clinical
form the extra confirmation click is cheaper than a silently changed value.

---

## 4. The local gate

`shared/src/gate.ts`, run before every extraction call on both client and server.

| Signal | Verdict |
|---|---|
| < 3 characters | skip |
| small talk (`ok`, `thanks`, `hi`, `got it`, …) | skip |
| contains a digit | **extract** |
| mentions a word (>3 chars) from any field label | **extract** |
| a question with no digits and no field terms | skip |
| ≥ 4 words | **extract** |

Biased towards letting things through: a false "relevant" costs one cheap call,
a false "irrelevant" loses real data.

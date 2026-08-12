# HTTP API

Base URL `http://localhost:4000`. Errors are always
`{ "error": { "code": string, "message": string, "details"?: unknown } }`.

## Authentication

Endpoints that can reach a model take the Gemini key from a request header, so
the key can be set in the app rather than in server config:

| Header | Purpose |
|---|---|
| `x-gemini-api-key` | The Gemini API key. Falls back to `GEMINI_API_KEY` on the server when absent. |
| `x-gemini-analysis-model` | Overrides the page-analysis model for this request. |
| `x-gemini-extraction-model` | Overrides the extraction model for this request. |

The key is used for the duration of the request and never persisted, logged or
returned. `POST /api/forms` and `POST /api/forms/:id/messages` need it; the
read, edit, resolve and save endpoints do not.

Without a key from either source those endpoints return `401
GEMINI_NOT_CONFIGURED`. A key Google rejects returns `401 GEMINI_KEY_REJECTED`.

---

## `GET /api/settings`

What the app needs to render its settings panel.

```bash
curl -s localhost:4000/api/settings
```

```json
{
  "serverHasKey": false,
  "mockGemini": false,
  "defaults": { "analysisModel": "gemini-2.5-pro", "extractionModel": "gemini-2.5-flash" },
  "models": [
    { "id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "note": "Most accurate on scans and dense forms. Slower.", "roles": ["analysis"] },
    { "id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "note": "Fast and cheap. Good for clean digital PDFs and for conversation.", "roles": ["analysis", "extraction"] },
    { "id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite", "note": "Lowest latency. Best only for short, plain dictation.", "roles": ["extraction"] }
  ],
  "maxAnalyzedPages": 1,
  "maxUploadBytes": 26214400,
  "apiKeyUrl": "https://aistudio.google.com/apikey"
}
```

---

## `GET /api/settings/models`

The models the supplied key can actually use, queried live from Google and
cached for 10 minutes per key. Send `x-gemini-api-key`; without one it falls back
to the server key, and without that to a small static list.

```bash
curl -s localhost:4000/api/settings/models -H "x-gemini-api-key: $GEMINI_API_KEY"
```

```json
{
  "live": true,
  "models": [
    {
      "id": "gemini-2.5-pro",
      "label": "Gemini 2.5 Pro",
      "description": "…",
      "roles": ["analysis"],
      "note": "Most accurate on scans and dense forms. Slower.",
      "inputTokenLimit": 1048576,
      "rank": 10,
      "recommendedFor": "analysis"
    }
  ]
}
```

`live: false` means the listing call failed or no key was available, and the
static fallback is being returned — the picker still works.

`roles` is where a model is offered: `-lite` tiers are not offered for page
analysis (a vision task larger models do much better), and Pro is not offered for
extraction (it would cost latency in the critical path for no accuracy gain).

---

## `POST /api/settings/verify-key`

Checks a key before the app stores it. Uses `countTokens`, which is free, so
checking costs the user nothing.

```bash
curl -s -X POST localhost:4000/api/settings/verify-key \
  -H 'content-type: application/json' \
  -d '{ "apiKey": "AIza…", "model": "gemini-2.5-flash" }'
```

```json
{
  "ok": true,
  "model": "gemini-2.5-flash",
  "message": "Key works. 14 models available.",
  "models": [{ "id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "...": "" }]
}
```

The model list is returned with the verification so the picker is populated the
moment a key is saved, without a second round trip.

Rejected (`400`):

```json
{
  "ok": false,
  "error": {
    "code": "GEMINI_KEY_REJECTED",
    "message": "Google rejected that API key. Check that it is correct and that the Generative Language API is enabled for its project."
  }
}
```

Other codes: `INVALID_API_KEY_FORMAT` (fails a local shape check, no call made),
`GEMINI_MODEL_UNAVAILABLE`, `GEMINI_RATE_LIMITED`, `GEMINI_UNREACHABLE`.

---

## `GET /api/health`

```bash
curl -s localhost:4000/api/health
```

```json
{
  "ok": true,
  "serverHasKey": false,
  "mockGemini": false,
  "analysisModel": "gemini-2.5-pro",
  "extractionModel": "gemini-2.5-flash",
  "maxAnalyzedPages": 1
}
```

---

## `POST /api/forms`

Upload a document. Extracts page 1, analyzes it, returns the generated schema and
an empty state. **This is the only endpoint that sends the document to a model.**

```bash
curl -s -X POST localhost:4000/api/forms \
  -H "x-gemini-api-key: $GEMINI_API_KEY" \
  -F "file=@samples/paramitha-initial-assessment.pdf"
```

`201 Created` — full example at
[`example-schema.paramitha-page1.json`](./example-schema.paramitha-page1.json).

```jsonc
{
  "schema": {
    "formId": "form_9f3a21c4",
    "title": "INITIAL ASSESSMENT FORM",
    "documentName": "paramitha-initial-assessment.pdf",
    "sourceMimeType": "application/pdf",
    "pageCount": 4,            // the document has 4 pages …
    "analyzedPages": [1],      // … only page 1 was processed
    "analysisModel": "gemini-2.5-pro",
    "createdAt": "2026-08-12T09:15:00.000Z",
    "pages": [
      {
        "pageNumber": 1,
        "dimensions": { "width": 595.28, "height": 841.89 },
        "sections": [
          {
            "id": "baby_details",
            "title": "BABY DETAILS",
            "bbox": { "x": 0.05, "y": 0.655, "width": 0.59, "height": 0.145 },
            "fields": [
              {
                "id": "time_of_birth",
                "label": "Time of birth",
                "type": "time",
                "required": false,
                "sectionId": "baby_details",
                "bbox": { "x": 0.458, "y": 0.696, "width": 0.116, "height": 0.014 },
                "labelBBox": { "x": 0.345, "y": 0.696, "width": 0.111, "height": 0.012 },
                "detectionConfidence": 0.97
              }
            ]
          }
        ]
      }
    ]
  },
  "state": { "formId": "form_9f3a21c4", "pages": { "1": { "time_of_birth": { "value": null, "source": null, "status": "missing", "editedByUser": false, "lastUpdated": null } } }, "updatedAt": "..." },
  "pageAssetUrl": "/api/forms/form_9f3a21c4/pages/1/asset",
  "usage": { "model": "gemini-2.5-pro", "promptTokens": 2104, "responseTokens": 6890, "totalTokens": 8994, "latencyMs": 21430, "cached": false }
}
```

Errors: `415 UNSUPPORTED_MEDIA_TYPE`, `413 UPLOAD_TOO_LARGE`, `422 PDF_PARSE_FAILED`,
`422 NO_FIELDS_DETECTED`, `502 ANALYSIS_SCHEMA_INVALID`, `502 MALFORMED_MODEL_JSON`,
`401 GEMINI_NOT_CONFIGURED`, `401 GEMINI_KEY_REJECTED`.

---

## `GET /api/forms/:formId`

Schema, current state and full transcript. Used to resume a session.

## `GET /api/forms`

`{ "forms": [{ "formId", "title", "createdAt", "savedAt" }] }`

## `GET /api/forms/:formId/pages/:pageNumber/asset`

The extracted single page, as `application/pdf` or the original image type. This
is the background for overlay mode.

---

## `POST /api/forms/:formId/messages`

A conversation turn. Runs the gate, then extraction if warranted.

```bash
curl -s -X POST localhost:4000/api/forms/form_9f3a21c4/messages \
  -H "x-gemini-api-key: $GEMINI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "pageNumber": 1,
        "message": "The baby is Rahul Kumar, born today at 10:35 AM. He is male and weighs 2.4 kilograms. He cried immediately after birth."
      }'
```

```jsonc
{
  "extraction": {
    "formId": "form_9f3a21c4",
    "applied": [
      { "fieldId": "name",  "pageNumber": 1, "value": "Rahul Kumar", "status": "confirmed", "evidence": "The baby is Rahul Kumar" },
      { "fieldId": "date_of_birth", "pageNumber": 1, "value": "2026-08-12", "status": "confirmed", "evidence": "born today" },
      { "fieldId": "time_of_birth", "pageNumber": 1, "value": "10:35", "status": "confirmed", "evidence": "at 10:35 AM" },
      { "fieldId": "sex",    "pageNumber": 1, "value": "male", "status": "confirmed", "evidence": "He is male" },
      { "fieldId": "weight", "pageNumber": 1, "value": 2.4, "unit": "kg", "status": "confirmed", "evidence": "weighs 2.4 kilograms" },
      { "fieldId": "cried_immediately_after_birth", "pageNumber": 1, "value": true, "status": "confirmed", "evidence": "He cried immediately after birth" }
    ],
    "pending": [],
    "rejected": [],
    "reply": "Recorded the name, birth date and time, sex, weight and that the baby cried immediately.",
    "skipped": false,
    "usage": { "model": "gemini-2.5-flash", "promptTokens": 812, "responseTokens": 214, "totalTokens": 1026, "latencyMs": 640 }
  },
  "state": { "...": "full FormState" },
  "messages": [ { "role": "user", "...": "" }, { "role": "assistant", "...": "" } ]
}
```

**Gated turn** — no model call was made:

```jsonc
{ "extraction": { "applied": [], "pending": [], "rejected": [], "reply": "", "skipped": true }, "...": "" }
```

**Conflict** — the value stays, the suggestion is parked:

```jsonc
"pending": [
  {
    "fieldId": "mothers_age_at_conception",
    "pageNumber": 1,
    "value": 31,                 // what the form still holds
    "status": "conflict",
    "conflict": true,
    "existingValue": 31,
    "suggestedValue": 30,
    "evidence": "mother is 30",
    "note": "a different value was recorded earlier"
  }
]
```

**Ambiguity** — heard, not confirmed:

```jsonc
"pending": [
  {
    "fieldId": "weight",
    "pageNumber": 1,
    "value": null,
    "status": "needs_clarification",
    "suggestedValue": 2.5,
    "evidence": "weighs around two and a half",
    "note": "the statement was not definite; confirm before saving"
  }
]
```

**Rejection** — dropped locally, never shown as form data:

```jsonc
"rejected": [
  { "fieldId": "amniotic_fluid", "valueText": "greenish", "reason": "\"greenish\" is not one of: Clear, Meconium stained, Foul smell" },
  { "fieldId": "lmp", "valueText": "03/04/2025", "reason": "ambiguous date \"03/04/2025\" (day/month order unclear)" },
  { "fieldId": "diagnosis", "valueText": "sepsis", "reason": "field id is not present in this form schema" }
]
```

---

## `PATCH /api/forms/:formId/fields/:fieldId`

A manual edit. Sets `editedByUser: true`, after which extraction may only
*suggest* against this field, never overwrite it.

```bash
curl -s -X PATCH localhost:4000/api/forms/form_9f3a21c4/fields/weight \
  -H 'content-type: application/json' \
  -d '{ "pageNumber": 1, "value": 2.45 }'
```

`{ "state": { ... } }` — send `"value": null` to clear.

---

## `POST /api/forms/:formId/fields/:fieldId/resolve`

Settle a `conflict` or `needs_clarification`.

```bash
curl -s -X POST localhost:4000/api/forms/form_9f3a21c4/fields/weight/resolve \
  -H 'content-type: application/json' \
  -d '{ "pageNumber": 1, "choice": "accept" }'
```

`choice: "accept"` takes the pending suggestion; `"keep"` discards it and keeps
the current value.

---

## `POST /api/forms/:formId/save`

Freezes the current values as a submission.

```json
{ "formId": "form_9f3a21c4", "savedAt": "2026-08-12T09:41:02.115Z", "state": {}, "schema": {} }
```

---

## Field state

Every field carries:

```jsonc
{
  "value": "Rahul Kumar",
  "source": "conversation",        // "conversation" | "user" | null
  "status": "confirmed",           // missing | confirmed | needs_clarification | conflict
  "unit": null,
  "lastUpdated": "2026-08-12T09:20:11.402Z",
  "editedByUser": false,           // true ⇒ extraction may only suggest
  "evidence": "The baby is Rahul Kumar",
  "pending": null,                 // the parked suggestion, when status is not confirmed/missing
  "note": null
}
```

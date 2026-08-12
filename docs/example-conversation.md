# Worked example: conversation → fields

Using the attached Paramitha form (page 1). Field ids come from the generated
schema — see [`example-schema.paramitha-page1.json`](./example-schema.paramitha-page1.json).

> Responses below are illustrative of the live pipeline. The behaviours marked
> **verified** were reproduced against the running server; the exact wording of
> `reply` varies with the model.

---

## 1. A normal dictation

> **Doctor:** The baby is Rahul Kumar, born today at 10:35 AM. He is male and
> weighs 2.4 kilograms. He cried immediately after birth.

Model output (`extractionResponseSchema`):

```json
{
  "updates": [
    { "fieldId": "name", "valueText": "Rahul Kumar", "evidence": "The baby is Rahul Kumar", "certainty": "explicit" },
    { "fieldId": "date_of_birth", "valueText": "today", "evidence": "born today", "certainty": "explicit" },
    { "fieldId": "time_of_birth", "valueText": "10:35 AM", "evidence": "at 10:35 AM", "certainty": "explicit" },
    { "fieldId": "sex", "valueText": "male", "evidence": "He is male", "certainty": "explicit" },
    { "fieldId": "weight", "valueText": "2.4", "unit": "kilograms", "evidence": "weighs 2.4 kilograms", "certainty": "explicit" },
    { "fieldId": "cried_immediately_after_birth", "valueText": "Yes", "evidence": "He cried immediately after birth", "certainty": "explicit" }
  ],
  "reply": "Recorded the name, birth date and time, sex, weight and that the baby cried immediately."
}
```

After local validation:

| field | stored value | note |
|---|---|---|
| `name` | `"Rahul Kumar"` | |
| `date_of_birth` | `"2026-08-12"` | `today` resolved against the server clock |
| `time_of_birth` | `"10:35"` | normalized to 24h |
| `sex` | `"male"` | free text — the document prints no options |
| `weight` | `2.4` | the form prints no unit, so `kilograms` is recorded as-is |
| `cried_immediately_after_birth` | `true` | `boolean` |

---

## 2. Printed choices

> **Doctor:** Amniotic fluid was meconium-stained. Delivery was by LSCS.

```json
{
  "updates": [
    { "fieldId": "amniotic_fluid", "valueText": "meconium-stained", "evidence": "Amniotic fluid was meconium-stained", "certainty": "explicit" },
    { "fieldId": "mode_of_delivery", "valueText": "LSCS", "evidence": "Delivery was by LSCS", "certainty": "explicit" }
  ],
  "reply": "Recorded the amniotic fluid and mode of delivery."
}
```

`matchOption` canonicalizes `"meconium-stained"` → `"Meconium stained"`, the
printed option. **Verified.**

---

## 3. Ambiguity is not resolved by guessing

> **Doctor:** Mother's age at conception is about 30.

```json
{
  "updates": [
    { "fieldId": "mothers_age_at_conception", "valueText": "30", "evidence": "about 30", "certainty": "ambiguous" }
  ],
  "reply": "I heard about 30 for the mother's age — confirm and I'll record it."
}
```

`certainty: "ambiguous"` → the field is **not** filled:

```json
{
  "fieldId": "mothers_age_at_conception",
  "status": "needs_clarification",
  "value": null,
  "suggestedValue": 30,
  "note": "the statement was not definite; confirm before saving"
}
```

The UI shows *Heard **30** — the statement was not definite* with
**Dismiss** / **Use 30**. **Verified.**

A second guard fires independently. Because this field's document prints `(years)`,
a bare number with no unit stated *also* escalates:

```json
{ "status": "needs_clarification", "note": "no unit stated; \"Mother's age at conception\" is recorded in years" }
```

---

## 4. Conflict

Weight already holds `2.4`.

> **Doctor:** Correction, the weight is 2.6 kg.

```json
{
  "fieldId": "weight",
  "status": "conflict",
  "conflict": true,
  "value": 2.4,
  "existingValue": 2.4,
  "suggestedValue": 2.6,
  "evidence": "the weight is 2.6 kg",
  "note": "a different value was recorded earlier"
}
```

The stored value stays `2.4` until a human decides. **Verified**, including
`POST …/fields/weight/resolve {"choice":"accept"}` → `2.6`, `status: confirmed`.

If the field had been typed by hand, the note reads *this field was edited by
hand* — `editedByUser` is never silently overwritten.

---

## 5. Values that are not on the form are dropped

> **Doctor:** Amniotic fluid was greenish. Start him on ampicillin.

```json
{
  "rejected": [
    { "fieldId": "amniotic_fluid", "valueText": "greenish", "reason": "\"greenish\" is not one of: Clear, Meconium stained, Foul smell" },
    { "fieldId": "medication", "valueText": "ampicillin", "reason": "field id is not present in this form schema" }
  ]
}
```

Page 1 has no medication field, so there is nowhere for that to go — and it is
dropped rather than forced into the nearest text blank. **Verified** for the
unknown-field case.

---

## 6. Turns that cost nothing

> **Doctor:** ok thanks

Gate verdict `small talk` → no request, no tokens, no latency. The panel replies
locally. **Verified** (`"skipped": true`).

---

## 7. The same pipeline on a completely different form

Nothing above is configured. Upload an HR onboarding sheet and the catalogue
becomes:

```json
[
  { "id": "employee_name", "label": "Employee Name", "type": "text" },
  { "id": "employee_id", "label": "Employee ID", "type": "text" },
  { "id": "department", "label": "Department", "type": "select", "options": ["Engineering", "Sales", "Operations"] },
  { "id": "joining_date", "label": "Joining Date", "type": "date" },
  { "id": "salary", "label": "Salary", "type": "decimal", "unit": "INR" }
]
```

> **HR:** Priya Nair, employee 4471, joining Engineering on 1 September 2026.

```json
{
  "updates": [
    { "fieldId": "employee_name", "valueText": "Priya Nair", "certainty": "explicit" },
    { "fieldId": "employee_id", "valueText": "4471", "certainty": "explicit" },
    { "fieldId": "department", "valueText": "Engineering", "certainty": "explicit" },
    { "fieldId": "joining_date", "valueText": "1 September 2026", "certainty": "explicit" }
  ]
}
```

`salary` stays empty — it was not mentioned, and absence of information is a
valid outcome. Same code, same prompts, same validators.

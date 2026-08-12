#!/usr/bin/env bash
#
# End-to-end exercise of the API against a running server.
#
#   npm run dev:server                    # real Gemini (needs GEMINI_API_KEY)
#   MOCK_GEMINI=true npm run dev:server   # offline fixture
#   ./scripts/smoke-test.sh
#
# Optional: BASE=http://localhost:4000 FILE=path/to/form.pdf ./scripts/smoke-test.sh

set -euo pipefail

BASE="${BASE:-http://localhost:4000}"
FILE="${FILE:-samples/paramitha-initial-assessment.pdf}"

jqish() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(require('util').inspect(eval('(' + '('+d+')' + ')')$1,{depth:6,colors:true,maxArrayLength:40}))}catch(e){console.log(d.slice(0,600))}})"; }

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

step "health"
curl -sS "$BASE/api/health" | jqish ""

step "upload page 1 of $FILE"
UPLOAD=$(curl -sS -X POST "$BASE/api/forms" -F "file=@$FILE")
FORM_ID=$(node -e "console.log(JSON.parse(process.argv[1]).schema.formId)" "$UPLOAD")
node -e '
const r = JSON.parse(process.argv[1]);
const page = r.schema.pages[0];
const fields = page.sections.flatMap(s => s.fields);
console.log("formId        :", r.schema.formId);
console.log("title         :", r.schema.title);
console.log("pages in doc  :", r.schema.pageCount, "| analyzed:", r.schema.analyzedPages.join(","));
console.log("sections      :", page.sections.length);
console.log("fields        :", fields.length);
console.log("types         :", JSON.stringify(fields.reduce((a,f)=>(a[f.type]=(a[f.type]||0)+1,a),{})));
console.log("usage         :", JSON.stringify(r.usage));
' "$UPLOAD"

say() {
  printf '\n\033[0;35m> %s\033[0m\n' "$1"
  curl -sS -X POST "$BASE/api/forms/$FORM_ID/messages" \
    -H 'content-type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({pageNumber:1,message:process.argv[1]}))' "$1")" |
    node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const x = JSON.parse(d).extraction;
  if (x.skipped) return console.log("  gated locally — no model call");
  for (const u of x.applied)  console.log("  ✓", u.fieldId, "=", JSON.stringify(u.value), u.unit ? u.unit : "");
  for (const p of x.pending)  console.log("  ?", p.fieldId, `[${p.status}]`, "have:", JSON.stringify(p.value), "heard:", JSON.stringify(p.suggestedValue), "—", p.note);
  for (const r of x.rejected) console.log("  ✗", r.fieldId, "—", r.reason);
  console.log("  reply:", x.reply);
  if (x.usage) console.log("  usage:", x.usage.totalTokens ?? "–", "tokens,", x.usage.latencyMs, "ms");
});'
}

step "conversation"
say "The baby is Rahul Kumar, born today at 10:35 AM. He is male and weighs 2.4 kilograms. He cried immediately after birth."
say "Amniotic fluid was clear and the delivery was by LSCS."
say "ok thanks"
say "The amniotic fluid was greenish."

step "manual edit (marks the field human-owned)"
curl -sS -X PATCH "$BASE/api/forms/$FORM_ID/fields/weight" \
  -H 'content-type: application/json' -d '{"pageNumber":1,"value":2.4}' |
  jqish ".state.pages[1].weight"

step "conversation now disagrees with the hand-typed value"
say "Correction, the weight is 2.6 kg."

step "resolve the conflict by accepting the new value"
curl -sS -X POST "$BASE/api/forms/$FORM_ID/fields/weight/resolve" \
  -H 'content-type: application/json' -d '{"pageNumber":1,"choice":"accept"}' |
  jqish ".state.pages[1].weight"

step "save"
curl -sS -X POST "$BASE/api/forms/$FORM_ID/save" | jqish ".savedAt"

printf '\n\033[1;32mdone — form %s\033[0m\n' "$FORM_ID"

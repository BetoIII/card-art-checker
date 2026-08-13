# Card Art Checker — integration guide for rain-api

Request and response shapes for submitting card art from the back-office card design
flow and consuming the compliance result.

**Base URL:** `https://card-art-checker.vercel.app`
**Audience:** whoever wires `rain-api/lib/tenant/cardArtForms` to this service.

---

## 1. The shape of the integration

A check takes **100–160 seconds** — a Claude agent inspects the art visually — so nothing
returns a verdict synchronously. The flow is always:

```
submit  →  runId  →  (wait)  →  result
```

That fits the existing lifecycle: the row is born `SUBMITTED`, the check runs after your
201 goes back to the tenant, and the result moves the row to a terminal state.

```
rain-frontend ──POST multipart──> rain-api ──┬──> 201 CardArtForm (tenant stops waiting)
                                             │
                                             └──> card-art-checker  (async, 100–160s)
                                                        │
                                                        └──> result → status + rejectionReason
```

---

## 2. Authentication

One shared secret, sent either way:

```http
Authorization: Bearer <CARD_ART_CHECKER_SECRET>
```
```http
x-webhook-secret: <CARD_ART_CHECKER_SECRET>
```

Ask Beto for the value. It is the same secret used by `/api/result/:runId`.

> **Why it matters beyond access control:** authentication is what distinguishes a
> server-to-server caller from the browser upload page. Authenticated callers may omit
> `projectId` and use `?async=1`; anonymous ones may not. If your calls are silently
> behaving like the browser path (streaming, demanding a `projectId`), the secret isn't
> arriving.

---

## 3. Submit a check

### Request

```http
POST /api/card-check?async=1
Authorization: Bearer <secret>
Content-Type: multipart/form-data
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | file | **yes** | The card art. PNG for virtual. |
| `cardType` | `"virtual"` \| `"physical"` | no | Inferred from the filename when omitted. Send `virtual` explicitly — back-office art is always virtual. |
| `reference` | string | no | **Your** correlation id, e.g. the `cardArtForm.id`. Comes back on `trigger.reference`. Sanitized to `[A-Za-z0-9._-]`, max 64 chars. |
| `projectId` | string | no | Rocketlane project id. Omit it — you don't have one. When present it must resolve in Rocketlane or the run fails. |
| `callbackUrl` | string | no | Push the result here instead of polling. Allowlist-gated — see §5. |
| `backFile` | file | no | Physical submissions only. |
| `slackDelivery` | boolean | no | Irrelevant to this flow. |

```ts
// rain-api/lib/tenant/cardArtForms/index.ts — after the row is created
const form = new FormData()
form.append("file", new Blob([body.cardArt.buffer], { type: "image/png" }), body.cardArt.filename)
form.append("cardType", "virtual")
form.append("reference", cardArtForm.id)

const res = await fetch(`${CARD_ART_CHECKER_URL}/api/card-check?async=1`, {
  method: "POST",
  headers: { Authorization: `Bearer ${CARD_ART_CHECKER_SECRET}` },
  body: form,
})
const { runId } = await res.json()
```

`?async=1` returns as soon as the file is parsed; the analysis continues in the
background. Without it you get a Server-Sent Events progress stream instead — don't,
from a server.

### Responses

**`200` — queued.** Store `runId` on the row.

```json
{
  "ok": true,
  "queued": true,
  "runId": "msqz4i4j-6fa7c9",
  "projectId": null,
  "reference": "cardArtForm_01HX9",
  "cardType": "virtual"
}
```

**`400` — the submission never started.** `runId` is included so the attempt is still traceable.

```json
{ "error": "No file uploaded", "runId": "msr0w4np-1eoerz" }
```

Other `error` values: `"Missing projectId"` (only if unauthenticated),
`"Invalid cardType \"foo\" — must be \"virtual\" or \"physical\""`,
`"Could not infer card type from \"art.bin\" — pass cardType=virtual|physical explicitly"`,
`"Multipart parse timed out"`.

**`400` (text) — wrong content type.** Body is `Bad request: expected multipart/form-data`.

---

## 4. Read the result (pull)

### Request

```http
GET /api/result/{runId}
Authorization: Bearer <secret>
```

### Responses

**`200`** — one entry per analyzed file:

```json
{ "runId": "msqz4i4j-6fa7c9", "count": 1, "results": [ { /* §6 */ } ] }
```

**`404`** — still running, or unknown run. This is the normal answer while waiting.

```json
{ "error": "No result for that runId", "runId": "…", "hint": "The run may still be in progress." }
```

**`400`** `{ "error": "Malformed runId" }` · **`401`** `Unauthorized` (text) ·
**`502`** `{ "error": "Result lookup failed" }`

Each run also produces a `resultUrl` — a public blob URL readable with no auth. Treat
the URL itself as the secret.

---

## 5. Receive the result (push) — recommended

Avoids polling entirely. Requires a receiving route on your side plus one config change
on ours (either `RESULT_WEBHOOK_URL` + `RESULT_WEBHOOK_SECRET` pointed at it, or your
host added to `RESULT_WEBHOOK_ALLOWED_HOSTS` so per-request `callbackUrl` is honored).

### What arrives

```http
POST <your endpoint>
Content-Type: application/json
User-Agent: card-art-checker/1.0
X-Card-Art-Signature: sha256=<hex>
X-Card-Art-Timestamp: <unix seconds>
```

```json
{
  "schema_version": "1.0",
  "event": "card_art_check.completed",
  "run_id": "msqz4i4j-6fa7c9",
  "attachment_id": null,
  "occurred_at": "2026-08-13T04:32:34.023Z",
  "data": { /* the result object, §6 */ }
}
```

`event` is `card_art_check.completed` or `card_art_check.failed`.

### Verifying

HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` — the timestamp is **inside** the signed
material, so a captured request cannot be replayed with a fresh one. Same scheme as the
Dock webhook rain already verifies, inverted.

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

function verify(rawBody: string, headers: Record<string, string>, secret: string) {
  const ts = headers["x-card-art-timestamp"]
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(headers["x-card-art-signature"] ?? "")
  return a.length === b.length && timingSafeEqual(a, b)
}
```

Verify against the **raw** body, before JSON parsing — re-serializing changes the bytes.

### Delivery semantics

| | |
|---|---|
| Retries | 3 attempts, 500ms backoff doubling |
| Retried on | `5xx`, `408`, `429` |
| Not retried | any other `4xx` |
| Timeout | 10s per attempt |
| Physical results | never sent (`schema_version: "0-internal"`) |
| Delivery failure | recorded on the run; never fails the analysis |

Respond `2xx` fast and do your work afterward.

---

## 6. The result object

```jsonc
{
  "schema_version": "1.0",          // "0-internal" for physical — not a stable contract
  "run_id": "msqz4i4j-6fa7c9",
  "attachment_id": null,            // set only on Rocketlane-sourced runs
  "card_type": "virtual",
  "generated_at": "2026-08-13T03:46:31.599Z",

  "outcome": "requires_changes",    // ← branch on this
  "status": "fail",                 // legacy two-state; see note below
  "summary": "The art is clean, full-color, and legible… but the Visa Brand Mark is placed in the lower-right corner…",

  "project":    { "id": null, "name": null },
  "submission": { "file_name": "BRAZA_CARTAO-2026_VIRTUAL.png" },
  "trigger":    { "source": "api", "endpoint": "/api/card-check", "reference": "cardArtForm_01HX9" },
  "report":     { "pdf_url": "https://…-report.pdf" },

  "counts": { "pass": 17, "fail": 1 },
  "blocking_failures": ["visa_brand_mark_position"],

  "checks": [
    {
      "id": "visa_brand_mark_position",
      "name": "Visa Brand Mark position (upper-left/upper-right only)",
      "category": "brand_mark",
      "severity": "blocker",
      "status": "fail",
      "reason_code": "position_lower_edge",
      "notes": "The Visa Brand Mark is in the lower-right corner…",
      "marker": { "x": 0.84, "y": 0.82 }
    }
  ],

  "tech_checks": [
    { "id": "bleed_zone", "status": "pass", "actual": "Bottom: 127px, Right: 63px",
      "required": null, "note": "…", "measurements": { } }
  ],

  "colors": {
    "background": { "rgb": [185, 5, 57],    "hex": "#B90539" },
    "foreground": { "rgb": [240, 240, 240], "hex": "#F0F0F0" },
    "label":      { "rgb": [240, 240, 240], "hex": "#F0F0F0" }
  },

  "unmapped_checks": []
}
```

### Field notes

| Field | Notes |
|---|---|
| `outcome` | The review decision. Branch on this. |
| `status` | Legacy top-level state: `pass` \| `fail` \| `error`. `approved_with_notes` collapses to `pass`, so **don't use it for the decision** — it erases the distinction you care about. `error` means the run broke (§8). |
| `checks[].id` | **The contract.** Bind to this. |
| `checks[].name` | Display text the model may reword. Never match on it. |
| `checks[].marker` | Normalized 0–1 coordinates on the art. `{x: 0.84, y: 0.82}` is lower-right. Absent when not locatable. |
| `counts` | Only non-zero statuses appear as keys. |
| `blocking_failures` | Check ids that are `fail` **and** `blocker`. Empty ⇒ nothing blocking. |
| `colors` | Extracted from the art — compare against the tenant's declared colors. |
| `unmapped_checks` | Should always be `[]`. Non-empty means our prompt and catalog drifted; nothing is dropped, but tell us. |

---

## 7. Enums

```ts
type Outcome  = "approved" | "approved_with_notes" | "requires_changes"
type Severity = "blocker" | "required" | "advisory"
type Status   = "pass" | "fail" | "warning" | "not_submitted" | "unverified" | "estimated"
```

`warning` is a real, common state — a borderline measurement that didn't fail. Treat
anything that isn't `pass` as "not clean", but only `blocking_failures` should reject.

### Virtual check IDs (18)

| id | category | severity | reason codes |
|---|---|---|---|
| `visa_brand_mark_present` | brand_mark | blocker | `mark_absent` |
| `visa_brand_mark_position` | brand_mark | blocker | `position_lower_edge`, `position_wrong_corner`, `mark_absent` |
| `visa_brand_mark_size` | brand_mark | blocker | `size_undersized`, `size_oversized`, `size_unverifiable` |
| `visa_brand_mark_margin` | brand_mark | blocker | `margin_below_minimum`, `margin_borderline`, `margin_unverifiable` |
| `visa_brand_mark_contrast` | brand_mark | blocker | `contrast_insufficient_wordmark`, `contrast_insufficient_identifier` |
| `product_identifier` | product_identifier | blocker | `identifier_absent`, `identifier_wrong_corner`, `identifier_separated_from_mark`, `identifier_in_pan_zone`, `identifier_casing`, `identifier_tier_mismatch` |
| `issuer_logo_present` | required_elements | required | `issuer_logo_absent` |
| `no_emv_chip` | prohibited | blocker | `prohibited_element_present` |
| `no_hologram` | prohibited | blocker | `prohibited_element_present` |
| `no_magnetic_stripe` | prohibited | blocker | `prohibited_element_present` |
| `no_cardholder_name` | prohibited | blocker | `prohibited_element_present` |
| `no_pan` | prohibited | blocker | `prohibited_element_present` |
| `no_expiry_date` | prohibited | blocker | `prohibited_element_present` |
| `no_physical_card_photography` | prohibited | required | `prohibited_element_present` |
| `lower_left_area_clear` | layout | blocker | `pan_zone_obstructed`, `pan_zone_legibility_risk` |
| `design_elements_clear_of_identifier` | layout | blocker | `identifier_obstructed` |
| `landscape_orientation` | layout | blocker | `orientation_not_landscape` |
| `full_color` | layout | required | `grayscale_or_monochrome` |

### Technical check IDs (virtual)

`dimensions` · `file_format` · `dpi` · `bleed_zone`

These overlap `validation.ts` and can serve as a cross-check. Note `dpi` here means
**calculated** DPI ≥ 72, not "declared density equals 72" — a PNG declaring 300 DPI
passes this check.

---

## 8. Failure results

A run that never produced an analysis still publishes a result, so *"this card has
problems"* stays distinguishable from *"the checker fell over"*. **Never reject a
tenant's design on a failure result** — leave the row `SUBMITTED` and retry.

```json
{
  "schema_version": "1.0",
  "run_id": "…",
  "card_type": null,
  "generated_at": "2026-08-13T04:12:09.114Z",
  "outcome": null,
  "status": "error",
  "error": { "code": "function_timeout", "message": "…", "step": "visual" },
  "project":    { "id": null, "name": null },
  "submission": { "file_name": "art.png" },
  "trigger":    { "source": "api", "endpoint": "/api/card-check", "reference": "cardArtForm_01HX9" }
}
```

**The cheapest discriminator is `status === "error"`** — a failure result carries no
`checks`, `counts`, `summary`, or `blocking_failures` at all, and `outcome` is `null`.
`card_type` is `null` when the run failed before the type was resolved.

Closed set of `error.code`:

`visual_budget_exhausted` · `function_timeout` · `abandoned` · `missing_project_id` ·
`card_type_indeterminate` · `attachment_download_failed` · `agent_output_unparseable` ·
`spec_check_failed` · `no_attachment_resolved` · `card_art_missing` ·
`unsupported_card_type` · `internal_error`

An unrecognized failure becomes `internal_error` rather than being misattributed.

---

## 9. Mapping onto `CardArtForm`

Using `CardArtFormStatus` from `rain-api/lib/api/repos/cardArtForm.ts`. Note that the
`rain-api-contract` package declares a different, four-value enum — see
[the integration guide §2](./rain-backoffice-integration-guide.md); that contradiction is
unresolved and the team owns it.

| Checker | → | Card art form |
|---|---|---|
| `outcome: "approved"` | → | `RAIN_APPROVED` |
| `outcome: "approved_with_notes"` | → | stay `UNDER_RAIN_REVIEW` — passes, but worth a human glance |
| `outcome: "requires_changes"` | → | `RAIN_REJECTED` |
| `summary` | → | `rejectionReason` — 1–2 sentences, fits `VARCHAR(1024)` |
| `blocking_failures[]` | → | which checks to cite |
| `checks[].id` / `reason_code` / `notes` | → | `CardArtFormValidationError` `{ field, code, message }` |
| `checks[].marker` | → | pin the issue on the preview tile |
| `colors.background` | → | cross-check the declared `backgroundColor` |
| `report.pdf_url` | → | annotated PDF for the reviewer |
| `error.code` present | → | **no transition** — retry |

---

## 10. If this replaces `validation.ts`

`validateCardArtFormSubmission` does four things; only the first is card art.

| | Covered here? |
|---|---|
| `validateDesignFile("cardArt", …)` | **yes** — plus 18 Visa rules it never attempted |
| `validateDesignFile("icon", …)` (100×100) | **no** — the icon is never analyzed |
| color string normalization (`rgb(r,g,b)`) | **no** — colors are *extracted*, not parsed |
| contact (email and/or phone) | **no** |

Two behavior changes to plan for:

1. **Instant feedback disappears.** A 1024×768 upload is rejected in milliseconds today.
   Afterward it's accepted, stored to GCS, and rejected ~2.5 minutes later — and each one
   costs a full agent run. Consider keeping a thin dimension/file-type pre-flight as a
   cheap gate.
2. **The DPI rule changes meaning** — see §7. A PNG declaring 300 DPI fails today and
   passes afterward.

---

## 11. Limits

- **Virtual only.** Physical results carry `schema_version: "0-internal"`, are never
  pushed, and their enums may change. Back-office art is PNG/virtual, so this shouldn't bite.
- **One result per file.** A run analyzing several files returns several results, each
  with its own `attachment_id`.
- **Max duration 300s.** The pipeline self-limits at 280s and degrades rather than dying.
- **`resultUrl` is public.** Unguessable, but unauthenticated — don't put it anywhere
  you wouldn't put the report.

Questions → Beto.

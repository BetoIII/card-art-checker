# Card Art Checker

Automated compliance review for Rain virtual-card art submissions. Customers drop a PNG into the form, the service runs technical-spec and visual checks with a Claude managed agent, generates a PDF report, and delivers the results to Slack and Rocketlane.

## What it does

1. Customer uploads card art (PNG/JPG) via the web form.
2. `/api/card-check` runs:
   - Technical spec validation (dimensions, color mode, file size, etc.).
   - Visual inspection by a Claude managed agent using Rain's brand guidelines.
   - PDF report generation (pdf-lib) and storage to Vercel Blob.
3. `/api/card-deliver` posts the report to the customer's Slack channel (`ext-{name}-rain`) and uploads it to the matching Rocketlane project space.

## Embedding in Rocketlane

Open the Rocketlane task, click **Insert iframe Embed Code**, and paste:

```html
<iframe
  src="https://card-art-checker.vercel.app/upload"
  width="576"
  height="324"
  style="border:0;"
  allow="clipboard-write"
></iframe>
```

Notes:
- Use the stable alias `card-art-checker.vercel.app` — not the per-deploy `...-<hash>-betoiiis-projects.vercel.app` URLs, which change on every push.
- `/upload` is the customer-facing form. The root `/` is an API playground for testing.
- `vercel.json` allows embedding via `frame-ancestors *.rocketlane.com`.
- 576×324 matches Rocketlane's recommended dimensions. Bump `height` to 600+ if the form feels cramped.

## Using the service

**Customer flow (iframe):**
1. Drop a card art file onto the upload zone.
2. Watch the progress steps — analysis, report generation, delivery.
3. The PDF is posted to your Slack channel and attached to the Rocketlane project.

**Internal testing (playground at `/`):**
1. Paste a real Rocketlane `projectId`.
2. Toggle "Skip delivery" to test without posting to Slack/Rocketlane.
3. Drop a file and watch the raw SSE event stream in the terminal view.

## Endpoints

| Route | Purpose | Timeout |
|-------|---------|---------|
| `/upload` | Customer-facing upload form (embedded in Rocketlane) | — |
| `/` | API playground for internal testing | — |
| `/api/card-check` | Analysis + PDF generation, streams SSE | 300s |
| `/api/card-deliver` | Slack + Rocketlane delivery, non-fatal per service | 60s |
| `/api/card-art-check` | External-trigger entrypoint: resolve attachment IDs, download, analyze, store, deliver. See below. | 300s |
| `/api/result/:runId` | Structured check results for a run. See below. | 30s |

## External-trigger API: `/api/card-art-check`

Project-keyed card-art check, driven by a Rocketlane "Form completed" HTTP automation. The request identifies a `projectId`; the attachment ID(s) are carried in the payload as the card-art field's HTML anchors (`<a data-attachment-id="12345">akasa.jpg</a>`). One field can hold several files → several anchors → several attachments, each analyzed and delivered.

Two stages run, in order, before any analysis or delivery begins:

1. **Resolve** — regex every `data-attachment-id` out of the raw payload.
2. **Download** — fetch each attachment's bytes via the Rocketlane v1 attachments API (`GET /api/v1/attachments/{id}/download`).

Both stages are awaited synchronously, so the HTTP response reflects whether the download succeeded. Analysis → store → deliver then runs per attachment in the background.

**Auth:** `Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET` (or `x-webhook-secret: $ROCKETLANE_WEBHOOK_SECRET`).

**Inputs** (query string takes precedence over JSON body — Rocketlane URL smart-fill is more reliable than body smart-fill):

| Field | Required | Notes |
|-------|----------|-------|
| `projectId` | yes | Numeric Rocketlane project ID. From the URL query string or JSON body. Used for Slack channel routing and Blob report path. |
| attachment IDs | yes | One or more, sourced from `data-attachment-id="…"` anchors anywhere in the payload. An explicit `attachmentId` query-string/body field is also accepted (manual/legacy callers). |
| `cardType` | no | `"virtual"` or `"physical"`. Override for ambiguous filenames; `.ai`/`.eps` always run physical regardless. Applies to every attachment in the request. |
| `callbackUrl` | no | Where to POST the structured result. Honored only for hosts in `RESULT_WEBHOOK_ALLOWED_HOSTS`; otherwise the run falls back to `RESULT_WEBHOOK_URL`. See Structured results. |

**Responses:**
- `200 { ok: true, queued: true, projectId, runId, downloaded: [...ids], failed: [...ids] }` — at least one attachment downloaded; analysis runs in the background via `waitUntil`. Use `runId` with `GET /api/result/:runId`.
- `400 { error: "Missing or unresolved projectId" }` / `{ error: "No attachment IDs found in payload" }`.
- `401` — bad/missing secret. `500` — server missing `ROCKETLANE_WEBHOOK_SECRET`.
- `502 { error: "All attachment downloads failed", projectId, failed }` — every download failed; nothing was analyzed.

**Example** (manual trigger with an explicit attachment ID; the Rocketlane automation instead posts the field-anchor payload):

```bash
curl -X POST "https://card-art-checker.vercel.app/api/card-art-check?projectId=12345&attachmentId=67890" \
  -H "Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET"
```

## Structured results

Every run publishes a machine-readable result alongside the PDF. Two ways to consume it:

**Pull** — `GET /api/result/:runId`, authenticated with the same
`ROCKETLANE_WEBHOOK_SECRET` bearer token as the trigger endpoints. The trigger's 200 response
returns the `runId`. A run analyzing several attachments yields several results, each with its
own `attachment_id`:

```bash
curl -H "Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET" \
  https://card-art-checker.vercel.app/api/result/mfk2q1x-a7b3c9
# → { "runId": "...", "count": 1, "results": [ { … } ] }
```

Returns `404` while a run is still in flight.

**Push** — set `RESULT_WEBHOOK_URL` + `RESULT_WEBHOOK_SECRET` and each completed file POSTs an
envelope. A per-request `?callbackUrl=` overrides the destination, but only for hosts listed in
`RESULT_WEBHOOK_ALLOWED_HOSTS` — the payload embeds a permanent public report URL, so an
unvalidated callback would leak it.

```json
{ "schema_version": "1.0",
  "event": "card_art_check.completed",
  "run_id": "mfk2q1x-a7b3c9", "attachment_id": "67890",
  "occurred_at": "2026-08-12T18:04:11.000Z",
  "data": { "…the result object…" } }
```

Verify with `X-Card-Art-Signature: sha256=hex(HMAC-SHA256(secret, "{timestamp}.{rawBody}"))`,
where `timestamp` is the `X-Card-Art-Timestamp` header. The timestamp is inside the signed
material, so a captured request cannot be replayed with a fresh one. `verifyPayload()` in
`lib/webhook-out.js` is the reference implementation.

Failures publish too, as `card_art_check.failed` with a closed `error.code` (e.g.
`function_timeout`, `visual_budget_exhausted`, `agent_output_unparseable`).

### The result object

```jsonc
{
  "schema_version": "1.0",
  "run_id": "…", "attachment_id": "…", "card_type": "virtual",
  "outcome": "approved | approved_with_notes | requires_changes",
  "status": "pass | fail",          // legacy two-state; approved_with_notes → pass
  "summary": "1-2 sentence assessment",
  "blocking_failures": ["visa_brand_mark_margin"],
  "counts": { "pass": 16, "warning": 2 },
  "checks": [
    { "id": "visa_brand_mark_margin",
      "name": "Visa Brand Mark margin (56px from edges)",
      "category": "brand_mark", "severity": "blocker",
      "status": "warning", "reason_code": "margin_borderline",
      "notes": "…", "marker": { "x": 0.045, "y": 0.06 } }
  ],
  "tech_checks": [ { "id": "bleed_zone", "status": "warning", "measurements": { … } } ],
  "colors": { "background": { "rgb": [68,78,92], "hex": "#444E5C" } },
  "unmapped_checks": []
}
```

`id` is the contract — `name` is display text the model may reword. The full check list,
statuses, severities, and reason codes live in `lib/check-catalog.js`, which also **generates**
the check list embedded in the agent prompt, so the two cannot drift apart.

`unmapped_checks` holds anything the agent reported that the catalog does not know. It should be
empty; a non-empty array in production means the prompt and catalog have diverged. Nothing is
ever dropped.

**Physical cards are not yet part of this contract.** No archived physical report exists to
validate their enums against, so physical results are stored with
`schema_version: "0-internal"` and are never sent to a webhook — they exist to build the corpus
a v1.1 physical schema needs.

## Tests

```bash
npm test    # node --test 'tests/*.test.js'
```

No test framework — `node:test` only. The suite is mostly a drift guard: it replays real check
names extracted from archived reports through the catalog resolver, and normalizes the one
surviving `_visual_results.json` artifact end to end.

## Deployment

Hosted on Vercel, project `card-art-checker` (team `betoiiis-projects`). Pushes to `main` deploy to production automatically.

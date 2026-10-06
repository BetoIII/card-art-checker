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

**Partners not on Rocketlane:** send them `https://card-art-checker.vercel.app/upload?tenantId=<prod tenant id>`
(the UUID from Weatherstation's `/tenants/{id}`). The form refuses to load without a
`projectId` or `tenantId` in the URL. Tenant-only runs return the PDF report without a
Slack post.

## Using the service

**Customer flow (iframe):**
1. Drop a card art file onto the upload zone.
2. Watch the progress steps — analysis, report generation, delivery.
3. The PDF is posted to your Slack channel and attached to the Rocketlane project.

**Internal testing (playground at `/`):**
1. Paste a real Rocketlane `projectId` or a Rain `tenantId` — the page detects which.
2. Toggle "Skip delivery" to test without posting to Slack/Rocketlane.
3. Drop a file and watch the raw SSE event stream in the terminal view.

## Endpoints

| Route | Purpose | Timeout |
|-------|---------|---------|
| `/upload` | Customer-facing upload form (embedded in Rocketlane, or linked with `?tenantId=`) | — |
| `/` | API playground for internal testing | — |
| `/api/card-check` | Analysis + PDF generation. Streams SSE for the browser UI; JSON for authenticated server-to-server callers. See below. | 300s |
| `/api/card-deliver` | Slack delivery for a run the browser watched. Posts only the delivery `/api/card-check` signed on completion, once per run. | 300s |
| `/api/result/:runId` | Structured check results for a run. See below. | 30s |

## Upload API: `/api/card-check`

**Every check must name the partner**: a Rocketlane `projectId` (digits), a Rain prod
`tenantId` (the UUID Weatherstation shows at `/tenants/{id}`, for partners who never
onboarded through Rocketlane), or both. A request with neither, or with a malformed one,
is refused with a 400 before a run starts — authenticated or not. Ids are checked for
shape only (`lib/partner-id.js`); a tenant id is not looked up anywhere.

Two callers share this endpoint, and **authentication is what separates them**.

| | Browser UI (`/upload`, playground) | Server-to-server |
|---|---|---|
| Auth | none | `Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET` (or `x-webhook-secret`) |
| `projectId` / `tenantId` | one required | one required |
| Response | SSE progress stream | SSE, or JSON with `?async=1` |
| `runLog.source` | `upload` | `api` |

**Fields** (multipart): `file` (required), `projectId` and/or `tenantId` (one required),
`cardType`, `backFile`, `slackDelivery`, plus two for server-to-server callers:

| Field | Purpose |
|-------|---------|
| `reference` | Caller's own correlation id (e.g. a `cardArtForm` id), echoed back on `trigger.reference`. Sanitized to a single path segment. |
| `callbackUrl` | Where to POST the result. Honored only for hosts in `RESULT_WEBHOOK_ALLOWED_HOSTS`; see Structured results. |

With a `projectId` the Rocketlane project name is looked up and the report is stored under
`reports/{projectId}/`. A tenant-only run skips Rocketlane, is stored under
`reports/{tenantId}/`, and its Slack delivery is skipped (`skipped: no Rocketlane project`)
— the channel finder needs a Rocketlane project.

```bash
curl -X POST "https://card-art-checker.vercel.app/api/card-check?async=1" \
  -H "Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET" \
  -F "file=@card.png" -F "cardType=virtual" \
  -F "tenantId=9eef553e-4dd3-4e70-b86a-0edc969f447c" -F "reference=cardArtForm_01HX9"

# → { "ok": true, "queued": true, "runId": "…", "projectId": null,
#     "tenantId": "9eef553e-4dd3-4e70-b86a-0edc969f447c",
#     "reference": "cardArtForm_01HX9", "cardType": "virtual" }
```

`?async=1` returns as soon as the file is parsed and runs the analysis in the background
via `waitUntil` — poll `GET /api/result/:runId`, or configure a webhook to be pushed the
result. It is honored only for authenticated callers: an anonymous request must hold the
stream it started.

## Structured results

Every run publishes a machine-readable result alongside the PDF. Two ways to consume it:

**Pull** — `GET /api/result/:runId`, authenticated with the same
`ROCKETLANE_WEBHOOK_SECRET` bearer token that submitted the check. The `?async=1` response
returns the `runId`; a run stores one result:

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
  "run_id": "mfk2q1x-a7b3c9", "attachment_id": null,
  "occurred_at": "2026-08-12T18:04:11.000Z",
  "data": { "…the result object…" } }
```

Verify with `X-Card-Art-Signature: sha256=hex(HMAC-SHA256(secret, "{timestamp}.{rawBody}"))`,
where `timestamp` is the `X-Card-Art-Timestamp` header. The timestamp is inside the signed
material, so a captured request cannot be replayed with a fresh one. `verifyPayload()` in
`lib/webhook-out.js` is the reference implementation.

Failures publish too, as `card_art_check.failed` with a closed `error.code` (e.g.
`function_timeout`, `visual_budget_exhausted`, `agent_output_unparseable`). Each analyzed file
gets exactly one result: a run the platform is about to kill at 300s publishes
`function_timeout` for whatever it still owes (`lib/result-emit.js`, armed by the run-log
watchdog), and a late emit after a published result is dropped.

### The result object

```jsonc
{
  "schema_version": "1.0",
  "run_id": "…", "attachment_id": "…", "card_type": "virtual",
  "outcome": "approved | approved_with_notes | requires_changes",
  "status": "pass | fail",          // legacy two-state; approved_with_notes → pass
  "summary": "1-2 sentence assessment",
  "blocking_failures": ["visa_brand_mark_margin", "bleed_zone"],
  "counts": { "pass": 20, "fail": 1 },
  "checks": [
    { "id": "visa_brand_mark_margin",
      "name": "Visa Brand Mark margin (56px from edges)",
      "category": "brand_mark", "severity": "blocker",
      "status": "fail", "reason_code": "margin_above_target",
      "notes": "…", "marker": { "x": 0.955, "y": 0.06 } }
  ],
  "tech_checks": [ { "id": "bleed_zone", "status": "fail", "measurements": { … } } ],
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
npm test          # node --test 'tests/*.test.js'
npm run test:py   # spec-check tests (scripts/check_technical_specs.py)
```

The Python tests need Pillow and numpy. Homebrew's Python won't take a global `pip install`,
so set up a virtualenv once; `test:py` uses `.venv` when it exists:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

No test framework — `node:test` only. The suite is mostly a drift guard: it replays real check
names extracted from archived reports through the catalog resolver, and normalizes the one
surviving `_visual_results.json` artifact end to end.

## Deployment

Hosted on Vercel, project `card-art-checker` (team `betoiiis-projects`). Pushes to `main` deploy to production automatically.

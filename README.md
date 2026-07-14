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

**Responses:**
- `200 { ok: true, queued: true, projectId, downloaded: [...ids], failed: [...ids] }` — at least one attachment downloaded; analysis runs in the background via `waitUntil`.
- `400 { error: "Missing or unresolved projectId" }` / `{ error: "No attachment IDs found in payload" }`.
- `401` — bad/missing secret. `500` — server missing `ROCKETLANE_WEBHOOK_SECRET`.
- `502 { error: "All attachment downloads failed", projectId, failed }` — every download failed; nothing was analyzed.

**Example** (manual trigger with an explicit attachment ID; the Rocketlane automation instead posts the field-anchor payload):

```bash
curl -X POST "https://card-art-checker.vercel.app/api/card-art-check?projectId=12345&attachmentId=67890" \
  -H "Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET"
```

## Deployment

Hosted on Vercel, project `card-art-checker` (team `betoiiis-projects`). Pushes to `main` deploy to production automatically.

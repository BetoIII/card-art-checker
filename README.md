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
| `/api/card-art-check` | External-trigger entrypoint: download attachment, analyze, store, deliver. See below. | 300s |

## External-trigger API: `/api/card-art-check`

Open-format, single-shot card-art check. Any system with a Rocketlane `projectId` and `attachmentId` can fire one request and get a full Slack-delivered report. No event-type filter, no batching, no dedup — one request → one analysis → one delivery.

**Auth:** `Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET` (or `x-webhook-secret: $ROCKETLANE_WEBHOOK_SECRET`).

**Inputs** (query string takes precedence over JSON body — Rocketlane URL smart-fill is more reliable than body smart-fill):

| Field | Required | Notes |
|-------|----------|-------|
| `projectId` | yes | Numeric Rocketlane project ID. Used for Slack channel routing and Blob report path. |
| `attachmentId` | yes | Numeric Rocketlane attachment ID. Downloaded via the Rocketlane v1 attachments API. |
| `cardType` | no | `"virtual"` or `"physical"`. Override for ambiguous filenames; `.ai`/`.eps` always run physical regardless. |

**Response:** `200 { ok: true, queued: true, projectId, attachmentId }` once auth + validation pass. The pipeline runs in the background via `waitUntil` — watch function logs for progress and delivery results.

**Example:**

```bash
curl -X POST "https://card-art-checker.vercel.app/api/card-art-check?projectId=12345&attachmentId=67890" \
  -H "Authorization: Bearer $ROCKETLANE_WEBHOOK_SECRET"
```

## Deployment

Hosted on Vercel, project `card-art-checker` (team `betoiiis-projects`). Pushes to `main` deploy to production automatically.

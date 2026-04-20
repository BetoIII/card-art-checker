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

## Deployment

Hosted on Vercel, project `card-art-checker` (team `betoiiis-projects`). Pushes to `main` deploy to production automatically.

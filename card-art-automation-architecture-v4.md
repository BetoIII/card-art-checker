# Card Art Checker Automation — Architecture v4

## Changes from v3

| Area | v3 | v4 |
|------|----|----|
| Slack channel resolution | Rocketlane custom field | Slack API search (exact + fuzzy match) |
| Upload page UX | Synchronous response (30-90s hang) | SSE streaming with real-time agent progress |
| Report destinations | Slack only | Slack + Rocketlane Space Documents |
| Slack bot channel access | Manual invitation | Programmatic `conversations.join` |
| Agent prompt source | TBD | Ported from existing `virtual-card-art-checker` skill |
| PDF blob TTL | 7-day expiry | Permanent (Rocketlane links must persist) |

---

## Overview

Customers upload card art through an **iframe embedded in the Rocketlane customer portal**. A **Vercel-hosted upload page** inside the iframe accepts the file and submits it to a **Vercel Function**, which orchestrates the entire pipeline:

1. Resolving the customer's shared Slack channel via **Slack API search** (channel naming convention: `ext-{name}-rain`)
2. Sending the card art to a **Claude Managed Agent** for programmatic spec checks and AI-powered visual analysis
3. **Streaming the agent's progress back to the upload page in real-time** via Server-Sent Events (SSE)
4. Generating a PDF compliance report
5. Posting results to the customer's **Slack channel**
6. Uploading the PDF to the project's **Rocketlane Space Documents**

**Single-function architecture** — no external orchestration layer. Vercel's 300s function timeout accommodates the Claude agent's processing time (60s+ typical). The SSE streaming connection keeps the user informed throughout.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ROCKETLANE CUSTOMER PORTAL                                                 │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  Iframe Section                                                        │ │
│  │  src="https://card-art-checker.vercel.app/upload?projectId={project_id}" │
│  │                                                                        │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │  UPLOAD PAGE (Vercel-hosted)                                     │  │ │
│  │  │                                                                  │  │ │
│  │  │  ┌─────────────────────────────┐                                │  │ │
│  │  │  │  Drag & drop card art PNG   │   • Image preview              │  │ │
│  │  │  │  or click to browse         │   • File validation            │  │ │
│  │  │  └─────────────────────────────┘   • Upload progress bar        │  │ │
│  │  │                                                                  │  │ │
│  │  │  [ Submit Card Art ]                                            │  │ │
│  │  │                                                                  │  │ │
│  │  │  ┌──────────────────────────────────────────────────────────┐    │  │ │
│  │  │  │  LIVE PROGRESS FEED (SSE)                                │    │  │ │
│  │  │  │                                                          │    │  │ │
│  │  │  │  ✓ Looking up project details...                        │    │  │ │
│  │  │  │  ✓ Found channel #ext-acme-rain                         │    │  │ │
│  │  │  │  ● Running technical spec checks...                     │    │  │ │
│  │  │  │    "Dimensions: 1536×969 — PASS"                        │    │  │ │
│  │  │  │    "Checking Visa Brand Mark margin..."                 │    │  │ │
│  │  │  │  ● Performing visual design analysis...                 │    │  │ │
│  │  │  │  ● Generating PDF report...                             │    │  │ │
│  │  │  │  ✓ Report posted to Slack                               │    │  │ │
│  │  │  │  ✓ Report uploaded to Rocketlane                        │    │  │ │
│  │  │  │                                                          │    │  │ │
│  │  │  │  ═══════════════════════════════════════════════         │    │  │ │
│  │  │  │  RESULT: APPROVED  |  PDF Report ↓                      │    │  │ │
│  │  │  └──────────────────────────────────────────────────────────┘    │  │ │
│  │  └────────────────────┬─────────────────────────────────────────┘  │ │
│  └───────────────────────┼────────────────────────────────────────────┘ │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │
                POST file + projectId
                   (response: SSE stream)
                           │
                           v
┌──────────────────────────────────────────────────────────────────────────────┐
│  VERCEL FUNCTION — POST /api/card-check  (SSE streaming response)           │
│                                                                             │
│  Phase 1: Setup                                                             │
│  ├─ 1. Parse multipart upload → PNG buffer + projectId                      │
│  ├─ 2. Rocketlane API → project name                                        │
│  ├─ 3. Slack API search → resolve channel (exact + fuzzy)                   │
│  └─ 4. Slack conversations.join → ensure bot is in channel                  │
│                                                                             │
│  Phase 2: Agent Execution (streamed to client)                              │
│  ├─ 5. Upload PNG + scripts to Anthropic Files API                          │
│  ├─ 6. Create Claude Managed Agent session                                  │
│  ├─ 7. Stream agent events → proxy to client as SSE                         │
│  │     (spec checks, visual analysis, PDF generation — 60s+ typical)        │
│  └─ 8. Download PDF from session outputs                                    │
│                                                                             │
│  Phase 3: Delivery                                                          │
│  ├─ 9.  Upload PDF to Vercel Blob (permanent URL)                           │
│  ├─ 10. Parse agent text → summary + pass/fail status                       │
│  ├─ 11. Slack: files.uploadV2 → PDF to customer channel                     │
│  ├─ 12. Slack: chat.postMessage → formatted summary                         │
│  ├─ 13. Rocketlane: resolve projectId → spaceId                             │
│  ├─ 14. Rocketlane: create space document (embedded PDF link)               │
│  └─ 15. SSE: send "complete" event with status + pdfUrl                     │
└──────────────────────────────────────────────────────────────────────────────┘
            │                    │                    │
            v                    v                    v
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ ROCKETLANE API  │  │ CLAUDE MANAGED   │  │ SLACK API       │
│                 │  │ AGENT            │  │                 │
│ GET project     │  │ "card-art-       │  │ conversations   │
│ → project name  │  │  checker"        │  │   .list (search)│
│                 │  │                  │  │ conversations   │
│ GET spaces      │  │ • Python specs   │  │   .join         │
│ → spaceId       │  │ • Visual analysis│  │ files.uploadV2  │
│                 │  │ • PDF generation │  │ chat.postMessage│
│ POST space-     │  │                  │  │                 │
│  documents      │  │ Streams events   │  │                 │
│ → embed PDF     │  │ via SSE          │  │                 │
└─────────────────┘  └──────────────────┘  └─────────────────┘
```

---

## Pipeline Steps

| Step | Phase | System | Action |
|------|-------|--------|--------|
| 1 | — | Rocketlane Portal | Customer opens portal, sees iframe with upload page |
| 2 | — | Upload Page | Customer drags/drops PNG. Client validates file type + size. projectId from URL param. |
| 3 | — | Upload Page | On submit, POSTs image + projectId. Opens SSE listener on the response. |
| 4 | Setup | Vercel Function | Calls Rocketlane `GET /api/1.0/projects/{projectId}` → extracts `projectName` |
| 5 | Setup | Vercel Function | Normalizes name → `ext-{name}-rain`, searches Slack API for channel (exact then fuzzy) |
| 6 | Setup | Vercel Function | Calls `conversations.join` to ensure bot is in the resolved channel |
| 7 | Agent | Vercel Function | Uploads card art PNG + `check_technical_specs.py` to Anthropic Files API → file IDs |
| 8 | Agent | Vercel Function | Creates Claude Managed Agent session with files mounted as resources |
| 9 | Agent | Vercel Function | Sends analysis instructions, streams session events to client via SSE |
| 10 | Agent | Claude Agent | Runs Python spec checks + visual AI analysis + generates PDF report |
| 11 | Agent | Vercel Function | Detects `session.status_idle`, downloads PDF from session outputs |
| 12 | Delivery | Vercel Function | Uploads PDF to Vercel Blob → permanent public URL |
| 13 | Delivery | Vercel Function | Parses agent text response → summary + pass/fail status |
| 14 | Delivery | Vercel Function | `files.uploadV2` → uploads PDF to Slack channel |
| 15 | Delivery | Vercel Function | `chat.postMessage` → posts formatted summary to Slack channel |
| 16 | Delivery | Vercel Function | Rocketlane `GET /api/1.0/spaces?projectId={projectId}` → extracts `spaceId` |
| 17 | Delivery | Vercel Function | Rocketlane `POST /api/1.0/space-documents` → creates embedded document linking PDF |
| 18 | Delivery | Vercel Function | Sends SSE `complete` event with pass/fail + summary + pdfUrl |

---

## Component Details

### 1. Upload Page (Vercel-hosted)

- **URL:** `https://card-art-checker.vercel.app/upload?projectId={project_id}`
- **Tech:** Lightweight static page (vanilla HTML/JS)
- **Embedded via:** Rocketlane portal iframe section
- **Features:**
  - Drag-and-drop upload zone
  - Client-side validation: PNG only, < 10MB, basic dimension check
  - Image preview thumbnail before submission
  - **Live progress feed** — renders SSE events as a step-by-step log
  - **Agent output stream** — shows Claude's analysis text as it generates (similar to Claude desktop UX)
  - Final pass/fail badge + summary + PDF download link
- **Iframe requirements:**
  - CSP `frame-ancestors` allowing `*.rocketlane.com`
  - No `X-Frame-Options` header
  - Responsive layout

**Client-side SSE handling:**

```javascript
const form = document.getElementById('upload-form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(form);

  const response = await fetch('/api/card-check', {
    method: 'POST',
    body: formData,
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop(); // keep incomplete chunk

    for (const chunk of lines) {
      const match = chunk.match(/^event: (\w+)\ndata: (.+)$/s);
      if (!match) continue;
      const [, eventType, data] = match;
      const payload = JSON.parse(data);
      handleEvent(eventType, payload);
    }
  }
});

function handleEvent(type, payload) {
  switch (type) {
    case 'progress':
      appendProgressStep(payload.message, payload.status);
      break;
    case 'agent_delta':
      appendAgentText(payload.text);
      break;
    case 'agent_tool':
      appendToolStatus(payload.tool, payload.command);
      break;
    case 'complete':
      showFinalResult(payload.status, payload.summary, payload.pdfUrl);
      break;
    case 'error':
      showError(payload.message);
      break;
  }
}
```

### 2. Vercel Function (`POST /api/card-check`)

**Streaming SSE response — single function, three phases:**

```
Request:  multipart/form-data { file: <PNG>, projectId: string }
Response: text/event-stream (SSE)

SSE Event Types:
  event: progress   — { step: string, message: string, status: "pending"|"done"|"error" }
  event: agent_delta — { text: string }
  event: agent_tool  — { tool: string, command?: string, status: "running"|"done" }
  event: complete    — { status: "pass"|"fail", summary: string, pdfUrl: string }
  event: error       — { message: string, step?: string }
```

**Full processing flow:**

```typescript
// POST /api/card-check
export async function POST(request: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // ── Phase 1: Setup ──────────────────────────────────
        const { file, projectId } = await parseMultipart(request);

        send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
        const project = await rocketlane.getProject(projectId);
        send('progress', { step: 'rocketlane', message: `Project: ${project.name}`, status: 'done' });

        send('progress', { step: 'slack_search', message: 'Finding Slack channel...', status: 'pending' });
        const channel = await findSlackChannel(project.name);
        send('progress', { step: 'slack_search', message: `Found channel: #${channel.name}`, status: 'done' });

        send('progress', { step: 'slack_join', message: 'Joining channel...', status: 'pending' });
        await slack.conversations.join({ channel: channel.id });
        send('progress', { step: 'slack_join', message: 'Bot joined channel', status: 'done' });

        // ── Phase 2: Agent Execution ────────────────────────
        send('progress', { step: 'agent_init', message: 'Uploading image for analysis...', status: 'pending' });
        const imageFileId = await anthropic.files.upload(file);
        const scriptFileId = await anthropic.files.upload(specCheckerScript);
        send('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

        const session = await anthropic.beta.agents.sessions.create({
          agent_id: AGENT_ID,
          environment_id: ENV_ID,
          resources: [
            { type: 'file', file_id: imageFileId, path: '/mnt/session/uploads/card-art.png' },
            { type: 'file', file_id: scriptFileId, path: '/mnt/session/scripts/check_technical_specs.py' },
          ],
        });

        // Send analysis instructions
        await anthropic.beta.agents.sessions.events.create(session.id, {
          type: 'user.message',
          content: ANALYSIS_PROMPT,
        });

        // Stream agent events → proxy to client
        const agentStream = await anthropic.beta.agents.sessions.events.stream(session.id);
        let agentTextResponse = '';

        for await (const event of agentStream) {
          if (event.type === 'assistant.content_block_delta' && event.delta?.text) {
            agentTextResponse += event.delta.text;
            send('agent_delta', { text: event.delta.text });
          }
          if (event.type === 'assistant.tool_use') {
            send('agent_tool', {
              tool: event.tool.type,
              command: event.tool.input?.command,
              status: 'running',
            });
          }
          if (event.type === 'session.status_idle') break;
        }

        // Download PDF from session outputs
        send('progress', { step: 'pdf_download', message: 'Retrieving report...', status: 'pending' });
        const files = await anthropic.beta.agents.files.list({ scope_id: session.id });
        const pdfFile = files.find(f => f.name.endsWith('.pdf'));
        const pdfBuffer = await anthropic.beta.agents.files.content(pdfFile.id);
        send('progress', { step: 'pdf_download', message: 'Report retrieved', status: 'done' });

        // ── Phase 3: Delivery ───────────────────────────────
        send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
        const blob = await put(`reports/${projectId}/${Date.now()}-report.pdf`, pdfBuffer, {
          access: 'public',
          contentType: 'application/pdf',
          // No TTL — Rocketlane space document links must persist
        });
        send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });

        const { status, summary } = parseAgentResponse(agentTextResponse);

        send('progress', { step: 'slack_post', message: 'Posting to Slack...', status: 'pending' });
        await postToSlack(channel.id, pdfBuffer, status, summary, project.name, blob.url, projectId);
        send('progress', { step: 'slack_post', message: 'Posted to Slack', status: 'done' });

        send('progress', { step: 'rocketlane_doc', message: 'Uploading to Rocketlane...', status: 'pending' });
        await uploadToRocketlaneSpace(projectId, blob.url, project.name);
        send('progress', { step: 'rocketlane_doc', message: 'Uploaded to Rocketlane', status: 'done' });

        send('complete', { status, summary, pdfUrl: blob.url });
      } catch (err) {
        send('error', { message: err.message, step: err.step });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Frame-Options': '', // allow iframe
      'Content-Security-Policy': "frame-ancestors *.rocketlane.com",
    },
  });
}
```

**Timeout:** Vercel Functions default 300s — sufficient for agent sessions (60s+ typical) plus delivery.

### 3. Slack Channel Resolution

Rocketlane's Slack integration creates channels at project creation time using the pattern `ext-{normalizedName}-rain`. The channel name is **not stored** in any Rocketlane API field, and projects renamed after creation retain the original channel name. Resolution requires searching the Slack API.

**Naming convention:**
```
lowercase → strip spaces → prepend "ext-" → append "-rain"
Example: "Yellow Card" → "ext-yellowcard-rain"
```

**Known edge cases:** Project renames cause mismatches (see `slack-channel-lookup-findings.md` for full evidence table).

```typescript
async function findSlackChannel(projectName: string): Promise<{ id: string; name: string }> {
  // Step 1: Build expected channel name from current project name
  const normalized = projectName.toLowerCase().replace(/\s+/g, '');
  const expectedChannel = `ext-${normalized}-rain`;

  // Step 2: Search Slack channels
  // Paginate — workspace may have 1000+ channels
  let channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const result = await slack.conversations.list({
      types: 'public_channel',
      limit: 200,
      cursor,
    });
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  // Step 3: Try exact match
  const exact = channels.find(c => c.name === expectedChannel);
  if (exact) return { id: exact.id!, name: exact.name! };

  // Step 4: Fuzzy fallback — ext-*-rain channels containing key words
  const keywords = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.replace(/-/g, '').includes(keywords)
  );
  if (fuzzy) return { id: fuzzy.id!, name: fuzzy.name! };

  // Step 5: Broader fuzzy — try first significant word only
  // Handles cases like "Brasil Bitcoin Onboarding" → "ext-brasil-bitcoin-rain"
  const firstWord = projectName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const broader = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.includes(firstWord)
  );
  if (broader) return { id: broader.id!, name: broader.name! };

  throw new SlackChannelNotFoundError(projectName, expectedChannel);
}
```

### 4. Claude Managed Agent ("card-art-checker")

**API key location:** The `ANTHROPIC_API_KEY` environment variable is set in the Vercel project settings:

```
Vercel Dashboard → Project → Settings → Environment Variables
  Key:   ANTHROPIC_API_KEY
  Value: sk-ant-...
  Environments: Production, Preview
```

Or via CLI: `vercel env add ANTHROPIC_API_KEY`

The Vercel function initializes the client:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'managed-agents-2026-04-01',
  },
});
```

**Agent configuration (created once via API):**

```typescript
// One-time setup — run via a setup script or the `ant` CLI
const agent = await anthropic.beta.agents.create({
  name: 'card-art-checker',
  description: 'Analyzes virtual card art for compliance with Visa Digital Card Brand Standards and Rain internal requirements',
  model: 'claude-sonnet-4-6',
  instructions: AGENT_SYSTEM_PROMPT, // See "Agent System Prompt" section below
  tools: [
    { type: 'bash' },
    { type: 'read' },
    { type: 'write' },
  ],
});
// Save agent.id as AGENT_ID constant or env var

const environment = await anthropic.beta.agents.environments.create({
  name: 'card-art-env',
  packages: {
    pip: ['Pillow', 'reportlab'],
  },
  networking: { enabled: false },
});
// Save environment.id as ENV_ID constant or env var
```

**Per-request session flow:**

Each card art submission creates a new session. Two files are mounted:

| Mounted File | Source | Session Path |
|---|---|---|
| Card art PNG | Customer upload (from request body) | `/mnt/session/uploads/card-art.png` |
| `check_technical_specs.py` | Stored in repo at `/scripts/check_technical_specs.py`, uploaded once to Files API | `/mnt/session/scripts/check_technical_specs.py` |

> **Optimization:** The spec checker script is static. Upload it once to the Files API and reuse the `file_id` across sessions. Only the card art image is uploaded per-request.

**What the agent does autonomously in the container:**

| Step | Action | Tool |
|------|--------|------|
| 1 | Read card art from `/mnt/session/uploads/card-art.png` | read |
| 2 | Run technical spec checks: `python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png` | bash |
| 3 | Parse JSON output from spec checker | (text) |
| 4 | Visually inspect card art against Visa Brand Standards checklist (14 checks) | (built-in vision) |
| 5 | Build visual results JSON with location-based markers for failures/warnings | write |
| 6 | Re-run spec checker with `--visual-results-file` flag to generate the PDF report | bash |
| 7 | Verify PDF output exists | read |
| 8 | Output structured summary as final text (pass/fail + per-check results + RGB colors) | (text) |

### 5. Slack Integration

**Slack app setup:**

| Scope | Purpose |
|-------|---------|
| `channels:read` | `conversations.list` — search for customer channels |
| `channels:join` | `conversations.join` — programmatic bot access |
| `files:write` | `files.uploadV2` — upload PDF report |
| `chat:write` | `chat.postMessage` — post summary message |

The bot token is stored as `SLACK_BOT_TOKEN` in Vercel environment variables.

**Channel access (programmatic):**

```typescript
// Before posting, ensure bot is in the channel
await slack.conversations.join({ channel: channelId });
// This is idempotent — no error if bot is already a member
```

**Message posting:**

```typescript
async function postToSlack(
  channelId: string,
  pdfBuffer: Buffer,
  status: 'pass' | 'fail',
  summary: string,
  projectName: string,
  pdfUrl: string,
  projectId: string,
) {
  // Upload PDF
  await slack.files.uploadV2({
    channel_id: channelId,
    file: pdfBuffer,
    filename: `card-art-report-${projectId}.pdf`,
    title: 'Card Art Compliance Report',
  });

  // Post formatted summary
  const statusEmoji = status === 'pass' ? ':white_check_mark:' : ':x:';
  const statusLabel = status === 'pass' ? 'APPROVED' : 'REQUIRES CHANGES';

  await slack.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${statusLabel} — Card Art Review` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${statusEmoji} *${projectName}*\n\n${summary}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `<${pdfUrl}|View Full PDF Report>` },
      },
    ],
  });
}
```

### 6. Rocketlane Space Documents

After generating the PDF and uploading to Vercel Blob, the function creates an embedded document in the project's Rocketlane space. This makes the report accessible to customers and internal teams directly within the Rocketlane portal.

**Resolve projectId → spaceId:**

```typescript
async function getSpaceId(projectId: string): Promise<number> {
  const response = await fetch(
    `https://api.rocketlane.com/api/1.0/spaces?projectId=${projectId}`,
    { headers: { 'Authorization': `Bearer ${process.env.ROCKETLANE_API_KEY}` } }
  );
  const data = await response.json();
  if (!data.results?.length) throw new Error(`No space found for project ${projectId}`);
  return data.results[0].id;
}
```

**Create embedded document:**

```typescript
async function uploadToRocketlaneSpace(
  projectId: string,
  pdfUrl: string,
  projectName: string,
) {
  const spaceId = await getSpaceId(projectId);
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  await fetch('https://api.rocketlane.com/api/1.0/space-documents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ROCKETLANE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      spaceDocumentName: `Card Art Report — ${projectName} — ${timestamp}`,
      space: { id: spaceId },
      spaceDocumentType: 'EMBEDDED_DOCUMENT',
      url: pdfUrl,
    }),
  });
}
```

> **Note:** Because the space document links to the Vercel Blob URL, the blob must be **permanent** (no TTL). This differs from v3's 7-day TTL.

### 7. Rocketlane Configuration

- **Iframe section:** Add to customer portal template, URL: `https://card-art-checker.vercel.app/upload?projectId={project_id}`
- **Variable substitution:** Rocketlane resolves `{project_id}` to the actual numeric project ID in live portal views (does NOT resolve in the template editor)
- **No custom field required** — Slack channel is resolved via Slack API search, not a Rocketlane field

---

## Agent System Prompt

The agent system prompt is derived from the existing `virtual-card-art-checker` skill. It instructs the agent to perform a 7-step workflow. Below is the condensed structure — the full prompt will be stored at `/prompts/agent-system-prompt.md` in the repo.

```
You are a card art compliance checker. You analyze virtual/digital card art
submissions against Visa Digital Card Brand Standards (September 2025) and
Rain's internal requirements.

## Your Environment

- Card art image: /mnt/session/uploads/card-art.png
- Spec checker script: /mnt/session/scripts/check_technical_specs.py
- Python packages available: Pillow, reportlab

## Workflow

### Step 1: Run Technical Spec Checks
  python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png
Parse the JSON output. Report each check result.

### Step 2: Visual Inspection (14 checks)
Examine the card art image visually and evaluate:

Required Elements:
  ☐ Visa Brand Mark present, legible, not distorted
  ☐ Visa Brand Mark position: upper-left or upper-right ONLY (NO lower-edge)
  ☐ Visa Brand Mark margin: 56px+ from ALL edges (CRITICAL — #1 rejection reason)
  ☐ Visa Brand Mark size: 109px height (Debit) or 142px height (Credit)
  ☐ Visa Brand Mark contrast: strong against background
  ☐ Issuer logo clearly present

Prohibited Elements:
  ☐ No EMV chip graphic
  ☐ No hologram imagery
  ☐ No magnetic stripe graphic
  ☐ No cardholder name
  ☐ No full PAN / card number
  ☐ No expiry date
  ☐ No physical card photography or 3D effects

Layout & Quality:
  ☐ Lower-left area clear (reserved for PAN personalization)
  ☐ Product identifier visible and not obscured
  ☐ Horizontal (landscape) orientation
  ☐ Full color (not grayscale)

For EACH check, determine: pass | fail | warning
For location-specific issues, record marker coordinates (0.0-1.0 normalized).

### Step 3: Construct Visual Results JSON
{
  "overall_status": "APPROVED | REQUIRES CHANGES | APPROVED WITH NOTES",
  "overall_description": "1-2 sentence summary",
  "visual_checks": [
    { "name": "...", "result": "pass|fail|warning", "notes": "...",
      "marker_x": 0.0-1.0, "marker_y": 0.0-1.0 }
  ]
}

Save to /tmp/visual_results.json

### Step 4: Generate PDF Report
  python3 /mnt/session/scripts/check_technical_specs.py \
    /mnt/session/uploads/card-art.png \
    --visual-results-file /tmp/visual_results.json

This generates the results PDF with:
  - Card art with 56px bleed border overlay
  - Sample PAN digits in suggested foreground color
  - Numbered location markers for failures/warnings
  - RGB color swatches
  - Technical spec table
  - Visual compliance table

### Step 5: Output Structured Summary
Output a text summary in this exact format:

STATUS: APPROVED | REQUIRES CHANGES
SUMMARY: <1-2 sentence overview>

TECHNICAL CHECKS:
- Dimensions: PASS/FAIL (actual vs required)
- Format: PASS/FAIL
- DPI: PASS/FAIL
- 56px Margin: PASS/FAIL/WARNING

VISUAL CHECKS:
- <check name>: PASS/FAIL/WARNING — <notes>
  (repeat for each check)

RGB FALLBACK COLORS:
- Background: #XXXXXX (R, G, B)
- Foreground: #XXXXXX (R, G, B)
- Label: #XXXXXX (R, G, B)

REPORT: <path to PDF>
```

---

## Streaming Event Protocol

The upload page receives SSE events throughout the 60-120 second processing window. This protocol defines the event types and client rendering behavior.

### Event Types

| Event | When | Client Rendering |
|-------|------|------------------|
| `progress` | Each pipeline step starts/completes | Step-by-step checklist (pending → done) |
| `agent_delta` | Agent generates text | Scrolling text feed (typewriter effect) |
| `agent_tool` | Agent invokes a tool (bash/read/write) | Tool badge: "Running spec checks..." |
| `complete` | Pipeline finished successfully | Pass/fail badge + summary + PDF link |
| `error` | Any step fails | Error message with affected step |

### Event Payloads

```typescript
// Progress event — pipeline step status
interface ProgressEvent {
  step: string;       // 'rocketlane' | 'slack_search' | 'slack_join' | 'agent_init' | 'pdf_download' | 'blob_upload' | 'slack_post' | 'rocketlane_doc'
  message: string;    // Human-readable status
  status: 'pending' | 'done' | 'error';
}

// Agent text delta — streamed as the agent types
interface AgentDeltaEvent {
  text: string;       // Incremental text chunk
}

// Agent tool use — when the agent runs a command
interface AgentToolEvent {
  tool: 'bash' | 'read' | 'write';
  command?: string;   // For bash: the command being run
  status: 'running' | 'done';
}

// Complete — final result
interface CompleteEvent {
  status: 'pass' | 'fail';
  summary: string;
  pdfUrl: string;
}

// Error — failure
interface ErrorEvent {
  message: string;
  step?: string;
}
```

### Client UX Rendering

```
┌──────────────────────────────────────────────────┐
│  Card Art Analysis                                │
│                                                   │
│  ✓ Project: Yellow Card                          │
│  ✓ Found channel: #ext-yellowcard-rain           │
│  ✓ Bot joined channel                            │
│  ✓ Image uploaded for analysis                   │
│                                                   │
│  ┌──────────────────────────────────────────────┐│
│  │ Agent Analysis (live)                         ││
│  │                                               ││
│  │ Running technical spec checks...              ││
│  │ Dimensions: 1536×969 — PASS                   ││
│  │ Format: PNG — PASS                            ││
│  │ DPI: 455 (min 72) — PASS                      ││
│  │ 56px Margin: Mark detected upper-right,       ││
│  │   all edges ≥ 56px — PASS                     ││
│  │                                               ││
│  │ Performing visual inspection...               ││
│  │ Visa Brand Mark: present, legible — PASS      ││
│  │ Position: upper-right — PASS                  ││
│  │ ...                                           ││
│  └──────────────────────────────────────────────┘│
│                                                   │
│  ✓ Report generated                              │
│  ✓ Posted to Slack                               │
│  ✓ Uploaded to Rocketlane                        │
│                                                   │
│  ══════════════════════════════════════════════   │
│  ✅ APPROVED                                     │
│  All checks passed. Card art meets Visa Digital  │
│  Card Brand Standards.                           │
│                                                   │
│  [ Download PDF Report ]                          │
└──────────────────────────────────────────────────┘
```

---

## Environment Variables

All stored in Vercel project settings (`Settings → Environment Variables`):

| Variable | Purpose | How to obtain |
|----------|---------|---------------|
| **`ANTHROPIC_API_KEY`** | Claude Managed Agent + Files API authentication | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `ROCKETLANE_API_KEY` | Rocketlane project lookup + space document creation | Rocketlane → Settings → API |
| `SLACK_BOT_TOKEN` | Slack channel search, join, file upload, message posting | Slack App → OAuth & Permissions → Bot User OAuth Token (`xoxb-...`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob PDF storage | Auto-provisioned when Vercel Blob store is connected to the project |
| `AGENT_ID` | Claude Managed Agent ID (created once during setup) | Returned by `agents.create()` during Phase 3 setup |
| `ENV_ID` | Claude Managed Agent environment ID | Returned by `environments.create()` during Phase 3 setup |
| `SPEC_SCRIPT_FILE_ID` | Pre-uploaded `check_technical_specs.py` file ID in Anthropic Files API | Returned by one-time `files.upload()` during Phase 3 setup |

**Setting via CLI:**
```bash
vercel env add ANTHROPIC_API_KEY        # paste sk-ant-...
vercel env add ROCKETLANE_API_KEY
vercel env add SLACK_BOT_TOKEN          # paste xoxb-...
vercel env add AGENT_ID
vercel env add ENV_ID
vercel env add SPEC_SCRIPT_FILE_ID
```

---

## Slack Message Format

When the Vercel Function posts to the customer's Slack channel:

- **Status badge:** APPROVED / REQUIRES CHANGES
- **Partner/project name** (from Rocketlane project metadata)
- **Spec check summary** (dimensions, format, DPI, 56px margin — pass/fail per check)
- **Visual check summary** (key findings with pass/fail/warning)
- **RGB fallback colors** (background, foreground, label hex values)
- **PDF report link** (full compliance report hosted on Vercel Blob)

---

## Estimated Costs

| Service | Purpose | Cost |
|---------|---------|------|
| Vercel (Hobby) | Upload page hosting + card-check function | $0 |
| Vercel Blob (Free tier) | PDF report storage (permanent, 1 GB) | $0 |
| Claude Managed Agent runtime | $0.08/session-hour | ~$2-5/mo at moderate volume |
| Anthropic API tokens | Sonnet 4.6 input/output per session | ~$5-15/mo at moderate volume |
| Slack API | Free tier (no cost for channel search, join, post) | $0 |
| Rocketlane API | Included in Rocketlane plan | $0 |
| **Total** | | **~$7-20/mo** |

*Savings vs. v2: ~$20/mo (Zapier Starter plan eliminated)*

---

## Build Sequence

### Phase 1: Upload Page + Streaming Shell
1. Build the upload page (`/upload`) with drag-and-drop, client-side validation, image preview
2. Build SSE progress feed UI component (step checklist + agent text stream)
3. Configure CSP headers for Rocketlane iframe embedding (`frame-ancestors *.rocketlane.com`)
4. Deploy to Vercel, verify page loads inside Rocketlane portal iframe
5. **Post-build:** Confirm CORS/CSP works correctly within Rocketlane portal

### Phase 2: Vercel Function — Rocketlane + Slack
6. Create `/api/card-check` Vercel Function with SSE streaming response skeleton
7. Implement Rocketlane API project lookup (`GET /api/1.0/projects/{projectId}`)
8. Implement Slack channel search (exact + fuzzy matching)
9. Implement `conversations.join` for programmatic bot access
10. Set up Slack app with required scopes (`channels:read`, `channels:join`, `files:write`, `chat:write`)
11. Implement `files.uploadV2` + `chat.postMessage` for report delivery
12. Wire up Phase 1 + 2: upload → function → Rocketlane lookup → Slack channel resolve → Slack post
13. Store all API keys as Vercel environment variables

### Phase 3: Claude Managed Agent
14. Create agent (`card-art-checker`) via Anthropic API with system prompt from SKILL.md
15. Create environment (`card-art-env`) with Pillow + reportlab
16. Copy `check_technical_specs.py` into repo at `/scripts/check_technical_specs.py`
17. Upload spec checker script to Anthropic Files API (one-time) → save `SPEC_SCRIPT_FILE_ID`
18. Save `AGENT_ID` and `ENV_ID` as environment variables
19. Test agent session standalone with sample card art images
20. Validate PDF output matches existing skill's report format

### Phase 4: Full Integration
21. Connect Vercel Function to Anthropic Files API + Managed Agent session creation
22. Implement agent event streaming → SSE proxy to client
23. Add Vercel Blob upload for PDF storage (permanent URLs)
24. Implement Rocketlane space document creation (`GET spaces` → `POST space-documents`)
25. Wire complete pipeline: upload → Rocketlane → agent (streamed) → Blob → Slack → Rocketlane space docs
26. End-to-end testing with real card art through Rocketlane portal

### Phase 5: Polish
27. Error handling + retry logic for external API calls (Rocketlane, Slack, Anthropic)
28. Upload page UX polish: loading states, error recovery, responsive design
29. Slack channel search edge case testing (renamed projects, special characters)
30. User acceptance testing with team

---

## Remaining Open Items

1. **CORS/CSP verification:** Confirm `frame-ancestors *.rocketlane.com` works correctly once the upload page is deployed and embedded in the Rocketlane portal. Test in production — browser security policies can't be fully validated in development.

2. **Rocketlane space document behavior:** Verify that `EMBEDDED_DOCUMENT` type with a PDF URL renders correctly in the customer portal (inline viewer vs. download link). Test with a sample Vercel Blob PDF URL.

3. **Slack channel search pagination:** For workspaces with 1000+ channels, the fuzzy search paginates through all channels. If performance is an issue, consider caching the channel list (5-minute TTL) or using Slack's `conversations.list` with `exclude_archived=true` to reduce results.

4. **Anthropic Files API script reuse:** Confirm that a file uploaded once (the spec checker script) can be reused across multiple agent sessions without re-uploading. If file IDs expire, implement a re-upload check.

5. **Rocketlane `GET /api/1.0/spaces` response shape:** Verify the exact response structure (field names for space ID) with a test API call before implementing the `getSpaceId` function.

import Anthropic from '@anthropic-ai/sdk';
import { WebClient } from '@slack/web-api';
import { put } from '@vercel/blob';
import Busboy from 'busboy';

// ── Clients ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const AGENT_ID = process.env.AGENT_ID;
const ENV_ID = process.env.ENV_ID;
const SPEC_SCRIPT_FILE_ID = process.env.SPEC_SCRIPT_FILE_ID;
const ROCKETLANE_API_KEY = process.env.ROCKETLANE_API_KEY;
const ROCKETLANE_BASE = 'https://api.rocketlane.com/api/1.0';

// ── Analysis prompt sent to the agent each session ───────────────────

const ANALYSIS_PROMPT = `Analyze the card art image at /mnt/session/uploads/card-art.png for compliance with Visa Digital Card Brand Standards (September 2025) and Rain's internal requirements.

## Workflow

### Step 1: Run Technical Spec Checks
\`\`\`bash
python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png
\`\`\`
Parse the JSON output. Report each check result.

### Step 2: Visual Inspection (14 checks)
Examine the card art image visually and evaluate:

Required Elements:
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position: upper-left or upper-right ONLY (NO lower-edge)
- Visa Brand Mark margin: 56px+ from ALL edges (CRITICAL — #1 rejection reason)
- Visa Brand Mark size: 109px height (Debit) or 142px height (Credit)
- Visa Brand Mark contrast: strong against background
- Issuer logo clearly present

Prohibited Elements:
- No EMV chip graphic
- No hologram imagery
- No magnetic stripe graphic
- No cardholder name
- No full PAN / card number
- No expiry date
- No physical card photography or 3D effects

Layout & Quality:
- Lower-left area clear (reserved for PAN personalization)
- Product identifier visible and not obscured
- Horizontal (landscape) orientation
- Full color (not grayscale)

For EACH check, determine: pass | fail | warning
For location-specific issues, record marker coordinates (0.0-1.0 normalized).

### Step 3: Construct Visual Results JSON
Save to /tmp/visual_results.json:
{
  "overall_status": "APPROVED | REQUIRES CHANGES | APPROVED WITH NOTES",
  "overall_description": "1-2 sentence summary",
  "visual_checks": [
    { "name": "...", "result": "pass|fail|warning", "notes": "...",
      "marker_x": 0.0, "marker_y": 0.0 }
  ]
}

### Step 4: Generate PDF Report
\`\`\`bash
python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png --visual-results-file /tmp/visual_results.json
\`\`\`

### Step 5: Output Structured Summary
Output in this exact format:

STATUS: APPROVED | REQUIRES CHANGES
SUMMARY: <1-2 sentence overview>

TECHNICAL CHECKS:
- Dimensions: PASS/FAIL (actual vs required)
- Format: PASS/FAIL
- DPI: PASS/FAIL
- 56px Margin: PASS/FAIL/WARNING

VISUAL CHECKS:
- <check name>: PASS/FAIL/WARNING — <notes>

RGB FALLBACK COLORS:
- Background: #XXXXXX (R, G, B)
- Foreground: #XXXXXX (R, G, B)
- Label: #XXXXXX (R, G, B)

REPORT: <path to PDF>`;

// ── Multipart parser ─────────────────────────────────────────────────

function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get('content-type') || '';
    const bb = Busboy({ headers: { 'content-type': contentType } });

    let fileBuffer = null;
    let fileName = '';
    let projectId = '';
    const chunks = [];

    bb.on('file', (_fieldname, stream, info) => {
      fileName = info.filename;
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, value) => {
      if (name === 'projectId') projectId = value;
    });

    bb.on('finish', () => {
      if (!fileBuffer) return reject(new Error('No file uploaded'));
      if (!projectId) return reject(new Error('Missing projectId'));
      resolve({ file: fileBuffer, fileName, projectId });
    });

    bb.on('error', reject);

    // Pipe request body to busboy
    const reader = request.body.getReader();
    const writable = bb;

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { writable.end(); break; }
          writable.write(Buffer.from(value));
        }
      } catch (err) { reject(err); }
    })();
  });
}

// ── Rocketlane API ───────────────────────────────────────────────────

async function getProject(projectId) {
  const res = await fetch(`${ROCKETLANE_BASE}/projects/${projectId}`, {
    headers: { 'Authorization': `Bearer ${ROCKETLANE_API_KEY}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Rocketlane project lookup failed: ${res.status}`), { step: 'rocketlane' });
  const data = await res.json();
  return { name: data.name || data.projectName, id: projectId };
}

async function getSpaceId(projectId) {
  const res = await fetch(`${ROCKETLANE_BASE}/spaces?projectId=${projectId}`, {
    headers: { 'Authorization': `Bearer ${ROCKETLANE_API_KEY}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Rocketlane space lookup failed: ${res.status}`), { step: 'rocketlane_doc' });
  const data = await res.json();
  if (!data.results?.length) throw Object.assign(new Error(`No space found for project ${projectId}`), { step: 'rocketlane_doc' });
  return data.results[0].id;
}

async function uploadToRocketlaneSpace(projectId, pdfUrl, projectName) {
  const spaceId = await getSpaceId(projectId);
  const timestamp = new Date().toISOString().split('T')[0];

  const res = await fetch(`${ROCKETLANE_BASE}/space-documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ROCKETLANE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      spaceDocumentName: `Card Art Report — ${projectName} — ${timestamp}`,
      space: { id: spaceId },
      spaceDocumentType: 'EMBEDDED_DOCUMENT',
      url: pdfUrl,
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`Rocketlane space document creation failed: ${res.status}`), { step: 'rocketlane_doc' });
}

// ── Slack channel resolution ─────────────────────────────────────────

async function findSlackChannel(projectName) {
  // Paginate through all public channels
  let channels = [];
  let cursor;
  do {
    const result = await slack.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  // Step 1: Exact match — ext-{normalizedName}-rain
  const normalized = projectName.toLowerCase().replace(/\s+/g, '');
  const expectedChannel = `ext-${normalized}-rain`;

  const exact = channels.find(c => c.name === expectedChannel);
  if (exact) return { id: exact.id, name: exact.name };

  // Step 2: Fuzzy — ext-*-rain containing all keywords run together
  const keywords = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.replace(/-/g, '').includes(keywords)
  );
  if (fuzzy) return { id: fuzzy.id, name: fuzzy.name };

  // Step 3: Broader — first significant word (6+ chars)
  const firstWord = projectName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const broader = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.includes(firstWord)
  );
  if (broader) return { id: broader.id, name: broader.name };

  throw Object.assign(
    new Error(`Could not find Slack channel for "${projectName}" (expected: #${expectedChannel})`),
    { step: 'slack_search' }
  );
}

// ── Slack posting ────────────────────────────────────────────────────

async function postToSlack(channelId, pdfBuffer, status, summary, projectName, pdfUrl, projectId) {
  // Upload PDF file
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

// ── Agent response parser ────────────────────────────────────────────

function parseAgentResponse(text) {
  const statusMatch = text.match(/STATUS:\s*(APPROVED|REQUIRES CHANGES)/i);
  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);

  return {
    status: statusMatch && statusMatch[1].toUpperCase() === 'APPROVED' ? 'pass' : 'fail',
    summary: summaryMatch ? summaryMatch[1].trim() : 'Analysis complete. See PDF report for details.',
  };
}

// ── Main handler ─────────────────────────────────────────────────────

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // ── Phase 1: Setup ─────────────────────────────────────
        const { file, projectId } = await parseMultipart(request);

        send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
        const project = await getProject(projectId);
        send('progress', { step: 'rocketlane', message: `Project: ${project.name}`, status: 'done' });

        send('progress', { step: 'slack_search', message: 'Finding Slack channel...', status: 'pending' });
        const channel = await findSlackChannel(project.name);
        send('progress', { step: 'slack_search', message: `Found channel: #${channel.name}`, status: 'done' });

        send('progress', { step: 'slack_join', message: 'Joining channel...', status: 'pending' });
        await slack.conversations.join({ channel: channel.id });
        send('progress', { step: 'slack_join', message: 'Bot joined channel', status: 'done' });

        // ── Phase 2: Agent Execution ───────────────────────────
        send('progress', { step: 'agent_init', message: 'Uploading image for analysis...', status: 'pending' });

        // Upload card art PNG to Anthropic Files API
        const imageFile = new File([file], 'card-art.png', { type: 'image/png' });
        const uploadedImage = await anthropic.files.upload({ file: imageFile });
        send('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

        // Build resource list — image is per-request, script is reusable
        const resources = [
          { type: 'file', file_id: uploadedImage.id, path: '/mnt/session/uploads/card-art.png' },
        ];
        if (SPEC_SCRIPT_FILE_ID) {
          resources.push({ type: 'file', file_id: SPEC_SCRIPT_FILE_ID, path: '/mnt/session/scripts/check_technical_specs.py' });
        }

        // Create agent session
        const session = await anthropic.beta.agents.sessions.create({
          agent_id: AGENT_ID,
          environment_id: ENV_ID,
          resources,
        });

        // Send analysis instructions
        await anthropic.beta.agents.sessions.events.create(session.id, {
          type: 'user.message',
          content: ANALYSIS_PROMPT,
        });

        // Stream agent events → proxy to client as SSE
        send('progress', { step: 'agent_run', message: 'Running card art analysis...', status: 'pending' });
        const agentStream = await anthropic.beta.agents.sessions.events.stream(session.id);
        let agentTextResponse = '';

        for await (const event of agentStream) {
          if (event.type === 'assistant.content_block_delta' && event.delta?.text) {
            agentTextResponse += event.delta.text;
            send('agent_delta', { text: event.delta.text });
          }
          if (event.type === 'assistant.tool_use') {
            send('agent_tool', {
              tool: event.tool?.type || 'tool',
              command: event.tool?.input?.command,
              status: 'running',
            });
          }
          if (event.type === 'session.status_idle') break;
        }
        send('progress', { step: 'agent_run', message: 'Analysis complete', status: 'done' });

        // Download PDF from session outputs
        send('progress', { step: 'pdf_download', message: 'Retrieving report...', status: 'pending' });
        const files = await anthropic.beta.agents.files.list({ scope_id: session.id });
        const pdfFile = files.find(f => f.name.endsWith('.pdf'));
        if (!pdfFile) throw Object.assign(new Error('Agent did not generate a PDF report'), { step: 'pdf_download' });
        const pdfBuffer = Buffer.from(await (await anthropic.beta.agents.files.content(pdfFile.id)).arrayBuffer());
        send('progress', { step: 'pdf_download', message: 'Report retrieved', status: 'done' });

        // ── Phase 3: Delivery ──────────────────────────────────
        send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
        const blob = await put(`reports/${projectId}/${Date.now()}-report.pdf`, pdfBuffer, {
          access: 'public',
          contentType: 'application/pdf',
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
        send('error', { message: err.message || 'An unexpected error occurred', step: err.step });
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
    },
  });
}

export const config = {
  maxDuration: 300,
};

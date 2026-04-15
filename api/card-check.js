import Anthropic from '@anthropic-ai/sdk';
import { WebClient } from '@slack/web-api';
import { put } from '@vercel/blob';
import Busboy from 'busboy';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// ── Clients (lazy-initialized to avoid cold-start hangs) ────────────

let _anthropic;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
    });
  }
  return _anthropic;
}

let _slack;
function getSlack() {
  if (_slack === undefined) {
    _slack = process.env.SLACK_BOT_TOKEN
      ? new WebClient(process.env.SLACK_BOT_TOKEN)
      : null;
  }
  return _slack;
}

const ROCKETLANE_BASE = 'https://api.rocketlane.com/api/1.0';

// ── Analysis prompt sent to the agent each session ───────────────────

const ANALYSIS_PROMPT = `Analyze the card art image at /mnt/session/uploads/card-art.png for compliance with Visa Digital Card Brand Standards (September 2025) and Rain's internal requirements.

## Workflow

### Step 1: Run Technical Spec Checks
\`\`\`bash
python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png
\`\`\`
Parse the JSON output. Save the full JSON (checks + colors) for Step 3.

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

### Step 3: Output Structured Results JSON

CRITICAL: You MUST output a JSON block between these exact markers. The system parses this to generate the PDF report. Without it, no report is created.

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "tech_checks": <the "checks" object from Step 1 Python output>,
  "visual_checks": [
    { "name": "Visa Brand Mark present", "result": "pass or fail or warning", "notes": "details" },
    { "name": "Visa Brand Mark position", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark margin", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark size", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark contrast", "result": "...", "notes": "..." },
    { "name": "Issuer logo", "result": "...", "notes": "..." },
    { "name": "No EMV chip", "result": "...", "notes": "..." },
    { "name": "No hologram", "result": "...", "notes": "..." },
    { "name": "No magnetic stripe", "result": "...", "notes": "..." },
    { "name": "No cardholder name", "result": "...", "notes": "..." },
    { "name": "No full PAN", "result": "...", "notes": "..." },
    { "name": "No expiry date", "result": "...", "notes": "..." },
    { "name": "No physical card effects", "result": "...", "notes": "..." },
    { "name": "Lower-left PAN area clear", "result": "...", "notes": "..." }
  ],
  "colors": <the "colors" object from Step 1 Python output>
}
RESULTS_JSON_END

### Step 4: Output Human-Readable Summary

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
- Label: #XXXXXX (R, G, B)`;

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
      clearTimeout(timeout);
      if (!fileBuffer) return reject(new Error('No file uploaded'));
      if (!projectId) return reject(new Error('Missing projectId'));
      resolve({ file: fileBuffer, fileName, projectId });
    });

    bb.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const timeout = setTimeout(() => {
      reject(Object.assign(new Error('Multipart parse timed out'), { step: 'upload' }));
    }, 30_000);

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
    headers: { 'api-key': process.env.ROCKETLANE_API_KEY },
  });
  if (!res.ok) throw Object.assign(new Error(`Rocketlane project lookup failed: ${res.status}`), { step: 'rocketlane' });
  const data = await res.json();
  return { name: data.name || data.projectName, id: projectId };
}

async function getSpaceId(projectId) {
  const res = await fetch(`${ROCKETLANE_BASE}/spaces?projectId=${projectId}`, {
    headers: { 'api-key': process.env.ROCKETLANE_API_KEY },
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
      'api-key': process.env.ROCKETLANE_API_KEY,
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
    const result = await getSlack().conversations.list({
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
  await getSlack().files.uploadV2({
    channel_id: channelId,
    file: pdfBuffer,
    filename: `card-art-report-${projectId}.pdf`,
    title: 'Card Art Compliance Report',
  });

  // Post formatted summary
  const statusEmoji = status === 'pass' ? ':white_check_mark:' : ':x:';
  const statusLabel = status === 'pass' ? 'APPROVED' : 'REQUIRES CHANGES';

  await getSlack().chat.postMessage({
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

function parseResultsJson(text) {
  const match = text.match(/RESULTS_JSON_START\s*([\s\S]*?)\s*RESULTS_JSON_END/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// ── Server-side PDF generation ──────────────────────────────────────

const PDF_COLORS = {
  green: rgb(0.13, 0.55, 0.13),
  red: rgb(0.8, 0.13, 0.13),
  amber: rgb(0.85, 0.55, 0.0),
  white: rgb(1, 1, 1),
  lightGray: rgb(0.94, 0.94, 0.94),
  dark: rgb(0.15, 0.15, 0.2),
  mid: rgb(0.4, 0.4, 0.45),
};

async function generatePdfReport(imageBuffer, results) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, M = 50, CW = W - 2 * M;
  let pg = doc.addPage([W, H]);
  let y = H - M;

  function wrapText(text, size, maxW, f = font) {
    const words = (text || '').split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function ensureSpace(needed) {
    if (y - needed < M) {
      pg = doc.addPage([W, H]);
      y = H - M;
    }
  }

  function drawSection(title) {
    ensureSpace(40);
    y -= 8;
    pg.drawRectangle({ x: M, y: y - 4, width: CW, height: 1, color: PDF_COLORS.lightGray });
    y -= 20;
    pg.drawText(title, { x: M, y, size: 15, font: bold, color: PDF_COLORS.dark });
    y -= 24;
  }

  // ── Title ──
  pg.drawText('Card Art Compliance Report', { x: M, y, size: 22, font: bold, color: PDF_COLORS.dark });
  y -= 36;

  // ── Status badge ──
  const isApproved = results.status?.toUpperCase().startsWith('APPROVED') &&
                     !results.status?.toUpperCase().includes('REQUIRES');
  const badgeColor = isApproved ? PDF_COLORS.green : PDF_COLORS.red;
  const badgeText = (results.status || 'REQUIRES CHANGES').toUpperCase();
  const badgeW = bold.widthOfTextAtSize(badgeText, 12) + 20;
  pg.drawRectangle({ x: M, y: y - 4, width: badgeW, height: 22, color: badgeColor });
  pg.drawText(badgeText, { x: M + 10, y, size: 12, font: bold, color: PDF_COLORS.white });
  y -= 34;

  // ── Summary ──
  if (results.summary) {
    for (const line of wrapText(results.summary, 11, CW)) {
      ensureSpace(16);
      pg.drawText(line, { x: M, y, size: 11, font, color: PDF_COLORS.mid });
      y -= 16;
    }
    y -= 6;
  }

  // ── Card art image ──
  try {
    const image = await doc.embedPng(imageBuffer);
    const scale = Math.min(CW / image.width, 260 / image.height);
    const iw = image.width * scale, ih = image.height * scale;
    ensureSpace(ih + 16);
    pg.drawImage(image, { x: M, y: y - ih, width: iw, height: ih });
    y -= ih + 16;
  } catch { /* skip if image can't be embedded */ }

  // ── Technical Checks ──
  drawSection('Technical Specifications');
  const tc = results.tech_checks || {};
  const techItems = [
    ['Dimensions', tc.dimensions],
    ['File Format', tc.file_format],
    ['DPI', tc.dpi],
    ['56px Margin', tc.margin_56px],
  ];
  for (const [name, check] of techItems) {
    if (!check) continue;
    ensureSpace(18);
    const passed = check.passed;
    const color = passed ? PDF_COLORS.green : PDF_COLORS.red;
    const label = passed ? 'PASS' : 'FAIL';
    const detail = check.actual ? `  (${check.actual}${check.required ? ' / required ' + check.required : ''})` : '';
    pg.drawText(label, { x: M, y, size: 10, font: bold, color });
    pg.drawText(`${name}${detail}`, { x: M + 42, y, size: 10, font, color: PDF_COLORS.dark });
    y -= 18;
  }

  // ── Visual Checks ──
  drawSection('Visual Design Compliance');
  const vc = results.visual_checks || [];
  for (const check of vc) {
    const color = check.result === 'pass' ? PDF_COLORS.green
      : check.result === 'warning' ? PDF_COLORS.amber : PDF_COLORS.red;
    const label = (check.result || 'N/A').toUpperCase();

    ensureSpace(18);
    pg.drawText(label, { x: M, y, size: 9, font: bold, color });
    pg.drawText(check.name || '', { x: M + 60, y, size: 9, font: bold, color: PDF_COLORS.dark });
    y -= 14;

    if (check.notes) {
      for (const line of wrapText(check.notes, 8, CW - 60)) {
        ensureSpace(13);
        pg.drawText(line, { x: M + 60, y, size: 8, font, color: PDF_COLORS.mid });
        y -= 13;
      }
    }
    y -= 3;
  }

  // ── RGB Colors ──
  if (results.colors && Object.keys(results.colors).length) {
    drawSection('RGB Fallback Colors');
    for (const [role, data] of Object.entries(results.colors)) {
      if (!data?.rgb) continue;
      ensureSpace(20);
      const [r, g, b] = data.rgb;
      pg.drawRectangle({ x: M, y: y - 2, width: 14, height: 14, color: rgb(r / 255, g / 255, b / 255) });
      pg.drawRectangle({ x: M, y: y - 2, width: 14, height: 14, borderColor: PDF_COLORS.mid, borderWidth: 0.5 });
      const label = role.charAt(0).toUpperCase() + role.slice(1);
      pg.drawText(`${label}: ${data.hex || ''} (${r}, ${g}, ${b})`, { x: M + 22, y, size: 10, font, color: PDF_COLORS.dark });
      y -= 20;
    }
  }

  return Buffer.from(await doc.save());
}

// ── Main handler ─────────────────────────────────────────────────────

export async function POST(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response('Bad request: expected multipart/form-data', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Send an immediate event to prevent headers timeout
        send('progress', { step: 'upload', message: 'Receiving file...', status: 'pending' });

        // ── Phase 1: Setup ─────────────────────────────────────
        const { file, projectId } = await parseMultipart(request);
        send('progress', { step: 'upload', message: 'File received', status: 'done' });

        send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
        const project = await getProject(projectId);
        send('progress', { step: 'rocketlane', message: `Project: ${project.name}`, status: 'done' });

        let channel = null;
        if (getSlack()) {
          send('progress', { step: 'slack_search', message: 'Finding Slack channel...', status: 'pending' });
          channel = await findSlackChannel(project.name);
          send('progress', { step: 'slack_search', message: `Found channel: #${channel.name}`, status: 'done' });

          send('progress', { step: 'slack_join', message: 'Joining channel...', status: 'pending' });
          await getSlack().conversations.join({ channel: channel.id });
          send('progress', { step: 'slack_join', message: 'Bot joined channel', status: 'done' });
        } else {
          send('progress', { step: 'slack_search', message: 'Slack not configured — skipping', status: 'done' });
        }

        // ── Phase 2: Agent Execution ───────────────────────────
        send('progress', { step: 'agent_init', message: 'Uploading image for analysis...', status: 'pending' });

        // Upload card art PNG to Anthropic Files API
        const imageFile = new File([file], 'card-art.png', { type: 'image/png' });
        const uploadedImage = await getAnthropic().beta.files.upload({ file: imageFile });
        send('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

        // Build resource list — image is per-request, script is reusable
        const resources = [
          { type: 'file', file_id: uploadedImage.id, mount_path: '/mnt/session/uploads/card-art.png' },
        ];
        if (process.env.SPEC_SCRIPT_FILE_ID) {
          resources.push({ type: 'file', file_id: process.env.SPEC_SCRIPT_FILE_ID, mount_path: '/mnt/session/scripts/check_technical_specs.py' });
        }

        // Create agent session
        const session = await getAnthropic().beta.sessions.create({
          agent: process.env.AGENT_ID,
          environment_id: process.env.ENV_ID,
          resources,
        });

        // Send analysis instructions
        await getAnthropic().beta.sessions.events.send(session.id, {
          events: [{
            type: 'user.message',
            content: [{ type: 'text', text: ANALYSIS_PROMPT }],
          }],
        });

        // Stream agent events → proxy to client as SSE
        send('progress', { step: 'agent_run', message: 'Running card art analysis...', status: 'pending' });
        const agentStream = await getAnthropic().beta.sessions.events.stream(session.id);
        let agentTextResponse = '';

        for await (const event of agentStream) {
          if (event.type === 'agent.message') {
            const text = event.content?.map(b => b.text).join('') || '';
            agentTextResponse += text;
            if (text) send('agent_delta', { text });
          }
          if (event.type === 'agent.tool_use') {
            send('agent_tool', {
              tool: event.name || 'tool',
              command: event.input?.command,
              status: 'running',
            });
          }
          if (event.type === 'session.status_idle') break;
        }
        send('progress', { step: 'agent_run', message: 'Analysis complete', status: 'done' });

        // Generate PDF server-side from agent's structured results
        send('progress', { step: 'pdf_generate', message: 'Generating report...', status: 'pending' });
        const results = parseResultsJson(agentTextResponse);
        if (!results) throw Object.assign(new Error('Agent did not output structured results (RESULTS_JSON_START/END block missing)'), { step: 'pdf_generate' });
        const pdfBuffer = await generatePdfReport(file, results);
        send('progress', { step: 'pdf_generate', message: 'Report generated', status: 'done' });

        // ── Phase 3: Delivery ──────────────────────────────────
        send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
        const blob = await put(`reports/${projectId}/${Date.now()}-report.pdf`, pdfBuffer, {
          access: 'public',
          contentType: 'application/pdf',
        });
        send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });

        const { status, summary } = parseAgentResponse(agentTextResponse);

        if (getSlack() && channel) {
          send('progress', { step: 'slack_post', message: 'Posting to Slack...', status: 'pending' });
          await postToSlack(channel.id, pdfBuffer, status, summary, project.name, blob.url, projectId);
          send('progress', { step: 'slack_post', message: 'Posted to Slack', status: 'done' });
        } else {
          send('progress', { step: 'slack_post', message: 'Slack not configured — skipping', status: 'done' });
        }

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

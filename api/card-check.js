import Anthropic from '@anthropic-ai/sdk';
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

const ROCKETLANE_BASE = 'https://api.rocketlane.com/api/1.0';

// ── Analysis prompts ────────────────────────────────────────────────
// Turn 1: quick tool-use turn to run the Python spec checker
const TECH_SPEC_PROMPT = `Run the technical spec checker on the card art image and output ONLY the raw JSON result. No commentary.

\`\`\`bash
python3 /mnt/session/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png
\`\`\`

Output the complete JSON from the script — nothing else.`;

// Turn 2: visual-only inspection (no tool use needed → much faster)
function buildVisualPrompt(techJson) {
  return `Analyze the card art image at /mnt/session/uploads/card-art.png for compliance with Visa Digital Card Brand Standards (September 2025) and Rain's internal requirements.

The technical spec checks have ALREADY been run. Here are the results — do NOT re-run the script:

TECH_SPEC_RESULTS:
${JSON.stringify(techJson, null, 2)}

## Your Task: Visual Inspection ONLY (14 checks)

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

## Output Structured Results JSON

CRITICAL: You MUST output a JSON block between these exact markers. The system parses this to generate the PDF report. Without it, no report is created.

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "tech_checks": ${JSON.stringify(techJson.checks || techJson, null, 2)},
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
  "colors": ${JSON.stringify(techJson.colors || {}, null, 2)}
}
RESULTS_JSON_END

## Output Human-Readable Summary

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
}

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
    // Strip markdown code fences the agent may wrap around the JSON
    const raw = match[1].replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Server-side PDF generation ──────────────────────────────────────

// Replace non-WinAnsi characters that pdf-lib's standard fonts can't encode
function sanitize(str) {
  return (str || '').replace(/[\u2248]/g, '~').replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2265]/g, '>=').replace(/[\u2264]/g, '<=')
    .replace(/[^\x00-\xFF]/g, '');
}

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
    const words = sanitize(text).split(' ');
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
    pg.drawText(sanitize(`${name}${detail}`), { x: M + 42, y, size: 10, font, color: PDF_COLORS.dark });
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
    pg.drawText(sanitize(check.name || ''), { x: M + 60, y, size: 9, font: bold, color: PDF_COLORS.dark });
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

        // ── Phase 2: Agent Execution (two turns) ─────────────
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

        // ── Turn 1: Run tech spec script (quick — just tool use) ──
        send('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
        await getAnthropic().beta.sessions.events.send(session.id, {
          events: [{
            type: 'user.message',
            content: [{ type: 'text', text: TECH_SPEC_PROMPT }],
          }],
        });

        let techSpecText = '';
        const techStream = await getAnthropic().beta.sessions.events.stream(session.id);
        for await (const event of techStream) {
          if (event.type === 'agent.message') {
            const text = event.content?.map(b => b.text).join('') || '';
            techSpecText += text;
          }
          if (event.type === 'agent.tool_use') {
            send('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
          }
          if (event.type === 'session.status_idle') break;
        }

        // Parse the tech spec JSON from the agent's output
        let techJson;
        try {
          const jsonMatch = techSpecText.match(/\{[\s\S]*\}/);
          techJson = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch { techJson = null; }
        if (!techJson) throw Object.assign(new Error('Tech spec script did not return valid JSON'), { step: 'tech_specs' });
        send('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });

        // ── Turn 2: Visual inspection only (no tool use → fast) ──
        send('progress', { step: 'agent_run', message: 'Running visual inspection...', status: 'pending' });
        await getAnthropic().beta.sessions.events.send(session.id, {
          events: [{
            type: 'user.message',
            content: [{ type: 'text', text: buildVisualPrompt(techJson) }],
          }],
        });

        const visualStream = await getAnthropic().beta.sessions.events.stream(session.id);
        let agentTextResponse = '';

        for await (const event of visualStream) {
          if (event.type === 'agent.message') {
            const text = event.content?.map(b => b.text).join('') || '';
            agentTextResponse += text;
            if (text) send('agent_delta', { text });
          }
          if (event.type === 'agent.tool_use') {
            send('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
          }
          if (event.type === 'session.status_idle') break;
        }
        send('progress', { step: 'agent_run', message: 'Analysis complete', status: 'done' });

        // ── Phase 3: PDF + Storage ─────────────────────────────
        send('progress', { step: 'pdf_generate', message: 'Generating report...', status: 'pending' });
        const results = parseResultsJson(agentTextResponse);
        if (!results) throw Object.assign(new Error('Agent did not output structured results (RESULTS_JSON_START/END block missing)'), { step: 'pdf_generate' });
        const pdfBuffer = await generatePdfReport(file, results);
        send('progress', { step: 'pdf_generate', message: 'Report generated', status: 'done' });

        send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
        const blob = await put(`reports/${projectId}/${Date.now()}-report.pdf`, pdfBuffer, {
          access: 'public',
          contentType: 'application/pdf',
        });
        send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });

        const { status, summary } = parseAgentResponse(agentTextResponse);

        // Send complete — delivery (Slack/Rocketlane) handled by /api/card-deliver
        send('complete', {
          status,
          summary,
          pdfUrl: blob.url,
          // Delivery context for the client to forward to /api/card-deliver
          delivery: {
            projectId,
            projectName: project.name,
            pdfUrl: blob.url,
            status,
            summary,
          },
        });
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

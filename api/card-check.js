import { waitUntil } from '@vercel/functions';
import { put } from '@vercel/blob';

const ANTHROPIC_API = 'https://api.anthropic.com/v1';
const BETA_VERSION = 'managed-agents-2026-04-01';

export const config = {
  maxDuration: 300,
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { imageUrl, projectId, slackChannel, callbackUrl } = body;

  if (!imageUrl || !projectId || !callbackUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: imageUrl, projectId, callbackUrl' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Return 202 immediately, process in the background via Fluid Compute
  waitUntil(processCardArt({ imageUrl, projectId, slackChannel, callbackUrl }));

  return new Response(JSON.stringify({ status: 'accepted', projectId }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Anthropic API helpers ──────────────────────────────

function apiHeaders(contentType = 'application/json') {
  const h = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': BETA_VERSION,
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

async function uploadFileToAnthropic(imageBuffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), filename);
  form.append('purpose', 'session_resource');

  const res = await fetch(`${ANTHROPIC_API}/files`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_VERSION,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Files API upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.id;
}

async function createSession(fileId) {
  const agentId = process.env.MANAGED_AGENT_ID;
  const envId = process.env.MANAGED_AGENT_ENV_ID;

  const res = await fetch(`${ANTHROPIC_API}/agents/${agentId}/sessions`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      environment: envId,
      resources: [
        {
          type: 'file',
          file_id: fileId,
          path: '/mnt/session/uploads/card-art.png',
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create session failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.id;
}

async function sendMessage(sessionId) {
  const res = await fetch(`${ANTHROPIC_API}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      role: 'user',
      content: ANALYSIS_PROMPT,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Send message failed (${res.status}): ${text}`);
  }
}

async function waitForCompletion(sessionId) {
  const res = await fetch(`${ANTHROPIC_API}/sessions/${sessionId}/events`, {
    headers: {
      ...apiHeaders(null),
      Accept: 'text/event-stream',
    },
  });

  if (!res.ok) {
    throw new Error(`Event stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let agentText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));

        // Accumulate text output from the agent
        if (event.type === 'text' && event.content) {
          agentText += event.content;
        }
        if (event.type === 'content_block_delta' && event.delta?.text) {
          agentText += event.delta.text;
        }

        // Session complete
        if (
          event.type === 'session.status_idle' ||
          event.type === 'session_idle' ||
          event.status === 'idle'
        ) {
          reader.cancel();
          return agentText;
        }
      } catch {
        // Non-JSON data line, skip
      }
    }
  }

  return agentText;
}

async function getSessionFiles(sessionId) {
  const res = await fetch(`${ANTHROPIC_API}/files?scope_id=${sessionId}`, {
    headers: apiHeaders(null),
  });

  if (!res.ok) {
    throw new Error(`List session files failed (${res.status})`);
  }

  const data = await res.json();
  return data.data || data.files || [];
}

async function downloadFile(fileId) {
  const res = await fetch(`${ANTHROPIC_API}/files/${fileId}/content`, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_VERSION,
    },
  });

  if (!res.ok) {
    throw new Error(`Download file failed (${res.status})`);
  }

  return res.arrayBuffer();
}

// ── Main processing pipeline ───────────────────────────

async function processCardArt({ imageUrl, projectId, slackChannel, callbackUrl }) {
  try {
    console.log(`[card-check] Starting analysis for project ${projectId}`);

    // 1. Download image from Vercel Blob URL
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw new Error(`Failed to download image (${imageRes.status})`);
    const imageBuffer = await imageRes.arrayBuffer();
    console.log(`[card-check] Downloaded image (${imageBuffer.byteLength} bytes)`);

    // 2. Upload to Anthropic Files API
    const fileId = await uploadFileToAnthropic(imageBuffer, 'card-art.png');
    console.log(`[card-check] Uploaded to Anthropic Files: ${fileId}`);

    // 3. Create managed agent session with file mounted
    const sessionId = await createSession(fileId);
    console.log(`[card-check] Created session: ${sessionId}`);

    // 4. Send analysis instructions as user message
    await sendMessage(sessionId);
    console.log(`[card-check] Sent analysis prompt`);

    // 5. Stream events until session completes
    const agentText = await waitForCompletion(sessionId);
    console.log(`[card-check] Session complete (${agentText.length} chars)`);

    // 6. Find the PDF report in session output files
    const files = await getSessionFiles(sessionId);
    const pdfFile = files.find(
      (f) => (f.filename || f.name || '').endsWith('.pdf')
    );

    let pdfUrl = null;

    if (pdfFile) {
      // 7. Download PDF from agent session
      const pdfBuffer = await downloadFile(pdfFile.id);
      console.log(`[card-check] Downloaded PDF (${pdfBuffer.byteLength} bytes)`);

      // 8. Upload PDF to Vercel Blob with 7-day TTL
      const blob = await put(
        `reports/${projectId}-${Date.now()}.pdf`,
        new Uint8Array(pdfBuffer),
        { access: 'public', addRandomSuffix: true }
      );
      pdfUrl = blob.url;
      console.log(`[card-check] PDF stored: ${pdfUrl}`);
    } else {
      console.warn(`[card-check] No PDF found in session outputs`);
    }

    // 9. Parse status and summary from agent text response
    const status = determineStatus(agentText);
    const summary = extractSummary(agentText);

    // 10. POST results to Zap 2 callback webhook
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl, summary, status, slackChannel, projectId }),
    });

    console.log(`[card-check] Callback sent: ${status}`);
  } catch (error) {
    console.error(`[card-check] Error for project ${projectId}:`, error);

    // Attempt to notify Zap 2 of the failure
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfUrl: null,
            summary: `Processing failed: ${error.message}`,
            status: 'ERROR',
            slackChannel,
            projectId,
          }),
        });
      } catch (cbErr) {
        console.error(`[card-check] Callback notification failed:`, cbErr);
      }
    }
  }
}

// ── Response parsing helpers ───────────────────────────

function determineStatus(agentText) {
  const lower = agentText.toLowerCase();
  if (
    lower.includes('fail') ||
    lower.includes('requires changes') ||
    lower.includes('not compliant') ||
    lower.includes('does not meet')
  ) {
    return 'REQUIRES CHANGES';
  }
  return 'APPROVED';
}

function extractSummary(agentText) {
  // Try to find a structured SUMMARY section
  const match = agentText.match(/(?:SUMMARY|Summary)[:\n]([\s\S]*?)(?:\n\n|$)/);
  if (match) return match[1].trim();

  // Try to find STATUS + lines after it
  const statusMatch = agentText.match(/STATUS:.*\nSUMMARY:\n([\s\S]*?)$/);
  if (statusMatch) return statusMatch[1].trim();

  // Fallback: last paragraph, capped at 500 chars
  const paragraphs = agentText.trim().split('\n\n');
  const last = paragraphs[paragraphs.length - 1]?.trim() || '';
  return last.slice(0, 500);
}

// ── Analysis prompt for the managed agent ──────────────

const ANALYSIS_PROMPT = `Analyze the card art image at /mnt/session/uploads/card-art.png for virtual card compliance.

## Step 1: Run Technical Spec Checks

Write and execute a Python script using Pillow to check these specifications:

| Check | Requirement |
|-------|-------------|
| Dimensions | 1536 x 969 px |
| Format | PNG |
| DPI | >= 72 (calculated: width / 3.375 inches) |
| Color mode | RGB (flag RGBA as warning) |

Also extract:
- **Background color**: Sample the 4 corner pixels (10px inset), compute average RGB hex
- **Dominant colors**: Resize to 150x150, quantize to 5-color palette, report hex values
- **Foreground suggestion**: Based on background luminance (0.299R + 0.587G + 0.114B), suggest white (#FFFFFF) for dark backgrounds or dark gray (#1A1A1A) for light backgrounds — this is for PAN/cardholder text legibility

## Step 2: Visual & Design Analysis

Using your vision capabilities, evaluate:
- Overall design quality and professionalism
- Text legibility concerns (if any text is present)
- Whether important design elements are within the safe zone (inset ~50px from edges)
- Any potential issues with the card art when overlaid with card number, expiry, CVV, and cardholder name

## Step 3: Generate PDF Report

Write and execute a Python script using reportlab to generate a PDF report at /mnt/session/outputs/report.pdf.

The report should include:
1. **Header**: "Card Art Compliance Report" with date
2. **Overall Status**: Large APPROVED or REQUIRES CHANGES badge
3. **Spec Check Results**: Table with each check, expected value, actual value, and pass/fail
4. **Color Analysis**: Background hex, dominant palette (color swatches), foreground suggestion
5. **Visual Analysis**: Your AI assessment of design quality and potential issues
6. **Recommendations**: Any changes needed for compliance

Use professional formatting with clear section headers, a clean color scheme, and readable fonts.

## Step 4: Output Summary

After generating the PDF, output a structured text summary in this exact format:

STATUS: [APPROVED or REQUIRES CHANGES]
SUMMARY:
- Dimensions: [PASS/FAIL] (actual: WxH)
- Format: [PASS/FAIL]
- DPI: [PASS/FAIL] (actual: X)
- Color Mode: [PASS/FAIL/WARNING] (actual: MODE)
- Background: #HEXVAL
- Foreground Suggestion: #HEXVAL
- Design Quality: [Brief assessment]
- Issues: [List any issues, or "None"]`;

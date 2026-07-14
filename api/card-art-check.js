import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { deliverReport } from '../lib/delivery.js';
import { inferCardType } from '../lib/card-type.js';
import { getProjectName, downloadAttachment } from '../lib/rocketlane.js';

// Card-art check, keyed on a Rocketlane projectId. The caller (a Rocketlane
// "Form completed" HTTP automation) posts a payload that carries the card-art
// field value as one or more HTML anchors, e.g.
//   <a data-attachment-id="12345">akasa.jpg</a>
// One field can hold several files → several anchors → several attachment IDs.
//
// Two stages, in order, before any analysis or delivery runs:
//   Stage 1 — resolve the attachment ID(s) for this submission (regex the
//             data-attachment-id anchors out of the raw payload).
//   Stage 2 — download each attachment's bytes from Rocketlane
//             (GET /api/v1/attachments/{id}/download).
// Both stages are awaited synchronously so the HTTP response reflects whether
// the download succeeded. Only once bytes are in hand do we spawn the
// (slow) analyze → store → deliver flow per attachment in the background.

function secretsMatch(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const looksLikeId = (v) => v != null && /^\d+$/.test(String(v).trim());

// Rocketlane wires cardType to the "card material" form answer, which is
// free-ish text ("Plastic", "Metal", "Virtual card", …) — normalize it to the
// virtual/physical override inferCardType expects, or drop it entirely so the
// filename extension decides. Never let an odd form answer abort the analysis.
function normalizeCardType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes('virtual')) return 'virtual';
  if (s.includes('physical') || s.includes('plastic') || s.includes('metal')) return 'physical';
  return undefined;
}

// Pull every attachment ID out of the raw payload. The card-art field value
// arrives as HTML anchors carrying data-attachment-id; a single field can hold
// multiple files, so collect them all (deduped, order preserved). The pattern
// is lenient about quoting so it matches whether the anchor is unescaped
// (data-attachment-id="123") or JSON-escaped inside a string
// (data-attachment-id=\"123\") or bare (data-attachment-id=123).
function extractAttachmentIds(rawBody, ...extra) {
  const ids = [];
  const seen = new Set();
  const push = (v) => {
    if (looksLikeId(v)) {
      const id = String(v).trim();
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  };
  const re = /data-attachment-id\s*=\s*\\?["']?(\d+)/gi;
  let m;
  while ((m = re.exec(rawBody || '')) !== null) push(m[1]);
  // Explicit ids (query string / JSON field) let a manual curl or legacy
  // caller still target a specific attachment.
  for (const v of extra) push(v);
  return ids;
}

// Analyze one already-downloaded attachment and deliver its report. Runs in the
// background (waitUntil) after Stage 2 has confirmed the bytes exist.
async function analyzeAndDeliver({ projectId, projectName, attachmentId, buffer, filename, cardTypeOverride }) {
  try {
    const cardType = inferCardType(filename, cardTypeOverride);
    if (!cardType) {
      console.error(`[card-art-check] could not infer card type for ${filename} (attachment ${attachmentId}) — aborting`);
      return;
    }

    const { pdfBuffer, status, summary } = await runAnalysis({
      file: buffer,
      fileName: filename,
      cardType,
      onProgress: (event, data) => {
        if (event === 'progress') console.log(`[card-art-check] ${data.step}: ${data.message} (${data.status})`);
      },
    });

    const { pdfUrl } = await storeReport({ pdfBuffer, projectId });
    console.log(`[card-art-check] pdfUrl=${pdfUrl} attachment=${attachmentId} project=${projectId}`);

    const delivery = await deliverReport({
      projectId,
      projectName,
      pdfUrl,
      status,
      summary,
      cardType,
    });
    console.log(`[card-art-check] delivered attachment ${attachmentId}:`, delivery);
  } catch (err) {
    console.error(`[card-art-check] analyzeAndDeliver error (attachment ${attachmentId}, project ${projectId}):`, err);
  }
}

export async function POST(request) {
  const expected = process.env.ROCKETLANE_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[card-art-check] ROCKETLANE_WEBHOOK_SECRET is not set — refusing to process');
    return new Response('Server misconfigured', { status: 500 });
  }
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const xHeader = request.headers.get('x-webhook-secret') || '';
  if (!secretsMatch(bearer, expected) && !secretsMatch(xHeader, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Read the raw body once: Stage 1 regexes attachment IDs out of it, and we
  // also JSON-parse it for projectId when the query string didn't carry one.
  const rawBody = await request.text();

  const url = new URL(request.url);
  // Query string wins for projectId — Rocketlane's URL-field smart-fill
  // substitution is more reliable than its JSON-body substitution.
  const qsProjectId = url.searchParams.get('projectId');
  const qsAttachmentId = url.searchParams.get('attachmentId');
  const qsCardType = url.searchParams.get('cardType');

  let body = null;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Non-JSON (or empty) body is fine — projectId may be in the URL, and
      // the attachment-id regex runs over the raw text regardless of format.
    }
  }

  const pickId = (...vals) => {
    const v = vals.find(looksLikeId);
    return v == null ? undefined : String(v).trim();
  };
  const projectId = pickId(qsProjectId, body?.projectId);
  const cardTypeOverride = normalizeCardType(qsCardType) ?? normalizeCardType(body?.cardType);

  if (!looksLikeId(projectId)) {
    console.warn('[card-art-check] 400 projectId missing or unresolved — qs:', JSON.stringify({ qsProjectId }), 'body:', rawBody.slice(0, 2000));
    return Response.json({ error: 'Missing or unresolved projectId' }, { status: 400 });
  }

  // ── Stage 1: resolve attachment ID(s) ──────────────────────────────
  const attachmentIds = extractAttachmentIds(rawBody, qsAttachmentId, body?.attachmentId);
  if (attachmentIds.length === 0) {
    console.warn(`[card-art-check] 400 no attachment IDs found for project ${projectId} — body:`, rawBody.slice(0, 2000));
    return Response.json({ error: 'No attachment IDs found in payload' }, { status: 400 });
  }
  console.log(`[card-art-check] project=${projectId} attachments=[${attachmentIds.join(', ')}]`);

  // ── Stage 2: download each attachment's bytes (synchronous gate) ────
  const downloaded = [];
  const failed = [];
  for (const attachmentId of attachmentIds) {
    try {
      const { buffer, filename } = await downloadAttachment(attachmentId);
      downloaded.push({ attachmentId, buffer, filename });
      console.log(`[card-art-check] downloaded attachment ${attachmentId} → "${filename}" (${buffer.length} bytes)`);
    } catch (err) {
      failed.push({ attachmentId, error: String(err?.message || err) });
      console.error(`[card-art-check] download failed for attachment ${attachmentId} (project ${projectId}):`, err);
    }
  }

  // Nothing downloaded → surface the failure to Rocketlane; don't start any
  // analysis or delivery.
  if (downloaded.length === 0) {
    return Response.json(
      { error: 'All attachment downloads failed', projectId, failed },
      { status: 502 }
    );
  }

  // Project name is needed for delivery (Slack channel resolution), not for the
  // download — fetch it once, but never let a lookup failure block the flow.
  let projectName;
  try {
    projectName = await getProjectName(projectId);
  } catch (err) {
    console.error(`[card-art-check] getProjectName failed for project ${projectId} — proceeding without name:`, err);
  }

  // Stages 1–2 are done. Only now kick off analyze → store → deliver per
  // attachment, in the background.
  for (const { attachmentId, buffer, filename } of downloaded) {
    waitUntil(analyzeAndDeliver({ projectId, projectName, attachmentId, buffer, filename, cardTypeOverride }));
  }

  return Response.json({
    ok: true,
    queued: true,
    projectId,
    downloaded: downloaded.map((d) => d.attachmentId),
    failed: failed.map((f) => f.attachmentId),
  });
}

export const config = {
  maxDuration: 300,
};

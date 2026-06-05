import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { deliverReport } from '../lib/delivery.js';
import { inferCardType } from '../lib/card-type.js';
import { getProjectName, downloadAttachment } from '../lib/rocketlane.js';

// Single-shot card-art check. Caller supplies { projectId, attachmentId,
// cardType? } via query string or JSON body; the API downloads the attachment
// from Rocketlane, runs the analysis pipeline, stores the PDF, and delivers
// to Slack. One request → one analysis → one delivery. No event-type filter,
// no batching, no dedup.

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

async function processAttachment({ projectId, attachmentId, cardTypeOverride }) {
  try {
    console.log(`[card-art-check] processing attachment=${attachmentId} project=${projectId}`);

    const projectName = await getProjectName(projectId);
    const { buffer, filename } = await downloadAttachment(attachmentId);

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
    console.error(`[card-art-check] processAttachment error (attachment ${attachmentId}, project ${projectId}):`, err);
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

  // Query string wins over body — Rocketlane's URL-field smart-fill
  // substitution is more reliable than its JSON-body substitution.
  const url = new URL(request.url);
  const qsProjectId = url.searchParams.get('projectId');
  const qsAttachmentId = url.searchParams.get('attachmentId');
  const qsCardType = url.searchParams.get('cardType');

  // Parse the body whenever a usable ID hasn't arrived via the URL — including
  // when a smart-fill chip came through unsubstituted as literal {{OV.…}} text.
  let body = null;
  if (!looksLikeId(qsProjectId) || !looksLikeId(qsAttachmentId)) {
    try {
      body = await request.json();
    } catch {
      // Empty/invalid body is fine if both IDs are in the URL.
    }
  }

  // Trim the winner: Rocketlane's chip-insertion flow encourages a space
  // before the chip, which can survive as %20 in the path segment.
  const pickId = (...vals) => {
    const v = vals.find(looksLikeId);
    return v == null ? undefined : String(v).trim();
  };
  const projectId = pickId(qsProjectId, body?.projectId);
  const attachmentId = pickId(qsAttachmentId, body?.attachmentId);
  const cardTypeOverride = normalizeCardType(qsCardType) ?? normalizeCardType(body?.cardType);

  if (!looksLikeId(projectId)) {
    console.warn('[card-art-check] 400 projectId missing or unresolved — qs:', JSON.stringify({ qsProjectId, qsAttachmentId }), 'body:', JSON.stringify(body));
    return Response.json({ error: 'Missing or unresolved projectId' }, { status: 400 });
  }
  if (!looksLikeId(attachmentId)) {
    console.warn('[card-art-check] 400 attachmentId missing or unresolved — qs:', JSON.stringify({ qsProjectId, qsAttachmentId }), 'body:', JSON.stringify(body));
    return Response.json({ error: 'Missing or unresolved attachmentId' }, { status: 400 });
  }

  waitUntil(processAttachment({ projectId, attachmentId, cardTypeOverride }));

  return Response.json({ ok: true, queued: true, projectId, attachmentId });
}

export const config = {
  maxDuration: 300,
};

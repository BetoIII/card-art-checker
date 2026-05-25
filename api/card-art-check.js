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

  let body = null;
  if (!qsProjectId || !qsAttachmentId) {
    try {
      body = await request.json();
    } catch {
      // Empty/invalid body is fine if both IDs are in the URL.
    }
  }

  const projectId = qsProjectId ?? body?.projectId;
  const attachmentId = qsAttachmentId ?? body?.attachmentId;
  const cardTypeOverride = qsCardType ?? body?.cardType ?? undefined;

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

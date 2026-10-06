import { list, put } from '@vercel/blob';
import { deliverReport } from '../lib/delivery.js';
import { verifyDelivery } from '../lib/internal-auth.js';

// Slack delivery for a run the browser watched (/upload and the playground).
// The browser holds no secret, so it can only hand back the delivery that
// /api/card-check signed when the run completed: this posts that report and
// nothing else, once.

// One delivery per run. A claim marker in Blob stops a signed delivery from
// being replayed into the customer's channel for as long as it is valid.
// (list-then-put leaves a narrow race; two near-simultaneous replays of the
// same genuine report is the worst it allows.) No store means no claim.
async function claimDelivery(runId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return true;
  const pathname = `deliveries/${runId}.json`;
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  if (blobs.some((b) => b.pathname === pathname)) return false;
  await put(pathname, JSON.stringify({ runId, deliveredAt: new Date().toISOString() }), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  return true;
}

export async function POST(request) {
  try {
    const delivery = await request.json();
    const { runId, projectId, tenantId, projectName, pdfUrl, status, summary, cardType, slackDelivery } = delivery || {};

    if (!pdfUrl || !(projectId || tenantId)) {
      return Response.json({ error: 'Missing required fields: pdfUrl, and projectId or tenantId' }, { status: 400 });
    }

    // Mirrors the mock gate in api/card-check.js: local UI work must never
    // run the Slack identifier or post anywhere, whatever the client sends.
    if (/^(1|true|yes)$/i.test(process.env.CARD_CHECK_MOCK || '')) {
      return Response.json({ ok: true, pdfUrl, results: { slack: 'skipped: mock mode' } });
    }

    const problem = verifyDelivery(delivery);
    if (problem) {
      return Response.json({ error: `Delivery refused: ${problem}` }, { status: 401 });
    }

    // Opting out posts nothing, so it needn't spend the run's one delivery —
    // nor does a tenant-only run, which has no channel to post to.
    if (slackDelivery !== false && projectId && !(await claimDelivery(runId))) {
      return Response.json({ error: 'This report was already delivered' }, { status: 409 });
    }

    const results = await deliverReport({ projectId, projectName, pdfUrl, status, summary, cardType, slackDelivery });
    return Response.json({ ok: true, pdfUrl, results });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// 300s: delivery now runs the slack-identifier sub-agent inline, and a cold
// conversations.list pagination of a large workspace under Tier-2 rate
// limiting can take 60-90s before the LLM turns even start.
export const config = {
  maxDuration: 300,
};

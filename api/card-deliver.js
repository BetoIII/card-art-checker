import { deliverReport } from '../lib/delivery.js';

export async function POST(request) {
  try {
    const { projectId, projectName, pdfUrl, status, summary, cardType, slackDelivery } = await request.json();

    if (!pdfUrl || !projectId) {
      return Response.json({ error: 'Missing required fields: pdfUrl, projectId' }, { status: 400 });
    }

    // Mirrors the mock gate in api/card-check.js: local UI work must never
    // run the Slack identifier or post anywhere, whatever the client sends.
    if (/^(1|true|yes)$/i.test(process.env.CARD_CHECK_MOCK || '')) {
      return Response.json({ ok: true, pdfUrl, results: { slack: 'skipped: mock mode' } });
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

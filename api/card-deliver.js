import { deliverReport } from '../lib/delivery.js';

export async function POST(request) {
  try {
    const { projectId, projectName, pdfUrl, status, summary, cardType } = await request.json();

    if (!pdfUrl || !projectId) {
      return Response.json({ error: 'Missing required fields: pdfUrl, projectId' }, { status: 400 });
    }

    const results = await deliverReport({ projectId, projectName, pdfUrl, status, summary, cardType });
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

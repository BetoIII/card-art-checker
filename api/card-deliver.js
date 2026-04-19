import { WebClient } from '@slack/web-api';

const ROCKETLANE_BASE = 'https://api.rocketlane.com/api/1.0';

// ── Lazy Slack client ───────────────────────────────────────────────

let _slack;
function getSlack() {
  if (_slack === undefined) {
    _slack = process.env.SLACK_BOT_TOKEN
      ? new WebClient(process.env.SLACK_BOT_TOKEN)
      : null;
  }
  return _slack;
}

// ── Rocketlane helpers ──────────────────────────────────────────────

async function getSpaceId(projectId) {
  const res = await fetch(`${ROCKETLANE_BASE}/spaces?projectId=${projectId}`, {
    headers: { 'api-key': process.env.ROCKETLANE_API_KEY },
  });
  if (!res.ok) throw new Error(`Rocketlane space lookup failed: ${res.status}`);
  const data = await res.json();
  if (!data.results?.length) throw new Error(`No space found for project ${projectId}`);
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
  if (!res.ok) throw new Error(`Rocketlane space document creation failed: ${res.status}`);
}

// ── Slack channel resolution ─────────────────────────────────────────

async function findSlackChannel(projectName) {
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

  // Exact match — ext-{normalizedName}-rain
  const normalized = projectName.toLowerCase().replace(/\s+/g, '');
  const expectedChannel = `ext-${normalized}-rain`;
  const exact = channels.find(c => c.name === expectedChannel);
  if (exact) return { id: exact.id, name: exact.name };

  // Fuzzy — ext-*-rain containing all keywords run together
  const keywords = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.replace(/-/g, '').includes(keywords)
  );
  if (fuzzy) return { id: fuzzy.id, name: fuzzy.name };

  // Broader — first significant word (6+ chars)
  const firstWord = projectName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const broader = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.includes(firstWord)
  );
  if (broader) return { id: broader.id, name: broader.name };

  throw new Error(`Could not find Slack channel for "${projectName}" (expected: #${expectedChannel})`);
}

// ── Slack posting ───────────────────────────────────────────────────

async function postToSlack(channelId, pdfUrl, status, summary, projectName, projectId) {
  // Fetch the PDF to attach as a file
  const pdfRes = await fetch(pdfUrl);
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

  await getSlack().files.uploadV2({
    channel_id: channelId,
    file: pdfBuffer,
    filename: `card-art-report-${projectId}.pdf`,
    title: 'Card Art Compliance Report',
  });

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

// ── Main handler ────────────────────────────────────────────────────

export async function POST(request) {
  try {
    const { projectId, projectName, pdfUrl, status, summary } = await request.json();

    if (!pdfUrl || !projectId) {
      return Response.json({ error: 'Missing required fields: pdfUrl, projectId' }, { status: 400 });
    }

    const results = { slack: null, rocketlane: null };

    // Slack delivery — find channel, join, and post
    if (getSlack()) {
      try {
        const channel = await findSlackChannel(projectName);
        await getSlack().conversations.join({ channel: channel.id });
        await postToSlack(channel.id, pdfUrl, status, summary, projectName, projectId);
        results.slack = 'ok';
      } catch (err) {
        results.slack = `failed: ${err.message}`;
      }
    } else {
      results.slack = 'skipped';
    }

    // Rocketlane delivery (non-fatal)
    try {
      await uploadToRocketlaneSpace(projectId, pdfUrl, projectName);
      results.rocketlane = 'ok';
    } catch (err) {
      results.rocketlane = `failed: ${err.message}`;
    }

    return Response.json({ ok: true, results });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export const config = {
  maxDuration: 60,
};

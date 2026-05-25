import { WebClient } from '@slack/web-api';

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

function cardTypeLabel(cardType) {
  return cardType === 'physical' ? 'Physical' : 'Virtual';
}

// ── Slack channel resolution ────────────────────────────────────────

async function findSlackChannel(projectName) {
  const slack = getSlack();
  let channels = [];
  let cursor;
  do {
    const result = await slack.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  const normalized = projectName.toLowerCase().replace(/\s+/g, '');
  const expectedChannel = `ext-${normalized}-rain`;
  const exact = channels.find(c => c.name === expectedChannel);
  if (exact) return { id: exact.id, name: exact.name };

  const keywords = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = channels.find(c =>
    c.name?.startsWith('ext-') &&
    c.name?.endsWith('-rain') &&
    c.name?.replace(/-/g, '').includes(keywords)
  );
  if (fuzzy) return { id: fuzzy.id, name: fuzzy.name };

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

async function postToSlack(channelId, pdfUrl, status, summary, projectName, projectId, cardType) {
  const slack = getSlack();
  const pdfRes = await fetch(pdfUrl);
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

  const label = cardTypeLabel(cardType);

  await slack.files.uploadV2({
    channel_id: channelId,
    file: pdfBuffer,
    filename: `${label.toLowerCase()}-card-art-report-${projectId}.pdf`,
    title: `${label} Card Art Compliance Report`,
  });

  const statusEmoji = status === 'pass' ? ':white_check_mark:' : ':x:';
  const statusLabel = status === 'pass' ? 'APPROVED' : 'REQUIRES CHANGES';

  await slack.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${statusLabel} — ${label} Card Art Review` },
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

// ── Public entrypoint ───────────────────────────────────────────────
//
// deliverReport attempts a best-effort Slack post. The Slack bot may not be
// provisioned; if it isn't (no token) or the post throws, the function still
// resolves so callers can return the pdfUrl regardless.
// Returns { slack } with 'ok' | 'skipped' | 'failed: ...'.
export async function deliverReport({ projectId, projectName, pdfUrl, status, summary, cardType }) {
  const normalizedCardType = cardType === 'physical' ? 'physical' : 'virtual';
  const results = { slack: null };

  if (getSlack()) {
    try {
      const channel = await findSlackChannel(projectName);
      await getSlack().conversations.join({ channel: channel.id });
      await postToSlack(channel.id, pdfUrl, status, summary, projectName, projectId, normalizedCardType);
      results.slack = 'ok';
    } catch (err) {
      results.slack = `failed: ${err.message}`;
    }
  } else {
    results.slack = 'skipped';
  }

  return results;
}

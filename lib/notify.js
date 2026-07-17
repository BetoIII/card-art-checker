import { getSlack } from './slack-client.js';

// Internal notifications from the card-art-checker bot to a team channel
// (SLACK_NOTIFY_CHANNEL_ID). Every function here is best-effort: missing
// config makes calls no-ops, and failures are logged, never thrown — the
// pipeline must not depend on notifications landing.

function adminUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'localhost:3000';
  return `https://${host}/admin`;
}

// Returns 'ok' | 'skipped' | 'failed: ...'
export async function notify(text, { blocks } = {}) {
  const slack = getSlack();
  const channel = process.env.SLACK_NOTIFY_CHANNEL_ID;
  if (!slack || !channel) return 'skipped';
  try {
    await slack.chat.postMessage({ channel, text, ...(blocks ? { blocks } : {}) });
    return 'ok';
  } catch (err) {
    console.error('[notify] postMessage failed:', err);
    return `failed: ${err.message}`;
  }
}

function formatCandidates(candidates = []) {
  if (candidates.length === 0) return '_no candidates_';
  return candidates
    .map((c) => {
      const created = c.created ? new Date(c.created * 1000).toISOString().slice(0, 10) : '?';
      return `• #${c.name} (${c.id}, created ${created}${c.is_archived ? ', archived' : ''})`;
    })
    .join('\n');
}

export async function notifyIdentifyMiss({ projectId, projectName, result }) {
  const title = `:mag: Slack channel not identified for ${projectName || 'unknown project'} (RL #${projectId})`;
  return notify(title, {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `confidence: *${result?.confidence ?? 'none'}*` +
            (result?.error ? `\nerror: ${result.error}` : '') +
            (result?.reasoning ? `\n${result.reasoning}` : '') +
            `\n\n*Candidates:*\n${formatCandidates(result?.candidates)}`,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: `<${adminUrl()}|View run in admin>` } },
    ],
  });
}

export async function notifyDeliveryFailure({ projectId, projectName, channelName, error, pdfUrl }) {
  const title = `:warning: Slack delivery failed for ${projectName || 'unknown project'} (RL #${projectId})`;
  return notify(title, {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `channel: ${channelName ? `#${channelName}` : 'unknown'}\nerror: ${error}` +
            (pdfUrl ? `\n<${pdfUrl}|PDF report>` : '') +
            `\n<${adminUrl()}|View run in admin>`,
        },
      },
    ],
  });
}

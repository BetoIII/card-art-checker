import { getSlack } from './slack-client.js';
import { identifySlackChannel } from './slack-identify.js';
import { notifyIdentifyMiss, notifyDeliveryFailure } from './notify.js';

function cardTypeLabel(cardType) {
  return cardType === 'physical' ? 'Physical' : 'Virtual';
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
// deliverReport posts to the customer's Slack channel, but ONLY when the
// slack-identifier sub-agent resolved the channel with high confidence —
// posting a client report to the wrong client's channel is worse than not
// posting at all. Misses and failures are flagged to the internal
// notifications channel (lib/notify.js) and recorded on the run log.
//
// channelPromise: an already-started identifySlackChannel promise (the
// Rocketlane webhook path spawns it concurrently with the multi-minute
// analysis). When absent, the identifier runs inline (manual upload path).
// identifySlackChannel never rejects, so awaiting it is safe either way.
//
// slackDelivery: caller-requested opt-out (defaults on). When explicitly
// false the caller wants the PDF report only — skip identification and
// posting entirely, and don't treat it as a miss (no notify).
//
// Always resolves; returns { slack, identify } where slack is
// 'ok' | 'skipped...' | 'failed: ...'.
export async function deliverReport({ projectId, projectName, pdfUrl, status, summary, cardType, channelPromise, runLog, slackDelivery = true }) {
  const normalizedCardType = cardType === 'physical' ? 'physical' : 'virtual';
  const results = { slack: null, identify: null };

  if (slackDelivery === false) {
    results.slack = 'skipped: slack delivery disabled by request';
    return results;
  }

  if (!getSlack()) {
    results.slack = 'skipped';
    return results;
  }

  const identify = await (channelPromise ?? identifySlackChannel({ projectId, projectName, runLog }));
  results.identify = {
    confidence: identify.confidence,
    channelId: identify.channelId,
    channelName: identify.channelName,
    reasoning: identify.reasoning,
    candidates: identify.candidates,
    ...(identify.error ? { error: identify.error } : {}),
  };

  // Hard gate: high confidence only, and never an archived channel.
  if (identify.confidence !== 'high' || !identify.channelId || identify.isArchived) {
    results.slack = `skipped: channel not identified (confidence=${identify.confidence}${identify.isArchived ? ', archived' : ''})`;
    await notifyIdentifyMiss({ projectId, projectName, result: identify });
    return results;
  }

  try {
    // Private channels reject join with method_not_supported_for_channel_type;
    // the post itself is the arbiter of access, so a failed join is non-fatal.
    await getSlack().conversations.join({ channel: identify.channelId }).catch(() => {});
    await postToSlack(identify.channelId, pdfUrl, status, summary, projectName, projectId, normalizedCardType);
    results.slack = 'ok';
    results.channel = { id: identify.channelId, name: identify.channelName };
  } catch (err) {
    results.slack = `failed: ${err.message}`;
    await notifyDeliveryFailure({
      projectId,
      projectName,
      channelName: identify.channelName,
      error: err.message,
      pdfUrl,
    });
  }

  return results;
}

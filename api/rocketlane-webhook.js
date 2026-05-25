import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { deliverReport } from '../lib/delivery.js';
import { inferCardType } from '../lib/card-type.js';
import {
  getProjectName,
  findAnswersForTask,
  downloadAttachment,
} from '../lib/rocketlane.js';
import { hasProcessed, markProcessed } from '../lib/dedup.js';

// Default card-art form templates per the findings doc.
// Override via ROCKETLANE_CARD_FORM_TEMPLATE_IDS (comma-separated).
const DEFAULT_TEMPLATE_IDS = [137109, 147717];

function getTemplateIds() {
  const raw = process.env.ROCKETLANE_CARD_FORM_TEMPLATE_IDS;
  if (!raw) return DEFAULT_TEMPLATE_IDS;
  const parsed = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  return parsed.length ? parsed : DEFAULT_TEMPLATE_IDS;
}

function secretsMatch(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── Background pipeline ─────────────────────────────────────────────

async function processAnswer(answer, projectName) {
  const { answerId, projectId, attachments } = answer;
  console.log(`[rocketlane-webhook] processing answer ${answerId} (project ${projectId}, ${attachments.length} card-art attachments)`);

  let successes = 0;
  let failures = 0;

  for (const att of attachments) {
    try {
      const { buffer, filename } = await downloadAttachment(att.attachmentId);
      const cardType = inferCardType(filename);
      if (!cardType) {
        console.warn(`[rocketlane-webhook] could not infer card type for ${filename} (attachment ${att.attachmentId}) — skipping`);
        continue;
      }

      const { pdfBuffer, status, summary } = await runAnalysis({
        file: buffer,
        fileName: filename,
        cardType,
        onProgress: (event, data) => {
          if (event === 'progress') console.log(`[rocketlane-webhook] ${data.step}: ${data.message} (${data.status})`);
        },
      });

      const { pdfUrl } = await storeReport({ pdfBuffer, projectId });
      console.log(`[rocketlane-webhook] pdfUrl=${pdfUrl} answer=${answerId} project=${projectId}`);

      const delivery = await deliverReport({
        projectId,
        projectName,
        pdfUrl,
        status,
        summary,
        cardType,
      });
      console.log(`[rocketlane-webhook] delivered answer ${answerId} attachment ${att.attachmentId}:`, delivery);
      successes += 1;
    } catch (err) {
      failures += 1;
      console.error(`[rocketlane-webhook] failed attachment ${att.attachmentId} (answer ${answerId}):`, err.message);
    }
  }

  // Mark the answer processed even if some attachments failed — partial
  // failure shouldn't cause a full re-run on the next TASK_UPDATED firing.
  // (The agent run itself is expensive; better to require manual retry.)
  await markProcessed(answerId, {
    projectId,
    taskId: answer.taskId,
    templateId: answer.templateId,
    attachmentCount: attachments.length,
    successes,
    failures,
  });
}

async function processTask({ taskId, projectId }) {
  try {
    const templateIds = getTemplateIds();
    console.log(`[rocketlane-webhook] processTask taskId=${taskId} projectId=${projectId} templates=${templateIds.join(',')}`);

    const projectName = await getProjectName(projectId);
    const answers = await findAnswersForTask(taskId, templateIds);

    if (!answers.length) {
      console.log(`[rocketlane-webhook] no card-art submissions found on task ${taskId}`);
      return;
    }

    for (const answer of answers) {
      if (await hasProcessed(answer.answerId)) {
        console.log(`[rocketlane-webhook] answer ${answer.answerId} already processed — skipping`);
        continue;
      }
      await processAnswer(answer, projectName);
    }
  } catch (err) {
    console.error('[rocketlane-webhook] processTask error:', err);
  }
}

// ── HTTP handler ────────────────────────────────────────────────────

export async function POST(request) {
  const expected = process.env.ROCKETLANE_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[rocketlane-webhook] ROCKETLANE_WEBHOOK_SECRET is not set — refusing to process');
    return new Response('Server misconfigured', { status: 500 });
  }
  const provided = request.headers.get('x-webhook-secret') || '';
  if (!secretsMatch(provided, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const eventType = body?.eventType || body?.event_type || body?.type;
  if (eventType !== 'TASK_UPDATED') {
    // Acknowledge irrelevant events so Rocketlane doesn't retry, but skip work.
    console.log(`[rocketlane-webhook] ignoring eventType=${eventType}`);
    return Response.json({ ok: true, ignored: true });
  }

  // Rocketlane TASK_UPDATED payload shape isn't fully documented; tolerate
  // a few common nestings while keeping the contract strict on the IDs.
  const taskId = body?.taskId ?? body?.data?.taskId ?? body?.task?.id;
  const projectId = body?.projectId ?? body?.data?.projectId ?? body?.project?.id;

  if (!taskId || !projectId) {
    return Response.json({ error: 'Missing taskId or projectId in payload' }, { status: 400 });
  }

  // Ack immediately, run the heavy work in the background. Fluid Compute keeps
  // the instance alive past the response until the function's maxDuration.
  waitUntil(processTask({ taskId, projectId }));

  return Response.json({ ok: true, queued: true, taskId, projectId });
}

export const config = {
  maxDuration: 300,
};

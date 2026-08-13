import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { inferCardType } from '../lib/card-type.js';
import { extractCardArtFile, cardTypeFromForm } from '../lib/dock.js';
import { createRunLog } from '../lib/run-log.js';
import { emitResult, emitFailure, classifyError } from '../lib/result-emit.js';

// Receives Dock (dock.us) webhook events — currently subscribed to
// workspace.form.submitted. Verifies the X-Dock-Signature HMAC, then runs the
// card-art compliance pipeline on the submitted design file and stores the PDF
// report to Blob. Acks with 200 immediately; analysis runs via waitUntil.
//
// Signature scheme (https://developers.dock.us/webhooks/verify-webhook-requests):
//   X-Dock-Signature = hex(HMAC-SHA256(secret, `${method}\n${url}\n${rawBody}`))
// Dock's own doc examples disagree on whether `url` includes the scheme
// (Node example uses `https://host/path`, Python/Go use `host/path`), so we
// accept either construction.

function signaturesMatch(received, computed) {
  let receivedBuf;
  try {
    receivedBuf = Buffer.from(received, 'hex');
  } catch {
    return false;
  }
  const computedBuf = Buffer.from(computed, 'hex');
  if (receivedBuf.length !== computedBuf.length) return false;
  return timingSafeEqual(receivedBuf, computedBuf);
}

function computeCandidates({ method, host, path, rawBody, secret }) {
  // Dock's docs disagree on URL construction (Node example: https://host/path,
  // Python/Go: host/path), and don't specify separators beyond \n. Try the
  // plausible constructions and remember each so failures can be diagnosed.
  const urlCandidates = [
    `https://${host}${path}`,
    `${host}${path}`,
    `http://${host}${path}`,
    `https://${host}${path}/`,
    path,
  ];
  const candidates = {};
  for (const url of urlCandidates) {
    candidates[url] = createHmac('sha256', secret)
      .update(`${method}\n${url}\n${rawBody}`)
      .digest('hex');
  }
  // Variant without any URL component, in case Dock signs method+body only.
  candidates['<no-url>'] = createHmac('sha256', secret)
    .update(`${method}\n${rawBody}`)
    .digest('hex');
  return candidates;
}

function verifySignature({ signature, candidates }) {
  return Object.values(candidates).some((computed) => signaturesMatch(signature, computed));
}

// Run the card-art pipeline on a Dock form submission. Downloads the card-art
// file straight from the payload's signed GCS URL, analyzes it, and stores the
// PDF report to Blob. Delivery (Slack/Rocketlane) is intentionally left out:
// Dock gives us an account/workspace, not a Rocketlane projectId, so customer
// delivery needs an account→project mapping that doesn't exist yet.
async function processDockSubmission({ assoc, eventId, runLog, deadlineAt }) {
  try {
    const questions = assoc.formQuestions;
    const responses = assoc.formQuestionResponses;

    const cardArt = extractCardArtFile(questions, responses);
    if (!cardArt) {
      console.warn(`[dock-webhook] ${eventId}: no card-art file in submission — nothing to analyze`);
      await runLog.skip('No card-art file in submission');
      return;
    }

    const cardType = inferCardType(cardArt.fileName, cardTypeFromForm(questions, responses));
    if (!cardType) {
      console.error(`[dock-webhook] ${eventId}: could not infer card type for ${cardArt.fileName} — aborting`);
      await runLog.fail(`Could not infer card type for "${cardArt.fileName}"`);
      return;
    }

    runLog.set({ file: cardArt.fileName, cardType });
    console.log(`[dock-webhook] ${eventId}: downloading card art "${cardArt.fileName}" (${cardType})`);
    const res = await fetch(cardArt.url);
    if (!res.ok) {
      console.error(`[dock-webhook] ${eventId}: card-art download failed HTTP ${res.status} (signed URL may have expired)`);
      await runLog.fail(`Card-art download failed HTTP ${res.status} (signed URL may have expired)`);
      return;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    runLog.set({ downloads: [{ filename: cardArt.fileName, bytes: buffer.length, ok: true }] });

    const { pdfBuffer, status, summary, results, techJson } = await runAnalysis({
      file: buffer,
      fileName: cardArt.fileName,
      cardType,
      deadlineAt,
      onProgress: (event, data) => {
        if (event === 'progress') {
          console.log(`[dock-webhook] ${eventId}: ${data.step}: ${data.message} (${data.status})`);
          runLog.event(data.step, data.message, data.status);
        }
      },
    });

    // Blob path is keyed by Dock account id (no Rocketlane projectId here).
    const reportKey = `dock-${assoc.account?.id || 'unknown'}`;
    const { pdfUrl } = await storeReport({ pdfBuffer, projectId: reportKey });
    console.log(`[dock-webhook] ${eventId}: report ready status=${status} pdfUrl=${pdfUrl}`);
    console.log(`[dock-webhook] ${eventId}: summary: ${summary}`);

    // Slack delivery is still blocked on an account→project mapping, but the
    // structured result has no such dependency — publish it regardless.
    const emitted = await emitResult({
      runId: runLog.runId,
      results, techJson, cardType,
      projectId: reportKey,
      projectName: assoc.account?.name || null,
      fileName: cardArt.fileName,
      pdfUrl,
      source: 'dock',
      trigger: { endpoint: '/api/dock-webhook', eventId },
      deadlineAt,
    });

    // TODO: deliver pdfUrl to the customer once account→Rocketlane-project
    // mapping exists (see lib/delivery.js + [[project-overview]]).
    runLog.addResult({
      filename: cardArt.fileName,
      cardType,
      status,
      summary,
      pdfUrl,
      outcome: emitted.outcome,
      resultUrl: emitted.resultUrl,
      webhook: emitted.webhook,
      delivery: { slack: 'skipped (no Dock account → Rocketlane project mapping)' },
    });
    await runLog.finish();
  } catch (err) {
    console.error(`[dock-webhook] ${eventId}: processDockSubmission error:`, err);
    const errorCode = classifyError(err);
    await emitFailure({
      runId: runLog.runId,
      errorCode,
      message: String(err?.message || err),
      step: err?.step || null,
      source: 'dock',
      trigger: { endpoint: '/api/dock-webhook', eventId },
      deadlineAt,
    });
    await runLog.fail(err);
  }
}

export async function POST(request) {
  // Vercel kills the function at maxDuration (300s); this deadline lets the
  // pipeline degrade gracefully instead of dying mid-step. It covers the
  // waitUntil background work too — that shares the same function lifetime.
  const deadlineAt = Date.now() + 280_000;

  const secret = process.env.DOCK_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[dock-webhook] DOCK_WEBHOOK_SECRET is not set — refusing to process');
    return new Response('Server misconfigured', { status: 500 });
  }

  const rawBody = await request.text();
  const url = new URL(request.url);
  // Behind Vercel's proxy request.url's host can be the deployment alias;
  // x-forwarded-host carries the host Dock actually addressed (and signed).
  const host = request.headers.get('x-forwarded-host') || url.host;

  const signature = request.headers.get('x-dock-signature');
  if (signature) {
    const candidates = computeCandidates({
      method: 'POST',
      host,
      path: url.pathname,
      rawBody,
      secret,
    });
    if (!verifySignature({ signature, candidates })) {
      // Diagnostic dump: everything needed to reproduce the HMAC offline and
      // pinpoint whether the URL construction or the secret is wrong.
      console.warn('[dock-webhook] invalid signature — diagnostics:', JSON.stringify({
        receivedSignature: signature,
        xTimestamp: request.headers.get('x-timestamp'),
        requestUrl: request.url,
        xForwardedHost: request.headers.get('x-forwarded-host'),
        xForwardedProto: request.headers.get('x-forwarded-proto'),
        hostUsed: host,
        path: url.pathname,
        search: url.search,
        bodyLength: rawBody.length,
        candidates,
        rawBody: rawBody.slice(0, 4000),
      }));
      return new Response('Invalid signature', { status: 401 });
    }
  } else if (rawBody.trim()) {
    // Unsigned requests with a body are rejected; an empty unsigned POST is
    // allowed through (and acked) so Dock's save-time URL verification passes.
    console.warn('[dock-webhook] unsigned request with body — rejecting');
    return new Response('No signature provided', { status: 401 });
  }

  let event = null;
  if (rawBody.trim()) {
    try {
      event = JSON.parse(rawBody);
    } catch {
      console.warn('[dock-webhook] non-JSON body — acking anyway');
    }
  }

  if (!event) {
    console.log('[dock-webhook] verification ping (empty body) — ok');
    return Response.json({ ok: true });
  }

  const type = event.subscriptionType || 'unknown';
  console.log(`[dock-webhook] event=${type} id=${event.id} occurredAt=${event.occurredAt}`);

  if (type === 'workspace.form.submitted') {
    const assoc = event.associatedObjects || {};
    console.log('[dock-webhook] form submitted:', JSON.stringify({
      workspace: assoc.workspace?.name,
      account: assoc.account?.id,
      user: assoc.user?.email,
      form: assoc.workspaceForm?.title,
      questions: assoc.formQuestions,
      responses: assoc.formQuestionResponses,
    }));
    const runLog = createRunLog({
      source: 'dock',
      trigger: {
        endpoint: '/api/dock-webhook',
        description: 'Dock workspace.form.submitted webhook',
        eventId: event.id,
        occurredAt: event.occurredAt,
        userAgent: request.headers.get('user-agent') || undefined,
      },
    });
    runLog.armWatchdog(300_000); // keep in sync with config.maxDuration below
    runLog.set({
      dock: {
        workspace: assoc.workspace?.name,
        account: assoc.account?.id,
        user: assoc.user?.email,
        form: assoc.workspaceForm?.title,
      },
    });
    // Ack immediately; run the (slow) analysis pipeline in the background.
    waitUntil(processDockSubmission({ assoc, eventId: event.id, runLog, deadlineAt }));
  } else {
    console.log('[dock-webhook] payload:', rawBody.slice(0, 2000));
  }

  return Response.json({ ok: true, received: type });
}

export const config = {
  maxDuration: 300,
};

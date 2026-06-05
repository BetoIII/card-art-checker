import { createHmac, timingSafeEqual } from 'node:crypto';

// Receives Dock (dock.us) webhook events — currently subscribed to
// workspace.form.submitted. Verifies the X-Dock-Signature HMAC, logs the
// payload, and acks with 200. Event handling (what a form submission should
// trigger) plugs in below once decided.
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

export async function POST(request) {
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
    // TODO: wire form submission into the card-art pipeline once the
    // trigger behavior is decided (see lib/pipeline.js + lib/delivery.js).
  } else {
    console.log('[dock-webhook] payload:', rawBody.slice(0, 2000));
  }

  return Response.json({ ok: true, received: type });
}

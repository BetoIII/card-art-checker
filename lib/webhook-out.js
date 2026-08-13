import { createHmac, timingSafeEqual } from 'node:crypto';

// Outbound delivery of a structured check result.
//
// Contract matches lib/notify.js and lib/delivery.js: this NEVER throws and
// never rejects. It returns a status string ('ok' | 'skipped: …' | 'failed: …')
// that the caller records on the run log. A webhook consumer being down must
// not turn a successful analysis into a failed run.
//
// Signature scheme — the inverse of the inbound verifier in
// api/dock-webhook.js, so the two can be tested against each other:
//
//   X-Card-Art-Signature: sha256=hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
//   X-Card-Art-Timestamp: <unix seconds>
//
// The timestamp is inside the signed payload, not just alongside it, so a
// captured request cannot be replayed with a fresh timestamp.

const SIGNATURE_HEADER = 'x-card-art-signature';
const TIMESTAMP_HEADER = 'x-card-art-timestamp';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export function signPayload({ rawBody, secret, timestamp }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return { timestamp: ts, signature: `sha256=${digest}` };
}

// Verify a payload signed by signPayload. Exported so the round-trip is
// testable and so a consumer inside Rain can reuse the exact implementation
// rather than reimplementing it from the docs.
export function verifyPayload({ rawBody, secret, timestamp, signature }) {
  const expected = signPayload({ rawBody, secret, timestamp });
  const a = Buffer.from(expected.signature);
  const b = Buffer.from(String(signature || ''));
  if (a.length !== b.length) return false;
  // timingSafeEqual requires equal lengths, guaranteed above.
  return timingSafeEqual(a, b);
}

// ── Target resolution ───────────────────────────────────────────────

function allowedHosts() {
  return (process.env.RESULT_WEBHOOK_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

// Resolve where to POST.
//
// The configured RESULT_WEBHOOK_URL is trusted (an operator set it). A
// caller-supplied callbackUrl is NOT: pdfUrl inside the payload is a
// permanent, unauthenticated, public Blob URL, so an arbitrary callback is
// both an SSRF vector and a way to exfiltrate a customer's report. It is only
// honored when its host is on the allowlist.
//
// Returns { url } or { skip: '<reason>' }.
export function resolveTarget(callbackUrl) {
  const configured = (process.env.RESULT_WEBHOOK_URL || '').trim();

  if (!callbackUrl) {
    return configured ? { url: configured } : { skip: 'skipped: no webhook target configured' };
  }

  let parsed;
  try {
    parsed = new URL(String(callbackUrl));
  } catch {
    return { skip: 'skipped: callbackUrl is not a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { skip: 'skipped: callbackUrl must be https' };
  }

  const hosts = allowedHosts();
  if (!hosts.length) {
    return { skip: 'skipped: callbackUrl supplied but RESULT_WEBHOOK_ALLOWED_HOSTS is empty' };
  }

  const host = parsed.hostname.toLowerCase();
  const permitted = hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!permitted) {
    return { skip: `skipped: callbackUrl host "${host}" is not allowlisted` };
  }

  return { url: parsed.toString() };
}

// ── Delivery ────────────────────────────────────────────────────────

const RETRYABLE = (status) => status >= 500 || status === 408 || status === 429;

export async function sendResultWebhook({
  result, event, runId, attachmentId = null, callbackUrl = null, deadlineAt = null,
}) {
  // Physical results are persisted for corpus-building but are not part of
  // the v1 contract — they must not reach a consumer as though they were.
  if (result?.schema_version && result.schema_version !== '1.0') {
    return `skipped: schema_version ${result.schema_version} is not published`;
  }

  const target = resolveTarget(callbackUrl);
  if (target.skip) return target.skip;

  const secret = process.env.RESULT_WEBHOOK_SECRET;
  if (!secret) return 'skipped: RESULT_WEBHOOK_SECRET is not set';

  const rawBody = JSON.stringify({
    schema_version: result.schema_version,
    event,
    run_id: runId,
    attachment_id: attachmentId,
    occurred_at: new Date().toISOString(),
    data: result,
  });
  const { timestamp, signature } = signPayload({ rawBody, secret });

  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Never start an attempt we cannot finish — the function is killed at
    // maxDuration, and a half-sent POST is worse than a recorded skip.
    if (deadlineAt && deadlineAt - Date.now() < REQUEST_TIMEOUT_MS) {
      return `failed: ${lastError} (out of time before attempt ${attempt})`;
    }

    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: String(timestamp),
          'User-Agent': 'card-art-checker/1.0',
        },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) return 'ok';

      lastError = `HTTP ${res.status}`;
      if (!RETRYABLE(res.status)) return `failed: ${lastError} (not retryable)`;
    } catch (err) {
      lastError = String(err?.message || err);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }

  return `failed: ${lastError} after ${MAX_ATTEMPTS} attempts`;
}

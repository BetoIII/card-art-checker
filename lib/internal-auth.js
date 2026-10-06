import { createHmac, timingSafeEqual } from 'node:crypto';

// The one credential: ROCKETLANE_WEBHOOK_SECRET, a shared secret.
//
//   • Server-to-server callers present it as a bearer token — on
//     /api/card-check (to unlock ?async=1 and a projectId-less run),
//     /api/result, and the pipeline's own self-call to /api/spec-check.
//   • The browser can't hold it, so /api/card-check signs the delivery it
//     hands the browser with it, and /api/card-deliver posts only that.
//
// No secret configured means every check here fails closed.

const secret = () => process.env.ROCKETLANE_WEBHOOK_SECRET || null;

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Bearer secret ───────────────────────────────────────────────────

// True when the request carries the secret as `Authorization: Bearer …` or
// `x-webhook-secret: …`.
export function isAuthenticated(request) {
  const expected = secret();
  if (!expected) return false;
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const xHeader = request.headers.get('x-webhook-secret') || '';
  return (!!bearer && safeEqual(bearer, expected)) || (!!xHeader && safeEqual(xHeader, expected));
}

// The Authorization header for a call to this deployment's own endpoints, or
// null when no secret is set.
export function selfAuthHeader() {
  const value = secret();
  return value ? `Bearer ${value}` : null;
}

// ── Browser-triggered delivery ──────────────────────────────────────
//
// /api/card-check signs the delivery it hands the browser when a run
// completes; /api/card-deliver posts only what it signed, so a caller can't
// put its own text or links in front of a customer. slackDelivery stays
// outside the signature on purpose: it's the playground's opt-out switch, and
// flipping it can only stop a genuine report or let it through.

const DELIVERY_TTL_MS = 15 * 60_000;
const DELIVERY_FIELDS = ['runId', 'projectId', 'tenantId', 'projectName', 'pdfUrl', 'status', 'summary', 'cardType', 'expiresAt'];

const deliveryMac = (key, delivery) => createHmac('sha256', key)
  .update(`delivery:${JSON.stringify(DELIVERY_FIELDS.map((f) => delivery?.[f] ?? null))}`)
  .digest('hex');

// The delivery plus `expiresAt` and `token`, or null when no secret is set.
export function signDelivery(delivery, now = Date.now()) {
  const key = secret();
  if (!key) return null;
  const signed = { ...delivery, expiresAt: now + DELIVERY_TTL_MS };
  signed.token = deliveryMac(key, signed);
  return signed;
}

// null when the delivery is genuine and current, otherwise the reason it isn't.
export function verifyDelivery(delivery, now = Date.now()) {
  const key = secret();
  if (!key) return 'delivery signing is not configured';
  if (!delivery?.token || !delivery.runId) return 'missing delivery token';
  if (!safeEqual(delivery.token, deliveryMac(key, delivery))) return 'invalid delivery token';
  if (!(Number(delivery.expiresAt) > now)) return 'delivery token expired';
  return null;
}

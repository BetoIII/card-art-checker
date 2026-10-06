import { createHmac, timingSafeEqual } from 'node:crypto';

// Server-issued credentials for calls the public internet must not be able to
// make on its own: the pipeline's self-call to /api/spec-check, and the
// browser's follow-up to /api/card-deliver after a run it watched.
//
// Both are derived from ROCKETLANE_WEBHOOK_SECRET, which every deployment
// already carries, so there is nothing new to configure. Each use gets its own
// key — an HMAC of a fixed label — so a value issued for one purpose can't be
// replayed as another, and the shared secret itself never leaves the server.
// No secret configured means every check here fails closed.

function derivedKey(purpose) {
  const secret = process.env.ROCKETLANE_WEBHOOK_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(`card-art-checker/${purpose}/v1`).digest();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Spec-check self-call ────────────────────────────────────────────
//
// A static token: the call only ever goes to this deployment's own host
// (VERCEL_URL or SELF_BASE_URL), never to a host taken from a request.
// api/spec-check.py derives the same value; tests pin both to one vector.

export const SPEC_CHECK_TOKEN_HEADER = 'x-spec-check-token';

export function specCheckToken() {
  const key = derivedKey('spec-check');
  return key ? key.toString('hex') : null;
}

// ── Browser-triggered delivery ──────────────────────────────────────
//
// /api/card-check signs the delivery it hands the browser when a run
// completes; /api/card-deliver posts only what it signed, so a caller can't
// put its own text or links in front of a customer. slackDelivery stays
// outside the signature on purpose: it's the playground's opt-out switch, and
// flipping it can only stop a genuine report or let it through.

const DELIVERY_TTL_MS = 15 * 60_000;
const DELIVERY_FIELDS = ['runId', 'projectId', 'projectName', 'pdfUrl', 'status', 'summary', 'cardType', 'expiresAt'];

const deliveryMaterial = (delivery) => JSON.stringify(DELIVERY_FIELDS.map((f) => delivery?.[f] ?? null));

// The delivery plus `expiresAt` and `token`, or null when no secret is set.
export function signDelivery(delivery, now = Date.now()) {
  const key = derivedKey('delivery');
  if (!key) return null;
  const signed = { ...delivery, expiresAt: now + DELIVERY_TTL_MS };
  signed.token = createHmac('sha256', key).update(deliveryMaterial(signed)).digest('hex');
  return signed;
}

// null when the delivery is genuine and current, otherwise the reason it isn't.
export function verifyDelivery(delivery, now = Date.now()) {
  const key = derivedKey('delivery');
  if (!key) return 'delivery signing is not configured';
  if (!delivery?.token || !delivery.runId) return 'missing delivery token';
  const expected = createHmac('sha256', key).update(deliveryMaterial(delivery)).digest('hex');
  if (!safeEqual(delivery.token, expected)) return 'invalid delivery token';
  if (!(Number(delivery.expiresAt) > now)) return 'delivery token expired';
  return null;
}

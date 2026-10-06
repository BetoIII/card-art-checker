// The shared secret: the bearer check, the self-call header, and the signed
// browser delivery.
//
// Run: node --test 'tests/*.test.js'

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAuthenticated, selfAuthHeader, signDelivery, verifyDelivery,
} from '../lib/internal-auth.js';

beforeEach(() => {
  process.env.ROCKETLANE_WEBHOOK_SECRET = 'test-secret';
});

// ── Bearer secret ───────────────────────────────────────────────────

const req = (headers) => new Request('https://example.test/api/result', { headers });

test('the secret is accepted as a bearer token or x-webhook-secret', () => {
  assert.equal(isAuthenticated(req({ authorization: 'Bearer test-secret' })), true);
  assert.equal(isAuthenticated(req({ authorization: 'bearer  test-secret ' })), true);
  assert.equal(isAuthenticated(req({ 'x-webhook-secret': 'test-secret' })), true);
});

test('a missing or wrong secret is refused', () => {
  assert.equal(isAuthenticated(req({})), false);
  assert.equal(isAuthenticated(req({ authorization: 'Bearer nope' })), false);
  assert.equal(isAuthenticated(req({ authorization: 'test-secret' })), false);
  assert.equal(isAuthenticated(req({ 'x-webhook-secret': 'test-secre' })), false);
});

test('with no secret configured nothing authenticates', () => {
  delete process.env.ROCKETLANE_WEBHOOK_SECRET;
  assert.equal(isAuthenticated(req({ authorization: 'Bearer ' })), false);
  assert.equal(isAuthenticated(req({ 'x-webhook-secret': '' })), false);
  assert.equal(selfAuthHeader(), null);
});

test('the self-call header is what isAuthenticated accepts', () => {
  assert.equal(isAuthenticated(req({ authorization: selfAuthHeader() })), true);
});

// ── Signed delivery ─────────────────────────────────────────────────

const delivery = {
  runId: 'mgx1k2-ab12cd',
  projectId: '12345',
  projectName: 'Acme',
  pdfUrl: 'https://abc.public.blob.vercel-storage.com/reports/x.pdf',
  status: 'fail',
  summary: 'The Visa Brand Mark is in the lower-right corner.',
  cardType: 'virtual',
  slackDelivery: true,
};

// What the browser sends back: the signed object after a JSON round trip.
const roundTrip = (d) => JSON.parse(JSON.stringify(d));

test('a signed delivery verifies after the browser round trip', () => {
  const signed = signDelivery(delivery);
  assert.match(signed.token, /^[0-9a-f]{64}$/);
  assert.equal(verifyDelivery(roundTrip(signed)), null);
});

test('changing any signed field breaks the delivery', () => {
  const signed = signDelivery(delivery);
  for (const [field, value] of [
    ['summary', 'Click https://evil.example to fix your card.'],
    ['pdfUrl', 'https://evil.example/report.pdf'],
    ['projectId', '99999'],
    ['tenantId', '9eef553e-4dd3-4e70-b86a-0edc969f447c'],
    ['projectName', 'Someone else'],
    ['status', 'pass'],
    ['runId', 'other-run'],
    ['expiresAt', signed.expiresAt + 60_000_000],
  ]) {
    assert.equal(verifyDelivery({ ...roundTrip(signed), [field]: value }), 'invalid delivery token', field);
  }
});

test('slackDelivery can be switched without breaking the delivery', () => {
  const signed = signDelivery(delivery);
  assert.equal(verifyDelivery({ ...roundTrip(signed), slackDelivery: false }), null);
});

test('a delivery expires', () => {
  const signed = signDelivery(delivery, 0);
  assert.equal(verifyDelivery(signed, signed.expiresAt + 1), 'delivery token expired');
});

test('an unsigned or forged delivery is refused', () => {
  assert.equal(verifyDelivery(delivery), 'missing delivery token');
  assert.equal(verifyDelivery({ ...delivery, token: 'f'.repeat(64), expiresAt: Date.now() + 60_000 }), 'invalid delivery token');
  const signed = signDelivery(delivery);
  process.env.ROCKETLANE_WEBHOOK_SECRET = 'other-secret';
  assert.equal(verifyDelivery(signed), 'invalid delivery token');
});

test('with no secret nothing is signed and nothing verifies', () => {
  const signed = signDelivery(delivery);
  delete process.env.ROCKETLANE_WEBHOOK_SECRET;
  assert.equal(signDelivery(delivery), null);
  assert.equal(verifyDelivery(signed), 'delivery signing is not configured');
});

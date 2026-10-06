// Server-issued credentials: the spec-check self-call token and the signed
// browser delivery.
//
// Run: node --test 'tests/*.test.js'

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { specCheckToken, signDelivery, verifyDelivery } from '../lib/internal-auth.js';

beforeEach(() => {
  process.env.ROCKETLANE_WEBHOOK_SECRET = 'test-secret';
});

// ── Spec-check token ────────────────────────────────────────────────

// api/spec-check.py derives the token on its own; tests/test_spec_checks.py
// pins it to this same vector, so the two sides can't drift apart.
test('the spec-check token is the shared vector', () => {
  assert.equal(specCheckToken(), '324d708b6aad55d0f0b423460d218eccb3671fbf34668b8db400601c0bbe8b1b');
});

test('the spec-check token is not the secret and changes with it', () => {
  const token = specCheckToken();
  assert.notEqual(token, 'test-secret');
  process.env.ROCKETLANE_WEBHOOK_SECRET = 'other-secret';
  assert.notEqual(specCheckToken(), token);
});

test('no secret, no spec-check token', () => {
  delete process.env.ROCKETLANE_WEBHOOK_SECRET;
  assert.equal(specCheckToken(), null);
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

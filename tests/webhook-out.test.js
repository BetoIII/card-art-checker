// Outbound webhook: signing, target validation, retry/never-throw contract.
//
// Run: node --test 'tests/*.test.js'

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  signPayload, verifyPayload, resolveTarget, sendResultWebhook,
} from '../lib/webhook-out.js';

const ENV_KEYS = [
  'RESULT_WEBHOOK_URL', 'RESULT_WEBHOOK_SECRET', 'RESULT_WEBHOOK_ALLOWED_HOSTS',
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ── Signing ─────────────────────────────────────────────────────────

test('signature round-trips through the verifier', () => {
  const rawBody = JSON.stringify({ hello: 'world' });
  const { timestamp, signature } = signPayload({ rawBody, secret: 's3cret' });
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.ok(verifyPayload({ rawBody, secret: 's3cret', timestamp, signature }));
});

test('signature verification fails on a tampered body, secret, or timestamp', () => {
  const rawBody = JSON.stringify({ amount: 1 });
  const { timestamp, signature } = signPayload({ rawBody, secret: 's3cret' });

  assert.ok(!verifyPayload({ rawBody: JSON.stringify({ amount: 2 }), secret: 's3cret', timestamp, signature }));
  assert.ok(!verifyPayload({ rawBody, secret: 'wrong', timestamp, signature }));
  assert.ok(!verifyPayload({ rawBody, secret: 's3cret', timestamp: timestamp + 1, signature }));
  assert.ok(!verifyPayload({ rawBody, secret: 's3cret', timestamp, signature: 'sha256=' + '0'.repeat(64) }));
  assert.ok(!verifyPayload({ rawBody, secret: 's3cret', timestamp, signature: undefined }));
});

test('the timestamp is inside the signed material, not merely alongside it', () => {
  // A replay with a fresh timestamp must not validate against the old
  // signature — that only holds if the timestamp is part of the HMAC input.
  const rawBody = '{}';
  const { signature } = signPayload({ rawBody, secret: 's', timestamp: 1000 });
  assert.ok(!verifyPayload({ rawBody, secret: 's', timestamp: 2000, signature }));
});

test('the scheme matches the inbound verifier it was inverted from', () => {
  // api/dock-webhook.js computes hex(HMAC-SHA256(secret, `${a}\n${b}\n${body}`))
  // and compares with timingSafeEqual. Ours is the same primitive over
  // `${timestamp}.${rawBody}` — recompute it independently here so a change to
  // the construction cannot pass unnoticed.
  const rawBody = JSON.stringify({ run_id: 'abc' });
  const secret = 'shared';
  const timestamp = 1737000000;
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  assert.equal(signPayload({ rawBody, secret, timestamp }).signature, expected);
});

// ── Target resolution / allowlist ───────────────────────────────────

test('with nothing configured there is no target', () => {
  assert.match(resolveTarget(null).skip, /no webhook target configured/);
});

test('the configured URL is used when no callback is supplied', () => {
  process.env.RESULT_WEBHOOK_URL = 'https://platform.rain.example/hooks/card-art';
  assert.equal(resolveTarget(null).url, 'https://platform.rain.example/hooks/card-art');
});

test('a caller-supplied callback is refused unless allowlisted', () => {
  // pdfUrl in the payload is a permanent public Blob URL, so an arbitrary
  // callback both leaks a customer report and gives an SSRF primitive.
  process.env.RESULT_WEBHOOK_ALLOWED_HOSTS = 'rain.example';
  assert.match(resolveTarget('https://evil.test/collect').skip, /not allowlisted/);
  assert.equal(
    resolveTarget('https://api.rain.example/hooks').url,
    'https://api.rain.example/hooks',
  );
});

test('an empty allowlist refuses every caller-supplied callback', () => {
  process.env.RESULT_WEBHOOK_URL = 'https://configured.example/hook';
  assert.match(resolveTarget('https://anything.example/x').skip, /ALLOWED_HOSTS is empty/);
});

test('allowlisting a domain covers its subdomains but not a lookalike suffix', () => {
  process.env.RESULT_WEBHOOK_ALLOWED_HOSTS = 'rain.example';
  assert.ok(resolveTarget('https://a.b.rain.example/h').url);
  assert.match(resolveTarget('https://notrain.example/h').skip, /not allowlisted/);
  assert.match(resolveTarget('https://rain.example.evil.test/h').skip, /not allowlisted/);
});

test('non-https and malformed callbacks are refused', () => {
  process.env.RESULT_WEBHOOK_ALLOWED_HOSTS = 'rain.example';
  assert.match(resolveTarget('http://rain.example/h').skip, /must be https/);
  assert.match(resolveTarget('not-a-url').skip, /not a valid URL/);
});

// ── Send behaviour ──────────────────────────────────────────────────

const RESULT = { schema_version: '1.0', run_id: 'r1', outcome: 'approved' };

test('sending is skipped when no secret is configured', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  const status = await sendResultWebhook({ result: RESULT, event: 'card_art_check.completed', runId: 'r1' });
  assert.match(status, /RESULT_WEBHOOK_SECRET is not set/);
});

test('internal-schema results are never published', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  process.env.RESULT_WEBHOOK_SECRET = 's';
  const status = await sendResultWebhook({
    result: { schema_version: '0-internal', run_id: 'r1' },
    event: 'card_art_check.completed', runId: 'r1',
  });
  assert.match(status, /not published/);
});

test('a successful POST reports ok and carries the signature headers', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  process.env.RESULT_WEBHOOK_SECRET = 'topsecret';

  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return new Response('', { status: 200 });
  };

  try {
    const status = await sendResultWebhook({
      result: RESULT, event: 'card_art_check.completed', runId: 'r1', attachmentId: 'a1',
    });
    assert.equal(status, 'ok');
    assert.equal(captured.length, 1);

    const { init } = captured[0];
    const signature = init.headers['x-card-art-signature'];
    const timestamp = Number(init.headers['x-card-art-timestamp']);
    assert.ok(verifyPayload({ rawBody: init.body, secret: 'topsecret', timestamp, signature }),
      'the delivered body verifies against the delivered signature');

    const envelope = JSON.parse(init.body);
    assert.equal(envelope.event, 'card_art_check.completed');
    assert.equal(envelope.run_id, 'r1');
    assert.equal(envelope.attachment_id, 'a1');
    assert.equal(envelope.data.outcome, 'approved');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a 4xx is not retried; a 5xx is', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  process.env.RESULT_WEBHOOK_SECRET = 's';
  const realFetch = globalThis.fetch;

  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 400 }); };
    let status = await sendResultWebhook({ result: RESULT, event: 'e', runId: 'r' });
    assert.equal(calls, 1, '4xx should not be retried');
    assert.match(status, /not retryable/);

    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
    status = await sendResultWebhook({ result: RESULT, event: 'e', runId: 'r' });
    assert.equal(calls, 3, '5xx should exhaust the retry budget');
    assert.match(status, /after 3 attempts/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a thrown transport error is reported, never propagated', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  process.env.RESULT_WEBHOOK_SECRET = 's';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const status = await sendResultWebhook({ result: RESULT, event: 'e', runId: 'r' });
    assert.match(status, /ECONNREFUSED/);
    assert.match(status, /after 3 attempts/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an imminent deadline stops a new attempt rather than dying mid-POST', async () => {
  process.env.RESULT_WEBHOOK_URL = 'https://rain.example/hook';
  process.env.RESULT_WEBHOOK_SECRET = 's';
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 200 }); };

  try {
    const status = await sendResultWebhook({
      result: RESULT, event: 'e', runId: 'r', deadlineAt: Date.now() + 1_000,
    });
    assert.equal(calls, 0, 'no request is started inside the timeout margin');
    assert.match(status, /out of time/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Slack delivery is off for every entry point. Off has to be quiet: a run for
// a real Rocketlane project, with a Slack token configured, still skips the
// channel lookup and the post, and returns the skip as a normal result.
//
// Run: node --test 'tests/*.test.js'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverReport, SLACK_DELIVERY_ENABLED, SLACK_DELIVERY_OFF } from '../lib/delivery.js';

test('Slack delivery is switched off', () => {
  assert.equal(SLACK_DELIVERY_ENABLED, false);
});

test('a project run with Slack configured is skipped quietly', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  // A confident channel match: with delivery on, this would be posted to.
  const channelPromise = Promise.resolve({ confidence: 'high', channelId: 'C123', channelName: 'ext-test-rain' });
  const results = await deliverReport({
    projectId: '12345678',
    projectName: 'Test',
    pdfUrl: 'https://example.test/report.pdf',
    status: 'pass',
    summary: 'ok',
    cardType: 'virtual',
    channelPromise,
  });
  assert.deepEqual(results, { slack: SLACK_DELIVERY_OFF, identify: null });
});

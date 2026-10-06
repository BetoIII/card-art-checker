// One published result per attachment, including for a run the platform is
// about to kill.
//
// Run: node --test 'tests/*.test.js'
//
// No Blob token and no webhook target are configured here, so emits build
// their result and skip the network — what's under test is which emits
// publish at all.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  emitResult, emitFailure, oweResult, settleOwedResults, publishOwedOnTimeout,
} from '../lib/result-emit.js';

beforeEach(() => {
  for (const key of ['BLOB_READ_WRITE_TOKEN', 'RESULT_WEBHOOK_URL', 'RESULT_WEBHOOK_SECRET', 'RESULT_WEBHOOK_ALLOWED_HOSTS']) {
    delete process.env[key];
  }
});

let n = 0;
const freshRun = () => `run${++n}-${Math.random().toString(36).slice(2, 8)}`;

const approved = { status: 'APPROVED', summary: 'Compliant.', visual_checks: [] };
const completed = (runId, attachmentId = null) =>
  emitResult({ runId, attachmentId, results: approved, techJson: null, cardType: 'virtual', source: 'api' });
const failed = (runId, attachmentId = null, errorCode = 'internal_error') =>
  emitFailure({ runId, attachmentId, errorCode, message: 'boom' });

test('a failure after a published result is dropped', async () => {
  const runId = freshRun();
  const first = await completed(runId);
  assert.equal(first.result.outcome, 'approved');
  const late = await failed(runId);
  assert.equal(late.result, null);
  assert.match(late.webhook, /already published/);
});

test('a result after a published failure is dropped', async () => {
  const runId = freshRun();
  assert.equal((await failed(runId)).result.error.code, 'internal_error');
  const late = await completed(runId);
  assert.equal(late.result, null);
  assert.equal(late.outcome, null);
});

test('attachments of one run settle independently', async () => {
  const runId = freshRun();
  assert.ok((await completed(runId, 'a1')).result);
  assert.ok((await failed(runId, 'a2')).result);
});

test('a run about to be killed publishes function_timeout for what it still owes', async () => {
  const runId = freshRun();
  const context = { runId, source: 'rocketlane', trigger: { endpoint: '/api/card-art-check' }, projectId: '12345', cardType: 'virtual' };
  oweResult({ ...context, attachmentId: 'done', fileName: 'done.png' });
  oweResult({ ...context, attachmentId: 'stuck', fileName: 'stuck.png' });
  await completed(runId, 'done');

  const settled = await settleOwedResults(runId, { message: 'Timed out — function hit its 300s limit', step: 'agent_run' });
  assert.equal(settled.length, 1);
  const { result } = settled[0];
  assert.equal(result.status, 'error');
  assert.equal(result.attachment_id, 'stuck');
  assert.deepEqual(result.error, { code: 'function_timeout', message: 'Timed out — function hit its 300s limit', step: 'agent_run' });
  assert.equal(result.submission.file_name, 'stuck.png');
  assert.equal(result.trigger.source, 'rocketlane');
  assert.equal(result.project.id, '12345');

  // Settled now: a second timeout, or the pipeline finishing late, adds nothing.
  assert.deepEqual(await settleOwedResults(runId, { message: 'again' }), []);
  assert.equal((await completed(runId, 'stuck')).result, null);
});

test('settling one run leaves another run alone', async () => {
  const mine = freshRun();
  const other = freshRun();
  oweResult({ runId: other, source: 'api' });
  assert.deepEqual(await settleOwedResults(mine, { message: 'x' }), []);
  assert.equal((await completed(other)).result.outcome, 'approved');
});

test('the watchdog hook passes the reason and step through', async () => {
  const runId = freshRun();
  oweResult({ runId, source: 'api', fileName: 'card.png' });
  const [{ result }] = await publishOwedOnTimeout(runId)({ reason: 'Timed out', step: 'tech_specs', killAt: Date.now() + 15_000 });
  assert.deepEqual(result.error, { code: 'function_timeout', message: 'Timed out', step: 'tech_specs' });
});

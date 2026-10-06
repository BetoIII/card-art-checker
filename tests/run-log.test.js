// The run-log watchdog: it fires shortly before the platform's kill, hands
// its hook the kill time, and stays armed through an abandoned stream.
//
// Run: node --test 'tests/*.test.js'
//
// No Blob token is set, so the log keeps its record in memory only.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createRunLog } from '../lib/run-log.js';

beforeEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
});
afterEach(() => mock.timers.reset());

// Let the watchdog's fire-and-forget hook run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the watchdog fires 15s before the kill and hands the hook the kill time', async () => {
  const calls = [];
  const runLog = createRunLog({ source: 'api' });
  runLog.event('agent_run', 'Running visual inspection...', 'pending');
  runLog.armWatchdog(300_000, { onTimeout: (info) => calls.push(info) });

  mock.timers.tick(284_999);
  await flush();
  assert.equal(calls.length, 0);

  mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].killAt, 1_000_000 + 300_000);
  assert.equal(calls[0].step, 'agent_run');
  assert.match(calls[0].reason, /300s limit during "agent_run"/);
  assert.equal(runLog.record.status, 'failed');
});

test('finishing the run disarms the watchdog', async () => {
  const calls = [];
  const runLog = createRunLog({ source: 'api' });
  runLog.armWatchdog(300_000, { onTimeout: (info) => calls.push(info) });
  runLog.finish();
  mock.timers.tick(300_000);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(runLog.record.status, 'completed');
});

test('an abandoned stream keeps the watchdog armed for the pipeline behind it', async () => {
  const calls = [];
  const runLog = createRunLog({ source: 'upload' });
  runLog.armWatchdog(300_000, { onTimeout: (info) => calls.push(info) });
  runLog.abandon('Client disconnected before the run finished');
  assert.equal(runLog.record.status, 'failed');

  mock.timers.tick(285_000);
  await flush();
  assert.equal(calls.length, 1);
  // The abandon reason stands; the watchdog doesn't overwrite it.
  assert.equal(runLog.record.error, 'Client disconnected before the run finished');
});

test('a hook that throws is contained', async () => {
  const runLog = createRunLog({ source: 'api' });
  const logged = mock.method(console, 'error', () => {});
  runLog.armWatchdog(300_000, { onTimeout: () => { throw new Error('store down'); } });
  mock.timers.tick(285_000);
  await flush();
  assert.equal(runLog.record.status, 'failed');
  assert.equal(logged.mock.callCount(), 1);
  logged.mock.restore();
});

// Transport-blob cleanup: every upload made through withTransportBlobs is
// deleted however the analysis ends. A run that threw before the report
// render used to leak its upload into tmp/spec-check/.
//
// Run: node --test 'tests/*.test.js'
//
// put/del are injected fakes; nothing touches Blob.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { withTransportBlobs } from '../lib/transport-blobs.js';

function fakeBlob() {
  const deleted = [];
  let n = 0;
  return {
    deleted,
    put: async (pathname) => ({ url: `https://blob.test/${pathname}-${n++}` }),
    del: async (url) => { deleted.push(url); },
  };
}

test('a successful run deletes its uploads and returns the result', async () => {
  const blob = fakeBlob();
  const out = await withTransportBlobs(async (put) => {
    await put('tmp/front.ai');
    await put('tmp/back.ai');
    return 'report';
  }, blob);
  assert.equal(out, 'report');
  assert.deepEqual(blob.deleted, ['https://blob.test/tmp/front.ai-0', 'https://blob.test/tmp/back.ai-1']);
});

test('a run that throws after uploading still deletes the upload and rethrows', async () => {
  const blob = fakeBlob();
  await assert.rejects(
    withTransportBlobs(async (put) => {
      await put('tmp/card-art.png');
      throw new Error('spec-check check failed (400)');
    }, blob),
    /spec-check check failed/,
  );
  assert.deepEqual(blob.deleted, ['https://blob.test/tmp/card-art.png-0']);
});

test('an upload still in flight when the run throws is deleted once it lands', async () => {
  const blob = fakeBlob();
  let land;
  const slowPut = () => new Promise((resolve) => { land = () => resolve({ url: 'https://blob.test/slow' }); });
  const run = withTransportBlobs(async (put) => {
    put('tmp/card-art.png'); // the virtual path starts the put, then fails elsewhere first
    throw new Error('files upload failed');
  }, { put: slowPut, del: blob.del });

  const settled = run.catch((err) => err);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(blob.deleted, [], 'cleanup waits for the upload instead of skipping it');
  land();
  assert.match((await settled).message, /files upload failed/);
  assert.deepEqual(blob.deleted, ['https://blob.test/slow']);
});

test('a failed upload is skipped and a failed delete never masks the outcome', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const out = await withTransportBlobs(async (put) => {
      await put('tmp/ok.png');
      await put('tmp/broken.png').catch(() => {}); // the caller handles its own put error
      return 'report';
    }, {
      put: async (pathname) => {
        if (pathname.includes('broken')) throw new Error('put failed');
        return { url: `https://blob.test/${pathname}` };
      },
      del: async () => { throw new Error('del failed'); },
    });
    assert.equal(out, 'report');
    assert.equal(warn.mock.callCount(), 1, 'one warning for the one delete attempted');
    assert.match(String(warn.mock.calls[0].arguments[1]), /del failed/);
  } finally {
    warn.mock.restore();
  }
});

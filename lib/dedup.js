import { head, put } from '@vercel/blob';

// Tiny marker files on Vercel Blob used as a "set" to dedup processed
// Rocketlane form answers. One file per answerId, ~100 bytes each.
//
// Key scheme: dedup/rocketlane-answers/{answerId}.json
//
// head() returns metadata if the blob exists, and throws (404) otherwise.
// We treat any error as "not processed" so a transient Blob outage degrades
// to "process this answer again" rather than "skip forever".

const PREFIX = 'dedup/rocketlane-answers';

function keyFor(answerId) {
  return `${PREFIX}/${answerId}.json`;
}

export async function hasProcessed(answerId) {
  try {
    await head(keyFor(answerId));
    return true;
  } catch {
    return false;
  }
}

export async function markProcessed(answerId, meta = {}) {
  const body = JSON.stringify({
    answerId,
    processedAt: new Date().toISOString(),
    ...meta,
  });
  await put(keyFor(answerId), body, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

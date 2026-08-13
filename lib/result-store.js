import { put, list } from '@vercel/blob';

// Persists the structured result object so GET /api/result/:runId can serve
// it, and so physical results accumulate into the corpus a v1.1 physical
// contract will need to validate against.
//
// Path scheme: results/{runId}[-{attachmentId}].json
//
// A run can analyze several attachments (api/card-art-check.js fans out over
// toAnalyze), so the attachment ID is part of the key. addRandomSuffix is off:
// the key must be derivable from the run ID alone for the read endpoint to
// find it by prefix.
//
// Writes are best-effort in the same spirit as lib/run-log.js — a failed
// result write must never sink an analysis that otherwise succeeded.

function resultKey(runId, attachmentId) {
  return attachmentId
    ? `results/${runId}-${attachmentId}.json`
    : `results/${runId}.json`;
}

export async function storeResult({ runId, attachmentId, result }) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { resultUrl: null };
  // Without a run ID the result is unaddressable — writing it would create a
  // `results/undefined.json` that the next run overwrites.
  if (!runId) {
    console.warn('[result-store] no runId — result not stored');
    return { resultUrl: null };
  }
  const key = resultKey(runId, attachmentId);
  try {
    const blob = await put(key, JSON.stringify(result), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
    });
    return { resultUrl: blob.url };
  } catch (err) {
    console.error(`[result-store] blob write failed for ${key}:`, err);
    return { resultUrl: null };
  }
}

// Every stored result for a run — one per analyzed attachment.
//
// Blobs are mutated in place behind a 60s CDN cache, so reads append a
// cache-buster the same way api/admin/runs.js does; without it a consumer
// polling right after a write can be served the previous body.
export async function loadResults(runId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const { blobs } = await list({ prefix: `results/${runId}` });
  const results = await Promise.all(blobs.map(async (blob) => {
    try {
      const res = await fetch(`${blob.url}?ts=${Date.now()}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.error(`[result-store] failed to read ${blob.pathname}:`, err);
      return null;
    }
  }));
  return results.filter(Boolean);
}

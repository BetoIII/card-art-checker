import { put } from '@vercel/blob';

// Persistent per-run log backing the /admin dashboard. Every run of the
// card-art pipeline — whichever entry point triggered it — is one JSON blob at
// runs/{sortKey}-{runId}.json, overwritten in place as the run progresses so
// in-flight runs show up with partial data.
//
// sortKey is an inverted, fixed-width millisecond timestamp, so a plain
// lexicographic blob list under the "runs/" prefix returns newest runs first
// without paginating the whole store.
//
// source values map to the trigger entry points:
//   'rocketlane' — Rocketlane form-completed webhook → /api/card-art-check
//   'dock'       — Dock workspace.form.submitted webhook → /api/dock-webhook
//   'upload'     — manual /upload UI → /api/card-check
//
// Logging must never break the pipeline: writes are best-effort (errors are
// swallowed after a console.error), and a missing BLOB_READ_WRITE_TOKEN turns
// the logger into a no-op.

const SORT_EPOCH = 99_999_999_999_999; // 14 digits — inverted keys stay fixed-width for millennia

export function createRunLog({ source, trigger } = {}) {
  const startedAtMs = Date.now();
  const runId = `${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `runs/${String(SORT_EPOCH - startedAtMs).padStart(14, '0')}-${runId}.json`;

  const record = {
    runId,
    source: source || 'unknown',
    trigger: trigger || {},
    status: 'running', // running | completed | failed | skipped
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date(startedAtMs).toISOString(),
    events: [],
    results: [],
  };

  // Writes are coalesced: one in-flight put at a time; changes made while a
  // put is running trigger exactly one trailing put. Awaiting the chain (what
  // finish/fail/skip return) therefore always covers the latest state.
  let writeChain = null;
  let dirty = false;

  function persist() {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return Promise.resolve();
    record.updatedAt = new Date().toISOString();
    dirty = true;
    if (!writeChain) {
      writeChain = (async () => {
        while (dirty) {
          dirty = false;
          try {
            await put(key, JSON.stringify(record), {
              access: 'public',
              contentType: 'application/json',
              addRandomSuffix: false,
              cacheControlMaxAge: 60,
            });
          } catch (err) {
            console.error(`[run-log] blob write failed for ${key}:`, err);
          }
        }
        writeChain = null;
      })();
    }
    return writeChain;
  }

  const api = {
    runId,
    record,
    // Merge top-level fields (projectId, projectName, downloads, selected, …).
    set(fields) {
      Object.assign(record, fields);
      return persist();
    },
    // Append a timeline event (mirrors the pipeline's onProgress steps).
    event(step, message, status, extra) {
      record.events.push({ t: new Date().toISOString(), step, message, status, ...extra });
      return persist();
    },
    // Append a per-attachment analysis outcome ({ attachmentId?, filename,
    // cardType, status, summary, pdfUrl, delivery } or { …, error }).
    addResult(result) {
      record.results.push(result);
      return persist();
    },
    finish(status = 'completed', fields = {}) {
      Object.assign(record, fields);
      record.status = status;
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.now() - startedAtMs;
      return persist();
    },
    fail(error, fields = {}) {
      return api.finish('failed', { ...fields, error: String(error?.message || error) });
    },
    skip(reason) {
      return api.finish('skipped', { skipReason: reason });
    },
  };
  return api;
}

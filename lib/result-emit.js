import { buildResult, buildFailureResult } from './result-schema.js';
import { storeResult } from './result-store.js';
import { sendResultWebhook } from './webhook-out.js';

// build → store → (optionally) POST, in one call.
//
// All three entry points need the identical sequence after an analysis
// settles, so it lives here rather than being triplicated across
// api/card-art-check.js, api/dock-webhook.js and api/card-check.js.
//
// Like lib/delivery.js and lib/notify.js, this NEVER throws: emitting a
// result is a side effect of a run, and a failure to publish must not turn a
// successful analysis into a failed one. Everything is reported back as data
// for the run log instead.

// ── One result per attachment ───────────────────────────────────────
//
// Every attachment a run starts on is owed exactly one published result.
// Two things used to break that: a function killed at maxDuration published
// nothing, so a poller saw 404 forever and no webhook fired; and a throw
// after a result went out could publish a failure on top of it. The ledger
// settles an attachment on its first emit and drops any later one, and
// settleOwedResults() — run by the run-log watchdog just before the kill —
// publishes a function_timeout failure for whatever is still owed.
//
// Module state, but keyed by run id, so concurrent invocations sharing a
// warm instance never touch each other's entries.

const ledger = new Map(); // `${runId}:${attachmentId}` → { context, settled, at }
const LEDGER_TTL_MS = 15 * 60_000;

const ledgerKey = (runId, attachmentId) => `${runId}:${attachmentId ?? ''}`;

function pruneLedger(now = Date.now()) {
  for (const [key, entry] of ledger) {
    if (now - entry.at > LEDGER_TTL_MS) ledger.delete(key);
  }
}

// Record that this attachment is owed a result. `context` holds what a
// failure result needs: runId, attachmentId, cardType, projectId, projectName,
// fileName, source, trigger, callbackUrl.
export function oweResult(context) {
  if (!context?.runId) return;
  pruneLedger();
  const key = ledgerKey(context.runId, context.attachmentId);
  if (!ledger.has(key)) ledger.set(key, { context, settled: false, at: Date.now() });
}

// True for the first emit for an attachment, false for any after it.
function claim(runId, attachmentId) {
  if (!runId) return true;
  const key = ledgerKey(runId, attachmentId);
  const entry = ledger.get(key);
  if (entry?.settled) return false;
  ledger.set(key, { context: entry?.context ?? null, settled: true, at: Date.now() });
  return true;
}

const ALREADY_PUBLISHED = 'skipped: a result was already published for this attachment';

// Publish a function_timeout failure for every attachment of the run still
// owed a result. `deadlineAt` is the real kill time, so the webhook gets an
// attempt only if one can finish before it. Never throws.
export async function settleOwedResults(runId, { message = null, step = null, deadlineAt = null } = {}) {
  const owed = [...ledger.entries()]
    .filter(([key, entry]) => key.startsWith(`${runId}:`) && !entry.settled && entry.context)
    .map(([, entry]) => entry.context);
  return Promise.all(owed.map((context) => emitFailure({
    ...context, errorCode: 'function_timeout', message, step, deadlineAt,
  })));
}

// The run-log watchdog hook for an entry point: when the platform is about
// to kill the run, publish what it still owes. Two seconds before the kill is
// the latest a webhook attempt may still finish.
export function publishOwedOnTimeout(runId) {
  return ({ reason, step, killAt }) =>
    settleOwedResults(runId, { message: reason, step, deadlineAt: killAt - 2_000 });
}

export async function emitResult({
  runId, attachmentId = null, results, techJson, cardType,
  projectId, projectName, fileName, pdfUrl, source, trigger,
  detectedProduct = null, declaredProduct = null, callbackUrl = null, deadlineAt = null,
}) {
  if (!claim(runId, attachmentId)) {
    console.warn(`[result-emit] run ${runId}: dropped a late result — one was already published`);
    return { result: null, resultUrl: null, webhook: ALREADY_PUBLISHED, outcome: null };
  }
  try {
    const result = buildResult({
      runId, attachmentId, results, techJson, cardType,
      projectId, projectName, fileName, pdfUrl, source, trigger,
      detectedProduct: detectedProduct ?? techJson?.detected_product ?? null,
      declaredProduct,
    });

    const { resultUrl } = await storeResult({ runId, attachmentId, result });

    const webhook = await sendResultWebhook({
      result,
      event: 'card_art_check.completed',
      runId,
      attachmentId,
      callbackUrl,
      deadlineAt,
    });

    // A non-empty unmapped_checks[] means the agent emitted a check the
    // catalog does not know. Nothing is lost (the entries are on the wire),
    // but it is the signal that the prompt and catalog have drifted apart.
    if (result.unmapped_checks?.length) {
      console.warn(
        `[result-emit] run ${runId}: ${result.unmapped_checks.length} unmapped check(s): ` +
        result.unmapped_checks.map((c) => JSON.stringify(c.name)).join(', ')
      );
    }

    return { result, resultUrl, webhook, outcome: result.outcome };
  } catch (err) {
    console.error(`[result-emit] failed for run ${runId}:`, err);
    return { result: null, resultUrl: null, webhook: `failed: ${err?.message || err}`, outcome: null };
  }
}

// The failure counterpart: a run that never produced an analysis is still a
// result the consumer is waiting on.
export async function emitFailure({
  runId, attachmentId = null, cardType = null, errorCode, message = null, step = null,
  projectId = null, projectName = null, fileName = null, source = null, trigger = null,
  callbackUrl = null, deadlineAt = null,
}) {
  if (!claim(runId, attachmentId)) {
    console.warn(`[result-emit] run ${runId}: dropped a late ${errorCode} failure — a result was already published`);
    return { result: null, resultUrl: null, webhook: ALREADY_PUBLISHED };
  }
  try {
    const result = buildFailureResult({
      runId, attachmentId, cardType, errorCode, message, step,
      projectId, projectName, fileName, source, trigger,
    });

    const { resultUrl } = await storeResult({ runId, attachmentId, result });

    const webhook = await sendResultWebhook({
      result,
      event: 'card_art_check.failed',
      runId,
      attachmentId,
      callbackUrl,
      deadlineAt,
    });

    return { result, resultUrl, webhook };
  } catch (err) {
    console.error(`[result-emit] failure emit failed for run ${runId}:`, err);
    return { result: null, resultUrl: null, webhook: `failed: ${err?.message || err}` };
  }
}

// Map a thrown pipeline error onto the closed error_code vocabulary. The
// pipeline tags its errors with a `step`; the message patterns come from the
// error strings actually recorded in the run store.
export function classifyError(err) {
  const message = String(err?.message || err || '');
  const step = err?.step || null;

  if (/Not enough time left for visual inspection/i.test(message)) return 'visual_budget_exhausted';
  if (/hit its \d+s limit|Timed out/i.test(message)) return 'function_timeout';
  if (/Died without a terminal write/i.test(message)) return 'abandoned';
  if (/Could not infer card type|Invalid cardType/i.test(message)) return 'card_type_indeterminate';
  if (/download failed|attachment downloads failed/i.test(message)) return 'attachment_download_failed';
  if (/did not output structured results/i.test(message)) return 'agent_output_unparseable';
  if (/spec-check/i.test(message) || step === 'tech_specs') return 'spec_check_failed';
  // The project id gates the public endpoint, so one Rocketlane doesn't know
  // is the caller's to fix, not a checker failure.
  if (/Missing or unresolved projectId|Missing projectId|Rocketlane project lookup failed: (400|404)\b/i.test(message)) {
    return 'missing_project_id';
  }
  if (/No card-art attachment resolved/i.test(message)) return 'no_attachment_resolved';
  if (/No card-art file|No file uploaded/i.test(message)) return 'card_art_missing';
  // Don't attribute an unrecognised failure to a specific stage — a wrong
  // code is worse for a consumer than an explicitly generic one.
  return 'internal_error';
}

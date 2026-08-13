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

export async function emitResult({
  runId, attachmentId = null, results, techJson, cardType,
  projectId, projectName, fileName, pdfUrl, source, trigger,
  detectedProduct = null, callbackUrl = null, deadlineAt = null,
}) {
  try {
    const result = buildResult({
      runId, attachmentId, results, techJson, cardType,
      projectId, projectName, fileName, pdfUrl, source, trigger,
      detectedProduct: detectedProduct ?? techJson?.detected_product ?? null,
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
  if (/Missing or unresolved projectId|Missing projectId/i.test(message)) return 'missing_project_id';
  if (/No card-art attachment resolved/i.test(message)) return 'no_attachment_resolved';
  if (/No card-art file/i.test(message)) return 'card_art_missing';
  // Don't attribute an unrecognised failure to a specific stage — a wrong
  // code is worse for a consumer than an explicitly generic one.
  return 'internal_error';
}

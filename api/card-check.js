import Busboy from 'busboy';
import { waitUntil } from '@vercel/functions';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { inferCardType, extOf } from '../lib/card-type.js';
import { getProjectName } from '../lib/rocketlane.js';
import { createRunLog } from '../lib/run-log.js';
import {
  emitResult, emitFailure, classifyError, oweResult, publishOwedOnTimeout,
} from '../lib/result-emit.js';
import { isAuthenticated, signDelivery } from '../lib/internal-auth.js';

// Two callers share this endpoint, and authentication is what separates them:
//
//   • The browser upload UI (/upload) is unauthenticated. It must still send a
//     projectId — the page refuses to submit without one — and it consumes the
//     SSE progress stream. Nothing about that path changes.
//   • A server-to-server caller presents the shared secret. It may omit
//     projectId (Rain's back office has a tenantId, not a Rocketlane project)
//     and can ask for `?async=1` to get JSON with a runId immediately instead
//     of holding an event stream open for the whole run.
//
// Tying the relaxation to the secret is what keeps it safe: an anonymous caller
// can never reach the projectId-less path, so the UI's guarantees are intact.
// The secret check itself lives in lib/internal-auth.js.

// A caller-supplied correlation id (e.g. a cardArtForm id) stands in for
// projectId as the report's Blob path segment, so it must be a single, boring
// path segment — no separators, no traversal, bounded length.
export function sanitizeReference(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

// ── Multipart parser ─────────────────────────────────────────────────

const VALID_CARD_TYPES = new Set(['virtual', 'physical']);
// Physical submissions may be vector source files (.ai/.eps) or PNG.
const PHYSICAL_EXTS = new Set(['.ai', '.eps', '.png']);

function parseMultipart(request, { requireProjectId = true } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get('content-type') || '';
    const bb = Busboy({ headers: { 'content-type': contentType } });

    const fileChunks = { file: [], backFile: [] };
    const fileNames = { file: '', backFile: '' };
    let projectId = '';
    let cardType = '';
    let slackDelivery = true;
    let reference = '';
    let callbackUrl = '';
    let declaredProduct = '';

    bb.on('file', (fieldname, stream, info) => {
      const key = fieldname === 'backFile' ? 'backFile' : 'file';
      fileNames[key] = info.filename || '';
      stream.on('data', (chunk) => fileChunks[key].push(chunk));
    });

    bb.on('field', (name, value) => {
      if (name === 'projectId') projectId = value;
      else if (name === 'cardType') cardType = (value || '').trim().toLowerCase();
      else if (name === 'slackDelivery') slackDelivery = !/^(false|0|no|off)$/i.test((value || '').trim());
      else if (name === 'reference') reference = value;
      else if (name === 'callbackUrl') callbackUrl = value;
      else if (name === 'declaredProduct') declaredProduct = value;
    });

    bb.on('finish', () => {
      clearTimeout(timeout);

      const fileBuffer = fileChunks.file.length ? Buffer.concat(fileChunks.file) : null;
      const backBuffer = fileChunks.backFile.length ? Buffer.concat(fileChunks.backFile) : null;

      if (!fileBuffer) return reject(new Error('No file uploaded'));
      // Only the unauthenticated (browser) path insists on a projectId; an
      // authenticated caller may identify the run however it likes.
      if (requireProjectId && !projectId) return reject(new Error('Missing projectId'));

      // cardType is now OPTIONAL — we'll infer from the filename if absent.
      // If supplied, it must be a known value.
      if (cardType && !VALID_CARD_TYPES.has(cardType)) {
        return reject(new Error(`Invalid cardType "${cardType}" — must be "virtual" or "physical"`));
      }

      const resolvedCardType = cardType || inferCardType(fileNames.file);
      if (!resolvedCardType) {
        return reject(new Error(
          `Could not infer card type from "${fileNames.file}" — pass cardType=virtual|physical explicitly`
        ));
      }

      if (resolvedCardType === 'virtual') {
        if (backBuffer) {
          return reject(new Error('backFile is only valid for physical submissions'));
        }
      } else {
        const frontExt = extOf(fileNames.file);
        if (!PHYSICAL_EXTS.has(frontExt)) {
          return reject(new Error(`Physical front file must be .ai, .eps, or .png; got ${frontExt || 'unknown'}`));
        }
        if (backBuffer) {
          const backExt = extOf(fileNames.backFile);
          if (!PHYSICAL_EXTS.has(backExt)) {
            return reject(new Error(`Physical back file must be .ai, .eps, or .png; got ${backExt || 'unknown'}`));
          }
        }
      }

      resolve({
        file: fileBuffer,
        fileName: fileNames.file,
        backFile: backBuffer,
        backFileName: fileNames.backFile,
        projectId,
        cardType: resolvedCardType,
        slackDelivery,
        reference: sanitizeReference(reference),
        callbackUrl: (callbackUrl || '').trim() || null,
        // The Visa product the program is provisioned as — lets the agent
        // match the identifier tier. runAnalysis normalizes or drops it.
        declaredProduct: (declaredProduct || '').trim() || null,
      });
    });

    bb.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const timeout = setTimeout(() => {
      reject(Object.assign(new Error('Multipart parse timed out'), { step: 'upload' }));
    }, 30_000);

    const reader = request.body.getReader();
    const writable = bb;

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { writable.end(); break; }
          writable.write(Buffer.from(value));
        }
      } catch (err) { reject(err); }
    })();
  });
}

// ── Analysis flow ────────────────────────────────────────────────────

// Everything after the body is parsed. `send` is the only difference between
// the two modes: the streaming path pushes SSE frames to a live client, the
// async path records progress on the run log alone.
async function processSubmission({ parsed, runLog, deadlineAt, send, source }) {
  const {
    file, fileName, backFile, backFileName,
    projectId, cardType, slackDelivery, reference, callbackUrl, declaredProduct,
  } = parsed;

  const trigger = {
    endpoint: '/api/card-check',
    ...(reference ? { reference } : {}),
  };
  // From here the caller is waiting on a result, even if the run is killed.
  oweResult({ runId: runLog.runId, cardType, projectId: projectId || null, fileName, source, trigger, callbackUrl });

  try {
    let projectName = null;
    if (projectId) {
      send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
      projectName = await getProjectName(projectId);
      send('progress', { step: 'rocketlane', message: `Project: ${projectName}`, status: 'done' });
      runLog.set({ projectName });
    }

    const {
      pdfBuffer, status, summary, results, techJson, cardType: resolvedCardType,
      declaredProduct: resolvedProduct,
    } = await runAnalysis({
      file,
      fileName,
      backFile,
      backFileName,
      cardType,
      declaredProduct,
      onProgress: send,
      deadlineAt,
    });

    send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
    // Without a projectId the report still needs a stable path segment; the
    // caller's reference is the natural one, and 'external' is the last resort.
    const { pdfUrl } = await storeReport({
      pdfBuffer,
      projectId: projectId || reference || 'external',
    });
    send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });

    const emitted = await emitResult({
      runId: runLog.runId,
      results, techJson,
      cardType: resolvedCardType,
      projectId: projectId || null,
      projectName, fileName, pdfUrl,
      source,
      trigger,
      declaredProduct: resolvedProduct,
      callbackUrl,
      deadlineAt,
    });

    send('complete', {
      status,
      summary,
      cardType,
      pdfUrl,
      // The manual/playground path is where drift shows up first, so the
      // structured outcome and its result URL are surfaced to the client.
      runId: runLog.runId,
      outcome: emitted.outcome,
      resultUrl: emitted.resultUrl,
      // The full structured result (lib/result-schema.js), so the browser can
      // render per-check verdicts and markers without the secret-gated
      // /api/result endpoint. Null when result emission failed — the client
      // falls back to the status/summary rendering.
      result: emitted.result,
      // The browser hands this back to /api/card-deliver, which posts only a
      // delivery signed here (lib/internal-auth.js). Unsigned when no secret
      // is configured, and card-deliver refuses it.
      delivery: (() => {
        const delivery = { runId: runLog.runId, projectId, projectName, pdfUrl, status, summary, cardType, slackDelivery };
        return signDelivery(delivery) ?? delivery;
      })(),
    });
    runLog.addResult({
      filename: fileName,
      cardType,
      status,
      summary,
      pdfUrl,
      outcome: emitted.outcome,
      resultUrl: emitted.resultUrl,
      webhook: emitted.webhook,
      // Slack delivery is a separate client-triggered call (/api/card-deliver).
      delivery: { slack: 'client-triggered' },
    });
    await runLog.finish();
  } catch (err) {
    // `code` is the closed error vocabulary, so a caller can branch without
    // parsing the message.
    const errorCode = classifyError(err);
    send('error', { code: errorCode, message: err.message || 'An unexpected error occurred', step: err.step });
    await emitFailure({
      runId: runLog.runId,
      errorCode,
      message: String(err?.message || err),
      step: err?.step || null,
      source,
      trigger,
      callbackUrl,
      deadlineAt,
    });
    await runLog.fail(err);
  }
}

// ── Mock mode ────────────────────────────────────────────────────────
//
// CARD_CHECK_MOCK=1 (set only in a local .env.local, never in prod) replays a
// canned event script so UI work doesn't burn a real Claude run. The multipart
// body still goes through the real parser, so client-side validation and the
// 400 paths behave exactly as in production. A filename containing "fail"
// yields the requires-changes outcome; anything else passes. The delivery
// payload pins slackDelivery: false, which makes deliverReport a no-op.

async function mockResponse(request) {
  let parsed;
  try {
    parsed = await parseMultipart(request, { requireProjectId: false });
  } catch (err) {
    return new Response(String(err?.message || err), { status: 400 });
  }

  // Filename picks the scenario: "fail" → requires_changes, "notes" →
  // approved_with_notes, anything else → approved.
  const failing = /fail/i.test(parsed.fileName || '');
  const withNotes = !failing && /note/i.test(parsed.fileName || '');
  const mockOutcome = failing ? 'requires_changes' : withNotes ? 'approved_with_notes' : 'approved';
  const status = failing ? 'fail' : 'pass';
  const summary = failing
    ? 'Mock run: the network logo sits inside the quiet zone and the contrast ratio on the cardholder name falls below the minimum.'
    : withNotes
      ? 'Mock run: approved, with minor gradient banding worth a look before print.'
      : 'Mock run: artwork meets all checked requirements.';
  const pdfUrl = 'https://example.com/mock-card-art-report.pdf';

  const encoder = new TextEncoder();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* client gone */ }
      };

      send('progress', { step: 'upload', message: 'File received', status: 'done' });
      await sleep(300);
      if (parsed.projectId) {
        send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
        await sleep(500);
        send('progress', { step: 'rocketlane', message: 'Project: Mock Project', status: 'done' });
      }
      send('progress', { step: 'analysis', message: 'Analyzing card art...', status: 'pending' });
      await sleep(400);
      send('agent_delta', { text: 'Reviewing the artwork against the compliance checklist. ' });
      send('agent_tool', { tool: 'Read', command: 'card-art.png' });
      await sleep(600);
      send('agent_delta', { text: 'Checking network logo placement, quiet zone, and contrast ratios...\n' });
      await sleep(600);
      send('progress', { step: 'analysis', message: 'Analysis complete', status: 'done' });
      send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });
      await sleep(200);
      // Real virtual catalog ids, so the result renders exactly as a live one
      // would — severities, reason-code links to /reference, and markers.
      const issuerLogoWarning = { id: 'issuer_logo_present', name: 'Issuer logo present', category: 'required_elements', severity: 'advisory', status: 'warning', reason_code: 'issuer_logo_absent', notes: 'No issuer logo found on the art.' };
      const mockChecks = failing
        ? [
            { id: 'visa_brand_mark_position', name: 'Visa Brand Mark position (upper-left/upper-right only)', category: 'brand_mark', severity: 'blocker', status: 'fail', reason_code: 'position_lower_edge', notes: 'The Visa Brand Mark is in the lower-right corner.', marker: { x: 0.84, y: 0.82 } },
            { id: 'lower_left_area_clear', name: 'Lower-left area clear', category: 'layout', severity: 'blocker', status: 'fail', reason_code: 'pan_zone_obstructed', notes: 'A partner logo sits in the lower-left personalization zone.', marker: { x: 0.18, y: 0.78 } },
            { id: 'contactless_indicator', name: 'Contactless indicator correct (if present)', category: 'required_elements', severity: 'required', status: 'warning', reason_code: 'contactless_indicator_incorrect', notes: 'The contactless symbol looks redrawn.', marker: { x: 0.9, y: 0.45 } },
            issuerLogoWarning,
            { id: 'visa_brand_mark_margin', name: 'Visa Brand Mark margin (56px from edges)', category: 'brand_mark', severity: 'blocker', status: 'pass', reason_code: null, notes: 'Measured 56px from the top and right edges.' },
            { id: 'no_emv_chip', name: 'No EMV chip graphic', category: 'prohibited', severity: 'blocker', status: 'pass', reason_code: null, notes: null },
            { id: 'product_identifier', name: 'Product identifier present and placed', category: 'product_identifier', severity: 'blocker', status: 'unverified', reason_code: null, notes: 'Not reported by the analysis.' },
          ]
        : [
            ...(withNotes ? [issuerLogoWarning] : []),
            { id: 'visa_brand_mark_position', name: 'Visa Brand Mark position (upper-left/upper-right only)', category: 'brand_mark', severity: 'blocker', status: 'pass', reason_code: null, notes: null },
            { id: 'visa_brand_mark_margin', name: 'Visa Brand Mark margin (56px from edges)', category: 'brand_mark', severity: 'blocker', status: 'pass', reason_code: null, notes: 'Measured 56px from the top and right edges.' },
            { id: 'lower_left_area_clear', name: 'Lower-left area clear', category: 'layout', severity: 'blocker', status: 'pass', reason_code: null, notes: null },
            { id: 'no_emv_chip', name: 'No EMV chip graphic', category: 'prohibited', severity: 'blocker', status: 'pass', reason_code: null, notes: null },
            { id: 'product_identifier', name: 'Product identifier present and placed', category: 'product_identifier', severity: 'blocker', status: 'unverified', reason_code: null, notes: 'Not reported by the analysis.' },
          ];
      const mockResult = {
        schema_version: '1.0',
        run_id: 'mock-run',
        card_type: parsed.cardType,
        generated_at: new Date().toISOString(),
        outcome: mockOutcome,
        status,
        summary,
        project: { id: parsed.projectId || null, name: 'Mock Project' },
        submission: { file_name: parsed.fileName },
        report: { pdf_url: pdfUrl },
        counts: mockChecks.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {}),
        blocking_failures: mockChecks.filter((c) => c.status === 'fail' && c.severity === 'blocker').map((c) => c.id),
        checks: mockChecks,
        tech_checks: [
          { id: 'dimensions', status: 'pass', actual: '1536x969', required: '1536x969', note: null },
          { id: 'mark_position', status: failing ? 'fail' : 'pass', actual: failing ? 'lower-right' : 'upper-right', required: 'upper-left or upper-right corner', note: null },
        ],
        colors: {
          background: { rgb: [40, 40, 60], hex: '#28283C' },
          primary: { rgb: [255, 47, 182], hex: '#FF2FB6' },
        },
        unmapped_checks: [],
      };
      send('complete', {
        status,
        summary,
        cardType: parsed.cardType,
        pdfUrl,
        runId: 'mock-run',
        outcome: mockOutcome,
        resultUrl: null,
        result: mockResult,
        delivery: {
          projectId: parsed.projectId || 'mock-project',
          projectName: 'Mock Project',
          pdfUrl,
          status,
          summary,
          cardType: parsed.cardType,
          slackDelivery: false,
        },
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── Main handler ─────────────────────────────────────────────────────

export async function POST(request) {
  // Vercel kills the function at maxDuration (300s). Give the pipeline a
  // slightly earlier deadline so it can degrade (skip the annotated-PDF turn,
  // fail fast with a real error) instead of dying mid-step with no output.
  const deadlineAt = Date.now() + 280_000;

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response('Bad request: expected multipart/form-data', { status: 400 });
  }

  if (/^(1|true|yes)$/i.test(process.env.CARD_CHECK_MOCK || '')) {
    return mockResponse(request);
  }

  const authenticated = isAuthenticated(request);
  const url = new URL(request.url);
  // Async mode is for server-to-server callers only: an anonymous request can
  // never spawn background work it isn't holding a connection for.
  const asyncMode = authenticated && /^(1|true|yes)$/i.test(url.searchParams.get('async') || '');
  const source = authenticated ? 'api' : 'upload';

  // Record the run for the /admin dashboard. Progress events mirror the SSE
  // stream; only 'progress' events are persisted (agent deltas are too chatty).
  const runLog = createRunLog({
    source,
    trigger: {
      endpoint: '/api/card-check',
      description: authenticated ? 'Server-to-server upload' : 'Manual upload via /upload',
      userAgent: request.headers.get('user-agent') || undefined,
    },
  });
  // Keep in sync with config.maxDuration below.
  runLog.armWatchdog(300_000, { onTimeout: publishOwedOnTimeout(runLog.runId) });

  // ── Async mode: parse, acknowledge, analyze in the background ──────
  if (asyncMode) {
    let parsed;
    try {
      parsed = await parseMultipart(request, { requireProjectId: false });
    } catch (err) {
      await runLog.fail(err);
      return Response.json(
        { error: String(err?.message || err), runId: runLog.runId },
        { status: 400 },
      );
    }

    runLog.set({
      projectId: parsed.projectId || undefined,
      cardType: parsed.cardType,
      file: parsed.fileName,
      ...(parsed.reference ? { reference: parsed.reference } : {}),
      ...(parsed.backFileName ? { backFile: parsed.backFileName } : {}),
    });

    // No client is listening, so progress goes to the run log only. The abort
    // listener the streaming path installs is deliberately absent here: the
    // caller disconnects the moment it has the runId, and that is not an
    // abandoned run.
    const send = (event, data) => {
      if (event === 'progress') runLog.event(data.step, data.message, data.status);
    };

    waitUntil(processSubmission({ parsed, runLog, deadlineAt, send, source }));

    return Response.json({
      ok: true,
      queued: true,
      runId: runLog.runId,
      projectId: parsed.projectId || null,
      reference: parsed.reference || null,
      cardType: parsed.cardType,
    });
  }

  // ── Streaming mode: unchanged behavior for the browser UI ──────────
  request.signal?.addEventListener('abort', () => {
    runLog.abandon('Client disconnected before the run finished');
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        // enqueue throws once the client has cancelled the stream — the run
        // log must still get its terminal write, so never let that propagate.
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* client gone; keep the pipeline + run log going */ }
        if (event === 'progress') runLog.event(data.step, data.message, data.status);
      };

      try {
        send('progress', { step: 'upload', message: 'Receiving file...', status: 'pending' });

        const parsed = await parseMultipart(request, { requireProjectId: !authenticated });
        send('progress', { step: 'upload', message: 'File received', status: 'done' });
        runLog.set({
          projectId: parsed.projectId,
          cardType: parsed.cardType,
          file: parsed.fileName,
          ...(parsed.reference ? { reference: parsed.reference } : {}),
          ...(parsed.backFileName ? { backFile: parsed.backFileName } : {}),
        });

        await processSubmission({ parsed, runLog, deadlineAt, send, source });
      } catch (err) {
        // Only a parse failure reaches here — processSubmission handles its own.
        const errorCode = classifyError(err);
        send('error', { code: errorCode, message: err.message || 'An unexpected error occurred', step: err.step });
        await emitFailure({
          runId: runLog.runId,
          errorCode,
          message: String(err?.message || err),
          step: err?.step || null,
          source,
          trigger: { endpoint: '/api/card-check' },
          deadlineAt,
        });
        await runLog.fail(err);
      } finally {
        try { controller.close(); } catch { /* already closed/cancelled */ }
      }
    },
    cancel() {
      runLog.abandon('Client disconnected before the run finished');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export const config = {
  maxDuration: 300,
};

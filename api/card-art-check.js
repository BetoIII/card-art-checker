import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { deliverReport } from '../lib/delivery.js';
import { inferCardType } from '../lib/card-type.js';
import { getProjectName, downloadAttachment, resolveLatestSubmission } from '../lib/rocketlane.js';
import { identifySlackChannel } from '../lib/slack-identify.js';
import { getImageSize } from '../lib/image-size.js';
import { createRunLog } from '../lib/run-log.js';

// Card-art check, keyed on a Rocketlane projectId. The caller is a Rocketlane
// "Form completed" HTTP automation on the custom-card-request form. Its payload
// carries projectId and a few dropdown answers, but NOT the file-upload
// answers — so there are no attachment IDs to scan for. projectId is the one
// thing we can rely on (from body.projectId or scraped off the raw text).
//
// Stages, in order, before any analysis or delivery runs:
//   Stage 1 — resolve the attachment ID(s) for this submission. Explicit IDs in
//             the payload/query win (manual curl / future richer webhook);
//             otherwise we resolve from Rocketlane by projectId — the newest
//             cluster of uploads on the project's "Custom Card Request" task is
//             this submission (see resolveLatestSubmission), typically the card
//             art plus a logo/icon.
//   Stage 2 — download each attachment's bytes from Rocketlane
//             (GET /api/v1/attachments/{id}/download).
//   Stage 3 — when we auto-resolved a multi-file submission, pick the card art
//             by image dimensions (it's 1536-wide; the logo/icon is tiny) and
//             analyze only that one. Neither upload order nor byte size is
//             reliable for this — pixel area is.
// The download stage is awaited synchronously so the HTTP response reflects
// whether it succeeded. Only once bytes are in hand do we spawn the
// (slow) analyze → store → deliver flow in the background.

function secretsMatch(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const looksLikeId = (v) => v != null && /^\d+$/.test(String(v).trim());

// Rocketlane wires cardType to the "card material" form answer, which is
// free-ish text ("Plastic", "Metal", "Virtual card", …) — normalize it to the
// virtual/physical override inferCardType expects, or drop it entirely so the
// filename extension decides. Never let an odd form answer abort the analysis.
function normalizeCardType(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes('virtual')) return 'virtual';
  if (s.includes('physical') || s.includes('plastic') || s.includes('metal')) return 'physical';
  return undefined;
}

// Walk an arbitrary JSON value and hand every attachment-id-looking value to
// `push`. Rocketlane's native form response can carry the card-art field as a
// structured attachments/files array of objects ({ attachmentId | id, ... })
// rather than as HTML anchors, so we scan for both key-named ids and the ids
// nested inside attachment/file objects. Depth-first; order preserved.
function collectAttachmentIdsFromJson(node, push) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectAttachmentIdsFromJson(item, push);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^attachment_?id$/i.test(k)) push(v);
    if (/^(attachments?|files?)$/i.test(k)) {
      const items = Array.isArray(v) ? v : [v];
      for (const it of items) {
        if (it && typeof it === 'object') push(it.attachmentId ?? it.attachment_id ?? it.id);
      }
    }
    collectAttachmentIdsFromJson(v, push);
  }
}

// Pull every attachment ID out of the submission. The card-art field value can
// arrive two ways in a Rocketlane form response: as HTML anchors carrying
// data-attachment-id (rich-text/link fields) or as structured attachment/file
// objects (file-upload fields). A single field can hold multiple files, so we
// gather from every source, dedupe, and preserve order. The anchor pattern is
// lenient about quoting so it matches whether the anchor is unescaped
// (data-attachment-id="123"), JSON-escaped inside a string
// (data-attachment-id=\"123\"), or bare (data-attachment-id=123).
function extractAttachmentIds(rawBody, body, ...extra) {
  const ids = [];
  const seen = new Set();
  const push = (v) => {
    if (looksLikeId(v)) {
      const id = String(v).trim();
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  };
  const re = /data-attachment-id\s*=\s*\\?["']?(\d+)/gi;
  let m;
  while ((m = re.exec(rawBody || '')) !== null) push(m[1]);
  // Structured attachment/file objects anywhere in the parsed payload.
  if (body) collectAttachmentIdsFromJson(body, push);
  // Explicit ids (query string / JSON field) let a manual curl or legacy
  // caller still target a specific attachment.
  for (const v of extra) push(v);
  return ids;
}

// Find a Rocketlane projectId anywhere in a parsed form-response payload.
// Rocketlane can't reliably substitute a custom URL/body parameter, so it just
// POSTs its native form response and we dig the projectId out of it. We prefer
// an explicitly project-id-named key, then a nested `project` object's own id,
// then recurse. Keying on the field *name* (not just "a number") keeps us from
// grabbing an unrelated id.
function findProjectIdInJson(node) {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProjectIdInJson(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^project_?id$/i.test(k) && looksLikeId(v)) return String(v).trim();
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^project$/i.test(k) && v && typeof v === 'object') {
      const id = v.projectId ?? v.project_id ?? v.id;
      if (looksLikeId(id)) return String(id).trim();
    }
  }
  for (const v of Object.values(node)) {
    const found = findProjectIdInJson(v);
    if (found) return found;
  }
  return undefined;
}

// Last-resort projectId scrape straight off the raw text — catches an embedded
// project URL/path segment (.../projects/12345) or a stringified id in a shape
// the parsed-JSON walk didn't reach.
function projectIdFromRawBody(rawBody) {
  const patterns = [
    /"project_?id"\s*:\s*\\?"?(\d+)/i,
    /\/projects?\/(\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(rawBody || '');
    if (m) return m[1];
  }
  return undefined;
}

// From a submission's downloaded files ({ attachmentId, buffer, filename }),
// pick the card art. The card-art design is large (form spec: 1536-wide) and
// the logo/icon is small, so we choose the greatest pixel area. Byte size is a
// last-resort tiebreak for files whose dimensions we can't read (e.g. vector
// .ai/.eps/.pdf), where the design is still typically the heavier file.
function pickCardArtByDimensions(files) {
  const scored = files.map((f) => {
    const size = getImageSize(f.buffer);
    return { f, area: size ? size.width * size.height : 0, bytes: f.buffer.length };
  });
  scored.sort((a, b) => b.area - a.area || b.bytes - a.bytes);
  return scored[0].f;
}

// Analyze one already-downloaded attachment and deliver its report. Runs in the
// background (waitUntil) after the download stage has confirmed the bytes exist.
// Returns true on success so the caller can settle the run log's final status.
async function analyzeAndDeliver({ projectId, projectName, attachmentId, buffer, filename, cardTypeOverride, channelPromise, runLog }) {
  try {
    const cardType = inferCardType(filename, cardTypeOverride);
    if (!cardType) {
      console.error(`[card-art-check] could not infer card type for ${filename} (attachment ${attachmentId}) — aborting`);
      runLog?.addResult({ attachmentId, filename, error: `Could not infer card type for "${filename}"` });
      return false;
    }

    const { pdfBuffer, status, summary } = await runAnalysis({
      file: buffer,
      fileName: filename,
      cardType,
      onProgress: (event, data) => {
        if (event === 'progress') {
          console.log(`[card-art-check] ${data.step}: ${data.message} (${data.status})`);
          runLog?.event(data.step, data.message, data.status);
        }
      },
    });

    const { pdfUrl } = await storeReport({ pdfBuffer, projectId });
    console.log(`[card-art-check] pdfUrl=${pdfUrl} attachment=${attachmentId} project=${projectId}`);

    const delivery = await deliverReport({
      projectId,
      projectName,
      pdfUrl,
      status,
      summary,
      cardType,
      channelPromise,
      runLog,
    });
    console.log(`[card-art-check] delivered attachment ${attachmentId}:`, delivery);
    runLog?.addResult({ attachmentId, filename, cardType, status, summary, pdfUrl, delivery });
    return true;
  } catch (err) {
    console.error(`[card-art-check] analyzeAndDeliver error (attachment ${attachmentId}, project ${projectId}):`, err);
    runLog?.addResult({ attachmentId, filename, error: String(err?.message || err) });
    return false;
  }
}

export async function POST(request) {
  const expected = process.env.ROCKETLANE_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[card-art-check] ROCKETLANE_WEBHOOK_SECRET is not set — refusing to process');
    return new Response('Server misconfigured', { status: 500 });
  }
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const xHeader = request.headers.get('x-webhook-secret') || '';
  if (!secretsMatch(bearer, expected) && !secretsMatch(xHeader, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Authenticated request — record it as a run for the /admin dashboard.
  // Everything past this point (including 400s and skips) is a run.
  const runLog = createRunLog({
    source: 'rocketlane',
    trigger: {
      endpoint: '/api/card-art-check',
      description: 'Rocketlane form-completed webhook',
      userAgent: request.headers.get('user-agent') || undefined,
    },
  });
  runLog.armWatchdog(300_000); // keep in sync with config.maxDuration below

  // Read the raw body once: Stage 1 regexes attachment IDs out of it, and we
  // also JSON-parse it for projectId when the query string didn't carry one.
  const rawBody = await request.text();

  const url = new URL(request.url);
  // Query string wins for projectId — Rocketlane's URL-field smart-fill
  // substitution is more reliable than its JSON-body substitution.
  const qsProjectId = url.searchParams.get('projectId');
  const qsAttachmentId = url.searchParams.get('attachmentId');
  const qsCardType = url.searchParams.get('cardType');

  let body = null;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Non-JSON (or empty) body is fine — projectId may be in the URL, and
      // the attachment-id regex runs over the raw text regardless of format.
    }
  }

  const pickId = (...vals) => {
    const v = vals.find(looksLikeId);
    return v == null ? undefined : String(v).trim();
  };
  // Resolution order, most-explicit first:
  //   1. ?projectId= query param (manual curl / legacy caller)
  //   2. any project-id-named field anywhere in the parsed form response
  //   3. a project URL/id scraped off the raw body text
  const projectId =
    pickId(qsProjectId, body?.projectId) ??
    findProjectIdInJson(body) ??
    projectIdFromRawBody(rawBody);
  const cardTypeOverride = normalizeCardType(qsCardType) ?? normalizeCardType(body?.cardType);

  if (!looksLikeId(projectId)) {
    console.warn('[card-art-check] 400 projectId missing or unresolved — qs:', JSON.stringify({ qsProjectId }), 'body:', rawBody.slice(0, 2000));
    await runLog.fail('Missing or unresolved projectId');
    return Response.json({ error: 'Missing or unresolved projectId' }, { status: 400 });
  }
  runLog.set({ projectId, cardTypeOverride });

  // ── Stage 1: resolve attachment ID(s) ──────────────────────────────
  // First honor any explicit attachment IDs carried in the payload/query (a
  // manual curl or a future richer webhook) — those are analyzed as-is. The
  // Rocketlane "Form completed" webhook, however, does NOT include file-upload
  // answers, so normally nothing is found here and we resolve the submission's
  // files from Rocketlane by projectId (see resolveLatestSubmission). When we
  // auto-resolve, `pickCardArtByDimensions` runs after download (Stage 3) to
  // isolate the card art from the logo/icon.
  let attachmentIds = extractAttachmentIds(rawBody, body, qsAttachmentId, body?.attachmentId);
  let autoResolved = false;
  if (attachmentIds.length === 0) {
    try {
      const resolved = await resolveLatestSubmission(projectId);
      if (resolved) {
        attachmentIds = resolved.submission.map((f) => f.attachmentId);
        autoResolved = true;
        runLog.set({
          attachmentResolution: {
            mode: 'auto-resolved',
            taskId: resolved.taskId,
            files: resolved.submission.map((f) => ({ attachmentId: f.attachmentId, filename: f.filename })),
          },
        });
        console.log(
          `[card-art-check] project=${projectId} resolved latest submission from task ${resolved.taskId}: ` +
          `${resolved.submission.length} file(s): ${resolved.submission.map((f) => `${f.attachmentId}:${f.filename}`).join(', ')}`
        );
      }
    } catch (err) {
      console.error(`[card-art-check] resolveLatestSubmission failed for project ${projectId}:`, err);
      runLog.event('resolve', `resolveLatestSubmission failed: ${String(err?.message || err)}`, 'error');
    }
  } else {
    runLog.set({ attachmentResolution: { mode: 'explicit', ids: attachmentIds } });
  }
  if (attachmentIds.length === 0) {
    // Nothing to analyze (no card-art task/upload found). Acknowledge with 200
    // so Rocketlane doesn't retry/error, and stop here.
    console.warn(`[card-art-check] 200 no card-art attachment resolved for project ${projectId} — skipping analysis. body:`, rawBody.slice(0, 2000));
    await runLog.skip('No card-art attachment resolved');
    return Response.json({ ok: true, queued: false, projectId, reason: 'No card-art attachment resolved' });
  }
  console.log(`[card-art-check] project=${projectId} attachments=[${attachmentIds.join(', ')}]`);

  // ── Stage 2: download each attachment's bytes (synchronous gate) ────
  const downloaded = [];
  const failed = [];
  for (const attachmentId of attachmentIds) {
    try {
      const { buffer, filename } = await downloadAttachment(attachmentId);
      downloaded.push({ attachmentId, buffer, filename });
      console.log(`[card-art-check] downloaded attachment ${attachmentId} → "${filename}" (${buffer.length} bytes)`);
    } catch (err) {
      failed.push({ attachmentId, error: String(err?.message || err) });
      console.error(`[card-art-check] download failed for attachment ${attachmentId} (project ${projectId}):`, err);
    }
  }

  runLog.set({
    downloads: [
      ...downloaded.map((d) => ({ attachmentId: d.attachmentId, filename: d.filename, bytes: d.buffer.length, ok: true })),
      ...failed.map((f) => ({ attachmentId: f.attachmentId, ok: false, error: f.error })),
    ],
  });

  // Nothing downloaded → surface the failure to Rocketlane; don't start any
  // analysis or delivery.
  if (downloaded.length === 0) {
    await runLog.fail('All attachment downloads failed');
    return Response.json(
      { error: 'All attachment downloads failed', projectId, failed },
      { status: 502 }
    );
  }

  // ── Stage 3: isolate the card art (auto-resolved multi-file only) ───
  // A custom-card-request submission carries the card art plus a logo/icon. The
  // card art is the design (1536-wide); the logo/icon is tiny. Pick by pixel
  // area, which cleanly separates them regardless of upload order or byte size.
  // Explicit payload/query IDs are never filtered — those are analyzed as given.
  let toAnalyze = downloaded;
  if (autoResolved && downloaded.length > 1) {
    const cardArt = pickCardArtByDimensions(downloaded);
    const dims = getImageSize(cardArt.buffer);
    console.log(
      `[card-art-check] selected card art ${cardArt.attachmentId} "${cardArt.filename}"` +
      `${dims ? ` (${dims.width}x${dims.height})` : ''} from ${downloaded.length} submission files; ` +
      `skipping ${downloaded.filter((d) => d !== cardArt).map((d) => `${d.attachmentId}:${d.filename}`).join(', ')}`
    );
    runLog.set({
      selected: {
        attachmentId: cardArt.attachmentId,
        filename: cardArt.filename,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      },
    });
    toAnalyze = [cardArt];
  }

  // Project name is needed for delivery (Slack channel resolution), not for the
  // download — fetch it once, but never let a lookup failure block the flow.
  let projectName;
  try {
    projectName = await getProjectName(projectId);
    runLog.set({ projectName });
  } catch (err) {
    console.error(`[card-art-check] getProjectName failed for project ${projectId} — proceeding without name:`, err);
  }

  // Start Slack channel identification now, concurrent with the multi-minute
  // analysis — deliverReport awaits it after the analysis completes.
  // identifySlackChannel never rejects, so the shared promise is safe to hold.
  const channelPromise = identifySlackChannel({ projectId, projectName, runLog });

  // Resolution is done. Only now kick off analyze → store → deliver for each
  // selected attachment, in the background. The run log settles once every
  // attachment's flow finishes — one wrapper promise so waitUntil keeps the
  // function alive through the final blob write.
  waitUntil((async () => {
    const outcomes = await Promise.all(toAnalyze.map(({ attachmentId, buffer, filename }) =>
      analyzeAndDeliver({ projectId, projectName, attachmentId, buffer, filename, cardTypeOverride, channelPromise, runLog })
    ));
    await runLog.finish(outcomes.every(Boolean) ? 'completed' : 'failed');
  })());

  return Response.json({
    ok: true,
    queued: true,
    projectId,
    analyzing: toAnalyze.map((d) => d.attachmentId),
    downloaded: downloaded.map((d) => d.attachmentId),
    failed: failed.map((f) => f.attachmentId),
  });
}

export const config = {
  maxDuration: 300,
};

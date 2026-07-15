// Rocketlane API client. Endpoints split across /api/1.0 and /api/v1 per the
// findings doc — the project route lives under 1.0, while attachment
// downloads live under v1.

const ROCKETLANE_BASE = 'https://api.rocketlane.com';
const V1_0 = `${ROCKETLANE_BASE}/api/1.0`;
const V1 = `${ROCKETLANE_BASE}/api/v1`;

function authHeaders() {
  return { 'api-key': process.env.ROCKETLANE_API_KEY };
}

// ── Project lookup ──────────────────────────────────────────────────

export async function getProjectName(projectId) {
  const res = await fetch(`${V1_0}/projects/${projectId}`, { headers: authHeaders() });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane project lookup failed: ${res.status}`),
      { step: 'rocketlane' }
    );
  }
  const data = await res.json();
  return data.name || data.projectName;
}

// ── Card-art attachment resolution ──────────────────────────────────
// The Rocketlane "Form completed" webhook only carries projectId plus a few
// dropdown answers — file-upload answers are NOT in its smart-fill payload, so
// there are no attachment IDs to scan for. Instead we resolve the card-art file
// from Rocketlane itself.
//
// How the data is laid out: the custom-card-request form drops every
// submission's uploaded files onto a single per-project task named
// "Custom Card Request", appending to that task's `attachments` array over time
// (26 files across 14 submissions on the test project). Rocketlane's public API
// does NOT expose per-response, per-field answers (the form-responses endpoints
// 401/404 for this key), so we can't ask "which file answered the Card Art
// question" directly. We reconstruct it from two facts:
//
//   1. The webhook fires at submit time, so the newest cluster of attachments
//      (files created within seconds of each other) is *this* submission. A
//      submission's files upload seconds apart; separate submissions are
//      minutes-to-days apart — so a time gap cleanly separates them.
//   2. Within one submission, files upload in form-question order. For every
//      branch, the design/Card-Art question precedes the Icon/logo question
//      (Custom Virtual: Card Art is position 2, Icon position 3). So the
//      earliest-created file in the newest cluster is the card art; the later
//      file(s) are the logo/icon we intentionally skip.
//
// (Size is deliberately NOT used to tell them apart — an .ai icon can be larger
// than the .ai card art. Upload order is the reliable signal.)

const V1_TASKS_PAGE_SIZE = 100;
const CARD_ART_TASK_NAME = /custom card request/i;
// Two files of one submission upload within seconds; distinct submissions are
// minutes+ apart. Any inter-file gap larger than this starts a new submission.
const SUBMISSION_GAP_MS = 2 * 60 * 1000;

const isLiveAttachment = (a) =>
  a && a.attachmentId != null && a.isDeleted !== true && String(a.isDeleted) !== 'true';

// Find the per-project task that the card-art form writes its uploads to.
async function findCardArtTaskId(projectId) {
  const res = await fetch(
    `${V1_0}/tasks?projectId.eq=${encodeURIComponent(projectId)}&pageSize=${V1_TASKS_PAGE_SIZE}`,
    { headers: authHeaders() }
  );
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane task list failed (project ${projectId}): ${res.status}`),
      { step: 'rocketlane' }
    );
  }
  const { data = [] } = await res.json();
  const task = data.find((t) => CARD_ART_TASK_NAME.test(t.taskName || ''));
  return task?.taskId;
}

// Fetch a task's live (non-deleted) attachments.
async function getTaskAttachments(taskId) {
  const res = await fetch(`${V1}/tasks/${taskId}`, { headers: authHeaders() });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane task fetch failed (${taskId}): ${res.status}`),
      { step: 'rocketlane' }
    );
  }
  const task = await res.json();
  return (task.attachments || []).filter(isLiveAttachment);
}

// Resolve the card-art attachment for the latest submission on a project.
// Returns { taskId, attachmentId, filename, submission: [...] } or null when
// no card-art task / attachments exist (caller treats null as "nothing to do").
export async function resolveLatestCardArt(projectId) {
  const taskId = await findCardArtTaskId(projectId);
  if (!taskId) return null;

  const attachments = await getTaskAttachments(taskId);
  if (attachments.length === 0) return null;

  // Newest first, then walk back collecting files until a gap marks the end of
  // this submission.
  const byNewest = attachments.slice().sort((a, b) => b.createdAt - a.createdAt);
  const cluster = [byNewest[0]];
  for (let i = 1; i < byNewest.length; i++) {
    const prev = cluster[cluster.length - 1];
    if (prev.createdAt - byNewest[i].createdAt <= SUBMISSION_GAP_MS) {
      cluster.push(byNewest[i]);
    } else {
      break;
    }
  }

  // Earliest-created file in the submission = the card art (design question
  // precedes the icon/logo question in every branch).
  cluster.sort((a, b) => a.createdAt - b.createdAt);
  const cardArt = cluster[0];

  return {
    taskId,
    attachmentId: String(cardArt.attachmentId),
    filename: cardArt.name,
    submission: cluster.map((a) => ({
      attachmentId: String(a.attachmentId),
      filename: a.name,
      createdAt: a.createdAt,
    })),
  };
}

// ── Attachment download ─────────────────────────────────────────────

export async function downloadAttachment(attachmentId) {
  const res = await fetch(`${V1}/attachments/${attachmentId}/download`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane attachment download failed (${attachmentId}): ${res.status}`),
      { step: 'rocketlane' }
    );
  }

  // Prefer x-filename, then content-disposition, then a fallback.
  let filename = res.headers.get('x-filename') || '';
  if (!filename) {
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\s*=\s*"?([^"]+)"?/i.exec(cd);
    if (m) filename = m[1];
  }
  if (!filename) filename = `attachment-${attachmentId}`;

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, filename };
}

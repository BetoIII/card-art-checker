// Rocketlane API client. Endpoints split across /api/1.0 and /api/v1 per the
// findings doc — the project + space routes live under 1.0, while form
// responses and attachments live under v1.

const ROCKETLANE_BASE = 'https://api.rocketlane.com';
const V1_0 = `${ROCKETLANE_BASE}/api/1.0`;
const V1 = `${ROCKETLANE_BASE}/api/v1`;

const CARD_ART_EXTS = new Set(['.png', '.ai', '.eps']);

// Heuristic — skip files that name themselves as icons/logos/marks/badges.
// Proper fix is to map specific Rocketlane questionIds → "card art" so the
// filter is form-aware, but until then the filename is the cheapest signal.
const NON_CARD_NAME = /(?:^|[^A-Za-z])(icon|logo|mark|badge|crest|favicon|symbol)(?=$|[^A-Za-z])/i;

function isLikelyCardArt(filename) {
  if (!filename) return false;
  if (!CARD_ART_EXTS.has(extOf(filename))) return false;
  if (NON_CARD_NAME.test(filename)) return false;
  return true;
}

function extOf(filename) {
  const m = /\.[a-z0-9]+$/i.exec(filename || '');
  return m ? m[0].toLowerCase() : '';
}

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

// ── Form responses ──────────────────────────────────────────────────

export async function listFormResponses(templateId) {
  const res = await fetch(`${V1}/forms/${templateId}/responses`, { headers: authHeaders() });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane form responses lookup failed (template ${templateId}): ${res.status}`),
      { step: 'rocketlane' }
    );
  }
  return res.json();
}

// Walk answerMetaJson and collect every attachment object. answerMetaJson
// shape per findings doc:
//   { "<questionId>": { "type": "ATTACHMENT", "answers": [ {...attachment}, ... ] }, ... }
function extractAttachments(answer) {
  const meta = answer.answerMetaJson;
  if (!meta || typeof meta !== 'object') return [];
  const out = [];
  for (const entry of Object.values(meta)) {
    if (entry?.type !== 'ATTACHMENT') continue;
    const items = Array.isArray(entry.answers) ? entry.answers : [];
    for (const att of items) {
      if (att?.attachmentId) out.push(att);
    }
  }
  return out;
}

// Given a taskId and a list of form template IDs, return every form answer
// hosted on that task with its card-art-relevant attachments unfurled.
//
// Filters:
//   - answer.taskId === taskId (the webhook gives us a single task)
//   - attachments restricted to card-art extensions (.png, .ai, .eps)
//
// Returns: [{ answerId, formInstanceId, projectId, taskId, attachments: [{ attachmentId, name, sizeInBytes }] }]
// Answers with no card-art attachments are omitted entirely.
export async function findAnswersForTask(taskId, templateIds) {
  const numericTaskId = typeof taskId === 'string' ? Number(taskId) : taskId;
  const results = [];

  for (const templateId of templateIds) {
    let payload;
    try {
      payload = await listFormResponses(templateId);
    } catch (err) {
      // One template failure shouldn't tank the rest.
      console.error(`[rocketlane] listFormResponses(${templateId}) failed:`, err.message);
      continue;
    }
    const answers = Array.isArray(payload?.answers) ? payload.answers : [];

    for (const answer of answers) {
      if (answer.taskId !== numericTaskId) continue;

      const allAttachments = extractAttachments(answer);
      const cardArt = allAttachments
        .filter(att => isLikelyCardArt(att.name))
        .map(att => ({
          attachmentId: att.attachmentId,
          name: att.name,
          sizeInBytes: att.sizeInBytes,
        }));

      if (!cardArt.length) continue;

      results.push({
        answerId: answer.answerId,
        formInstanceId: answer.formInstanceId,
        projectId: answer.projectId,
        taskId: answer.taskId,
        templateId,
        attachments: cardArt,
      });
    }
  }

  return results;
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

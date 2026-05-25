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

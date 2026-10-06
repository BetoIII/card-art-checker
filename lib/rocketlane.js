// Rocketlane API client. Only the project lookup is used: it names the
// project for the report and Slack routing, and gates an anonymous upload.

const ROCKETLANE_BASE = 'https://api.rocketlane.com';
const V1_0 = `${ROCKETLANE_BASE}/api/1.0`;

function authHeaders() {
  return { 'api-key': process.env.ROCKETLANE_API_KEY };
}

// ── Project lookup ──────────────────────────────────────────────────

export async function getProject(projectId) {
  const res = await fetch(`${V1_0}/projects/${projectId}`, { headers: authHeaders() });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Rocketlane project lookup failed: ${res.status}`),
      { step: 'rocketlane' }
    );
  }
  const data = await res.json();
  return {
    projectId: String(projectId),
    projectName: data.projectName || data.name,
    createdAt: data.createdAt, // epoch millis
    createdAtIso: data.createdAt ? new Date(data.createdAt).toISOString() : undefined,
  };
}

export async function getProjectName(projectId) {
  return (await getProject(projectId)).projectName;
}

// Every check must name the partner it is for, by a Rocketlane project id, a
// Rain prod tenant id (the UUID Weatherstation shows at /tenants/{id}), or
// both. Partners who never onboarded through Rocketlane only have the latter.
//
// Ids are checked against their shape only — nothing here calls Rocketlane or
// Rain. Both become a Blob path segment, so the patterns are also what keeps
// a caller-supplied value from leaving its segment.
//
// assets/form-engine.js repeats these two patterns for the browser; keep them
// in step.

export const PROJECT_ID_RE = /^\d{1,12}$/;
export const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Throws on a missing pair or a malformed id; otherwise returns the ids
// normalized, with an absent one as null.
export function parsePartnerIds({ projectId, tenantId } = {}) {
  const project = String(projectId ?? '').trim();
  const tenant = String(tenantId ?? '').trim().toLowerCase();

  if (!project && !tenant) throw new Error('Missing projectId or tenantId');
  if (project && !PROJECT_ID_RE.test(project)) {
    throw new Error(`Invalid projectId "${project.slice(0, 64)}" — expected a numeric Rocketlane project id`);
  }
  if (tenant && !TENANT_ID_RE.test(tenant)) {
    throw new Error(`Invalid tenantId "${tenant.slice(0, 64)}" — expected a Rain tenant UUID`);
  }

  return { projectId: project || null, tenantId: tenant || null };
}

// Normalizes a completed analysis into the versioned, closed-enum result
// object that /api/result and the outbound webhook publish.
//
// Everything that reaches the wire passes through here, so this module owns
// two guarantees:
//
//   1. Closed enums. Every `status`, `outcome`, `severity` and `reason_code`
//      on the wire is drawn from lib/check-catalog.js. Anything the agent
//      emits outside that vocabulary is coerced, and the raw value preserved
//      alongside it.
//   2. Nothing is silently dropped. A check name that does not resolve lands
//      in `unmapped_checks[]` with its raw text. That array is also the drift
//      alarm: it should be empty in production, and a non-empty one means the
//      agent has wandered from the catalog.

import {
  getCatalog, getCheck, resolveChecks, isValidReasonCode, TECH_CHECK_IDS,
} from './check-catalog.js';

export const SCHEMA_VERSION = '1.0';

// Physical results are persisted for corpus-building but are NOT a published
// contract yet — no archived physical report exists to validate their enums
// against. This marker keeps them out of the v1 wire contract while still
// accumulating the evidence a v1.1 physical schema would need.
export const INTERNAL_SCHEMA_VERSION = '0-internal';

export function schemaVersionFor(cardType) {
  return cardType === 'physical' ? INTERNAL_SCHEMA_VERSION : SCHEMA_VERSION;
}

// ── Status normalization ────────────────────────────────────────────

const STATUS_ALIASES = new Map([
  ['pass', 'pass'], ['passed', 'pass'], ['ok', 'pass'],
  ['fail', 'fail'], ['failed', 'fail'],
  ['warning', 'warning'], ['warn', 'warning'],
  ['not submitted', 'not_submitted'], ['not_submitted', 'not_submitted'],
  ['n/s', 'not_submitted'],
  ['unverified', 'unverified'], ['n/v', 'unverified'],
  ['estimated', 'estimated'], ['est', 'estimated'], ['est.', 'estimated'],
]);

export function normalizeStatus(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return STATUS_ALIASES.get(key) || 'unverified';
}

// Deterministic tech checks report {passed, borderline}. This is the mapping
// _physical_check_status already uses in scripts/check_technical_specs.py —
// mirrored here so both renderers agree.
export function techCheckStatus(check) {
  if (!check) return 'unverified';
  if (check.borderline) return 'warning';
  if (check.passed === true) return 'pass';
  if (check.passed === false) return 'fail';
  return 'unverified';
}

// ── Outcome ─────────────────────────────────────────────────────────

// The pipeline collapses APPROVED WITH NOTES into 'pass' (lib/pipeline.js),
// which loses the distinction between a clean approval and one carrying
// caveats. `outcome` keeps all three states; `status` stays as-is so every
// existing consumer (/admin, run logs, Slack) is unaffected.
export function normalizeOutcome(rawStatus) {
  const text = String(rawStatus || '').trim().toUpperCase();
  if (!text.startsWith('APPROVED')) return 'requires_changes';
  if (text.includes('REQUIRES')) return 'requires_changes';
  return text.includes('NOTE') ? 'approved_with_notes' : 'approved';
}

export function legacyStatusFor(outcome) {
  return outcome === 'requires_changes' ? 'fail' : 'pass';
}

// ── Check normalization ─────────────────────────────────────────────

function normalizeMarker(entry) {
  const x = Number(entry.marker_x);
  const y = Number(entry.marker_y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const marker = { x, y };
  if (entry.marker_side === 'front' || entry.marker_side === 'back') {
    marker.side = entry.marker_side;
  }
  return marker;
}

function normalizeReasonCode(cardType, checkId, entry, status) {
  if (status !== 'fail' && status !== 'warning') return null;
  const raw = entry.reason_code || entry.reasonCode;
  if (!raw) return 'other';
  const code = String(raw).trim();
  return isValidReasonCode(cardType, checkId, code) ? code : 'other';
}

// Map the agent's visual_checks[] onto catalog checks.
//
// resolveChecks returns an array because the agent sometimes merges several
// canonical checks into one row ("No EMV chip / hologram / magstripe"); such a
// row fans out, with every resulting check carrying the same verdict and notes
// and flagged `merged_from` so a consumer can tell it was not independently
// assessed.
export function normalizeVisualChecks(cardType, visualChecks = []) {
  const checks = [];
  const unmapped = [];
  const seen = new Set();

  for (const entry of visualChecks) {
    if (!entry || typeof entry !== 'object') continue;
    const rawName = entry.name || '';
    const status = normalizeStatus(entry.result);
    const notes = entry.notes ? String(entry.notes) : null;
    const marker = normalizeMarker(entry);

    // The agent is asked to echo `id`; fall back to the display name, which
    // is what every archived report actually carries.
    const ids = resolveChecks(cardType, entry.id || rawName);
    if (!ids.length && rawName) {
      const byName = resolveChecks(cardType, rawName);
      if (byName.length) ids.push(...byName);
    }

    if (!ids.length) {
      unmapped.push({
        name: String(rawName),
        status,
        ...(notes ? { notes } : {}),
        ...(marker ? { marker } : {}),
      });
      continue;
    }

    const merged = ids.length > 1;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = getCheck(cardType, id);
      checks.push({
        id,
        name: meta.name,
        category: meta.category,
        severity: meta.severity,
        status,
        reason_code: normalizeReasonCode(cardType, id, entry, status),
        notes,
        ...(marker ? { marker } : {}),
        ...(merged ? { merged_from: String(rawName) } : {}),
      });
    }
  }

  return { checks, unmapped };
}

// Catalog checks the agent never reported. Recorded explicitly as
// `unverified` rather than left absent, so a consumer can always iterate a
// complete check list and tell "not assessed" apart from "passed".
function addMissingChecks(cardType, checks) {
  const present = new Set(checks.map((c) => c.id));
  return getCatalog(cardType)
    .filter((meta) => !present.has(meta.id))
    .map((meta) => ({
      id: meta.id,
      name: meta.name,
      category: meta.category,
      severity: meta.severity,
      status: 'unverified',
      reason_code: null,
      notes: 'Not reported by the analysis.',
    }));
}

// ── Tech checks ─────────────────────────────────────────────────────

// Virtual tech results are flat ({dimensions: {...}}); physical nest per side
// ({front: {checks: {...}}, back: {...}}). Both flatten to one array whose
// `id` values are the keys check_technical_specs.py already emits.
export function normalizeTechChecks(cardType, techJson) {
  if (!techJson) return [];
  const ids = TECH_CHECK_IDS[cardType] || [];
  const out = [];

  const pushSide = (source, side) => {
    if (!source) return;
    for (const id of ids) {
      const check = source[id];
      if (!check) continue;
      out.push({
        id,
        ...(side ? { side } : {}),
        status: techCheckStatus(check),
        actual: check.actual ?? null,
        required: check.required ?? null,
        note: check.note || null,
        ...(check.borderline ? { borderline: true } : {}),
        // check_bleed_zone carries the measurements behind the #1 rejection
        // reason; they are the difference between "too close" and "how close".
        ...(id === 'bleed_zone' ? bleedZoneDetail(check) : {}),
      });
    }
  };

  if (cardType === 'physical') {
    pushSide(techJson.front?.checks, 'front');
    pushSide(techJson.back?.checks, 'back');
  } else {
    pushSide(techJson.checks || techJson, null);
  }
  return out;
}

function bleedZoneDetail(check) {
  const detail = {};
  for (const key of [
    'mark_detected', 'mark_corner', 'min_distance', 'top_distance', 'right_distance',
    'strict_top_px', 'strict_bottom_px', 'strict_right_px', 'strict_min_px',
    'margin_px', 'measured_from',
  ]) {
    if (check[key] !== undefined) detail[key] = check[key];
  }
  return Object.keys(detail).length ? { measurements: detail } : {};
}

// ── Colors ──────────────────────────────────────────────────────────

function normalizeColors(colors) {
  if (!colors || typeof colors !== 'object') return null;
  const out = {};
  for (const [role, data] of Object.entries(colors)) {
    if (!data?.rgb) continue;
    out[role] = { rgb: data.rgb, hex: data.hex || null };
  }
  return Object.keys(out).length ? out : null;
}

// ── Public builders ─────────────────────────────────────────────────

export function buildResult({
  runId, attachmentId = null, results, techJson, cardType,
  projectId = null, projectName = null, fileName = null, pdfUrl = null,
  source = null, trigger = null, detectedProduct = null,
}) {
  const outcome = normalizeOutcome(results?.status);
  const { checks, unmapped } = normalizeVisualChecks(cardType, results?.visual_checks);
  const allChecks = [...checks, ...addMissingChecks(cardType, checks)];

  const counts = allChecks.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, {});

  const blocking = allChecks
    .filter((c) => c.status === 'fail' && c.severity === 'blocker')
    .map((c) => c.id);

  const techChecks = normalizeTechChecks(cardType, techJson);
  const techBlocking = techChecks
    .filter((c) => c.status === 'fail')
    .map((c) => (c.side ? `${c.side}.${c.id}` : c.id));

  return {
    schema_version: schemaVersionFor(cardType),
    run_id: runId,
    attachment_id: attachmentId,
    card_type: cardType,
    generated_at: new Date().toISOString(),

    outcome,
    status: legacyStatusFor(outcome),
    summary: results?.summary || null,

    project: { id: projectId, name: projectName },
    submission: {
      file_name: fileName,
      ...(detectedProduct ? { detected_product: detectedProduct } : {}),
    },
    trigger: { source, ...(trigger || {}) },
    report: { pdf_url: pdfUrl },

    counts,
    blocking_failures: [...blocking, ...techBlocking],
    checks: allChecks,
    tech_checks: techChecks,
    colors: normalizeColors(results?.colors),
    unmapped_checks: unmapped,
  };
}

// A run that never produced an analysis is still a result the consumer needs.
// `error_code` is the closed vocabulary; `step` is the pipeline stage, and
// together they reconstruct the templated prose the run log records today.
export function buildFailureResult({
  runId, attachmentId = null, cardType = null, errorCode, message = null, step = null,
  projectId = null, projectName = null, fileName = null, source = null, trigger = null,
}) {
  return {
    schema_version: schemaVersionFor(cardType),
    run_id: runId,
    attachment_id: attachmentId,
    card_type: cardType,
    generated_at: new Date().toISOString(),

    outcome: null,
    status: 'error',
    error: { code: errorCode, message, step },

    project: { id: projectId, name: projectName },
    submission: { file_name: fileName },
    trigger: { source, ...(trigger || {}) },
  };
}

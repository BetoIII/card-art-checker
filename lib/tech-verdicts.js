// Deterministic spec checks override the agent where they are conclusive.
//
// The virtual prompt asks the agent to mirror several TECH_SPEC_RESULTS
// entries into visual checks (the 56px placement and corner, mark size, mark color,
// identifier alignment, lockup and clearance, partner-logo border, border
// frame) and to
// return REQUIRES CHANGES when any check fails. This module enforces both
// after the fact, so a measured failure can never ride out on an agent that
// paraphrased it away.
//
// It only ever ESCALATES: a failing tech entry fails its visual check, a
// borderline one lifts a pass to a warning. A passing tech entry never clears
// a visual failure — the agent may see what a measurement cannot (a gradient
// the sampler missed, a redrawn lockup that happens to measure right).

import { TECH_CHECK_IDS } from './check-catalog.js';

// tech check id → the visual check that mirrors it.
const VIRTUAL_MIRRORS = {
  bleed_zone: 'visa_brand_mark_margin',
  mark_position: 'visa_brand_mark_position',
  mark_size: 'visa_brand_mark_size',
  mark_color: 'visa_brand_mark_color',
  identifier_alignment: 'product_identifier',
  lockup_match: 'product_identifier',
  identifier_clearance: 'design_elements_clear_of_identifier',
  issuer_logo_border: 'issuer_logo_within_border',
  border_frame: 'no_physical_card_photography',
};

// Reason code for a mirrored failure when the tech entry does not name one.
const DEFAULT_REASON = {
  bleed_zone: 'margin_below_minimum',
  mark_position: 'position_lower_edge',
  mark_size: 'size_undersized',
  mark_color: 'mark_color_not_permitted',
  identifier_alignment: 'identifier_misaligned',
  lockup_match: 'lockup_not_official_artwork',
  identifier_clearance: 'identifier_obstructed',
  issuer_logo_border: 'issuer_logo_in_bleed_zone',
  border_frame: 'border_frame_present',
};

function techVerdict(check) {
  if (!check) return null;
  if (check.passed === false) return 'fail';
  if (check.borderline) return 'warning';
  return null;
}

const RANK = { pass: 0, warning: 1, fail: 2 };

// Mutates and returns `results` (the parsed RESULTS_JSON block). Returns the
// list of changes made so the caller can log them.
export function applyTechVerdicts(results, techJson, cardType = 'virtual') {
  const changes = [];
  if (cardType !== 'virtual' || !results || !techJson) return changes;
  const tech = techJson.checks || techJson;
  const visual = Array.isArray(results.visual_checks) ? results.visual_checks : [];

  for (const [techId, visualId] of Object.entries(VIRTUAL_MIRRORS)) {
    const verdict = techVerdict(tech[techId]);
    if (!verdict) continue;
    const entry = visual.find((v) => v && v.id === visualId);
    if (!entry) continue;
    const current = String(entry.result || '').trim().toLowerCase();
    if ((RANK[current] ?? -1) >= RANK[verdict]) continue;
    const note = tech[techId].note || tech[techId].actual || '';
    changes.push({ check: visualId, from: current || null, to: verdict, tech: techId });
    entry.result = verdict;
    entry.reason_code = tech[techId].reason_code || DEFAULT_REASON[techId];
    entry.notes = [note, entry.notes].filter(Boolean).join(' | ');
  }

  // Overall status follows the worst check. Only virtual tech ids count —
  // colors and errors ride in the same object.
  const techFailed = TECH_CHECK_IDS.virtual.filter((id) => tech[id]?.passed === false);
  const anyFail = techFailed.length || visual.some((v) => String(v?.result).toLowerCase() === 'fail');
  const anyWarning = visual.some((v) => String(v?.result).toLowerCase() === 'warning');
  const status = String(results.status || '').toUpperCase();
  const approved = status.startsWith('APPROVED') && !status.includes('REQUIRES');

  if (anyFail && approved) {
    changes.push({ status: { from: results.status, to: 'REQUIRES CHANGES' } });
    results.status = 'REQUIRES CHANGES';
    const failing = [
      ...techFailed,
      ...visual.filter((v) => String(v?.result).toLowerCase() === 'fail').map((v) => v.id),
    ];
    results.summary = `Requires changes — failing checks: ${[...new Set(failing)].join(', ')}.` +
      (results.summary ? ` ${results.summary}` : '');
  } else if (!anyFail && anyWarning && approved && !status.includes('NOTE')) {
    changes.push({ status: { from: results.status, to: 'APPROVED WITH NOTES' } });
    results.status = 'APPROVED WITH NOTES';
  }
  return changes;
}

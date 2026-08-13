// Canonical catalog of card-art compliance checks.
//
// This module is the single source of truth for check identity. The visual
// check list the agent is asked to fill in (lib/pipeline.js) is GENERATED from
// this catalog rather than hardcoded alongside it, so a display name and its
// wire ID cannot drift apart — there is only one place either is written.
//
// The split mirrors what already works on the Python side:
// PHYSICAL_CHECK_ORDER / PHYSICAL_CHECK_LABELS in scripts/check_technical_specs.py
// keep snake_case IDs and human labels as separate constants.
//
// Why IDs at all: the agent paraphrases check names. Across 59 archived reports
// a single check appeared as "Visa Brand Mark size", "…size (Option Two: 142px
// height)", "…size (~13.3% height, Option Two)", and a dozen more. Names are a
// display concern; only `id` is the contract.

// ── Closed enums (the wire vocabulary) ──────────────────────────────
//
// check_status adopts STATUS_LABELS from scripts/check_technical_specs.py
// verbatim rather than inventing a parallel vocabulary. `estimated` and
// `unverified` currently only ever come from the deterministic tech layer;
// `not_submitted` is the snake_case wire form of the prompt's "not submitted".

export const CHECK_STATUS = Object.freeze([
  'pass', 'fail', 'warning', 'not_submitted', 'unverified', 'estimated',
]);

export const SEVERITY = Object.freeze(['blocker', 'required', 'advisory']);

export const OUTCOME = Object.freeze([
  'approved', 'approved_with_notes', 'requires_changes',
]);

// From the hand-maintained failure ledger (card_art_eval.csv) — the vocabulary
// the team already uses when triaging a rejection.
export const FAILURE_TYPE = Object.freeze([
  'visa_rejection', 'rain_internal_flag',
  'visa_quiet_zone_violation', 'visa_brand_mark_position',
]);

export const ERROR_CODE = Object.freeze([
  'visual_budget_exhausted', 'function_timeout', 'abandoned',
  'missing_project_id', 'card_type_indeterminate', 'attachment_download_failed',
  'agent_output_unparseable', 'spec_check_failed', 'no_attachment_resolved',
  'card_art_missing', 'unsupported_card_type', 'internal_error',
]);

// Deterministic spec-check IDs. These are already stable — they are the dict
// keys check_technical_specs.py emits — so they pass through unchanged.
export const TECH_CHECK_IDS = Object.freeze({
  virtual: ['dimensions', 'file_format', 'dpi', 'bleed_zone'],
  physical: [
    'file_format', 'trim_size', 'bleed_margin', 'cr80_aspect_ratio',
    'min_resolution', 'bleed_zone', 'magstripe_band', 'color_mode',
    'layers_present',
  ],
});

// ── Virtual catalog (18 checks) ─────────────────────────────────────
//
// `name` is the sentence shown to the agent and printed in the PDF.
// `aliases` are normalized forms observed in real reports that normalization
// alone does not reconcile (word reordering, dropped qualifiers).
// `severity` is the severity WHEN THIS CHECK FAILS.

const VIRTUAL_CHECKS = [
  {
    id: 'visa_brand_mark_present',
    name: 'Visa Brand Mark present',
    category: 'brand_mark',
    severity: 'blocker',
    reason_codes: ['mark_absent'],
  },
  {
    id: 'visa_brand_mark_position',
    name: 'Visa Brand Mark position (upper-left/upper-right only)',
    category: 'brand_mark',
    severity: 'blocker',
    reason_codes: ['position_lower_edge', 'position_wrong_corner', 'mark_absent'],
  },
  {
    id: 'visa_brand_mark_size',
    name: 'Visa Brand Mark size',
    category: 'brand_mark',
    severity: 'blocker',
    reason_codes: ['size_undersized', 'size_oversized', 'size_unverifiable'],
  },
  {
    id: 'visa_brand_mark_margin',
    name: 'Visa Brand Mark margin (56px from edges)',
    // "Visa Brand Mark 56px margin (#1 rejection reason)" — word-reordered.
    aliases: ['visa brand mark 56px margin', 'visa brand mark margin 56px'],
    category: 'brand_mark',
    severity: 'blocker',
    reason_codes: ['margin_below_minimum', 'margin_borderline', 'margin_unverifiable'],
  },
  {
    id: 'visa_brand_mark_contrast',
    name: 'Visa Brand Mark contrast against background',
    // Observed: bare "Visa Brand Mark contrast", and the identifier-scoped
    // "Product identifier (Signature) contrast" — both are this check.
    aliases: [
      'visa brand mark contrast',
      'product identifier contrast',
      'visa brand mark and product identifier contrast',
    ],
    category: 'brand_mark',
    severity: 'blocker',
    reason_codes: ['contrast_insufficient_wordmark', 'contrast_insufficient_identifier'],
  },
  {
    id: 'product_identifier',
    name: 'Product identifier present and placed',
    aliases: [
      'product identifier present',
      'product identifier',
      'visa product identifier',
      'product identifier present and placed correctly',
    ],
    category: 'product_identifier',
    severity: 'blocker',
    reason_codes: [
      'identifier_absent', 'identifier_wrong_corner', 'identifier_separated_from_mark',
      'identifier_in_pan_zone', 'identifier_casing', 'identifier_tier_mismatch',
    ],
  },
  {
    id: 'issuer_logo_present',
    name: 'Issuer logo present',
    aliases: ['issuer logo'],
    category: 'required_elements',
    severity: 'required',
    reason_codes: ['issuer_logo_absent'],
  },
  {
    id: 'no_emv_chip',
    name: 'No EMV chip graphic',
    aliases: ['no emv chip'],
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_hologram',
    name: 'No hologram imagery',
    aliases: ['no hologram'],
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_magnetic_stripe',
    name: 'No magnetic stripe graphic',
    aliases: ['no magnetic stripe', 'no magstripe', 'no magstripe graphic'],
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_cardholder_name',
    name: 'No cardholder name',
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_pan',
    name: 'No PAN / card number',
    aliases: ['no pan', 'no full pan / card number', 'no full pan', 'no card number'],
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_expiry_date',
    name: 'No expiry date',
    aliases: ['no expiry', 'no expiration date'],
    category: 'prohibited',
    severity: 'blocker',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'no_physical_card_photography',
    name: 'No physical card photography',
    aliases: ['no physical card photography or 3d effects', 'no 3d effects'],
    category: 'prohibited',
    severity: 'required',
    reason_codes: ['prohibited_element_present'],
  },
  {
    id: 'lower_left_area_clear',
    name: 'Lower-left area clear',
    aliases: ['lower-left area clear for pan', 'lower left area clear', 'lower-left zone clear'],
    category: 'layout',
    severity: 'blocker',
    reason_codes: ['pan_zone_obstructed', 'pan_zone_legibility_risk'],
  },
  {
    id: 'design_elements_clear_of_identifier',
    name: 'Design elements clear of product identifier',
    aliases: ['design elements clear of identifier'],
    category: 'layout',
    severity: 'blocker',
    reason_codes: ['identifier_obstructed'],
  },
  {
    id: 'landscape_orientation',
    name: 'Landscape orientation',
    aliases: ['horizontal orientation', 'landscape (horizontal) orientation'],
    category: 'layout',
    severity: 'blocker',
    reason_codes: ['orientation_not_landscape'],
  },
  {
    id: 'full_color',
    name: 'Full color (not grayscale)',
    aliases: ['full colour'],
    category: 'layout',
    severity: 'required',
    reason_codes: ['grayscale_or_monochrome'],
  },
];

// ── Physical catalog (18 checks) ────────────────────────────────────
//
// Present so the prompt generator and normalizer work identically for both
// card types, but NOT part of the v1 wire contract: no physical report
// artifact exists to validate these against (every archived report uses the
// virtual schema). Physical results are persisted internally as
// schema_version "0-internal" to build that corpus. See lib/result-schema.js.

const PHYSICAL_CHECKS = [
  { id: 'visa_brand_mark_present_front', name: 'Visa Brand Mark present (front)',
    category: 'brand_mark', severity: 'blocker', side: 'front',
    reason_codes: ['mark_absent'] },
  { id: 'visa_brand_mark_position_front', name: 'Visa Brand Mark position (front)',
    category: 'brand_mark', severity: 'blocker', side: 'front',
    reason_codes: ['position_wrong_corner'] },
  { id: 'visa_brand_mark_color_front', name: 'Visa Brand Mark color (front)',
    category: 'brand_mark', severity: 'required', side: 'front',
    reason_codes: ['mark_color_not_permitted'] },
  { id: 'visa_brand_mark_contrast_front', name: 'Visa Brand Mark contrast (front)',
    category: 'brand_mark', severity: 'blocker', side: 'front',
    reason_codes: ['contrast_insufficient_wordmark', 'contrast_insufficient_identifier'] },
  { id: 'visa_brand_mark_quiet_zone_front', name: 'Visa Brand Mark quiet zone (front)',
    category: 'brand_mark', severity: 'blocker', side: 'front',
    reason_codes: ['margin_below_minimum', 'margin_borderline', 'margin_unverifiable'] },
  { id: 'product_identifier_front', name: 'Product identifier (front)',
    category: 'product_identifier', severity: 'blocker', side: 'front',
    reason_codes: ['identifier_absent', 'identifier_tier_mismatch', 'identifier_wrong_corner'] },
  { id: 'chip_position_front', name: 'Chip position (front)',
    category: 'required_elements', severity: 'required', side: 'front',
    reason_codes: ['chip_position_mismatch'] },
  { id: 'issuer_logo_front', name: 'Issuer logo (front)',
    category: 'required_elements', severity: 'required', side: 'front',
    reason_codes: ['issuer_logo_absent'] },
  { id: 'rounded_corners_cr80', name: 'Rounded corners match CR80',
    category: 'layout', severity: 'advisory', side: 'front',
    reason_codes: ['corner_radius_mismatch'] },
  { id: 'magnetic_stripe_area_back', name: 'Magnetic stripe area (back)',
    category: 'required_elements', severity: 'required', side: 'back',
    reason_codes: ['magstripe_absent', 'magstripe_misplaced'] },
  { id: 'pan_expiry_cvv_fields_back', name: 'PAN / expiry / CVV fields (back)',
    category: 'required_elements', severity: 'required', side: 'back',
    reason_codes: ['personalization_fields_absent'] },
  { id: 'issuer_text_back',
    name: 'Issuer text: "Card issued by Third National under license from Visa" (back)',
    aliases: ['issuer text', 'issuer statement'],
    category: 'required_elements', severity: 'blocker', side: 'back',
    reason_codes: ['issuer_text_absent', 'issuer_text_mismatch'] },
  { id: 'contactless_indicator_back', name: 'Contactless indicator (back)',
    category: 'required_elements', severity: 'required', side: 'back',
    reason_codes: ['contactless_indicator_absent'] },
  { id: 'no_mocked_dove_hologram_back', name: 'No mocked Visa Dove hologram in artwork (back)',
    aliases: ['no mocked visa dove hologram', 'no mocked dove hologram'],
    category: 'prohibited', severity: 'required', side: 'back',
    reason_codes: ['mocked_hologram_present'] },
  { id: 'template_placeholders_replaced', name: 'Template placeholders replaced',
    category: 'layout', severity: 'advisory', side: null,
    reason_codes: ['template_placeholder_retained'] },
  { id: 'full_color_physical', name: 'Full color (not grayscale)',
    category: 'layout', severity: 'advisory', side: null,
    reason_codes: ['grayscale_or_monochrome'] },
  { id: 'orientation_consistent', name: 'Orientation consistent',
    aliases: ['orientation consistent horizontal', 'orientation consistent vertical'],
    category: 'layout', severity: 'required', side: null,
    reason_codes: ['artwork_rotated'] },
  { id: 'front_back_design_consistency', name: 'Front/back design consistency',
    category: 'layout', severity: 'advisory', side: null,
    reason_codes: ['front_back_mismatch'] },
];

const CATALOGS = { virtual: VIRTUAL_CHECKS, physical: PHYSICAL_CHECKS };

// ── Merged-row splitters ────────────────────────────────────────────
//
// The agent sometimes collapses several canonical checks into one row, e.g.
// "No EMV chip / hologram / magstripe". These are tried only AFTER exact,
// normalized, and alias lookup all miss, so a legitimately slash-bearing
// canonical name ("No PAN / card number") is never split.

const MERGE_PATTERNS = [
  { test: /^no\s+emv\s+chip\s*\/\s*hologram\s*\/\s*mag(netic\s+)?stripe/i,
    ids: ['no_emv_chip', 'no_hologram', 'no_magnetic_stripe'] },
  { test: /^no\s+cardholder\s+name\s*\/\s*pan\s*\/\s*expiry/i,
    ids: ['no_cardholder_name', 'no_pan', 'no_expiry_date'] },
  { test: /^no\s+chip\s*\/\s*hologram\s*\/\s*mag(netic\s+)?stripe/i,
    ids: ['no_emv_chip', 'no_hologram', 'no_magnetic_stripe'] },
];

// ── Name normalization ──────────────────────────────────────────────
//
// Reduces the observed paraphrase drift to a comparable key. The dominant
// drift mode by far is a trailing parenthetical qualifier carrying the
// measurement the agent just made — "(Option Two: 142px height)", "(56px)",
// "(upper-left)" — which is display detail, not identity.

export function normalizeCheckName(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')      // parenthetical qualifiers
    .replace(/"[^"]*"/g, ' ')        // quoted literals (issuer text check)
    .replace(/[“”][^“”]*[“”]/g, ' ')
    .replace(/\s[—–-]\s.*$/, ' ')    // trailing " — #1 rejection reason" clause
    .replace(/:.*$/, ' ')            // trailing ": <literal>" clause
    .replace(/&/g, ' and ')
    .replace(/[#*_.,'’]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Built once per catalog: id → descriptor, and every lookup key → id.
const INDEXES = Object.fromEntries(Object.entries(CATALOGS).map(([cardType, checks]) => {
  const byId = new Map();
  const byKey = new Map();
  for (const check of checks) {
    byId.set(check.id, check);
    byKey.set(check.name.toLowerCase(), check.id);
    byKey.set(normalizeCheckName(check.name), check.id);
    for (const alias of check.aliases || []) {
      byKey.set(normalizeCheckName(alias), check.id);
    }
  }
  return [cardType, { byId, byKey }];
}));

// ── Public API ──────────────────────────────────────────────────────

export function getCatalog(cardType) {
  return CATALOGS[cardType] || [];
}

export function getCheck(cardType, id) {
  return INDEXES[cardType]?.byId.get(id) || null;
}

// Resolve an agent-emitted check name (or id) to catalog IDs.
//
// Returns an ARRAY, not a scalar: a merged row like
// "No EMV chip / hologram / magstripe" legitimately maps to three checks.
// An empty array means unresolved — the caller must preserve the raw entry
// rather than guess (see unmapped_checks in lib/result-schema.js).
export function resolveChecks(cardType, nameOrId) {
  const index = INDEXES[cardType];
  if (!index) return [];
  const raw = String(nameOrId || '').trim();
  if (!raw) return [];

  if (index.byId.has(raw)) return [raw];

  const exact = index.byKey.get(raw.toLowerCase());
  if (exact) return [exact];

  const normalized = index.byKey.get(normalizeCheckName(raw));
  if (normalized) return [normalized];

  for (const { test, ids } of MERGE_PATTERNS) {
    if (test.test(raw)) return ids.filter((id) => index.byId.has(id));
  }

  return [];
}

// Render the visual_checks JSON skeleton embedded in the turn-1 prompt.
//
// Generating this from the catalog is the whole point of the module: the
// prompt and the wire contract can no longer disagree about what checks
// exist or what they are called.
export function buildCheckListForPrompt(cardType, { orientation } = {}) {
  const checks = getCatalog(cardType);
  const resultHint = cardType === 'physical'
    ? 'pass or fail or warning or not submitted'
    : 'pass or fail or warning';

  return checks.map((check, i) => {
    // The physical orientation check names the detected orientation so the
    // agent knows which trim it is judging against.
    const name = check.id === 'orientation_consistent' && orientation
      ? `${check.name} (${orientation})`
      : check.name;
    const result = i === 0 ? resultHint : '...';
    const notes = i === 0 ? 'details' : '...';
    return `    { "id": ${JSON.stringify(check.id)}, "name": ${JSON.stringify(name)}, ` +
           `"result": ${JSON.stringify(result)}, "notes": ${JSON.stringify(notes)} }`;
  }).join(',\n');
}

// Compact per-check reason-code reference for the prompt. Generated from the
// catalog so the vocabulary the agent is offered is exactly the vocabulary
// the normalizer accepts.
export function buildReasonCodeReference(cardType) {
  return getCatalog(cardType)
    .map((check) => `- ${check.id}: ${(check.reason_codes || []).join(' | ')}`)
    .join('\n');
}

// Reason codes valid for a given check: its own, plus the cross-cutting
// source-quality codes and the open-ended fallback.
const UNIVERSAL_REASON_CODES = ['source_is_screenshot', 'source_not_production_file', 'other'];

export function isValidReasonCode(cardType, checkId, code) {
  if (!code) return false;
  if (UNIVERSAL_REASON_CODES.includes(code)) return true;
  const check = getCheck(cardType, checkId);
  return !!check && (check.reason_codes || []).includes(code);
}

// Every reason_code the catalog references, plus the open-ended fallback.
export function allReasonCodes(cardType) {
  const codes = new Set(['other']);
  for (const check of getCatalog(cardType)) {
    for (const code of check.reason_codes || []) codes.add(code);
  }
  // Source-quality codes are not tied to one check — any measurement-bearing
  // check can cite them when the submission is not a production file.
  codes.add('source_is_screenshot');
  codes.add('source_not_production_file');
  if (cardType === 'virtual') {
    codes.add('dimensions_mismatch');
    codes.add('format_not_png');
  }
  return [...codes];
}

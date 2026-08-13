// Regression guard against prompt/catalog drift.
//
// Run: node --test tests/
//
// The fixtures below are REAL check names extracted from the 59 archived
// card-art reports. The agent paraphrases the names it is given, so these
// are not hypothetical inputs — they are what production actually emits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCatalog, getCheck, resolveChecks, normalizeCheckName,
  buildCheckListForPrompt, allReasonCodes,
  CHECK_STATUS, SEVERITY, OUTCOME,
} from '../lib/check-catalog.js';

// ── Catalog integrity ───────────────────────────────────────────────

test('virtual catalog has the canonical 18 checks with unique ids', () => {
  const checks = getCatalog('virtual');
  assert.equal(checks.length, 18);
  assert.equal(new Set(checks.map((c) => c.id)).size, 18);
});

test('physical catalog has the canonical 18 checks with unique ids', () => {
  const checks = getCatalog('physical');
  assert.equal(checks.length, 18);
  assert.equal(new Set(checks.map((c) => c.id)).size, 18);
});

test('every check declares a valid severity and at least one reason code', () => {
  for (const cardType of ['virtual', 'physical']) {
    for (const check of getCatalog(cardType)) {
      assert.ok(SEVERITY.includes(check.severity), `${check.id}: ${check.severity}`);
      assert.ok(check.reason_codes?.length, `${check.id} has no reason codes`);
    }
  }
});

test('every catalog name round-trips back to its own id', () => {
  for (const cardType of ['virtual', 'physical']) {
    for (const check of getCatalog(cardType)) {
      assert.deepEqual(resolveChecks(cardType, check.name), [check.id], check.name);
      assert.deepEqual(resolveChecks(cardType, check.id), [check.id], check.id);
    }
  }
});

test('every declared alias resolves to its own check', () => {
  for (const cardType of ['virtual', 'physical']) {
    for (const check of getCatalog(cardType)) {
      for (const alias of check.aliases || []) {
        assert.deepEqual(resolveChecks(cardType, alias), [check.id], `${check.id} ← ${alias}`);
      }
    }
  }
});

// ── The prompt is generated from the catalog ────────────────────────

test('prompt skeleton lists every catalog check exactly once', () => {
  for (const cardType of ['virtual', 'physical']) {
    const block = buildCheckListForPrompt(cardType);
    for (const check of getCatalog(cardType)) {
      const occurrences = block.split(`"id": "${check.id}"`).length - 1;
      assert.equal(occurrences, 1, `${cardType}/${check.id} appeared ${occurrences}x`);
    }
    assert.equal(block.split('"id":').length - 1, 18);
  }
});

test('prompt skeleton is parseable JSON when wrapped', () => {
  for (const cardType of ['virtual', 'physical']) {
    const parsed = JSON.parse(`[\n${buildCheckListForPrompt(cardType)}\n]`);
    assert.equal(parsed.length, 18);
    assert.deepEqual(parsed.map((p) => p.id), getCatalog(cardType).map((c) => c.id));
  }
});

test('physical orientation check interpolates the detected orientation', () => {
  const vertical = JSON.parse(`[\n${buildCheckListForPrompt('physical', { orientation: 'vertical' })}\n]`);
  const entry = vertical.find((p) => p.id === 'orientation_consistent');
  assert.equal(entry.name, 'Orientation consistent (vertical)');
  // …and the interpolated name still resolves back, since the parenthetical
  // is exactly the drift mode normalization strips.
  assert.deepEqual(resolveChecks('physical', entry.name), ['orientation_consistent']);
});

// ── Observed drift: parenthetical qualifiers ────────────────────────

const SIZE_VARIANTS = [
  'Visa Brand Mark size',
  'Visa Brand Mark size (Option Two: 142px height)',
  'Visa Brand Mark size (Option Two: 142px)',
  'Visa Brand Mark size (Option Two: ~142px height)',
  'Visa Brand Mark size (Option Two ~142px)',
  'Visa Brand Mark size (Option Two ~142px height)',
  'Visa Brand Mark size (Option Two)',
  'Visa Brand Mark size (Option Two: 142px height standalone)',
  'Visa Brand Mark size (Option Two: 142px with product identifier)',
  'Visa Brand Mark size (Option Two — 142px with Product Identifier)',
  'Visa Brand Mark size (Option Two standalone — ~142px / 14.7% of card height)',
  'Visa Brand Mark size (Option One: 109px / Option Two: 142px height)',
  'Visa Brand Mark size (109px or 142px height)',
  'Visa Brand Mark size (~136px height, Option Two 142px)',
  'Visa Brand Mark size (~13.3% height, Option Two)',
  'Visa Brand Mark size (~142px, Option Two)',
];

test('all 16 observed size-check variants resolve', () => {
  for (const name of SIZE_VARIANTS) {
    assert.deepEqual(resolveChecks('virtual', name), ['visa_brand_mark_size'], name);
  }
});

const POSITION_VARIANTS = [
  'Visa Brand Mark position',
  'Visa Brand Mark position (upper-left)',
  'Visa Brand Mark position (upper-right)',
  'Visa Brand Mark position (upper corner)',
  'Visa Brand Mark position (upper corner only)',
  'Visa Brand Mark position (upper-left or upper-right)',
  'Visa Brand Mark position (upper-left or upper-right only)',
  'Visa Brand Mark position (upper-left/upper-right only)',
  'Visa Brand Mark position (upper-left/right only)',
];

test('all 9 observed position-check variants resolve', () => {
  for (const name of POSITION_VARIANTS) {
    assert.deepEqual(resolveChecks('virtual', name), ['visa_brand_mark_position'], name);
  }
});

const MARGIN_VARIANTS = [
  'Visa Brand Mark margin (56px)',
  'Visa Brand Mark margin (56px from edges)',
  'Visa Brand Mark margin (~56px from edges)',
  'Visa Brand Mark margin (>= 56px from edges)',
  'Visa Brand Mark margin (56px minimum)',
  'Visa Brand Mark margin (56px — #1 rejection reason)',
  'Visa Brand Mark margin (56px from edges — #1 rejection reason)',
  'Visa Brand Mark margin (56px) — #1 rejection reason',
  'Visa Brand Mark 56px margin (#1 rejection reason)',
];

test('all 9 observed margin-check variants resolve, including word reordering', () => {
  for (const name of MARGIN_VARIANTS) {
    assert.deepEqual(resolveChecks('virtual', name), ['visa_brand_mark_margin'], name);
  }
});

test('observed identifier, contrast, issuer and layout variants resolve', () => {
  const cases = {
    visa_brand_mark_contrast: [
      'Visa Brand Mark contrast',
      'Visa Brand Mark contrast against background',
      'Product identifier (Signature) contrast',
    ],
    product_identifier: [
      'Product identifier present and placed',
      'Product identifier present and placed (Platinum)',
      'Product identifier present and placed (Infinite)',
      'Product identifier present and placed (Corporate)',
      "Product identifier present & placed ('Platinum')",
      "Product identifier present & placed ('Corporate')",
      'Product identifier present (Platinum)',
      'Visa product identifier',
    ],
    issuer_logo_present: [
      'Issuer logo present',
      'Issuer logo present (Veem)',
      'Issuer logo present (SPay)',
      'Issuer logo present (Finu)',
    ],
    lower_left_area_clear: [
      'Lower-left area clear',
      'Lower-left area clear (no marks/graphics)',
      'Lower-left area clear (PAN zone)',
      'Lower-left area clear (PAN reserved)',
      'Lower-left area clear (reserved for PAN overlay)',
      'Lower-left area clear for PAN',
    ],
    full_color: ['Full color', 'Full color (not grayscale)'],
    design_elements_clear_of_identifier: [
      'Design elements clear of product identifier',
      'Design elements clear of identifier',
    ],
    no_pan: ['No PAN / card number', 'No full PAN / card number'],
  };
  for (const [id, names] of Object.entries(cases)) {
    for (const name of names) {
      assert.deepEqual(resolveChecks('virtual', name), [id], name);
    }
  }
});

// ── Observed drift: merged rows ─────────────────────────────────────

test('merged prohibited-element rows fan out to their component checks', () => {
  assert.deepEqual(
    resolveChecks('virtual', 'No EMV chip / hologram / magstripe'),
    ['no_emv_chip', 'no_hologram', 'no_magnetic_stripe'],
  );
  assert.deepEqual(
    resolveChecks('virtual', 'No cardholder name / PAN / expiry'),
    ['no_cardholder_name', 'no_pan', 'no_expiry_date'],
  );
});

test('a slash-bearing canonical name is never mistaken for a merged row', () => {
  // "No PAN / card number" is one check, not two. It must match before the
  // merge splitter is ever consulted.
  assert.deepEqual(resolveChecks('virtual', 'No PAN / card number'), ['no_pan']);
});

// ── Observed drift: invented checks ─────────────────────────────────

test('checks the agent invents resolve to nothing, so callers preserve them', () => {
  const invented = [
    'Black frame around artwork',
    'Full-bleed card art (no white padding)',
    'Aspect ratio / dimensions',
    'Contactless indicator',
  ];
  for (const name of invented) {
    assert.deepEqual(resolveChecks('virtual', name), [], name);
  }
});

test('a physical check name does not resolve against the virtual catalog', () => {
  assert.deepEqual(resolveChecks('virtual', 'Magnetic stripe area (back)'), []);
  assert.deepEqual(resolveChecks('virtual', 'Chip position (front)'), []);
});

// ── Normalization unit behaviour ────────────────────────────────────

test('normalizeCheckName strips the drift-bearing decoration', () => {
  assert.equal(normalizeCheckName('Visa Brand Mark size (Option Two: 142px)'), 'visa brand mark size');
  assert.equal(normalizeCheckName('Full color (not grayscale)'), 'full color');
  assert.equal(
    normalizeCheckName('Issuer text: "Card issued by Third National under license from Visa" (back)'),
    'issuer text',
  );
  assert.equal(normalizeCheckName("Product identifier present & placed ('Platinum')"), 'product identifier present and placed');
});

test('empty and nullish names resolve to nothing rather than throwing', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(resolveChecks('virtual', value), []);
  }
  assert.deepEqual(resolveChecks('nonexistent-type', 'Visa Brand Mark present'), []);
});

// ── Reason codes ────────────────────────────────────────────────────

test('reason codes include the evidence-backed virtual vocabulary', () => {
  const codes = allReasonCodes('virtual');
  for (const expected of [
    'margin_below_minimum', 'margin_borderline', 'position_wrong_corner',
    'size_undersized', 'contrast_insufficient_identifier', 'identifier_absent',
    'identifier_tier_mismatch', 'issuer_logo_absent', 'prohibited_element_present',
    'pan_zone_obstructed', 'orientation_not_landscape', 'grayscale_or_monochrome',
    'source_is_screenshot', 'other',
  ]) {
    assert.ok(codes.includes(expected), `missing reason code: ${expected}`);
  }
});

test('enum vocabularies match the tech layer they were adopted from', () => {
  assert.deepEqual(
    CHECK_STATUS,
    ['pass', 'fail', 'warning', 'not_submitted', 'unverified', 'estimated'],
  );
  assert.deepEqual(OUTCOME, ['approved', 'approved_with_notes', 'requires_changes']);
});

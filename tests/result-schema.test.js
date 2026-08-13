// Normalization tests, anchored on real artifacts.
//
// Run: node --test 'tests/*.test.js'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildResult, buildFailureResult, normalizeStatus, normalizeOutcome,
  legacyStatusFor, techCheckStatus, normalizeVisualChecks, normalizeTechChecks,
  SCHEMA_VERSION, INTERNAL_SCHEMA_VERSION,
} from '../lib/result-schema.js';
import { getCatalog } from '../lib/check-catalog.js';

// ── Outcome: the three-state fidelity the pipeline currently loses ──

test('APPROVED WITH NOTES survives as its own outcome', () => {
  assert.equal(normalizeOutcome('APPROVED WITH NOTES'), 'approved_with_notes');
  assert.equal(normalizeOutcome('APPROVED'), 'approved');
  assert.equal(normalizeOutcome('REQUIRES CHANGES'), 'requires_changes');
});

test('legacy pass/fail keeps its current meaning exactly', () => {
  // The pipeline maps APPROVED WITH NOTES to 'pass' today. Changing that
  // would silently reclassify runs in /admin, so it must not change.
  assert.equal(legacyStatusFor(normalizeOutcome('APPROVED WITH NOTES')), 'pass');
  assert.equal(legacyStatusFor(normalizeOutcome('APPROVED')), 'pass');
  assert.equal(legacyStatusFor(normalizeOutcome('REQUIRES CHANGES')), 'fail');
});

test('an unrecognised or missing status is treated as requiring changes', () => {
  for (const value of [undefined, null, '', 'garbage', 'REJECTED']) {
    assert.equal(normalizeOutcome(value), 'requires_changes');
  }
});

// ── Status vocabulary ───────────────────────────────────────────────

test('status aliases normalize to the closed enum', () => {
  assert.equal(normalizeStatus('pass'), 'pass');
  assert.equal(normalizeStatus('PASS'), 'pass');
  assert.equal(normalizeStatus('warning'), 'warning');
  assert.equal(normalizeStatus('warn'), 'warning');
  assert.equal(normalizeStatus('not submitted'), 'not_submitted');
  assert.equal(normalizeStatus('N/S'), 'not_submitted');
  assert.equal(normalizeStatus('N/V'), 'unverified');
  assert.equal(normalizeStatus('nonsense'), 'unverified');
});

test('tech check tri-state mirrors the Python mapping', () => {
  assert.equal(techCheckStatus({ passed: true }), 'pass');
  assert.equal(techCheckStatus({ passed: false }), 'fail');
  assert.equal(techCheckStatus({ passed: null }), 'unverified');
  assert.equal(techCheckStatus({ passed: true, borderline: true }), 'warning');
  assert.equal(techCheckStatus(undefined), 'unverified');
});

// ── Visual check mapping ────────────────────────────────────────────

test('a merged row fans out and is flagged as not independently assessed', () => {
  const { checks, unmapped } = normalizeVisualChecks('virtual', [
    { name: 'No EMV chip / hologram / magstripe', result: 'pass' },
  ]);
  assert.equal(unmapped.length, 0);
  assert.deepEqual(checks.map((c) => c.id), ['no_emv_chip', 'no_hologram', 'no_magnetic_stripe']);
  for (const check of checks) {
    assert.equal(check.status, 'pass');
    assert.equal(check.merged_from, 'No EMV chip / hologram / magstripe');
  }
});

test('invented checks are preserved in unmapped_checks, never dropped', () => {
  const { checks, unmapped } = normalizeVisualChecks('virtual', [
    { name: 'Black frame around artwork', result: 'warning', notes: 'Confirm intended.' },
    { name: 'Contactless indicator', result: 'pass' },
  ]);
  assert.equal(checks.length, 0);
  assert.equal(unmapped.length, 2);
  assert.equal(unmapped[0].name, 'Black frame around artwork');
  assert.equal(unmapped[0].status, 'warning');
  assert.equal(unmapped[0].notes, 'Confirm intended.');
});

test('markers are normalized and only kept when numeric', () => {
  const { checks } = normalizeVisualChecks('virtual', [
    { name: 'Visa Brand Mark margin (56px)', result: 'fail', marker_x: 0.045, marker_y: 0.06 },
    { name: 'Landscape orientation', result: 'pass', marker_x: 'nope' },
  ]);
  assert.deepEqual(checks[0].marker, { x: 0.045, y: 0.06 });
  assert.equal(checks[1].marker, undefined);
});

test('physical markers keep their side', () => {
  const { checks } = normalizeVisualChecks('physical', [
    { name: 'Issuer text', result: 'fail', marker_x: 0.5, marker_y: 0.8, marker_side: 'back' },
  ]);
  assert.deepEqual(checks[0].marker, { x: 0.5, y: 0.8, side: 'back' });
});

test('an out-of-vocabulary reason code degrades to other', () => {
  const { checks } = normalizeVisualChecks('virtual', [
    { id: 'visa_brand_mark_margin', result: 'fail', reason_code: 'margin_below_minimum' },
    { id: 'visa_brand_mark_size', result: 'fail', reason_code: 'invented_code' },
    { id: 'lower_left_area_clear', result: 'fail' },
    { id: 'landscape_orientation', result: 'pass', reason_code: 'orientation_not_landscape' },
  ]);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId.visa_brand_mark_margin.reason_code, 'margin_below_minimum');
  assert.equal(byId.visa_brand_mark_size.reason_code, 'other');
  assert.equal(byId.lower_left_area_clear.reason_code, 'other');
  assert.equal(byId.landscape_orientation.reason_code, null, 'passes carry no reason code');
});

test('checks the agent omits are reported as unverified, not absent', () => {
  const result = buildResult({
    runId: 'r1', cardType: 'virtual',
    results: { status: 'APPROVED', visual_checks: [{ id: 'full_color', result: 'pass' }] },
  });
  assert.equal(result.checks.length, 18, 'every catalog check is present');
  const missing = result.checks.filter((c) => c.status === 'unverified');
  assert.equal(missing.length, 17);
});

// ── Tech checks ─────────────────────────────────────────────────────

test('virtual tech checks flatten with bleed-zone measurements retained', () => {
  const techChecks = normalizeTechChecks('virtual', {
    checks: {
      dimensions: { passed: false, actual: '1254x1254', required: '1536x969', note: 'n' },
      bleed_zone: {
        passed: false, actual: 'Top: 19px', note: 'FAIL',
        mark_detected: true, mark_corner: 'bottom-right', strict_min_px: 19, measured_from: 'trim',
      },
    },
  });
  const byId = Object.fromEntries(techChecks.map((c) => [c.id, c]));
  assert.equal(byId.dimensions.status, 'fail');
  assert.equal(byId.dimensions.actual, '1254x1254');
  assert.equal(byId.bleed_zone.measurements.strict_min_px, 19);
  assert.equal(byId.bleed_zone.measurements.mark_corner, 'bottom-right');
});

test('physical tech checks are flattened per side', () => {
  const techChecks = normalizeTechChecks('physical', {
    front: { checks: { file_format: { passed: true, actual: '.ai' } } },
    back: { checks: { magstripe_band: { passed: null, actual: 'not measurable' } } },
  });
  assert.deepEqual(
    techChecks.map((c) => [c.side, c.id, c.status]),
    [['front', 'file_format', 'pass'], ['back', 'magstripe_band', 'unverified']],
  );
});

test('a borderline tech result surfaces as a warning, not a pass', () => {
  // The 56-58px band: measured in spec, rejected by Visa in practice.
  const [check] = normalizeTechChecks('virtual', {
    checks: { bleed_zone: { passed: true, borderline: true, actual: 'Top: 58px, Right: 56px' } },
  });
  assert.equal(check.status, 'warning');
  assert.equal(check.borderline, true);
});

// ── Whole-result assembly ───────────────────────────────────────────

test('blocking failures list only blocker-severity failures', () => {
  const result = buildResult({
    runId: 'r1', cardType: 'virtual',
    results: {
      status: 'REQUIRES CHANGES',
      visual_checks: [
        { id: 'visa_brand_mark_margin', result: 'fail' },   // blocker
        { id: 'issuer_logo_present', result: 'fail' },      // required
        { id: 'full_color', result: 'warning' },            // not a failure
      ],
    },
    techJson: { checks: { dimensions: { passed: false, actual: '500x315' } } },
  });
  assert.ok(result.blocking_failures.includes('visa_brand_mark_margin'));
  assert.ok(!result.blocking_failures.includes('issuer_logo_present'));
  assert.ok(result.blocking_failures.includes('dimensions'), 'failed tech checks block too');
});

test('physical results are marked internal, virtual results carry v1.0', () => {
  const virtual = buildResult({ runId: 'r', cardType: 'virtual', results: { status: 'APPROVED' } });
  const physical = buildResult({ runId: 'r', cardType: 'physical', results: { status: 'APPROVED' } });
  assert.equal(virtual.schema_version, SCHEMA_VERSION);
  assert.equal(physical.schema_version, INTERNAL_SCHEMA_VERSION);
});

test('failure results carry a closed error code and the pipeline step', () => {
  const result = buildFailureResult({
    runId: 'r1', cardType: 'virtual', errorCode: 'function_timeout',
    message: 'Timed out — function hit its 300s limit during "agent_run"', step: 'agent_run',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.outcome, null);
  assert.equal(result.error.code, 'function_timeout');
  assert.equal(result.error.step, 'agent_run');
});

// ── Golden file: the one real visual_results artifact in existence ──

const GOLDEN = join(homedir(), 'Desktop', 'Rain Scratch', '_visual_results.json');

test('golden Coinflow artifact normalizes cleanly', { skip: !existsSync(GOLDEN) && 'golden file not present' }, () => {
  const raw = JSON.parse(readFileSync(GOLDEN, 'utf8'));

  // The artifact predates the current field names: it uses
  // overall_status/overall_description where the pipeline now emits
  // status/summary. Shim it rather than teaching buildResult a dead shape.
  const results = {
    status: raw.overall_status,
    summary: raw.overall_description,
    visual_checks: raw.visual_checks,
  };

  const result = buildResult({
    runId: 'golden', cardType: 'virtual', results,
    fileName: 'CoinflowvirtualcardCorporate.png',
  });

  assert.equal(result.outcome, 'approved_with_notes');
  assert.equal(result.status, 'pass', 'legacy status still collapses to pass');
  assert.deepEqual(result.unmapped_checks, [], 'every name in the artifact resolves');
  assert.equal(result.checks.length, 18);
  assert.equal(result.checks.filter((c) => c.status === 'unverified').length, 0,
    'all 18 checks were reported');

  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
  assert.equal(byId.visa_brand_mark_margin.status, 'warning');
  assert.deepEqual(byId.visa_brand_mark_margin.marker, { x: 0.045, y: 0.06 });
  assert.equal(byId.product_identifier.status, 'warning');
  assert.equal(byId.visa_brand_mark_position.status, 'pass');
  assert.equal(result.counts.pass, 16);
  assert.equal(result.counts.warning, 2);
  assert.deepEqual(result.blocking_failures, [], 'warnings do not block');
});

test('catalog and normalizer agree on every check id', () => {
  const result = buildResult({ runId: 'r', cardType: 'virtual', results: { status: 'APPROVED' } });
  assert.deepEqual(
    result.checks.map((c) => c.id).sort(),
    getCatalog('virtual').map((c) => c.id).sort(),
  );
});

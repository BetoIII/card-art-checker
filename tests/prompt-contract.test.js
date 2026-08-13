// The prompt is generated from the catalog. These tests assert the two stay
// welded together — if the generated RESULTS_JSON block ever stops matching
// the catalog, every downstream consumer breaks silently, so it fails here.
//
// Run: node --test 'tests/*.test.js'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVisualPrompt } from '../lib/pipeline.js';
import { getCatalog } from '../lib/check-catalog.js';
import { normalizeVisualChecks } from '../lib/result-schema.js';

const VIRTUAL_TECH = { checks: { dimensions: { passed: true, actual: '1536x969' } } };
const PHYSICAL_TECH = { front: { orientation: 'horizontal', checks: {} } };

function resultsBlock(prompt) {
  const match = prompt.match(/RESULTS_JSON_START([\s\S]*?)RESULTS_JSON_END/);
  assert.ok(match, 'prompt must contain a RESULTS_JSON block');
  return JSON.parse(match[1].trim());
}

test('the virtual prompt emits a parseable block with all 18 catalog ids in order', () => {
  const parsed = resultsBlock(buildVisualPrompt(VIRTUAL_TECH, 'virtual', false, []));
  assert.deepEqual(
    parsed.visual_checks.map((c) => c.id),
    getCatalog('virtual').map((c) => c.id),
  );
});

test('the physical prompt emits a parseable block with all 18 catalog ids in order', () => {
  const parsed = resultsBlock(buildVisualPrompt(PHYSICAL_TECH, 'physical', true, []));
  assert.equal(parsed.card_type, 'physical');
  assert.deepEqual(
    parsed.visual_checks.map((c) => c.id),
    getCatalog('physical').map((c) => c.id),
  );
});

test('a verbatim echo of the prompt skeleton normalizes with nothing unmapped', () => {
  // The best case the agent can produce: it returns exactly what it was given.
  // If that does not round-trip, nothing else will.
  for (const [cardType, tech] of [['virtual', VIRTUAL_TECH], ['physical', PHYSICAL_TECH]]) {
    const parsed = resultsBlock(buildVisualPrompt(tech, cardType, true, []));
    const echoed = parsed.visual_checks.map((c) => ({ ...c, result: 'pass' }));
    const { checks, unmapped } = normalizeVisualChecks(cardType, echoed);
    assert.deepEqual(unmapped, [], `${cardType}: skeleton echo left unmapped entries`);
    assert.equal(checks.length, 18);
  }
});

test('names in the block are unchanged from the catalog, so the PDF renders as before', () => {
  // The Python report renderer keys its rows off `name`. Regenerating the
  // prompt must not have reworded anything.
  const parsed = resultsBlock(buildVisualPrompt(VIRTUAL_TECH, 'virtual', false, []));
  const catalogNames = getCatalog('virtual').map((c) => c.name);
  assert.deepEqual(parsed.visual_checks.map((c) => c.name), catalogNames);
  assert.ok(catalogNames.includes('Visa Brand Mark margin (56px from edges)'));
  assert.ok(catalogNames.includes('No PAN / card number'));
});

test('the physical prompt still names the detected orientation', () => {
  const vertical = resultsBlock(
    buildVisualPrompt({ front: { orientation: 'vertical', checks: {} } }, 'physical', true, []),
  );
  const entry = vertical.visual_checks.find((c) => c.id === 'orientation_consistent');
  assert.equal(entry.name, 'Orientation consistent (vertical)');
});

test('both prompts carry the reason-code table for their own card type', () => {
  const virtual = buildVisualPrompt(VIRTUAL_TECH, 'virtual', false, []);
  const physical = buildVisualPrompt(PHYSICAL_TECH, 'physical', true, []);

  assert.match(virtual, /## Reason Codes/);
  assert.match(virtual, /visa_brand_mark_margin: margin_below_minimum \| margin_borderline/);
  assert.ok(!virtual.includes('issuer_text_back'), 'virtual must not offer physical codes');

  assert.match(physical, /## Reason Codes/);
  assert.match(physical, /issuer_text_back:/);
});

test('the prompt tells the agent the ids are fixed', () => {
  for (const [cardType, tech] of [['virtual', VIRTUAL_TECH], ['physical', PHYSICAL_TECH]]) {
    const prompt = buildVisualPrompt(tech, cardType, true, []);
    assert.match(prompt, /"id" values below EXACTLY/);
    assert.match(prompt, /never change/);
  }
});

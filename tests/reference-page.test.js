// Drift guard for /reference.
//
// Run: node --test tests/
//
// reference.html is static and hand-edited, and every rule change used to
// mean remembering to edit it too. These tests hold the parts that restate
// the code — the check catalog, the technical checks, the error codes and
// the enums — to lib/check-catalog.js, and keep every in-page link live.
// When the catalog test fails, `node scripts/sync-reference.js` is the fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getCatalog, TECH_CHECK_IDS, ERROR_CODE, CHECK_STATUS, SEVERITY, OUTCOME,
} from '../lib/check-catalog.js';
import { CHECK_ZONES, START, END, renderCatalog } from '../scripts/sync-reference.js';

const html = readFileSync(new URL('../reference.html', import.meta.url), 'utf8');

const attrValues = (source, attr) =>
  [...source.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);

const between = (source, open, close) => {
  const start = source.indexOf(open);
  assert.ok(start !== -1, `missing ${open}`);
  const end = source.indexOf(close, start);
  assert.ok(end !== -1, `missing ${close} after ${open}`);
  return source.slice(start + open.length, end);
};

test('the generated catalog matches lib/check-catalog.js (fix: node scripts/sync-reference.js)', () => {
  const block = between(html, START, END);
  assert.equal(block.trim(), renderCatalog().trim());
});

test('every virtual check sits in a zone the diagram can light', () => {
  const zones = new Set(attrValues(between(html, '<svg class="zone-svg"', '</svg>'), 'data-zone'));
  for (const check of getCatalog('virtual')) {
    assert.ok(CHECK_ZONES[check.id], `${check.id} has no zone in scripts/sync-reference.js`);
    assert.ok(zones.has(CHECK_ZONES[check.id]), `${check.id}: zone "${CHECK_ZONES[check.id]}" is not on the diagram`);
  }
});

test('the technical checks table lists exactly the virtual tech checks, in order', () => {
  const table = between(html, '<table id="tech-check-table">', '</table>');
  assert.deepEqual(attrValues(table, 'data-tech'), [...TECH_CHECK_IDS.virtual]);
});

test('the error code table lists exactly the closed error set', () => {
  const table = between(html, '<table id="error-code-table">', '</table>');
  const codes = attrValues(table, 'data-error');
  assert.equal(new Set(codes).size, codes.length, 'an error code is listed twice');
  assert.deepEqual([...codes].sort(), [...ERROR_CODE].sort());
});

test('the Enums block states the closed sets the code enforces', () => {
  const block = between(html, '<pre data-hl="ts" id="enums-closed-sets">', '</pre>');
  const union = (name) => {
    const line = block.split('\n').find((l) => l.startsWith(`type ${name}`));
    assert.ok(line, `no "type ${name}" line`);
    return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(union('Outcome'), [...OUTCOME]);
  assert.deepEqual(union('Severity'), [...SEVERITY]);
  assert.deepEqual(union('Status'), [...CHECK_STATUS]);
});

test('every in-page link lands on an element', () => {
  const ids = new Set(attrValues(html, 'id'));
  const missing = [...new Set(attrValues(html, 'href').filter((h) => h.startsWith('#') && h.length > 1))]
    .filter((h) => !ids.has(h.slice(1)));
  assert.deepEqual(missing, []);
});

test('no id is used twice', () => {
  const ids = attrValues(html, 'id');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, []);
});

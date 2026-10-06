// Every check names its partner by a Rocketlane project id or a Rain tenant
// id. Only the shape is checked, and the shape is also what keeps the id a
// safe Blob path segment.
//
// Run: node --test 'tests/*.test.js'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePartnerIds } from '../lib/partner-id.js';

const TENANT = '9eef553e-4dd3-4e70-b86a-0edc969f447c';

test('a Rain tenant id alone is enough', () => {
  assert.deepEqual(parsePartnerIds({ tenantId: TENANT }), { projectId: null, tenantId: TENANT });
});

test('a Rocketlane project id alone is enough', () => {
  assert.deepEqual(parsePartnerIds({ projectId: '1318663' }), { projectId: '1318663', tenantId: null });
});

test('both ids may be sent together', () => {
  assert.deepEqual(
    parsePartnerIds({ projectId: '1318663', tenantId: TENANT }),
    { projectId: '1318663', tenantId: TENANT },
  );
});

test('a tenant id is matched case-insensitively and stored lowercased', () => {
  assert.equal(parsePartnerIds({ tenantId: TENANT.toUpperCase() }).tenantId, TENANT);
});

test('surrounding whitespace is ignored', () => {
  assert.deepEqual(
    parsePartnerIds({ projectId: ' 1318663\n', tenantId: `  ${TENANT} ` }),
    { projectId: '1318663', tenantId: TENANT },
  );
});

test('a check with neither id is refused', () => {
  for (const ids of [{}, { projectId: '', tenantId: '' }, { projectId: '   ' }, { tenantId: null }, undefined]) {
    assert.throws(() => parsePartnerIds(ids), /Missing projectId or tenantId/);
  }
});

test('a malformed project id is refused, not looked up', () => {
  for (const projectId of ['abc', '12-34', '../1', '1'.repeat(13), TENANT]) {
    assert.throws(() => parsePartnerIds({ projectId }), /Invalid projectId/);
  }
});

test('a malformed tenant id is refused', () => {
  for (const tenantId of ['not-a-uuid', '1318663', TENANT.slice(0, -1), `${TENANT}/x`, TENANT.replace(/-/g, '')]) {
    assert.throws(() => parsePartnerIds({ tenantId }), /Invalid tenantId/);
  }
});

test('one malformed id fails the pair even when the other is good', () => {
  assert.throws(() => parsePartnerIds({ projectId: 'nope', tenantId: TENANT }), /Invalid projectId/);
  assert.throws(() => parsePartnerIds({ projectId: '1318663', tenantId: 'nope' }), /Invalid tenantId/);
});

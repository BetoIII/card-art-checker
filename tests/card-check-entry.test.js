import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReference } from '../api/card-check.js';

// The reference is a caller-controlled correlation id, echoed back on
// trigger.reference. It is sanitized to a single path segment, and must
// never be able to leave it.

test('a reference keeps the characters a path segment can safely hold', () => {
  assert.equal(sanitizeReference('cardArtForm_01HX9'), 'cardArtForm_01HX9');
  assert.equal(sanitizeReference('tenant-abc.form-123'), 'tenant-abc.form-123');
});

test('separators and traversal collapse instead of escaping the segment', () => {
  // The danger is a reference that climbs out of reports/ or forks a new path.
  assert.equal(sanitizeReference('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeReference('tenant/abc'), 'tenant-abc');
  assert.equal(sanitizeReference('a\\b'), 'a-b');
  for (const value of ['../../etc/passwd', 'tenant/abc', 'a\\b', './../x']) {
    const cleaned = sanitizeReference(value);
    assert.ok(!cleaned.includes('/'), `"${value}" left a forward slash`);
    assert.ok(!cleaned.includes('\\'), `"${value}" left a backslash`);
    assert.ok(!cleaned.startsWith('.'), `"${value}" can still climb`);
  }
});

test('an empty or junk-only reference resolves to nothing, not a stray segment', () => {
  // Falsy means no trigger.reference is echoed, rather than a stray '---'.
  assert.equal(sanitizeReference(''), '');
  assert.equal(sanitizeReference('   '), '');
  assert.equal(sanitizeReference('///'), '');
  assert.equal(sanitizeReference(undefined), '');
  assert.equal(sanitizeReference(null), '');
});

test('a long reference is bounded', () => {
  assert.equal(sanitizeReference('x'.repeat(500)).length, 64);
});

test('unicode and spaces reduce to safe filler rather than being dropped silently', () => {
  assert.equal(sanitizeReference('rain tenant ✨ 42'), 'rain-tenant-42');
});

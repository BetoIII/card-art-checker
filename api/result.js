import { timingSafeEqual } from 'node:crypto';
import { loadResults } from '../lib/result-store.js';

// GET /api/result/:runId — the pull half of the results contract.
//
// Always available, whether or not an outbound callback was configured. A run
// can analyze several attachments, so this returns every stored result for the
// run; each carries its own attachment_id.
//
// Auth reuses the trigger endpoints' shared secret rather than introducing a
// third credential: a caller that may start a check may read its result.

function secretsMatch(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function authorized(request) {
  const expected = process.env.ROCKETLANE_WEBHOOK_SECRET;
  if (!expected) return false;
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const xHeader = request.headers.get('x-webhook-secret') || '';
  return secretsMatch(bearer, expected) || secretsMatch(xHeader, expected);
}

export async function GET(request) {
  if (!process.env.ROCKETLANE_WEBHOOK_SECRET) {
    return new Response('Server misconfigured', { status: 500 });
  }
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  // The rewrite in vercel.json maps /api/result/:runId onto ?runId=:runId.
  const runId = (url.searchParams.get('runId') || '').trim();
  if (!runId) {
    return Response.json({ error: 'Missing runId' }, { status: 400 });
  }
  // Run IDs are `${base36 ms}-${base36 rand}` (lib/run-log.js). Constrain the
  // value before it reaches a blob prefix lookup so a caller cannot list the
  // store by passing a partial or crafted prefix. The random suffix is
  // normally 6 chars but can be shorter — Math.random().toString(36) is not
  // fixed-width — so don't pin the length.
  if (!/^[a-z0-9]+-[a-z0-9]{1,8}$/.test(runId)) {
    return Response.json({ error: 'Malformed runId' }, { status: 400 });
  }

  let results;
  try {
    results = await loadResults(runId);
  } catch (err) {
    console.error(`[result] lookup failed for run ${runId}:`, err);
    return Response.json({ error: 'Result lookup failed' }, { status: 502 });
  }

  if (!results.length) {
    return Response.json(
      { error: 'No result for that runId', runId, hint: 'The run may still be in progress.' },
      { status: 404 },
    );
  }

  return Response.json({ runId, count: results.length, results });
}

export const config = {
  maxDuration: 30,
};

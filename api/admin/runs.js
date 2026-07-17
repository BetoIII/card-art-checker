import { list, put } from '@vercel/blob';

// A run whose record still says 'running' but hasn't been written in this
// long is definitively dead: every entry point caps at maxDuration 300s, so
// no live function can go 6 minutes without its startup write aging past
// this. (Killed functions never get to write a terminal status — see
// lib/run-log.js — so we repair the record here, lazily, on read.)
const STALE_RUNNING_MS = 6 * 60 * 1000;

function repairIfStale(run, pathname) {
  if (run.status !== 'running') return null;
  const lastWrite = new Date(run.updatedAt || run.startedAt).getTime();
  if (!Number.isFinite(lastWrite) || Date.now() - lastWrite < STALE_RUNNING_MS) return null;

  const lastStep = run.events?.[run.events.length - 1]?.step;
  run.status = 'failed';
  run.error = `Died without a terminal write (function timed out or was aborted${lastStep ? ` during "${lastStep}"` : ''})`;
  run.finishedAt = run.updatedAt;
  run.durationMs = lastWrite - new Date(run.startedAt).getTime();
  run.staleRepaired = true;

  return put(pathname, JSON.stringify(run), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
  }).catch((err) => console.error(`[admin/runs] stale-repair write failed for ${pathname}:`, err));
}

// Run history for the /admin dashboard. Run records are JSON blobs under
// runs/ written by lib/run-log.js; their keys embed an inverted timestamp, so
// a plain prefix list is already newest-first — no full-store pagination.
export async function GET(request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 200);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ error: 'BLOB_READ_WRITE_TOKEN is not configured' }, { status: 500 });
  }

  const { blobs } = await list({ prefix: 'runs/', limit });

  // Cache-buster query param: run blobs are overwritten in place while a run
  // is live, and the public blob CDN can serve a stale copy for up to a
  // minute otherwise.
  const runs = await Promise.all(
    blobs.map(async (blob) => {
      try {
        const res = await fetch(`${blob.url}?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const run = await res.json();
        await repairIfStale(run, blob.pathname);
        return run;
      } catch (err) {
        console.error(`[admin/runs] failed to read ${blob.pathname}:`, err);
        return null;
      }
    })
  );

  return Response.json(
    { runs: runs.filter(Boolean) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

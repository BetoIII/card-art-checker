import { list } from '@vercel/blob';

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
        return await res.json();
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

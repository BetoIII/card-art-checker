import { timingSafeEqual } from 'node:crypto';
import { next } from '@vercel/functions';

// Light password gate for the admin dashboard: HTTP Basic Auth over /admin and
// /api/admin/*, checked against ADMIN_PASSWORD. Any username is accepted — the
// password is the only credential. The browser's native prompt handles the UI,
// and its cached credentials cover the page's own fetches to /api/admin/*.
// Fails closed when ADMIN_PASSWORD is unset.

function passwordsMatch(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export default function middleware(request) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return new Response('Admin auth is not configured (set ADMIN_PASSWORD)', { status: 503 });
  }

  const header = request.headers.get('authorization') || '';
  if (header.toLowerCase().startsWith('basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    } catch { /* malformed base64 → fall through to 401 */ }
    // "user:pass" → everything after the first colon; a bare value (no colon)
    // is treated as the password so curl -u :pass and pasted tokens both work.
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password && passwordsMatch(password, expected)) return next();
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Card Art Checker Admin", charset="UTF-8"' },
  });
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/admin', '/admin.html', '/api/admin/:path*'],
};

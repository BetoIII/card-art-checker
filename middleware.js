import { createHash, timingSafeEqual } from 'node:crypto';
import { next } from '@vercel/functions';

// Light password gate for the admin dashboard (/admin and /api/admin/*),
// checked against ADMIN_PASSWORD. Fails closed when ADMIN_PASSWORD is unset.
//
// The browser's native Basic Auth dialog always shows a username field, so
// page requests get a password-only login form served straight from this
// middleware instead. A correct POST sets an HttpOnly session cookie holding
// sha256(password) — rotating ADMIN_PASSWORD invalidates every session — and
// the cookie then covers the page and its same-origin /api/admin/* fetches.
// An Authorization: Basic header (any username) is still accepted so curl and
// scripts can hit /api/admin/* directly.

const COOKIE = 'card_art_admin';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const sessionToken = (password) => createHash('sha256').update(password).digest('hex');

function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1);
  }
  return undefined;
}

function basicAuthPassword(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('basic ')) return undefined;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  // "user:pass" → everything after the first colon; a bare value (no colon)
  // is treated as the password so curl -u :pass and pasted tokens both work.
  return decoded.slice(decoded.indexOf(':') + 1);
}

function loginPage(error) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rain — Admin Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: #FFFFFF; color: #000000;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px; -webkit-font-smoothing: antialiased;
    }
    .card {
      width: 100%; max-width: 360px; position: relative; padding-top: 20px;
    }
    .card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(135deg, #EEEEEE 0%, #71FFFF 48%, #71FF7D 100%);
      border-radius: 2px;
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
    p.sub { font-size: 13px; color: #121212; opacity: 0.7; margin-bottom: 20px; letter-spacing: 0.4px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; letter-spacing: 0.4px; }
    input[type="password"] {
      width: 100%; padding: 10px 12px; font-size: 14px; font-family: inherit;
      border: 1px solid #D8DCDF; border-radius: 8px; outline: none;
    }
    input[type="password"]:focus { border-color: #3B5BDB; }
    button {
      margin-top: 14px; width: 100%; padding: 11px 20px; border: none; border-radius: 8px;
      background: #000000; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    .error {
      margin-bottom: 14px; padding: 8px 12px; font-size: 13px; color: #E84142;
      background: rgba(232, 65, 66, 0.06); border: 1px solid rgba(232, 65, 66, 0.25); border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Card Art Checker — Admin</h1>
    <p class="sub">Enter the admin password to continue.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(body, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function middleware(request) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return new Response('Admin auth is not configured (set ADMIN_PASSWORD)', { status: 503 });
  }

  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');

  // Already signed in (cookie), or curl-style Basic auth.
  const cookie = getCookie(request, COOKIE);
  if (cookie && safeEqual(cookie, sessionToken(expected))) return next();
  const basicPassword = basicAuthPassword(request);
  if (basicPassword && safeEqual(basicPassword, expected)) return next();

  // API requests never see the HTML form.
  if (isApi) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  // Login form submission.
  if (request.method === 'POST') {
    let password = '';
    try {
      const form = await request.formData();
      password = String(form.get('password') || '');
    } catch { /* not form data → treat as wrong password */ }
    if (password && safeEqual(password, expected)) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.pathname,
          'Set-Cookie': `${COOKIE}=${sessionToken(expected)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return loginPage('Incorrect password — try again.');
  }

  return loginPage();
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/admin', '/admin.html', '/api/admin/:path*'],
};

/* Shared top navigation for the card-art-checker front end.
 *
 * Usage — in <head>, after the page's own <style>:
 *
 *   <link rel="stylesheet" href="/assets/nav.css">
 *   <script src="/assets/nav.js" data-tag="Playground"></script>
 *
 * Options, as data attributes on the script tag:
 *
 *   data-tag           the mono label beside the brand (this page's name)
 *   data-auto-theme    follow the viewer's local time: light by day, dark by
 *                      night; only for pages that actually define a
 *                      [data-theme="dark"] palette
 *   data-menu          selector of a drawer the hamburger opens
 *   data-menu-scrim    selector of the backdrop shown alongside it
 *
 * Deliberately a plain blocking script in <head>, not deferred: it reserves
 * the bar's height and sets the theme before first paint, so the page neither
 * shifts down nor flashes the wrong palette. Only the markup injection waits
 * for <body>.
 *
 * /upload is embedded in Rocketlane through an iframe. A framed page gets no
 * bar at all — and, because the height is reserved by a class this script
 * adds rather than by a rule in the stylesheet, no leftover gap either. */

(() => {
  'use strict';

  const script = document.currentScript;
  const cfg = script ? script.dataset : {};
  const root = document.documentElement;

  // Nothing renders inside an iframe: the embed shows the form, not our chrome.
  if (window.self !== window.top) return;

  /* ── Before first paint ──────────────────────────────── */

  root.classList.add('rn-nav-on');

  // Light from DAY_START to DAY_END in the viewer's own time zone, dark
  // otherwise. A page left open flips at the boundary, and a tab coming back
  // from the background re-checks in case a sleeping timer missed it.
  const DAY_START = 7;
  const DAY_END = 19;

  if (cfg.autoTheme !== undefined) {
    const applyTheme = () => {
      const h = new Date().getHours();
      root.setAttribute('data-theme', h >= DAY_START && h < DAY_END ? 'light' : 'dark');
    };
    const msToNextSwitch = () => {
      const now = new Date();
      const h = now.getHours();
      const next = new Date(now);
      // setHours rolls 24 + DAY_START over to tomorrow morning.
      next.setHours(h < DAY_START ? DAY_START : h < DAY_END ? DAY_END : 24 + DAY_START, 0, 0, 0);
      return next - now;
    };
    const schedule = () => {
      applyTheme();
      setTimeout(schedule, msToNextSwitch() + 1000);
    };

    schedule();
    document.addEventListener('visibilitychange', applyTheme);
  }

  /* ── Destinations ────────────────────────────────────── */

  // Every href here is a route that exists: '/' and rewrites declared in
  // vercel.json. Keep them in step. /upload is deliberately absent: it is the
  // customer form reached through Rocketlane, not a page to browse to.
  const LINKS = [
    { href: '/',          label: 'Playground' },
    { href: '/reference', label: 'Reference' },
    { href: '/admin',     label: 'Admin' },
  ];

  // '/upload.html' and '/upload' are the same page; '/' and '/index.html' too.
  const normalize = (path) => {
    const p = path.replace(/\.html$/, '').replace(/\/+$/, '');
    return p === '' || p === '/index' ? '/' : p;
  };
  const here = normalize(location.pathname);

  /* ── Markup ──────────────────────────────────────────── */

  const svg = (paths, extra = '') =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" ${extra}>${paths}</svg>`;

  const menuIcon = svg('<path d="M2 4h12M2 8h12M2 12h12"/>');

  const build = () => {
    const bar = document.createElement('header');
    bar.className = 'rn-nav';

    const links = LINKS.map((l) => {
      const current = normalize(l.href) === here;
      return `<a class="rn-link" href="${l.href}"${current ? ' aria-current="page"' : ''}>${l.label}</a>`;
    }).join('');

    bar.innerHTML =
      (cfg.menu
        ? `<button class="rn-btn" id="rn-menu" aria-label="Open navigation" aria-expanded="false">${menuIcon}</button>`
        : '') +
      `<a class="rn-brand" href="/">
         <span class="rn-brand-name">Card Art Checker</span>
         ${cfg.tag ? `<span class="rn-brand-tag">${cfg.tag}</span>` : ''}
       </a>
       <div class="rn-nav-spacer-flex"></div>
       <nav class="rn-links" aria-label="Site">${links}</nav>`;

    document.body.prepend(bar);

    /* ── Drawer ────────────────────────────────────────── */

    const menuBtn = bar.querySelector('#rn-menu');
    const drawer = cfg.menu ? document.querySelector(cfg.menu) : null;
    if (menuBtn && drawer) {
      const scrim = cfg.menuScrim ? document.querySelector(cfg.menuScrim) : null;
      const set = (open) => {
        drawer.classList.toggle('open', open);
        if (scrim) scrim.classList.toggle('open', open);
        menuBtn.setAttribute('aria-expanded', String(open));
      };

      menuBtn.addEventListener('click', () => set(!drawer.classList.contains('open')));
      if (scrim) scrim.addEventListener('click', () => set(false));
      // Following a link inside the drawer should close it behind you.
      drawer.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
    }
  };

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();

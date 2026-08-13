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
 *   data-theme-toggle  render a light/dark button; only for pages that
 *                      actually define a [data-theme="dark"] palette
 *   data-menu          selector of a drawer the hamburger opens
 *   data-menu-scrim    selector of the backdrop shown alongside it
 *
 * Deliberately a plain blocking script in <head>, not deferred: it reserves
 * the bar's height and restores the stored theme before first paint, so the
 * page neither shifts down nor flashes the wrong palette. Only the markup
 * injection waits for <body>.
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

  const THEME_KEY = 'cac-theme';
  if (cfg.themeToggle !== undefined) {
    const stored = localStorage.getItem(THEME_KEY);
    root.setAttribute(
      'data-theme',
      stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    );
  }

  /* ── Destinations ────────────────────────────────────── */

  // Every href here is a route that exists: '/' and the three rewrites
  // declared in vercel.json. Keep them in step.
  const LINKS = [
    { href: '/',          label: 'Playground' },
    { href: '/upload',    label: 'Submit' },
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
  const sunIcon = svg(
    '<circle cx="8" cy="8" r="3.1"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1' +
    'M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/>',
    'class="rn-icon-sun"',
  );
  const moonIcon = svg(
    '<path d="M13.5 9.6A5.8 5.8 0 016.4 2.5a5.9 5.9 0 107.1 7.1z"/>',
    'class="rn-icon-moon" stroke-linejoin="round"',
  );

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
       <nav class="rn-links" aria-label="Site">${links}</nav>` +
      (cfg.themeToggle !== undefined
        ? `<button class="rn-btn" id="rn-theme" aria-label="Toggle dark mode">${sunIcon}${moonIcon}</button>`
        : '');

    document.body.prepend(bar);

    /* ── Theme ─────────────────────────────────────────── */

    const themeBtn = bar.querySelector('#rn-theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        localStorage.setItem(THEME_KEY, next);
      });
    }

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

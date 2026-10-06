#!/usr/bin/env node
// Regenerate the check catalog on /reference from lib/check-catalog.js.
//
//   node scripts/sync-reference.js           rewrite reference.html in place
//   node scripts/sync-reference.js --check   exit 1 if the page is stale
//
// reference.html stays a static page — no runtime fetch, nothing to break if
// a script fails. The catalog block between the markers below is written by
// this script and nothing else; tests/reference-page.test.js fails when it
// no longer matches the catalog, and running this script is the fix.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCatalog, REASON_DESCRIPTIONS } from '../lib/check-catalog.js';

export const START = '<!-- generated:catalog -->';
export const END = '<!-- /generated:catalog -->';

const PAGE = fileURLToPath(new URL('../reference.html', import.meta.url));

// Which part of the card each rule governs, for the zone diagram above the
// catalog. A presentation fact, so it lives here rather than in the catalog.
export const CHECK_ZONES = {
  visa_brand_mark_present: 'mark',
  visa_brand_mark_position: 'mark',
  visa_brand_mark_size: 'mark',
  visa_brand_mark_margin: 'mark',
  visa_brand_mark_contrast: 'mark',
  visa_brand_mark_color: 'mark',
  product_identifier: 'identifier',
  design_elements_clear_of_identifier: 'identifier',
  lower_left_area_clear: 'pan',
  issuer_logo_present: 'card',
  issuer_logo_within_border: 'card',
  contactless_indicator: 'card',
  no_emv_chip: 'card',
  no_hologram: 'card',
  no_magnetic_stripe: 'card',
  no_cardholder_name: 'card',
  no_pan: 'card',
  no_expiry_date: 'card',
  no_physical_card_photography: 'card',
  art_fills_canvas: 'card',
  landscape_orientation: 'card',
  full_color: 'card',
};

const CATEGORY_TITLES = {
  brand_mark: 'Brand mark',
  product_identifier: 'Product identifier',
  required_elements: 'Required elements',
  prohibited: 'Prohibited elements',
  layout: 'Layout',
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const indent = (lines, n) => lines.map((l) => (l ? ' '.repeat(n) + l : l));

function renderCheck(check) {
  const reasons = check.reason_codes.map((code) => [
    `  <dt><code>${esc(code)}</code></dt>`,
    `  <dd>${esc(REASON_DESCRIPTIONS[code] ?? '')}</dd>`,
  ]).flat();
  return [
    `<article class="check" id="check-${check.id}" data-zone="${CHECK_ZONES[check.id] ?? 'card'}" data-severity="${check.severity}">`,
    '  <div class="check-head">',
    `    <code class="check-id">${check.id}</code>`,
    `    <span class="sev ${check.severity}">${check.severity}</span>`,
    `    <a class="anchor" href="#check-${check.id}" aria-label="Link to ${check.id}">#</a>`,
    '  </div>',
    `  <p class="check-name">${esc(check.name)}</p>`,
    '  <dl class="reasons">',
    ...indent(reasons, 2),
    '  </dl>',
    '</article>',
  ];
}

// The block between the markers, indented to sit inside <section id="checks">.
export function renderCatalog() {
  const groups = new Map();
  for (const check of getCatalog('virtual')) {
    if (!groups.has(check.category)) groups.set(check.category, []);
    groups.get(check.category).push(check);
  }

  const lines = ['<div class="catalog" id="catalog">'];
  for (const [category, checks] of groups) {
    const title = CATEGORY_TITLES[category] ?? category;
    lines.push(
      `  <div class="catalog-group" data-category="${category}">`,
      `    <h3 id="checks-${category}">${esc(title)} <a class="anchor" href="#checks-${category}" aria-label="Link to ${esc(title)}">#</a></h3>`,
      ...indent(checks.flatMap(renderCheck), 4),
      '  </div>',
    );
  }
  lines.push('</div>');
  return indent(lines, 6).join('\n');
}

// Swap the marked block in `html` for a fresh render.
export function syncCatalog(html) {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`reference.html is missing the ${START} … ${END} markers`);
  }
  return `${html.slice(0, start + START.length)}\n${renderCatalog()}\n      ${html.slice(end)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(PAGE, 'utf8');
  const next = syncCatalog(html);
  if (process.argv.includes('--check')) {
    if (next !== html) {
      console.error('reference.html is out of date — run: node scripts/sync-reference.js');
      process.exit(1);
    }
    console.log('reference.html catalog is up to date.');
  } else if (next !== html) {
    writeFileSync(PAGE, next);
    console.log('reference.html catalog regenerated.');
  } else {
    console.log('reference.html catalog already up to date.');
  }
}

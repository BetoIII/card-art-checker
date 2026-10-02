import Anthropic from '@anthropic-ai/sdk';
import { put as blobPut, del as blobDel } from '@vercel/blob';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { readFileSync, existsSync } from 'fs';
import { resolve as pathResolve, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { extOf, inferCardType } from './card-type.js';
import { buildCheckListForPrompt, buildReasonCodeReference } from './check-catalog.js';
import { applyTechVerdicts } from './tech-verdicts.js';
import { getImageSize } from './image-size.js';

const __pipelineDir = pathDirname(fileURLToPath(import.meta.url));

// ── Canonical physical templates (Rain designers, 2026-07) ─────────
// The 12 Visa products the canonical templates cover. Golden previews for
// each product x orientation (plus the single standardized back) are
// committed under assets/templates/ and mounted as a visual reference when
// the submission's product can be inferred.
const PHYSICAL_PRODUCTS = [
  'Debit', 'Business Debit', 'Corporate',
  'Platinum', 'Platinum Business', 'Platinum Corporate',
  'Signature', 'Signature Business', 'Signature Corporate',
  'Infinite', 'Infinite Business', 'Infinite Corporate',
];

function productSlug(product) {
  return product.toLowerCase().replace(/\s+/g, '-');
}

// Best-effort product detection: tier OCG layer name (template-derived .ai
// files carry one — surfaced by the spec checker), then filename tokens.
// Longest names first so "Signature Business" wins over "Signature".
export function detectPhysicalProduct(techJson, fileName = '') {
  const fromLayers = techJson?.front?.checks?.layers_present?.product_tier;
  if (fromLayers && PHYSICAL_PRODUCTS.includes(fromLayers)) return fromLayers;
  const normalized = (fileName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const byLength = [...PHYSICAL_PRODUCTS].sort((a, b) => b.length - a.length);
  for (const product of byLength) {
    if (normalized.includes(product.toLowerCase())) return product;
  }
  return null;
}

// Resolve the committed golden-preview PNG for a product+orientation (and
// the shared back). Returns null when unavailable — the prompt degrades to
// identifier-only checking.
function referenceTemplateBuffers(product, orientation) {
  const dir = pathResolve(__pipelineDir, '../assets/templates');
  const frontPath = pathResolve(dir, `${productSlug(product)}_${orientation}.png`);
  const backPath = pathResolve(dir, 'back_horizontal.png');
  try {
    if (!existsSync(frontPath)) return null;
    return {
      front: readFileSync(frontPath),
      back: existsSync(backPath) ? readFileSync(backPath) : null,
    };
  } catch (err) {
    console.warn('Reference template load failed:', err?.message || err);
    return null;
  }
}

// ── Lazy Anthropic client ───────────────────────────────────────────

let _anthropic;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
    });
  }
  return _anthropic;
}

// ── Prompts ─────────────────────────────────────────────────────────

function mimeForPhysicalExt(ext) {
  switch (ext) {
    case '.eps': return 'application/postscript';
    case '.png': return 'image/png';
    case '.ai':
    default:     return 'application/illustrator';
  }
}

// Exported so tests can assert the generated RESULTS_JSON block stays in sync
// with lib/check-catalog.js — that coupling is the whole drift guard.
//
// options.declaredProduct — the Visa product the program is provisioned as
// (normalizeDeclaredProduct output), when the caller supplied one. Virtual
// only: it lets the agent check the identifier against the product rather
// than just checking that some valid identifier is present.
export function buildVisualPrompt(techJson, cardType = 'virtual', hasBack = false, cropPaths = [], options = {}) {
  if (cardType === 'physical') return buildPhysicalVisualPrompt(techJson, hasBack);
  return buildVirtualVisualPrompt(techJson, cropPaths, options);
}

// The 12 canonical Visa products plus the tiers Visa's feedback names on
// virtual submissions. Longest names first so "Signature Corporate" wins
// over "Signature".
const DECLARED_PRODUCTS = [...PHYSICAL_PRODUCTS, 'Business', 'Classic']
  .sort((a, b) => b.length - a.length);

// Map a caller-supplied product ("Visa Signature Corporate", "platinum",
// "SIGNATURE BUSINESS") onto a canonical product name, or null when it names
// none. Free text never reaches the prompt — only a canonical name does.
export function normalizeDeclaredProduct(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!text) return null;
  const words = ` ${text} `;
  return DECLARED_PRODUCTS.find((p) => words.includes(` ${p.toLowerCase()} `)) || null;
}

function buildVirtualVisualPrompt(techJson, cropPaths = [], { declaredProduct = null } = {}) {
  const cropDescriptions = {
    brand_mark: 'the Visa Brand Mark corner at 2× zoom — use for mark legibility, color, contrast, and the product identifier\'s typeface, weight, alignment and lettering',
    issuer: 'the issuer-logo corner and the side band below it at 2× zoom — where a contactless symbol usually sits',
    lower_left: 'the lower-left personalization zone at native resolution',
    reference_lockup: 'Visa\'s OFFICIAL lockup (from Visa\'s artwork files), same corner as brand_mark — the identified or closest tier at the same 2× zoom, or a 1× sheet of all four tiers (Platinum, Signature, Infinite, Corporate) when no tier is close. Compare the submission\'s wordmark and identifier against it',
  };
  const cropBlock = cropPaths.length
    ? `\nPre-rendered zoom crops are mounted for close inspection — \`read\` these instead of cropping or zooming yourself:\n${cropPaths.map(p => {
        const name = (p.split('/').pop() || '').replace(/\.png$/, '');
        return `- ${p} — ${cropDescriptions[name] || 'zoom crop'}`;
      }).join('\n')}\n`
    : '';
  const copy = techJson?.working_copy;
  const copyBlock = copy
    ? `\nThe upload is ${copy.original_width}x${copy.original_height}. Every TECH_SPEC_RESULTS pixel
measurement and every zoom crop is taken from a ${copy.width}x${copy.height} copy (the 1536px canvas
scale); "dimensions" describes the original.\n`
    : '';
  const productBlock = declaredProduct
    ? `\nDECLARED PRODUCT: the program is provisioned as "${declaredProduct}". The product
identifier on the card must read exactly "${declaredProduct}": every word, in that
order. Fail with reason_code "identifier_tier_mismatch" for a different tier, a
tier-only identifier where the product carries a business/corporate qualifier, or the
right words in a different order (e.g. "Corporate Signature" for a "Signature
Corporate" program).\n`
    : `\nNo declared product was supplied, so the tier cannot be matched to the program —
check only that the identifier is a valid Visa product and do not use
"identifier_tier_mismatch".\n`;
  return `Analyze the card art image at /mnt/session/uploads/card-art.png for compliance with Visa Digital Card Brand Standards (September 2025), Visa's current submission feedback, and Rain's internal requirements.
${cropBlock}${copyBlock}${productBlock}
The technical spec checks have ALREADY been run. Here are the results — do NOT re-run the script:

TECH_SPEC_RESULTS:
${JSON.stringify(techJson, null, 2)}

## Your Task: Visual Inspection ONLY (22 checks)

Tool budget: every pixel measurement you need is already provided in TECH_SPEC_RESULTS,
and zoom crops (if listed above) are already rendered. Inspect by \`read\`ing the mounted
files — do NOT write Python/PIL code to measure pixels, crop regions, or zoom in.

Deterministic results win. Several checks below mirror a TECH_SPEC_RESULTS entry.
When that entry has "passed": false, the matching visual check is a FAIL — use the
entry's "reason_code" and restate its measurement in the notes. When it is
"borderline": true, the visual check is a WARNING. When it is "passed": null (the
checker could not locate the Brand Mark or identifier), judge that check visually
and say so in the notes. A passing entry does not stop you failing the visual check
for a problem the measurement cannot see.

Examine the card art image visually and evaluate:

Required Elements:
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position — mirrors tech "mark_position": upper-left or upper-right ONLY.
  A mark in a lower corner fails → "position_lower_edge", even when it measures 56px
  from the edges.
- Visa Brand Mark margin (CRITICAL — #1 rejection reason) — mirrors tech "bleed_zone".
  Visa places the mark AT 56px from its nearest top/bottom edge AND its nearest side
  edge — not "at least" 56px. A mark too FAR from the edge is rejected with the same
  wording as one too close ("should be placed at 56 pixels"). The checker measures the
  strict letter-tip distances (\`strict_*_px\`) and accepts 53-59px on both edges.
  Below 53 → reason_code "margin_below_minimum"; above 59 → "margin_above_target".
  There is no borderline/warning band for this check.
- Visa Brand Mark size — mirrors tech "mark_size". Visa's lockup is a 109px-tall mark
  (~11.2% of the 969px card height) with 170px from the top of the mark to the
  baseline of the product identifier. A mark noticeably smaller or larger fails
  ("size_undersized" / "size_oversized"), including the retired 142px "Option Two".
- Visa Brand Mark contrast: the "VISA" wordmark and the product identifier must both
  be clearly readable. A flat permitted ink on a plain ground PASSES even at modest
  contrast — Visa approves silver or gray marks on white or near-white cards, and white
  or black marks on monochrome cards — so never fail on a contrast ratio alone. Fail
  only when letters are genuinely hard to make out: an identifier in a different,
  weaker color than the wordmark (e.g. light silver "Platinum" under a white wordmark
  on pink) → "contrast_insufficient_identifier", or a wordmark that merges into a busy
  or same-tone background → "contrast_insufficient_wordmark". When it fails, recommend
  white or a higher-contrast color.
- Visa Brand Mark color — mirrors tech "mark_color" (sampled ink color and gradient
  spread). Permitted versions: white, black, Visa Blue (R20 G52 B203), or the Visa
  Gold / Silver premium ink versions — each FLAT. Fail a mark in any other color,
  including brown or dark gold ("mark_color_not_permitted"), and any mark with a
  gradient, metallic shading or sheen applied ("mark_gradient_applied"), even when
  the tech entry passed. A gold mark is a WARNING: Visa's feedback on Signature
  cards names white, black or Visa Blue only. A FLAT off-white — cream, ivory or a
  warm near-white close to white (e.g. #E4E1CD) — is also a WARNING with
  "mark_color_not_permitted", not a fail; a gradient or sheen on it still fails.
- Product identifier present and placed: every card MUST display a Visa product
  identifier — "Visa Platinum", "Visa Signature", or "Visa Infinite" (consumer),
  "Business" or "Corporate" (business/corporate), or the business/corporate variant of
  a tier (e.g. "Signature Business", "Signature Corporate"). Each is valid on its own;
  only a declared product can make one the wrong tier. Rain no longer offers the
  Classic tier, so an identifier is ALWAYS required — absence is an automatic fail. It
  must be placed directly below or immediately adjacent to the Visa Brand Mark,
  anchored to the same upper corner.
  Fail if: (a) no identifier visible, (b) identifier in the opposite corner from the
  Brand Mark, (c) identifier separated from the Brand Mark by unrelated graphics or
  large empty space, (d) identifier in the lower-left personalization zone,
  (e) MISALIGNED — mirrors tech "identifier_alignment": the identifier's edge must
  align with the mark's outer edge on the mark's side (right-aligned under an
  upper-right mark, left-aligned under an upper-left mark) → "identifier_misaligned",
  (f) wrong TYPEFACE or style — italicized, a different font, or modified lettering
  (e.g. a dotless "ı") instead of Visa's identifier type → "identifier_font_mismatch",
  (g) identifier text visibly too large or too small for the lockup (it sets the
  170px mark-top-to-baseline distance) → "identifier_size_mismatch",
  (h) the lockup is legible but is not Visa's official artwork — redrawn, re-typeset,
  distorted, or the wrong variant → "lockup_not_official_artwork". The official
  wordmark has a flag on the top-left of the V; that flag is correct.
  Checks (e)-(h) and the tier also mirror tech "lockup_match", which compares the
  lockup with Visa's official artwork: wordmark shape ("wordmark_iou"), identifier
  size relative to the mark ("identifier_size_ratio", 0.87-1.15 passes), and which
  official identifier it reads as ("identifier_tier", null when it matches none —
  e.g. a two-word identifier like "Signature Corporate"; "identifier_candidate_tier"
  then names the tier it most resembles, unconfirmed). When a reference_lockup crop
  is mounted, compare the identifier with it letter by letter at the same zoom for
  (f): stroke weight (bolder or lighter than Visa's fails), letter widths and
  spacing, and the shapes of individual letters.
  Casing that differs from Visa's official lockup fails → "identifier_casing": an
  all-caps "PLATINUM" or a lowercase "platinum" where the lockup reads "Platinum".
  (The "VISA" wordmark itself is always capitals.)
- Issuer logo present: a missing issuer logo is a WARNING, never a fail →
  "issuer_logo_absent". Visa approves virtual art without one.
- Partner/issuer logo outside the 56px bleed zone — mirrors tech "issuer_logo_border".
  Partner and issuer logos keep out of the same 56px bleed zone as the Visa Brand
  Mark: no part of a logo within 53px of any card edge. A logo farther in is fine
  (unlike the mark, logos are not held to exact placement). Background artwork
  may still bleed to the edge — only logos count → "issuer_logo_in_bleed_zone".
  When the tech entry is null (no logo located), a few pixels can't be judged by eye:
  fail only a logo that is clearly closer to the edge than the Brand Mark's 56px; one
  that sits about as far in as the mark is a WARNING with the same code.
- Contactless indicator correct (if present): the indicator is ALLOWED — even if the
  physical card is not contactless enabled — and its absence is a pass. When present
  it must be the official EMVCo contactless symbol: four arcs that grow in size from
  left to right, each bulging to the RIGHT like ")))". Arcs that bulge to the LEFT,
  like "(((", are mirrored or rotated 180° → "contactless_indicator_rotated", as are
  rotated or upside-down arcs; any other wrong or redrawn glyph →
  "contactless_indicator_incorrect". Read the issuer crop, which covers the side band
  where the symbol usually sits, before judging its direction.

Prohibited Elements:
- No EMV chip graphic
- No hologram imagery
- No magnetic stripe graphic
- No cardholder name
- No PAN / card number: any card-number digits fail, including masked or partial
  numbers (e.g. "•••• 1234" or a lone last-4 group) — the wallet overlays the real
  last 4 digits itself.
- No expiry date
- No physical card photography or 3D effects

Layout & Quality:
- Lower-left area clear: reserved for PAN personalization (last-4 digits overlay). It
  must not contain discrete marks or graphics that would reduce readability of overlaid
  PAN digits — no issuer logos, brand names, icons, or text. Background patterns and
  subtle decorative elements ARE allowed: thin lines, curves, gradients, textures, and
  guilloche patterns that are clearly part of the overall background design do NOT fail
  this check. The key question: would the element meaningfully reduce the legibility of
  white or light-colored PAN digits overlaid on top of it? A thin decorative curve on a
  dark background passes; a logo, icon, or high-contrast graphic fails
  ("pan_zone_obstructed"), whatever its size. WARNING ("pan_zone_legibility_risk") is
  only for an illustration detail that is more than background texture but leaves
  overlaid white digits clearly legible; decide pass, warning or fail by these rules,
  not by how busy the zone feels.
- Design elements clear of product identifier — mirrors tech "identifier_clearance",
  which counts artwork pixels within 4px of the identifier's letters: no artwork,
  logos, or design elements obscuring or touching the Visa product identifier text
  → "identifier_obstructed"
- Art fills the canvas — mirrors tech "border_frame": the design runs to every edge of
  the 1536x969 canvas. White or gray border lines, transparent padding, or a frame
  around the art (a card-on-background render) fail → "border_frame_present". The tech
  entry catches padding and uniform edge lines; judge a card rendered on a white or
  colored canvas visually.
- Horizontal (landscape) orientation
- Full color (not grayscale). EXCEPTION: an intentionally monochrome design (e.g. an
  all-black, all-white, or black-and-silver card with white or black marks) is a pass,
  not a warning — grayscale here means a design that appears to have lost its color in
  export.

Canvas checks (tech only — no visual_checks entry): "square_corners" (virtual art must
have square corners; the wallet applies its own mask) and "border_frame". If either
failed in TECH_SPEC_RESULTS, mention it in the summary.

Bleed rules reminder: the Visa Brand Mark sits AT 56px; partner and issuer logos stay
at least 53px from the edges; artwork and background may extend to the card edge.

For EACH check, determine: pass | fail | warning

Overall status: any failing check — visual or TECH_SPEC_RESULTS — means REQUIRES
CHANGES. Warnings alone mean APPROVED WITH NOTES.

## Location markers

For any FAIL or WARNING where a specific location on the card caused the issue, add
"marker_x" and "marker_y" fields (floats 0.0-1.0; x: 0.0 = left edge, 1.0 = right edge;
y: 0.0 = top, 1.0 = bottom) to that check, placed at the approximate center of the issue.
Only location-specific issues get markers (e.g. a contrast failure gets a marker at the
Visa logo; a margin failure gets one at the offending edge; a logo in the lower-left gets
one on that logo). Global or absence checks (orientation, grayscale, no-cardholder-name,
missing identifier) get NO marker. Omit both fields entirely for passes.

## Output Structured Results JSON

CRITICAL: You MUST output a JSON block between these exact markers. The system parses this to generate the PDF report. Without it, no report is created.

Do NOT repeat the technical check results or colors in your output — the system already has TECH_SPEC_RESULTS and merges them into the report itself. Output ONLY the fields shown below.

Reproduce the "id" values below EXACTLY as given — they are the stable machine
identifiers downstream systems key on. Do not rename, merge, reorder, or omit
entries, and do not add entries of your own to this array. You may adjust a
"name" to record what you measured; "id" must never change.

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "visual_checks": [
${buildCheckListForPrompt('virtual')}
  ]
}
RESULTS_JSON_END

## Reason Codes

For every check whose result is "fail" or "warning", add a "reason_code" field
naming the cause. Use the code listed for that check below, or "other" if none
of them fit. Passing checks get no "reason_code".

${buildReasonCodeReference('virtual')}

Two codes apply to any check: "source_is_screenshot" (the submission is a
screenshot or mockup rather than the production file, so measurements cannot be
trusted) and "source_not_production_file".

## Output Status Lines

After the JSON block, output exactly two lines and nothing else:

STATUS: APPROVED | REQUIRES CHANGES | APPROVED WITH NOTES
SUMMARY: <1-2 sentence overview>`;
}

function buildPhysicalVisualPrompt(techJson, hasBack) {
  const frontPreview = techJson?.front?.rendered_preview_path || '/mnt/session/uploads/front_render.png';
  const backPreview = techJson?.back?.rendered_preview_path || '/mnt/session/uploads/back_render.png';
  const frontOrientation = techJson?.front?.orientation || 'horizontal';
  const backFromPage2 = /\(page 2\)/.test(techJson?.back?.file || '');
  const detectedProduct = techJson?.detected_product || null;
  const hasReference = !!techJson?.reference_template_mounted;
  const backBlock = hasBack
    ? `You also have the back-of-card render at ${backPreview}${backFromPage2 ? ' (page 2 of the submitted file — Rain\'s canonical templates are one 2-page file: front, back)' : ''}. Inspect both sides.`
    : `The submitter did NOT provide a back-of-card file. For every back-of-card check below, set "result": "not submitted" and explain in the notes that the optional back file was omitted.`;

  const referenceBlock = hasReference
    ? `
## Canonical Template Reference

The submission was identified as a "${detectedProduct}" card. Rain's canonical designer template for that product (${frontOrientation}) is mounted at /mnt/session/uploads/reference_template.png${hasBack ? ', and the standardized canonical back at /mnt/session/uploads/reference_back.png' : ''}. \`read\` it and compare the submission against it:
- FIXED elements must match the template: chip position, VISA Brand Mark lockup position and its product identifier text, and (back) magstripe/personalization/issuer-text/contactless layout.
- The BACKGROUND ARTWORK is the customer's design and is EXPECTED to differ — do not flag background differences.
` : detectedProduct
      ? `\nThe submission was identified as a "${detectedProduct}" card (no canonical reference preview was available for comparison).\n`
      : `\nThe product tier could not be inferred from the file. For the product-identifier check, verify the identifier is one of the 12 canonical products: ${'Debit, Business Debit, Corporate, Platinum, Platinum Business, Platinum Corporate, Signature, Signature Business, Signature Corporate, Infinite, Infinite Business, Infinite Corporate'} — positioned adjacent to the VISA Brand Mark.\n`;

  // Zoom crops written by the spec script next to the rendered previews,
  // keys namespaced by side (absent on failure — degrade to no crop block
  // rather than referencing files that don't exist).
  const cropDescriptions = {
    front_brand_mark: 'the Visa Brand Mark corner at 2× zoom — use for mark legibility, color, contrast, and the product identifier',
    front_issuer: 'the issuer-logo corner at 2× zoom',
    front_lower_left: 'the lower-left zone at native resolution',
    back_magstripe: 'the back top zone (magstripe band) at native resolution',
    back_issuer_text: 'the back issuer-statement zone at 2× zoom — use to verify the exact issuer text',
  };
  const zoomCrops = techJson?.front?.zoom_crops || {};
  const cropBlock = Object.keys(zoomCrops).length
    ? `\nPre-rendered zoom crops are available — \`read\` these instead of cropping or zooming yourself:\n${Object.entries(zoomCrops).map(([name, p]) => `- ${p} — ${cropDescriptions[name] || 'zoom crop'}`).join('\n')}\n`
    : '';

  return `Analyze the physical card art for compliance with Visa Physical Card Brand Standards and Rain's internal requirements.

Front render: ${frontPreview}
${backBlock}
${cropBlock}${referenceBlock}
The technical spec checks have ALREADY been run. Here are the results — do NOT re-run the script:

TECH_SPEC_RESULTS:
${JSON.stringify(techJson, null, 2)}

## Your Task: Visual Inspection ONLY

Tool budget: every pixel measurement you need is already provided in TECH_SPEC_RESULTS,
and zoom crops (if listed above) are already rendered. Inspect by \`read\`ing the preview
and crop files — do NOT write Python/PIL code to measure pixels, crop regions, or zoom in.

Examine the rendered preview image(s) visually. Note: physical cards may LEGITIMATELY show chip graphics, magnetic stripes, holograms, and 3D effects — these are NOT prohibited on physical cards (unlike virtual).

Orientation: the technical checker detected a ${frontOrientation.toUpperCase()} front (from the file's TrimBox). BOTH orientations are allowed — Rain's canonical templates ship in horizontal AND vertical. On vertical fronts the Visa Brand Mark lockup stays in the lower-right and the chip sits near the top. The BACK is ALWAYS horizontal, even when the front is vertical — do NOT flag a horizontal back on a vertical card as rotated or inconsistent.

Required Elements (Front):
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position: lower right, upper right, or upper left (lower-left is NOT allowed)
- Visa Brand Mark color is one of: Visa Blue, White, Black, Silver, or Gold (or PVBM in Blue/Silver/Gold/Black)
- Visa Brand Mark contrast: strong against background
- Visa Brand Mark quiet zone (~3mm from trim edges): the technical checker has
  already measured edge distances from the TRIM line and emitted a \`bleed_zone\`
  result in TECH_SPEC_RESULTS above. Do NOT re-measure; just mirror that
  pass/warning/fail verdict in the matching visual_checks entry with a concise
  human-readable note.
- Product identifier: the product name lockup adjacent to the VISA Brand Mark
  (e.g. "Signature" below the mark, "DEBIT" above it). ${hasReference
    ? `Must read "${detectedProduct}" and match the reference template's lockup.`
    : detectedProduct
      ? `Expected to read "${detectedProduct}".`
      : 'Must be one of the 12 canonical Visa products.'}
- Chip position: ${hasReference
    ? 'must match the reference template (vertical fronts place the chip near the top).'
    : 'standard ISO placement — left-center on horizontal fronts, near the top on vertical fronts. A chip graphic may also be omitted from the artwork (applied at manufacturing).'}
- Issuer logo clearly present
- Rounded corners consistent with CR80 die-cut

Required Elements (Back — only if a back was submitted or derived from page 2).
Rain's canonical back is standardized: magstripe band near the top edge (~5mm
below trim, ~8mm tall), personalization block (cardholder name, business name,
PAN, expiry, security code), issuer text, and a contactless indicator on the
right. Check:
- Magnetic stripe area present near the top of the back
- PAN, expiry, and security code fields present
- Issuer text present and reads EXACTLY: "Card issued by Third National under
  license from Visa" (a trailing period is optional — Rain's canonical
  template omits it; any other wording difference is a fail)
- Contactless indicator present (rounded square + radiating arcs, right side)
- No MOCKED Visa Dove hologram drawn in the artwork: the real Dove hologram is
  applied during manufacturing, not in the art file. The canonical back has no
  dove. If the artwork fakes a dove/hologram graphic, mark WARNING and note it
  must be removed before production. If absent (normal), mark pass.

Template placeholders: Rain's templates ship with placeholder content — a flat
gray chip rectangle, a "John Doe / Business Name / 0000 3333 4444 5555 /
Exp. 05/28 / Code 123" personalization block, and magenta-styled issuer text.
Placeholders retained in a submission are a WARNING ("template placeholder
retained — confirm before production"), NOT a failure: personalization is
applied at manufacturing, but the magenta issuer-text styling must be
finalized and the design should be complete.

Layout & Quality:
- Full color (not grayscale). EXCEPTION: an intentionally monochrome design
  (e.g. all-black card with white marks) is a pass — grayscale here means a
  design that appears to have lost its color in export.
- Orientation consistent: the artwork reads correctly for the detected
  ${frontOrientation.toUpperCase()} trim (art not rotated relative to the trim box).
  Either orientation passes; the back is always horizontal.
- Design appears consistent across front and back (if back provided) —
  remember the standardized back is mostly fixed content, so "consistency"
  means colors/finish don't clash, not that layouts match.

For EACH check, determine: pass | fail | warning | not submitted

## Location Markers

For any FAIL or WARNING where a specific location on the card caused the issue, add
"marker_x", "marker_y", and "marker_side" fields to that check in the results JSON.
marker_x and marker_y are floats 0.0-1.0 relative to THAT SIDE's rendered preview
image (marker_x: 0.0 = left edge, 1.0 = right edge; marker_y: 0.0 = top, 1.0 =
bottom), placed at the approximate center of the problem area. marker_side is
"front" or "back" and MUST match the preview image the coordinates refer to.
Examples: a Brand Mark contrast failure gets a marker on the Brand Mark; a bleed
zone violation gets a marker at the offending edge; wrong issuer text gets a marker
on that text on the back. Only location-specific issues get markers — global checks
(orientation, grayscale, front/back consistency), absence checks, and "not
submitted" results get NO marker. Omit all three fields entirely for passing checks.

## Output Structured Results JSON

CRITICAL: You MUST output a JSON block between these exact markers. The system parses this to generate the PDF report. Without it, no report is created.

Do NOT repeat the technical check results in your output — the system already has TECH_SPEC_RESULTS and merges them into the report itself. Output ONLY the fields shown below.

Reproduce the "id" values below EXACTLY as given — they are the stable machine
identifiers downstream systems key on. Do not rename, merge, reorder, or omit
entries, and do not add entries of your own to this array. You may adjust a
"name" to record what you measured; "id" must never change.

For "visa_brand_mark_quiet_zone_front", mirror the tech bleed_zone verdict and
restate the edge distances in the notes. For back-of-card checks with no back
submitted, use "not submitted".

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "card_type": "physical",
  "visual_checks": [
${buildCheckListForPrompt('physical', { orientation: frontOrientation })}
  ]
}
RESULTS_JSON_END

## Reason Codes

For every check whose result is "fail" or "warning", add a "reason_code" field
naming the cause. Use the code listed for that check below, or "other" if none
of them fit. Passing and "not submitted" checks get no "reason_code".

${buildReasonCodeReference('physical')}

## Output Status Lines

After the JSON block, output exactly two lines and nothing else:

STATUS: APPROVED | REQUIRES CHANGES
SUMMARY: <1-2 sentence overview>`;
}

// ── Response parsing ────────────────────────────────────────────────

export function parseAgentResponse(text) {
  const statusMatch = text.match(/STATUS:\s*(APPROVED|REQUIRES CHANGES)/i);
  const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
  return {
    status: statusMatch && statusMatch[1].toUpperCase() === 'APPROVED' ? 'pass' : 'fail',
    summary: summaryMatch ? summaryMatch[1].trim() : 'Analysis complete. See PDF report for details.',
  };
}

export function parseResultsJson(text) {
  const match = text.match(/RESULTS_JSON_START\s*([\s\S]*?)\s*RESULTS_JSON_END/);
  if (!match) return null;
  try {
    const raw = match[1].replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── PDF report generation ───────────────────────────────────────────

function sanitize(str) {
  return (str || '').replace(/[≈]/g, '~').replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
    .replace(/[^\x00-\xFF]/g, '');
}

const PDF_COLORS = {
  green: rgb(0.13, 0.55, 0.13),
  red: rgb(0.8, 0.13, 0.13),
  amber: rgb(0.85, 0.55, 0.0),
  white: rgb(1, 1, 1),
  lightGray: rgb(0.94, 0.94, 0.94),
  dark: rgb(0.15, 0.15, 0.2),
  mid: rgb(0.4, 0.4, 0.45),
};

export async function generatePdfReport(imageBuffer, results, options = {}) {
  const cardType = options.cardType || results.card_type || 'virtual';
  const hasBack = !!options.hasBack;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, M = 50, CW = W - 2 * M;
  let pg = doc.addPage([W, H]);
  let y = H - M;

  function wrapText(text, size, maxW, f = font) {
    const words = sanitize(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function ensureSpace(needed) {
    if (y - needed < M) {
      pg = doc.addPage([W, H]);
      y = H - M;
    }
  }

  function drawSection(title) {
    ensureSpace(40);
    y -= 8;
    pg.drawRectangle({ x: M, y: y - 4, width: CW, height: 1, color: PDF_COLORS.lightGray });
    y -= 20;
    pg.drawText(title, { x: M, y, size: 15, font: bold, color: PDF_COLORS.dark });
    y -= 24;
  }

  const titleText = cardType === 'physical'
    ? 'Physical Card Art Compliance Report'
    : 'Virtual Card Art Compliance Report';
  pg.drawText(titleText, { x: M, y, size: 22, font: bold, color: PDF_COLORS.dark });
  y -= 36;

  const isApproved = results.status?.toUpperCase().startsWith('APPROVED') &&
                     !results.status?.toUpperCase().includes('REQUIRES');
  const badgeColor = isApproved ? PDF_COLORS.green : PDF_COLORS.red;
  const badgeText = (results.status || 'REQUIRES CHANGES').toUpperCase();
  const badgeW = bold.widthOfTextAtSize(badgeText, 12) + 20;
  pg.drawRectangle({ x: M, y: y - 4, width: badgeW, height: 22, color: badgeColor });
  pg.drawText(badgeText, { x: M + 10, y, size: 12, font: bold, color: PDF_COLORS.white });
  y -= 34;

  if (results.summary) {
    for (const line of wrapText(results.summary, 11, CW)) {
      ensureSpace(16);
      pg.drawText(line, { x: M, y, size: 11, font, color: PDF_COLORS.mid });
      y -= 16;
    }
    y -= 6;
  }

  if (imageBuffer) {
    try {
      const image = await doc.embedPng(imageBuffer);
      const scale = Math.min(CW / image.width, 260 / image.height);
      const iw = image.width * scale, ih = image.height * scale;
      ensureSpace(ih + 16);
      pg.drawImage(image, { x: M, y: y - ih, width: iw, height: ih });
      y -= ih + 16;
    } catch { /* skip if image can't be embedded */ }
  } else if (cardType === 'physical') {
    ensureSpace(20);
    pg.drawText('Source: .ai / .eps vector file (preview rendered in agent sandbox)',
      { x: M, y, size: 9, font, color: PDF_COLORS.mid });
    y -= 20;
  }

  drawSection('Technical Specifications');
  const drawTechRow = (name, check) => {
    if (!check) return;
    ensureSpace(18);
    const passed = check.passed;
    let color, label;
    if (check.borderline) { color = PDF_COLORS.amber; label = 'WARN'; }
    else if (passed === true) { color = PDF_COLORS.green; label = 'PASS'; }
    else if (passed === false) { color = PDF_COLORS.red; label = 'FAIL'; }
    else { color = PDF_COLORS.amber; label = 'N/V'; }
    const detail = check.actual
      ? `  (${check.actual}${check.required ? ' / required ' + check.required : ''})`
      : '';
    pg.drawText(label, { x: M, y, size: 10, font: bold, color });
    pg.drawText(sanitize(`${name}${detail}`), { x: M + 42, y, size: 10, font, color: PDF_COLORS.dark });
    y -= 18;
    if (check.note) {
      for (const line of wrapText(check.note, 8, CW - 42)) {
        ensureSpace(12);
        pg.drawText(line, { x: M + 42, y, size: 8, font, color: PDF_COLORS.mid });
        y -= 12;
      }
      y -= 2;
    }
  };

  if (cardType === 'physical') {
    const tc = results.tech_checks || {};
    const front = tc.front?.checks || {};
    ensureSpace(16);
    pg.drawText('Front', { x: M, y, size: 11, font: bold, color: PDF_COLORS.dark });
    y -= 16;
    drawTechRow('File Format', front.file_format);
    drawTechRow('CR80 Aspect Ratio', front.cr80_aspect_ratio);
    drawTechRow('Min Resolution', front.min_resolution);
    drawTechRow('56px Bleed Zone', front.bleed_zone);
    drawTechRow('Color Mode', front.color_mode);
    drawTechRow('Layers Present', front.layers_present);

    if (tc.back && tc.back.checks) {
      y -= 4;
      ensureSpace(16);
      pg.drawText('Back', { x: M, y, size: 11, font: bold, color: PDF_COLORS.dark });
      y -= 16;
      drawTechRow('File Format', tc.back.checks.file_format);
      drawTechRow('CR80 Aspect Ratio', tc.back.checks.cr80_aspect_ratio);
      drawTechRow('Min Resolution', tc.back.checks.min_resolution);
      drawTechRow('56px Bleed Zone', tc.back.checks.bleed_zone);
      drawTechRow('Color Mode', tc.back.checks.color_mode);
      drawTechRow('Layers Present', tc.back.checks.layers_present);
    } else if (hasBack === false) {
      ensureSpace(14);
      pg.drawText('Back: not submitted (optional)',
        { x: M, y, size: 9, font, color: PDF_COLORS.mid });
      y -= 14;
    }
  } else {
    const tc = results.tech_checks || {};
    drawTechRow('Dimensions', tc.dimensions);
    drawTechRow('File Format', tc.file_format);
    drawTechRow('DPI', tc.dpi);
    drawTechRow('Visa Brand Mark placed at 56px', tc.bleed_zone);
    drawTechRow('Visa Brand Mark in an upper corner', tc.mark_position);
    drawTechRow('Visa Brand Mark size (109px)', tc.mark_size);
    drawTechRow('Identifier aligned with mark', tc.identifier_alignment);
    drawTechRow('Visa Brand Mark color', tc.mark_color);
    drawTechRow("Matches Visa's official lockup", tc.lockup_match);
    drawTechRow('Artwork clear of identifier', tc.identifier_clearance);
    drawTechRow('Partner logo outside bleed zone', tc.issuer_logo_border);
    drawTechRow('Square corners', tc.square_corners);
    drawTechRow('No border lines', tc.border_frame);
  }

  drawSection('Visual Design Compliance');
  const vc = results.visual_checks || [];
  for (const check of vc) {
    const result = (check.result || '').toLowerCase();
    let color, label;
    if (result === 'pass') { color = PDF_COLORS.green; label = 'PASS'; }
    else if (result === 'warning') { color = PDF_COLORS.amber; label = 'WARN'; }
    else if (result === 'not submitted') { color = PDF_COLORS.mid; label = 'N/S'; }
    else if (result === 'fail') { color = PDF_COLORS.red; label = 'FAIL'; }
    else { color = PDF_COLORS.mid; label = (check.result || 'N/A').toUpperCase(); }

    ensureSpace(18);
    pg.drawText(label, { x: M, y, size: 9, font: bold, color });
    pg.drawText(sanitize(check.name || ''), { x: M + 60, y, size: 9, font: bold, color: PDF_COLORS.dark });
    y -= 14;

    if (check.notes) {
      for (const line of wrapText(check.notes, 8, CW - 60)) {
        ensureSpace(13);
        pg.drawText(line, { x: M + 60, y, size: 8, font, color: PDF_COLORS.mid });
        y -= 13;
      }
    }
    y -= 3;
  }

  if (cardType !== 'physical' && results.colors && Object.keys(results.colors).length) {
    drawSection('RGB Fallback Colors');
    for (const [role, data] of Object.entries(results.colors)) {
      if (!data?.rgb) continue;
      ensureSpace(20);
      const [r, g, b] = data.rgb;
      pg.drawRectangle({ x: M, y: y - 2, width: 14, height: 14, color: rgb(r / 255, g / 255, b / 255) });
      pg.drawRectangle({ x: M, y: y - 2, width: 14, height: 14, borderColor: PDF_COLORS.mid, borderWidth: 0.5 });
      const label = role.charAt(0).toUpperCase() + role.slice(1);
      pg.drawText(`${label}: ${data.hex || ''} (${r}, ${g}, ${b})`, { x: M + 22, y, size: 10, font, color: PDF_COLORS.dark });
      y -= 20;
    }
  }

  return Buffer.from(await doc.save());
}

// ── Turn 3: annotated results PDF ───────────────────────────────────

// ── Spec-check self-call ────────────────────────────────────────────
// The deterministic spec work all runs in api/spec-check.py, a Vercel
// Python function in this same deployment: tech specs before the session
// starts (virtual PNG checks directly; physical .ai/.eps rendered with the
// function's vendored Ghostscript) and the annotated report after it ends.
// The agent session spends its entire budget on visual inspection, and
// nothing depends on the sandbox's toolchain or an uploaded script copy.

function specCheckBaseUrl() {
  // SELF_BASE_URL for local dry-runs / explicit override; VERCEL_URL is the
  // deployment's generated host, injected on every Vercel deployment.
  if (process.env.SELF_BASE_URL) return process.env.SELF_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}

async function callSpecCheck(mode, payload) {
  const base = specCheckBaseUrl();
  if (!base) {
    throw new Error('spec-check self-call needs VERCEL_URL (on Vercel) or SELF_BASE_URL (local)');
  }
  const headers = { 'Content-Type': 'application/json' };
  // Deployment protection (SSO) covers preview URLs; the automation bypass
  // secret is injected by Vercel when Protection Bypass for Automation is on.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  const res = await fetch(`${base}/api/spec-check`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode, ...payload }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { detail = res.statusText || ''; }
    throw Object.assign(
      new Error(`spec-check ${mode} failed (${res.status})${detail ? `: ${detail}` : ''}`),
      { step: mode.startsWith('render') ? 'pdf_generate' : 'tech_specs' }
    );
  }
  return res;
}

// ── Main pipeline ───────────────────────────────────────────────────

const VALID_CARD_TYPES = new Set(['virtual', 'physical']);
// Virtual uploads wider than this are measured on a 1536px-wide copy
// (WORKING_COPY_MAX_WIDTH in scripts/check_technical_specs.py). The agent
// reads that copy too: an 8148px original can pass the agent's 20MB image
// limit, and the agent then spends minutes resizing it in the sandbox.
const WORKING_COPY_MAX_WIDTH = 1920;
const PHYSICAL_EXTS = new Set(['.ai', '.eps', '.png']);

// runAnalysis — agent session + PDF generation. No I/O outside Anthropic +
// the in-memory PDF return value. Caller is responsible for blob storage
// and downstream delivery.
//
// Args:
//   file          Buffer       required — front card art bytes
//   fileName      string       required — filename (drives extension/MIME)
//   backFile      Buffer?      optional — physical back-of-card bytes
//   backFileName  string?      optional — back filename
//   cardType      string?      optional — 'virtual' | 'physical'; inferred if omitted
//   declaredProduct string?    optional — the Visa product the program is
//                              provisioned as ("Signature Corporate"); virtual
//                              only. Normalized to a canonical name or dropped.
//   onProgress    function?    optional — (event, data) => void; mirrors SSE event names
//   deadlineAt    number?      optional — epoch ms by which the caller's function
//                              is killed (Vercel maxDuration). Used to fail fast
//                              or degrade to the local PDF instead of dying
//                              silently mid-step.
//   agentVersion  number?      optional — pin the session to this agent version
//                              (defaults to AGENT_VERSION; unset = latest). The
//                              eval pins it so a prompt push can't silently change
//                              what a run measures.
//
// Returns: { pdfBuffer, status, summary, results, techJson, cardType, telemetry, declaredProduct }
//   telemetry: { sessionId, agent: {id, version, model}, usage, modelRequests,
//                toolCalls, prompt, events } — session bookkeeping for callers
//                that meter or trace runs (the eval); production ignores it.

// Time (ms) the visual-inspection turn needs; below this we fail fast with a
// clear error instead of getting killed mid-turn. (The annotated PDF no
// longer needs a reserve: it renders via a ~2-3s spec-check call for both
// card types, not an in-session turn.)
const VISUAL_TURN_MIN_MS = 150_000;

export async function runAnalysis({ file, fileName, backFile, backFileName, cardType, declaredProduct, onProgress, deadlineAt, agentVersion }) {
  const emit = onProgress || (() => {});
  const product = normalizeDeclaredProduct(declaredProduct);
  const remainingMs = () => (deadlineAt ? deadlineAt - Date.now() : Infinity);

  if (!file) throw Object.assign(new Error('runAnalysis: file is required'), { step: 'pipeline' });
  if (!fileName) throw Object.assign(new Error('runAnalysis: fileName is required'), { step: 'pipeline' });

  // Resolve card type — explicit override wins, otherwise infer from extension.
  let resolvedCardType = (cardType || '').trim().toLowerCase();
  if (resolvedCardType && !VALID_CARD_TYPES.has(resolvedCardType)) {
    throw Object.assign(new Error(`Invalid cardType "${cardType}" — must be "virtual" or "physical"`), { step: 'pipeline' });
  }
  if (!resolvedCardType) {
    resolvedCardType = inferCardType(fileName, undefined);
    if (!resolvedCardType) {
      throw Object.assign(
        new Error(`Could not infer card type from "${fileName}" — pass cardType explicitly`),
        { step: 'pipeline' }
      );
    }
  }

  const hasBack = !!backFile;
  if (resolvedCardType === 'virtual' && hasBack) {
    throw Object.assign(new Error('backFile is only valid for physical submissions'), { step: 'pipeline' });
  }

  emit('progress', { step: 'agent_init', message: 'Uploading image for analysis...', status: 'pending' });

  const resources = [];
  let physicalFrontExt = '.ai';
  let physicalBackExt = '.ai';
  let techJson = null;
  let cropPaths = [];
  let sourceBlob = null;
  let backBlob = null;
  let physicalPreviews = null;

  if (resolvedCardType === 'virtual') {
    // Tech specs run in the spec-check Python function, concurrently with
    // the Files-API upload — no longer an in-session turn serialized ahead
    // of the visual inspection. The source file travels as a Blob URL: the
    // platform 413s JSON bodies over ~4.5MB, which inline base64 would hit
    // on larger PNGs.
    emit('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
    const oversized = (getImageSize(file)?.width || 0) > WORKING_COPY_MAX_WIDTH;
    const sourceBlobP = blobPut(`tmp/spec-check/${Date.now()}-card-art.png`, file, {
      access: 'public',
      contentType: 'image/png',
      addRandomSuffix: true,
    });
    const [uploadedImage, specRes] = await Promise.all([
      (async () => {
        let bytes = file;
        if (oversized) {
          // Best-effort: without the copy the agent still gets the original.
          try {
            const { url } = await sourceBlobP;
            const preview = await callSpecCheck('preview', { card_type: 'virtual', image_url: url, file_name: fileName });
            bytes = Buffer.from(await preview.arrayBuffer());
          } catch (err) {
            console.error('Working-copy preview failed — mounting the original:', err?.message || err);
          }
        }
        return getAnthropic().beta.files.upload({ file: new File([bytes], 'card-art.png', { type: 'image/png' }) });
      })(),
      (async () => {
        sourceBlob = await sourceBlobP;
        return callSpecCheck('check', {
          card_type: 'virtual', image_url: sourceBlob.url, file_name: fileName,
          ...(product ? { declared_product: product } : {}),
        });
      })(),
    ]);
    resources.push({ type: 'file', file_id: uploadedImage.id, mount_path: '/mnt/session/uploads/card-art.png' });
    const specJson = await specRes.json();
    techJson = specJson.tech_specs;
    if (!techJson) {
      throw Object.assign(new Error('spec-check did not return tech_specs'), { step: 'tech_specs' });
    }
    emit('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });

    // Mount the spec-check zoom crops as session resources so the agent's
    // close inspection is `read` calls, not PIL scripting. Best-effort: a
    // failed crop upload costs speed, not correctness.
    try {
      const cropResources = await Promise.all(
        Object.entries(specJson.crops || {}).map(async ([name, b64]) => {
          const uploaded = await getAnthropic().beta.files.upload({
            file: new File([Buffer.from(b64, 'base64')], `${name}.png`, { type: 'image/png' }),
          });
          return { type: 'file', file_id: uploaded.id, mount_path: `/mnt/session/uploads/crops/${name}.png` };
        })
      );
      resources.push(...cropResources);
      cropPaths = cropResources.map(r => r.mount_path);
    } catch (err) {
      console.error('Crop upload failed — continuing without zoom crops:', err?.message || err);
    }
  } else {
    physicalFrontExt = extOf(fileName) || '.ai';
    if (!PHYSICAL_EXTS.has(physicalFrontExt)) {
      throw Object.assign(
        new Error(`Physical front file must be .ai, .eps, or .png; got ${physicalFrontExt || 'unknown'}`),
        { step: 'pipeline' }
      );
    }
    if (hasBack) {
      physicalBackExt = extOf(backFileName) || '.ai';
      if (!PHYSICAL_EXTS.has(physicalBackExt)) {
        throw Object.assign(
          new Error(`Physical back file must be .ai, .eps, or .png; got ${physicalBackExt || 'unknown'}`),
          { step: 'pipeline' }
        );
      }
    }

    // Physical tech specs run fully off-session: spec-check renders the
    // .ai/.eps with its vendored Ghostscript (seconds, vs 84-133s for the
    // same step inside a cold agent sandbox) and returns the tech JSON,
    // downscaled preview PNGs, and zoom crops. The session never sees the
    // source files — only the rendered previews it needs to inspect.
    emit('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
    const ts = Date.now();
    [sourceBlob, backBlob] = await Promise.all([
      blobPut(`tmp/spec-check/${ts}-front${physicalFrontExt}`, file, {
        access: 'public',
        contentType: mimeForPhysicalExt(physicalFrontExt),
        addRandomSuffix: true,
      }),
      hasBack
        ? blobPut(`tmp/spec-check/${ts}-back${physicalBackExt}`, backFile, {
            access: 'public',
            contentType: mimeForPhysicalExt(physicalBackExt),
            addRandomSuffix: true,
          })
        : Promise.resolve(null),
    ]);
    const specRes = await callSpecCheck('check', {
      card_type: 'physical',
      image_url: sourceBlob.url,
      file_name: `front${physicalFrontExt}`,
      ...(backBlob ? { back_url: backBlob.url, back_file_name: `back${physicalBackExt}` } : {}),
    });
    const specJson = await specRes.json();
    techJson = specJson.tech_specs;
    physicalPreviews = specJson.previews || {};
    if (!techJson) {
      throw Object.assign(new Error('spec-check did not return tech_specs'), { step: 'tech_specs' });
    }
    if (!physicalPreviews.front) {
      const reason = (techJson.front?.errors || []).join('; ') || 'no rendered preview returned';
      throw Object.assign(new Error(`Could not render the physical card art: ${reason}`), { step: 'tech_specs' });
    }

    // Golden-template reference: when the product is inferable (tier layer
    // or filename), mount the matching canonical template preview so the
    // agent can diff fixed elements (chip, VISA lockup, back layout)
    // against the designers' ground truth. ~3KB per PNG — uploaded per run.
    const detectedProduct = detectPhysicalProduct(techJson, fileName);
    const frontOrientation = techJson?.front?.orientation || 'horizontal';
    const referenceBuffers = detectedProduct
      ? referenceTemplateBuffers(detectedProduct, frontOrientation)
      : null;
    techJson.detected_product = detectedProduct;
    techJson.reference_template_mounted = !!referenceBuffers;

    // Mount the previews (+ crops + reference) for the visual turn, and
    // point the tech JSON's paths at the mounts so the prompt references
    // what the agent can actually read.
    const mountUploads = [
      { name: 'front_render.png', b64: physicalPreviews.front, mount: '/mnt/session/uploads/front_render.png' },
      ...(physicalPreviews.back
        ? [{ name: 'back_render.png', b64: physicalPreviews.back, mount: '/mnt/session/uploads/back_render.png' }]
        : []),
      ...(referenceBuffers
        ? [{ name: 'reference_template.png', b64: referenceBuffers.front.toString('base64'), mount: '/mnt/session/uploads/reference_template.png' }]
        : []),
      ...(referenceBuffers?.back && physicalPreviews.back
        ? [{ name: 'reference_back.png', b64: referenceBuffers.back.toString('base64'), mount: '/mnt/session/uploads/reference_back.png' }]
        : []),
      ...Object.entries(specJson.crops || {}).map(([name, b64]) => ({
        name: `${name}.png`, b64, mount: `/mnt/session/uploads/crops/${name}.png`, crop: name,
      })),
    ];
    const uploaded = await Promise.all(mountUploads.map(async (m) => {
      const up = await getAnthropic().beta.files.upload({
        file: new File([Buffer.from(m.b64, 'base64')], m.name, { type: 'image/png' }),
      });
      return { ...m, file_id: up.id };
    }));
    const mountedCrops = {};
    for (const m of uploaded) {
      resources.push({ type: 'file', file_id: m.file_id, mount_path: m.mount });
      if (m.crop) mountedCrops[m.crop] = m.mount;
    }
    techJson.front.rendered_preview_path = '/mnt/session/uploads/front_render.png';
    techJson.front.zoom_crops = mountedCrops;
    if (techJson.back && physicalPreviews.back) {
      techJson.back.rendered_preview_path = '/mnt/session/uploads/back_render.png';
    }
    emit('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });
  }

  emit('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

  // A multi-page vector front supplies the back automatically (canonical
  // templates are one 2-page .ai) — treat that the same as an uploaded back
  // file for the prompt and the fallback report.
  const effectiveHasBack = hasBack || !!(physicalPreviews && physicalPreviews.back);

  const pinnedVersion = Number(agentVersion ?? process.env.AGENT_VERSION) || null;
  const session = await getAnthropic().beta.sessions.create({
    agent: pinnedVersion
      ? { type: 'agent', id: process.env.AGENT_ID, version: pinnedVersion }
      : process.env.AGENT_ID,
    environment_id: process.env.ENV_ID,
    resources,
  });

  // ── Turn 2: Visual inspection ──────────────────────────────
  // Fail fast if the tech-spec turn ate the budget: dying mid-inspection at
  // the platform's maxDuration kill leaves no error and no report at all.
  if (remainingMs() < VISUAL_TURN_MIN_MS) {
    throw Object.assign(
      new Error(
        'Not enough time left for visual inspection — the source file took too long to process. ' +
        'Resubmit as a flattened 1536×969 PNG export of the design.'
      ),
      { step: 'agent_run' }
    );
  }
  emit('progress', { step: 'agent_run', message: 'Running visual inspection...', status: 'pending' });
  const visualPrompt = buildVisualPrompt(
    techJson, resolvedCardType, effectiveHasBack, cropPaths,
    { declaredProduct: resolvedCardType === 'virtual' ? product : null },
  );
  await getAnthropic().beta.sessions.events.send(session.id, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: visualPrompt }],
    }],
  });

  const visualStream = await getAnthropic().beta.sessions.events.stream(session.id);
  let agentTextResponse = '';
  // Summed from span.model_request_end: the session object's own usage splits
  // cache writes by TTL, while per-request usage is the flat Messages shape.
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const events = [];
  let modelRequests = 0;
  let toolCalls = 0;

  for await (const event of visualStream) {
    if (event.type === 'agent.message') {
      const text = event.content?.map(b => b.text).join('') || '';
      agentTextResponse += text;
      if (text) emit('agent_delta', { text });
      if (text) events.push({ type: 'agent.message', text });
    }
    if (event.type === 'agent.tool_use') {
      toolCalls++;
      emit('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
      events.push({ type: 'agent.tool_use', name: event.name || 'tool', input: event.input });
    }
    if (event.type === 'agent.tool_result') {
      const text = (event.content || []).map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
      events.push({ type: 'agent.tool_result', is_error: !!event.is_error, text: text.slice(0, 2000) });
    }
    if (event.type === 'span.model_request_end') {
      modelRequests++;
      for (const k of Object.keys(usage)) usage[k] += event.model_usage?.[k] || 0;
    }
    if (event.type === 'session.error') events.push({ type: 'session.error', error: event.error });
    if (event.type === 'session.status_idle') break;
  }
  const telemetry = {
    sessionId: session.id,
    agent: { id: session.agent?.id, version: session.agent?.version, model: session.agent?.model?.id },
    usage, modelRequests, toolCalls, prompt: visualPrompt, events,
  };
  emit('progress', { step: 'agent_run', message: 'Analysis complete', status: 'done' });

  // ── PDF generation ─────────────────────────────────────────
  emit('progress', { step: 'pdf_generate', message: 'Generating report...', status: 'pending' });
  const results = parseResultsJson(agentTextResponse);
  if (!results) {
    throw Object.assign(
      new Error('Agent did not output structured results (RESULTS_JSON_START/END block missing)'),
      { step: 'pdf_generate', telemetry }
    );
  }

  // Measured failures override the agent (lib/tech-verdicts.js): a failing
  // deterministic check fails its mirrored visual check and blocks approval.
  // Recorded on telemetry so an eval can tell the agent's own verdict apart.
  telemetry.techOverrides = applyTechVerdicts(results, techJson, resolvedCardType);
  if (telemetry.techOverrides.length) {
    console.log('[pipeline] tech verdicts applied:', JSON.stringify(telemetry.techOverrides));
  }

  // The agent no longer echoes the tech results back (pure output-token
  // waste on a slow step) — merge them into the results server-side.
  if (resolvedCardType === 'physical') {
    results.tech_checks = techJson;
  } else {
    results.tech_checks = techJson.checks || techJson;
    if (!results.colors || !Object.keys(results.colors).length) {
      results.colors = techJson.colors || {};
    }
  }

  // Annotated results PDF — a fast (~2-3s) spec-check render call for both
  // card types; no session turn, no time gating, so the annotated report is
  // produced on every run. Virtual re-sends the original image; physical
  // sends the tech JSON plus the preview PNGs Turn 1 already rendered
  // (raster submissions ARE the uploaded buffers, vector previews are
  // downloaded from the session's output files).
  let pdfBuffer = null;
  const visualResults = {
    overall_status: results.status || 'REQUIRES CHANGES',
    overall_description: results.summary || '',
    visual_checks: results.visual_checks || [],
  };
  try {
    let renderRes;
    if (resolvedCardType === 'virtual') {
      renderRes = await callSpecCheck('render', {
        image_url: sourceBlob.url,
        file_name: fileName,
        visual_results: visualResults,
      });
    } else {
      // The downscaled previews from the tech-specs call are still in hand —
      // send them straight back for report composition.
      renderRes = await callSpecCheck('render-physical', {
        tech_results: techJson,
        previews: {
          front: physicalPreviews.front,
          ...(physicalPreviews.back ? { back: physicalPreviews.back } : {}),
        },
        visual_results: visualResults,
      });
    }
    pdfBuffer = Buffer.from(await renderRes.arrayBuffer());
    if (pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('spec-check render did not return a valid PDF');
    }
  } catch (err) {
    console.error('spec-check render failed, falling back to local report:', err?.message || err);
    emit('progress', { step: 'pdf_generate', message: 'Annotated report unavailable — generating standard report...', status: 'pending' });
    pdfBuffer = null;
  } finally {
    // The transport blobs only exist to sidestep the ~4.5MB request-body
    // cap on the self-call — drop them once the render is done.
    for (const blob of [sourceBlob, backBlob]) {
      if (blob) blobDel(blob.url).catch(err => console.warn('transport blob cleanup failed:', err?.message || err));
    }
  }
  if (!pdfBuffer) {
    const pdfImageBuffer = resolvedCardType === 'virtual' ? file : null;
    pdfBuffer = await generatePdfReport(pdfImageBuffer, results, { cardType: resolvedCardType, hasBack: effectiveHasBack });
  }
  emit('progress', { step: 'pdf_generate', message: 'Report generated', status: 'done' });

  // Prefer the structured results for status/summary; fall back to the
  // STATUS:/SUMMARY: lines if the JSON is missing either field.
  const parsed = parseAgentResponse(agentTextResponse);
  const statusText = (results.status || '').toUpperCase();
  const status = statusText
    ? (statusText.startsWith('APPROVED') && !statusText.includes('REQUIRES') ? 'pass' : 'fail')
    : parsed.status;
  const summary = results.summary || parsed.summary;

  // techJson is returned alongside `results` so callers can normalize the
  // structured result (lib/result-schema.js) without having to know how the
  // tech checks were merged in above — that merge differs by card type.
  return {
    pdfBuffer, status, summary, results, techJson, cardType: resolvedCardType, telemetry,
    declaredProduct: resolvedCardType === 'virtual' ? product : null,
  };
}

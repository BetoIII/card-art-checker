import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { extOf, inferCardType } from './card-type.js';

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

// Physical-only: virtual tech specs run in api/spec-check.py before the
// session starts (see callSpecCheck), not as an in-session turn.
function buildTechSpecPrompt(hasBack, frontExt = '.ai', backExt = '.ai') {
  const frontPath = `/mnt/session/uploads/front${frontExt}`;
  const backArg = hasBack ? ` --back /mnt/session/uploads/back${backExt}` : '';
  const needsGs = frontExt !== '.png' || (hasBack && backExt !== '.png');
  // Ghostscript is pre-installed in the environment (packages.apt); the
  // guard is a same-command no-op fallback in case a container predates it.
  const gsGuard = needsGs ? 'which gs || (apt-get update -qq && apt-get install -y ghostscript)\n' : '';
  return `Run the technical spec checker on the physical card art and output ONLY the raw JSON result. No commentary.

\`\`\`bash
${gsGuard}python3 /mnt/session/uploads/scripts/check_technical_specs.py ${frontPath} --card-type physical${backArg}
\`\`\`

Output the complete JSON from the script — nothing else.`;
}

function buildVisualPrompt(techJson, cardType = 'virtual', hasBack = false) {
  if (cardType === 'physical') return buildPhysicalVisualPrompt(techJson, hasBack);
  return buildVirtualVisualPrompt(techJson);
}

function buildVirtualVisualPrompt(techJson) {
  return `Analyze the card art image at /mnt/session/uploads/card-art.png for compliance with Visa Digital Card Brand Standards (September 2025) and Rain's internal requirements.

The technical spec checks have ALREADY been run. Here are the results — do NOT re-run the script:

TECH_SPEC_RESULTS:
${JSON.stringify(techJson, null, 2)}

## Your Task: Visual Inspection ONLY (18 checks)

Tool budget: every pixel measurement you need is already provided in TECH_SPEC_RESULTS.
Inspect the image by \`read\`ing the mounted files — do NOT write Python/PIL code to
measure pixels, crop regions, or zoom in.

Examine the card art image visually and evaluate:

Required Elements:
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position: upper-left or upper-right ONLY (NO lower-edge)
- Visa Brand Mark margin (CRITICAL — #1 rejection reason): the technical checker has
  already measured the exact edge distances — including strict per-pixel distances that
  count anti-aliased letter tips (\`strict_*_px\` fields) — and emitted a \`bleed_zone\`
  result in TECH_SPEC_RESULTS above. Do NOT re-measure; mirror that pass/warning/fail
  verdict in the matching visual_checks entry with a concise note restating the measured
  distances. This margin applies ONLY to the Visa Brand Mark, not to other logos or
  elements.
- Visa Brand Mark size — must match one of the two allowed options:
  Option One (Debit cards): 109px mark height, ~11.2% of the 969px card height.
  Option Two (Signature/Platinum/Infinite): 142px mark height, ~14.7% of the card height.
  If it looks significantly smaller or larger than either option, fail it.
- Visa Brand Mark contrast: BOTH the "VISA" wordmark AND the product identifier text
  (Signature, Platinum, Infinite, Debit, etc.) must have strong contrast against the
  background and be clearly readable. Common failures: gray/silver text on light
  backgrounds, dark text on dark backgrounds, or an identifier in a different color
  than the wordmark that lacks contrast (e.g. silver "Platinum" on pink). If either is
  hard to read, fail and recommend white or a higher-contrast color.
- Product identifier present and placed: every card MUST display one of four identifiers —
  "Visa Platinum", "Visa Signature", or "Visa Infinite" (consumer) or "Corporate"
  (business/corporate). Rain no longer offers the Classic tier, so an identifier is
  ALWAYS required — absence is an automatic fail. It must be placed directly below or
  immediately adjacent to the Visa Brand Mark, anchored to the same upper corner.
  Fail if: (a) no identifier visible, (b) identifier in the opposite corner from the
  Brand Mark, (c) identifier separated from the Brand Mark by unrelated graphics or
  large empty space, or (d) identifier in the lower-left personalization zone.
  Casing deviations from the canonical forms (e.g. "VISA PLATINUM") are a warning.
- Issuer logo clearly present (may bleed to edge — no margin requirement)

Prohibited Elements:
- No EMV chip graphic
- No hologram imagery
- No magnetic stripe graphic
- No cardholder name
- No full PAN / card number
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
  dark background passes; a logo, icon, or high-contrast graphic fails.
- Design elements clear of product identifier: no artwork, logos, or design elements
  obscuring or touching the Visa product identifier text
- Horizontal (landscape) orientation
- Full color (not grayscale)

Bleed rules reminder: ONLY the Visa Brand Mark has the 56px margin requirement. Issuer
logos, artwork, and other design elements may extend to the card edge — do NOT flag
non-Visa elements for being close to the edge. The Contactless Indicator is allowed
even if the physical card is not contactless enabled — do NOT flag it.

For EACH check, determine: pass | fail | warning

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

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "visual_checks": [
    { "name": "Visa Brand Mark present", "result": "pass or fail or warning", "notes": "details" },
    { "name": "Visa Brand Mark position (upper-left/upper-right only)", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark size", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark margin (56px from edges)", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark contrast against background", "result": "...", "notes": "..." },
    { "name": "Product identifier present and placed", "result": "...", "notes": "..." },
    { "name": "Issuer logo present", "result": "...", "notes": "..." },
    { "name": "No EMV chip graphic", "result": "...", "notes": "..." },
    { "name": "No hologram imagery", "result": "...", "notes": "..." },
    { "name": "No magnetic stripe graphic", "result": "...", "notes": "..." },
    { "name": "No cardholder name", "result": "...", "notes": "..." },
    { "name": "No PAN / card number", "result": "...", "notes": "..." },
    { "name": "No expiry date", "result": "...", "notes": "..." },
    { "name": "No physical card photography", "result": "...", "notes": "..." },
    { "name": "Lower-left area clear", "result": "...", "notes": "..." },
    { "name": "Design elements clear of product identifier", "result": "...", "notes": "..." },
    { "name": "Landscape orientation", "result": "...", "notes": "..." },
    { "name": "Full color (not grayscale)", "result": "...", "notes": "..." }
  ]
}
RESULTS_JSON_END

## Output Status Lines

After the JSON block, output exactly two lines and nothing else:

STATUS: APPROVED | REQUIRES CHANGES | APPROVED WITH NOTES
SUMMARY: <1-2 sentence overview>`;
}

function buildPhysicalVisualPrompt(techJson, hasBack) {
  const frontPreview = techJson?.front?.rendered_preview_path || '/mnt/session/uploads/front_render.png';
  const backPreview = techJson?.back?.rendered_preview_path || '/mnt/session/uploads/back_render.png';
  const backBlock = hasBack
    ? `You also have the back-of-card render at ${backPreview}. Inspect both sides.`
    : `The submitter did NOT provide a back-of-card file. For every back-of-card check below, set "result": "not submitted" and explain in the notes that the optional back file was omitted.`;

  return `Analyze the physical card art for compliance with Visa Physical Card Brand Standards and Rain's internal requirements.

Front render: ${frontPreview}
${backBlock}

The technical spec checks have ALREADY been run. Here are the results — do NOT re-run the script:

TECH_SPEC_RESULTS:
${JSON.stringify(techJson, null, 2)}

## Your Task: Visual Inspection ONLY

Examine the rendered preview image(s) visually. Note: physical cards may LEGITIMATELY show chip graphics, magnetic stripes, holograms, and 3D effects — these are NOT prohibited on physical cards (unlike virtual).

Required Elements (Front):
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position: lower right, upper right, or upper left (lower-left is NOT allowed)
- Visa Brand Mark color is one of: Visa Blue, White, Black, Silver, or Gold (or PVBM in Blue/Silver/Gold/Black)
- Visa Brand Mark contrast: strong against background
- Visa Brand Mark 56px bleed zone: the technical checker has already measured
  edge distances and emitted a \`bleed_zone\` result in TECH_SPEC_RESULTS above.
  Do NOT re-measure; just mirror that pass/warning/fail verdict in the matching
  visual_checks entry with a concise human-readable note.
- Issuer logo clearly present
- Rounded corners consistent with CR80 die-cut

Required Elements (Back — only if back file was submitted):
- Magnetic stripe area present
- PAN, expiry, and security code fields present
- Issuer text present and reads EXACTLY: "Card issued by Third National under license from Visa."
- Visa Dove present on the back (UNLESS the Premium Visa Brand Mark (PVBM) is used on the front, in which case the Dove may be omitted)

Layout & Quality:
- Full color (not grayscale)
- Horizontal (landscape) orientation
- Design appears consistent across front and back (if back provided)

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

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "card_type": "physical",
  "visual_checks": [
    { "name": "Visa Brand Mark present (front)", "result": "pass or fail or warning", "notes": "details" },
    { "name": "Visa Brand Mark position (front)", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark color (front)", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark contrast (front)", "result": "...", "notes": "..." },
    { "name": "Visa Brand Mark 56px bleed zone (front)", "result": "mirror the tech bleed_zone verdict", "notes": "restate edge distances" },
    { "name": "Issuer logo (front)", "result": "...", "notes": "..." },
    { "name": "Rounded corners match CR80", "result": "...", "notes": "..." },
    { "name": "Magnetic stripe area (back)", "result": "pass or fail or warning or not submitted", "notes": "..." },
    { "name": "PAN / expiry / CVV fields (back)", "result": "...", "notes": "..." },
    { "name": "Issuer text: \\"Card issued by Third National under license from Visa.\\" (back)", "result": "...", "notes": "..." },
    { "name": "Visa Dove or PVBM exception (back)", "result": "...", "notes": "..." },
    { "name": "Full color (not grayscale)", "result": "...", "notes": "..." },
    { "name": "Horizontal orientation", "result": "...", "notes": "..." },
    { "name": "Front/back design consistency", "result": "...", "notes": "..." }
  ]
}
RESULTS_JSON_END

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
    if (passed === true) { color = PDF_COLORS.green; label = 'PASS'; }
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
    drawTechRow('56px Margin Zone (Visa Brand Mark)', tc.bleed_zone);
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

// Physical-only: the spec script's --visual-results-file mode renders the
// full results PDF — front/back review panes with the scaled 56px boundary,
// per-side markers (marker_side), File Info panels, and per-side spec tables.
// (Virtual annotated PDFs render in api/spec-check.py mode=render instead.)
// The Node side owns the JSON handoff so the agent only executes commands.
function buildResultsPdfPrompt(visualResultsJson, { frontExt = '.ai', backExt = '.ai', hasBack = false } = {}) {
  const backArg = hasBack ? ` --back /mnt/session/uploads/back${backExt}` : '';
  const target = `/mnt/session/uploads/front${frontExt} --card-type physical${backArg}`;
  // Re-running check_physical re-renders vector previews. Ghostscript was
  // installed in Turn 1 and the sandbox persists, but the guard is free.
  const gsGuard = (frontExt !== '.png' || (hasBack && backExt !== '.png'))
    ? 'which gs || (apt-get update -qq && apt-get install -y ghostscript)\n'
    : '';
  return `Generate the results PDF. Run exactly this — no commentary:

\`\`\`bash
${gsGuard}cat > /tmp/visual_results.json << 'VISUAL_RESULTS_EOF'
${visualResultsJson}
VISUAL_RESULTS_EOF
mkdir -p /mnt/session/outputs
python3 /mnt/session/uploads/scripts/check_technical_specs.py ${target} --visual-results-file /tmp/visual_results.json --output-dir /mnt/session/outputs
ls -la /mnt/session/outputs/
\`\`\`

Then output ONLY the absolute path of the generated PDF file.`;
}

async function generateResultsPdfInSession(sessionId, results, emit, opts = {}) {
  const visualResults = {
    overall_status: results.status || 'REQUIRES CHANGES',
    overall_description: results.summary || '',
    visual_checks: results.visual_checks || [],
  };

  await getAnthropic().beta.sessions.events.send(sessionId, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: buildResultsPdfPrompt(JSON.stringify(visualResults, null, 2), opts) }],
    }],
  });

  const stream = await getAnthropic().beta.sessions.events.stream(sessionId);
  for await (const event of stream) {
    if (event.type === 'agent.tool_use') {
      emit('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
    }
    if (event.type === 'session.status_idle') break;
  }

  // Find the PDF among the session's output files (newest first). The SDK's
  // files methods build their own anthropic-beta header (files-api), which
  // replaces the client-level managed-agents default — pass it explicitly or
  // the scope_id filter is rejected with "unknown field". Files written to
  // /mnt/session/outputs/ appear in the list after a 1-3s indexing lag past
  // session idle, so retry before giving up.
  const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
  let pdfFile = null;
  for (let attempt = 0; attempt < 5 && !pdfFile; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
    for await (const f of getAnthropic().beta.files.list({ scope_id: sessionId, betas: [MANAGED_AGENTS_BETA] })) {
      if (!f.filename?.endsWith('.pdf') || f.downloadable === false) continue;
      if (!pdfFile || (f.created_at || '') > (pdfFile.created_at || '')) pdfFile = f;
    }
  }
  if (!pdfFile) throw new Error('No PDF found in session output files');

  const response = await getAnthropic().beta.files.download(pdfFile.id, { betas: [MANAGED_AGENTS_BETA] });
  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  if (pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(`Downloaded session file ${pdfFile.filename} is not a valid PDF`);
  }
  return pdfBuffer;
}

// ── Spec-check self-call (virtual path) ─────────────────────────────
// The deterministic spec script also runs as a Vercel Python function in
// this same deployment (api/spec-check.py), so virtual runs get tech specs
// before the session starts and the annotated PDF after it ends — the agent
// session spends its entire budget on visual inspection. Physical stays
// in-session (.ai/.eps rendering needs the sandbox's Ghostscript).

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
    body: JSON.stringify({ mode, card_type: 'virtual', ...payload }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { detail = res.statusText || ''; }
    throw new Error(`spec-check ${mode} failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

// ── Main pipeline ───────────────────────────────────────────────────

const VALID_CARD_TYPES = new Set(['virtual', 'physical']);
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
//   onProgress    function?    optional — (event, data) => void; mirrors SSE event names
//   deadlineAt    number?      optional — epoch ms by which the caller's function
//                              is killed (Vercel maxDuration). Used to fail fast
//                              or degrade to the local PDF instead of dying
//                              silently mid-step.
//
// Returns: { pdfBuffer, status, summary, results, cardType }

// Time (ms) the visual-inspection turn needs; below this we fail fast with a
// clear error instead of getting killed mid-turn.
const VISUAL_TURN_MIN_MS = 150_000;
// Time (ms) the annotated-PDF turn needs; below this we skip straight to the
// local pdf-lib report.
const RESULTS_PDF_MIN_MS = 90_000;
// Post-PDF work (blob upload, delivery) reserve carved out of the Turn 3 cap.
const WRAPUP_RESERVE_MS = 45_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    // If the timeout won, the losing promise may still reject later —
    // attach a handler so it doesn't surface as an unhandled rejection.
    promise.catch(() => {});
  });
}

export async function runAnalysis({ file, fileName, backFile, backFileName, cardType, onProgress, deadlineAt }) {
  const emit = onProgress || (() => {});
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

  if (resolvedCardType === 'virtual') {
    // Tech specs run in the spec-check Python function, concurrently with
    // the Files-API upload — no longer an in-session turn serialized ahead
    // of the visual inspection.
    emit('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
    const imageFile = new File([file], 'card-art.png', { type: 'image/png' });
    const [uploadedImage, specRes] = await Promise.all([
      getAnthropic().beta.files.upload({ file: imageFile }),
      callSpecCheck('check', { image_b64: file.toString('base64'), file_name: fileName }),
    ]);
    resources.push({ type: 'file', file_id: uploadedImage.id, mount_path: '/mnt/session/uploads/card-art.png' });
    techJson = (await specRes.json()).tech_specs;
    if (!techJson) {
      throw Object.assign(new Error('spec-check did not return tech_specs'), { step: 'tech_specs' });
    }
    emit('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });
  } else {
    physicalFrontExt = extOf(fileName) || '.ai';
    if (!PHYSICAL_EXTS.has(physicalFrontExt)) {
      throw Object.assign(
        new Error(`Physical front file must be .ai, .eps, or .png; got ${physicalFrontExt || 'unknown'}`),
        { step: 'pipeline' }
      );
    }
    const frontMime = mimeForPhysicalExt(physicalFrontExt);
    const uploadedFront = await getAnthropic().beta.files.upload({
      file: new File([file], `front${physicalFrontExt}`, { type: frontMime }),
    });
    resources.push({
      type: 'file',
      file_id: uploadedFront.id,
      mount_path: `/mnt/session/uploads/front${physicalFrontExt}`,
    });

    if (hasBack) {
      physicalBackExt = extOf(backFileName) || '.ai';
      if (!PHYSICAL_EXTS.has(physicalBackExt)) {
        throw Object.assign(
          new Error(`Physical back file must be .ai, .eps, or .png; got ${physicalBackExt || 'unknown'}`),
          { step: 'pipeline' }
        );
      }
      const backMime = mimeForPhysicalExt(physicalBackExt);
      const uploadedBack = await getAnthropic().beta.files.upload({
        file: new File([backFile], `back${physicalBackExt}`, { type: backMime }),
      });
      resources.push({
        type: 'file',
        file_id: uploadedBack.id,
        mount_path: `/mnt/session/uploads/back${physicalBackExt}`,
      });
    }

    // Physical-only: the in-session turns (tech specs + results PDF) run the
    // uploaded spec script inside the sandbox. Virtual runs use the bundled
    // copy in api/spec-check.py instead — no Files-API script dependency.
    if (process.env.SPEC_SCRIPT_FILE_ID) {
      resources.push({
        type: 'file',
        file_id: process.env.SPEC_SCRIPT_FILE_ID,
        // The managed-agent environment roots all mounted resources under
        // /mnt/session/uploads/ — a mount_path outside it (e.g.
        // /mnt/session/scripts/...) gets relocated there, so the agent can't
        // find the script at the path the prompt names. Mount under /uploads/
        // so the requested and actual paths agree.
        mount_path: '/mnt/session/uploads/scripts/check_technical_specs.py',
      });
    }
  }

  emit('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

  const session = await getAnthropic().beta.sessions.create({
    agent: process.env.AGENT_ID,
    environment_id: process.env.ENV_ID,
    resources,
  });

  // ── Turn 1: Tech specs (physical only — .ai/.eps rendering needs the
  // sandbox's Ghostscript; virtual specs already ran in spec-check above) ──
  if (resolvedCardType === 'physical') {
    emit('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
    await getAnthropic().beta.sessions.events.send(session.id, {
      events: [{
        type: 'user.message',
        content: [{ type: 'text', text: buildTechSpecPrompt(hasBack, physicalFrontExt, physicalBackExt) }],
      }],
    });

    let techSpecText = '';
    const techStream = await getAnthropic().beta.sessions.events.stream(session.id);
    for await (const event of techStream) {
      if (event.type === 'agent.message') {
        const text = event.content?.map(b => b.text).join('') || '';
        techSpecText += text;
      }
      if (event.type === 'agent.tool_use') {
        emit('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
      }
      if (event.type === 'session.status_idle') break;
    }

    try {
      const jsonMatch = techSpecText.match(/\{[\s\S]*\}/);
      techJson = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch { techJson = null; }
    if (!techJson) throw Object.assign(new Error('Tech spec script did not return valid JSON'), { step: 'tech_specs' });
    emit('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });
  }

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
  await getAnthropic().beta.sessions.events.send(session.id, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: buildVisualPrompt(techJson, resolvedCardType, hasBack) }],
    }],
  });

  const visualStream = await getAnthropic().beta.sessions.events.stream(session.id);
  let agentTextResponse = '';

  for await (const event of visualStream) {
    if (event.type === 'agent.message') {
      const text = event.content?.map(b => b.text).join('') || '';
      agentTextResponse += text;
      if (text) emit('agent_delta', { text });
    }
    if (event.type === 'agent.tool_use') {
      emit('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
    }
    if (event.type === 'session.status_idle') break;
  }
  emit('progress', { step: 'agent_run', message: 'Analysis complete', status: 'done' });

  // ── PDF generation ─────────────────────────────────────────
  emit('progress', { step: 'pdf_generate', message: 'Generating report...', status: 'pending' });
  const results = parseResultsJson(agentTextResponse);
  if (!results) {
    throw Object.assign(
      new Error('Agent did not output structured results (RESULTS_JSON_START/END block missing)'),
      { step: 'pdf_generate' }
    );
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

  // Annotated results PDF.
  // Virtual: a fast (~2-3s) spec-check render call — no session turn, no
  // time gating, so the annotated report is produced on every run.
  // Physical: Turn 3 has the agent render it in-session via the spec script.
  // Skipped (in favor of the fast local pdf-lib report) when the function is
  // close to its maxDuration kill, and hard-capped so a slow turn degrades
  // instead of riding the function into the wall.
  let pdfBuffer = null;
  if (resolvedCardType === 'virtual') {
    try {
      const renderRes = await callSpecCheck('render', {
        image_b64: file.toString('base64'),
        file_name: fileName,
        visual_results: {
          overall_status: results.status || 'REQUIRES CHANGES',
          overall_description: results.summary || '',
          visual_checks: results.visual_checks || [],
        },
      });
      pdfBuffer = Buffer.from(await renderRes.arrayBuffer());
      if (pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error('spec-check render did not return a valid PDF');
      }
    } catch (err) {
      console.error('spec-check render failed, falling back to local report:', err?.message || err);
      emit('progress', { step: 'pdf_generate', message: 'Annotated report unavailable — generating standard report...', status: 'pending' });
      pdfBuffer = null;
    }
  } else if (remainingMs() < RESULTS_PDF_MIN_MS) {
    console.warn(`Skipping annotated results PDF — only ${Math.round(remainingMs() / 1000)}s left before maxDuration`);
    emit('progress', { step: 'pdf_generate', message: 'Low on time — generating standard report...', status: 'pending' });
  } else {
    const turn3Budget = Math.min(120_000, remainingMs() - WRAPUP_RESERVE_MS);
    try {
      pdfBuffer = await withTimeout(
        generateResultsPdfInSession(session.id, results, emit, {
          frontExt: physicalFrontExt,
          backExt: physicalBackExt,
          hasBack,
        }),
        turn3Budget,
        'Annotated results PDF'
      );
    } catch (err) {
      console.error('Turn 3 results PDF failed, falling back to local report:', err?.message || err);
      emit('progress', { step: 'pdf_generate', message: 'Annotated report unavailable — generating standard report...', status: 'pending' });
    }
  }
  if (!pdfBuffer) {
    const pdfImageBuffer = resolvedCardType === 'virtual' ? file : null;
    pdfBuffer = await generatePdfReport(pdfImageBuffer, results, { cardType: resolvedCardType, hasBack });
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

  return { pdfBuffer, status, summary, results, cardType: resolvedCardType };
}

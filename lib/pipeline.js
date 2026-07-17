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

function buildTechSpecPrompt(cardType, hasBack, frontExt = '.ai', backExt = '.ai') {
  if (cardType === 'physical') {
    const frontPath = `/mnt/session/uploads/front${frontExt}`;
    const backArg = hasBack ? ` --back /mnt/session/uploads/back${backExt}` : '';
    const needsGs = frontExt !== '.png' || (hasBack && backExt !== '.png');
    const gsStep = needsGs
      ? `\nIf Ghostscript is missing, install it first (required for .ai/.eps rendering):
\`\`\`bash
which gs || (apt-get update -qq && apt-get install -y ghostscript)
\`\`\`\n`
      : '';
    return `Run the technical spec checker on the physical card art and output ONLY the raw JSON result. No commentary.
${gsStep}
\`\`\`bash
python3 /mnt/session/uploads/scripts/check_technical_specs.py ${frontPath} --card-type physical${backArg}
\`\`\`

Output the complete JSON from the script — nothing else.`;
  }
  return `Run the technical spec checker on the card art image and output ONLY the raw JSON result. No commentary.

\`\`\`bash
python3 /mnt/session/uploads/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png --card-type virtual
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

Examine the card art image visually and evaluate:

Required Elements:
- Visa Brand Mark present, legible, not distorted
- Visa Brand Mark position: upper-left or upper-right ONLY (NO lower-edge)
- Visa Brand Mark margin (CRITICAL — #1 rejection reason): every part of the Visa Brand
  Mark — including the outermost edges of letters like the tips of the "A" in "VISA" and
  every character in the product identifier — must be fully inside the 56px boundary on
  ALL sides. ZERO TOLERANCE: if ANY pixel of the brand mark text touches or crosses the
  56px boundary, this is a fail. Do NOT use approximate language ("looks about right",
  "appears close enough") — zoom in on the boundary edges near the brand mark and check
  each edge explicitly. Cross-reference the bleed_zone measurement in TECH_SPEC_RESULTS:
  it reports exact pixel distances (FAIL < 56px, WARN 56-58px borderline). Borderline
  placements have been rejected by Visa in practice — when in doubt, fail the card.
  This margin applies ONLY to the Visa Brand Mark, not to other logos or elements.
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

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "tech_checks": ${JSON.stringify(techJson.checks || techJson, null, 2)},
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
  ],
  "colors": ${JSON.stringify(techJson.colors || {}, null, 2)}
}
RESULTS_JSON_END

## Output Human-Readable Summary

STATUS: APPROVED | REQUIRES CHANGES | APPROVED WITH NOTES
SUMMARY: <1-2 sentence overview>

TECHNICAL CHECKS:
- Dimensions: PASS/FAIL (actual vs required)
- Format: PASS/FAIL
- DPI: PASS/FAIL
- 56px Margin Zone (Visa Brand Mark): PASS/FAIL/WARNING (restate measured edge distances)

VISUAL CHECKS:
- <check name>: PASS/FAIL/WARNING — <notes>

RGB FALLBACK COLORS:
- Background: #XXXXXX (R, G, B)
- Foreground: #XXXXXX (R, G, B)
- Label: #XXXXXX (R, G, B)`;
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

## Output Structured Results JSON

CRITICAL: You MUST output a JSON block between these exact markers. The system parses this to generate the PDF report. Without it, no report is created.

RESULTS_JSON_START
{
  "status": "APPROVED or REQUIRES CHANGES or APPROVED WITH NOTES",
  "summary": "1-2 sentence overall assessment",
  "card_type": "physical",
  "tech_checks": ${JSON.stringify(techJson, null, 2)},
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

## Output Human-Readable Summary

STATUS: APPROVED | REQUIRES CHANGES
SUMMARY: <1-2 sentence overview>

TECHNICAL CHECKS (front):
- File Format: PASS/FAIL
- CR80 Aspect Ratio: PASS/FAIL
- Min Resolution: PASS/FAIL
- 56px Bleed Zone: PASS/FAIL/WARNING (mirror the tech bleed_zone result)
- Color Mode: PASS/FAIL/UNKNOWN
- Layers Present: PASS/UNKNOWN

VISUAL CHECKS:
- <check name>: PASS/FAIL/WARNING/NOT SUBMITTED — <notes>`;
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

// ── Turn 3: annotated results PDF (virtual only) ────────────────────

// The spec script's --visual-results-file mode renders the full results PDF:
// the card art with the 56px boundary, sample PAN overlay, RGB swatches,
// numbered markers at marker_x/marker_y, and the spec + visual check tables.
// The Node side owns the JSON handoff so the agent only executes commands.
function buildResultsPdfPrompt(visualResultsJson) {
  return `Generate the results PDF. Run exactly this — no commentary:

\`\`\`bash
cat > /tmp/visual_results.json << 'VISUAL_RESULTS_EOF'
${visualResultsJson}
VISUAL_RESULTS_EOF
mkdir -p /mnt/session/outputs
python3 /mnt/session/uploads/scripts/check_technical_specs.py /mnt/session/uploads/card-art.png --card-type virtual --visual-results-file /tmp/visual_results.json --output-dir /mnt/session/outputs
ls -la /mnt/session/outputs/
\`\`\`

Then output ONLY the absolute path of the generated PDF file.`;
}

async function generateResultsPdfInSession(sessionId, results, emit) {
  const visualResults = {
    overall_status: results.status || 'REQUIRES CHANGES',
    overall_description: results.summary || '',
    visual_checks: results.visual_checks || [],
  };

  await getAnthropic().beta.sessions.events.send(sessionId, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: buildResultsPdfPrompt(JSON.stringify(visualResults, null, 2)) }],
    }],
  });

  const stream = await getAnthropic().beta.sessions.events.stream(sessionId);
  for await (const event of stream) {
    if (event.type === 'agent.tool_use') {
      emit('agent_tool', { tool: event.name || 'tool', command: event.input?.command, status: 'running' });
    }
    if (event.type === 'session.status_idle') break;
  }

  // Find the PDF among the session's output files (newest first).
  let pdfFile = null;
  for await (const f of getAnthropic().beta.files.list({ scope_id: sessionId })) {
    if (!f.filename?.endsWith('.pdf') || f.downloadable === false) continue;
    if (!pdfFile || (f.created_at || '') > (pdfFile.created_at || '')) pdfFile = f;
  }
  if (!pdfFile) throw new Error('No PDF found in session output files');

  const response = await getAnthropic().beta.files.download(pdfFile.id);
  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  if (pdfBuffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(`Downloaded session file ${pdfFile.filename} is not a valid PDF`);
  }
  return pdfBuffer;
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
//
// Returns: { pdfBuffer, status, summary, results, cardType }
export async function runAnalysis({ file, fileName, backFile, backFileName, cardType, onProgress }) {
  const emit = onProgress || (() => {});

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

  if (resolvedCardType === 'virtual') {
    const imageFile = new File([file], 'card-art.png', { type: 'image/png' });
    const uploadedImage = await getAnthropic().beta.files.upload({ file: imageFile });
    resources.push({ type: 'file', file_id: uploadedImage.id, mount_path: '/mnt/session/uploads/card-art.png' });
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
  }

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

  emit('progress', { step: 'agent_init', message: 'Starting card art analysis...', status: 'done' });

  const session = await getAnthropic().beta.sessions.create({
    agent: process.env.AGENT_ID,
    environment_id: process.env.ENV_ID,
    resources,
  });

  // ── Turn 1: Tech specs ─────────────────────────────────────
  emit('progress', { step: 'tech_specs', message: 'Running technical spec checks...', status: 'pending' });
  await getAnthropic().beta.sessions.events.send(session.id, {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: buildTechSpecPrompt(resolvedCardType, hasBack, physicalFrontExt, physicalBackExt) }],
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

  let techJson;
  try {
    const jsonMatch = techSpecText.match(/\{[\s\S]*\}/);
    techJson = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch { techJson = null; }
  if (!techJson) throw Object.assign(new Error('Tech spec script did not return valid JSON'), { step: 'tech_specs' });
  emit('progress', { step: 'tech_specs', message: 'Technical specs complete', status: 'done' });

  // ── Turn 2: Visual inspection ──────────────────────────────
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

  // Turn 3 (virtual only): have the agent render the annotated results PDF —
  // card art with the 56px boundary, PAN overlay, RGB swatches, and numbered
  // location markers — via the spec script, then download it from the session.
  let pdfBuffer = null;
  if (resolvedCardType === 'virtual') {
    try {
      pdfBuffer = await generateResultsPdfInSession(session.id, results, emit);
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

  const { status, summary } = parseAgentResponse(agentTextResponse);

  return { pdfBuffer, status, summary, results, cardType: resolvedCardType };
}

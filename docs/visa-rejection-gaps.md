# Where Visa rejects card art that the checker cannot catch

The virtual-card eval sources its cases from Visa's real rejections. This file lists the rejection reasons Visa enforces that the checker cannot catch today, or catches under a different rule than Visa applies. Each section covers what Visa asks for, what the checker does now, and the smallest change that would close the gap.

**Source.** Every design submitted through the card-submission channel and its tracking canvas between 2025-09 and 2026-09: 424 records, including 197 rejections Visa relayed and 70 pre-submission flags. The eval data (partner art, verbatim feedback, PDRs) is private and stays outside this public repo. `REJ-###` and `FAIL-###` are opaque case IDs in that dataset.

**Counts** are design versions whose feedback names the reason. The reasons were sorted by keyword matching, so treat counts as approximate. A single rejection can carry several reasons.

## Summary

| # | Reason | Visa rejections | Checker today | Fix |
|---|---|---|---|---|
| 1 | Brand Mark not *at* 56px (too far, not just too close) | ≈53 | `>=56` minimum; 56–58px counted as borderline | Change the margin rule to "at 56px ±2" |
| 2 | Brand Mark lockup size (109px mark / 170px composite) | ≈14 | Prompt also accepts a 142px "Option Two" | Check the size options against current Visa guidance |
| 3 | Brand Mark color not an allowed version, or a gradient | ≈8 | No virtual color check (physical has one) | New check `visa_brand_mark_color` |
| 4 | Product identifier misaligned with the mark | ≈8 | `product_identifier` has no alignment code | New reason code `identifier_misaligned` |
| 5 | Rounded corners on virtual art | ≈7 | No check | New deterministic tech check |
| 6 | Product identifier font / size / italic | ≈7 (+4 flags) | Only `identifier_casing` exists | New reason codes |
| 7 | Identifier tier doesn't match the BIN / declared product | ≈5 | Virtual prompt never receives the declared product | Pass the declared product into the prompt |
| 8 | Lockup artwork modified / not the official Visa file | ≈3 | No reason code | New reason code |
| 9 | Contactless indicator incorrect or rotated | ≈3 | Prompt says the indicator is allowed — "do NOT flag it" | New check for the correct glyph and orientation |
| 10 | Partner logo violates border guidelines | ≈2 | Prompt says the margin applies **only** to the Visa mark | New check; confirm Visa's partner-logo rule |
| 11 | White border lines around the art | 0 (+4 flags) | No check | New check (lower confidence) |
| 12 | Brand Mark not detected / misdetected by the spec script | — | Margin ends up unverifiable or wrong | Make mark detection more robust |

Reasons the checker already covers are not listed here: position, presence, identifier missing, contrast, lower-left clear, 72 DPI, 1536×969 dimensions, and prohibited elements.

---

## 1. The 56px rule is exact placement, not a minimum

**Visa:** "The Visa logo should be placed at 56 pixels from the (nearest) edges of the card." This is the single most common rejection. Visa returns the same sentence when the mark is *too far* from the edge:

| Case | Strict distance (top/bottom, right) | Visa verdict |
|---|---|---|
| FAIL-001 | 57, **70** | rejected — "confirm that Visa logo is placed at 56 pixels" |
| FAIL-003 | **90**, 54 | rejected — "should be placed at 56 pixels from the edges" |
| (window-4 dispute) | ≈64 ("+8 pixels away from the bleed zone") | rejected |
| PASS-002, 006, 007, 010–013 | 54–57, 56–57 | approved |

Every Visa-approved card measures 54–57px on the `strict_*_px` letter-tip measurement. Every 56px rejection has at least one edge outside that band. Several internal disputes of Visa's feedback, including "our logo is 65px from the edge", were arguing under the minimum reading that Visa does not apply.

**Checker today:**
- `scripts/check_technical_specs.py` `check_bleed_zone` fails below 56 and marks 56–58 as `borderline`. Anything above 58 passes, including 70px and 90px.
- `references/visa-requirements.md:39` and the virtual prompt in `lib/pipeline.js` describe a *minimum* margin.

**Fix:**
- Pass when both nearest-edge strict distances fall within 54–58px. Fail below 54 (existing `margin_below_minimum`), and fail above 58 with a new reason code `margin_above_target`.
- Drop the "borderline = warning" band. Under the eval's scoring, a warning on a known-bad card counts as a miss.
- Update the reference doc and prompt wording to "placed at 56px".
- **Eval cases:** FAIL-001, FAIL-003, LOCAL-001, LOCAL-002, REJ-001…REJ-006 and their `-FIXED` pairs.

## 2. Brand Mark lockup size

**Visa (recent, repeated):**
- "Please ensure the Visa logo is set to a height of 109 px. Composite logo is set to a 170px height."
- "The Visa Logo must have a height of 170 px with identifier and be placed 56 px from the edges."
- "The Visa logo is smaller than the minimum size allowed … The total height, including the Platinum identifier, must be 170 px."
- "The distance from the top of the Visa logo to the baseline of the product identifier should be 170 pixels."

**Checker today:** `lib/pipeline.js:131-132` accepts two options: 109px (Debit) and **142px** (Signature/Platinum/Infinite). One internal thread adopted "size option #2 (142px high)", and the design was then rejected for identifier font size.

**Fix:**
- Check the 142px option against the current Visa Product Brand Standards. Visa's feedback describes a single geometry: a 109px mark, and 170px from the top of the mark to the identifier baseline.
- The spec script already finds the mark's bounding box, so a deterministic height measurement would take this off the model entirely.
- **Eval cases:** FAIL-004, REJ-010, REJ-011, REJ-019.

## 3. Brand Mark color

**Visa:**
- "Please update the Visa logo to black or Visa Blue color. The color used is not a valid version."
- "Please update the Visa logo with Signature identifier to white, black or Visa Blue color."
- "update the Visa logo using the following code color R20 G52 B203"
- "Use the Visa Gold Premium or Foil ink logo, don't add a gradient"

**Checker today:** the virtual catalog (`lib/check-catalog.js`) has no color check. The physical catalog has `visa_brand_mark_color_front`, and the physical prompt lists allowed colors at `lib/pipeline.js:292`.

**Fix:**
- Add `visa_brand_mark_color` (severity `blocker`) to the virtual catalog, with reason codes `mark_color_not_permitted` and `mark_gradient_applied`.
- Allowed colors: white, black, Visa Blue (R20 G52 B203), plus the Gold/Silver premium ink versions, flat and without a gradient.
- Sampling the mark's pixels inside the bounding box the spec script already computes would make this deterministic.
- **Eval cases:** REJ-012, REJ-013, REJ-014, REJ-029.

## 4. Product identifier alignment

**Visa:**
- "The Platinum identifier must be aligned to the right."
- "The corporate identifier isn't align with Visa brand mark."
- "the Platinum identifier be aligned to the left."
- "The Platinum identifier needs to be aligned with the Visa logo."

**Checker today:** `product_identifier` has codes for absent, wrong corner, separated, PAN zone, casing and tier. None of them covers alignment within the lockup.

**Fix:**
- Add the reason code `identifier_misaligned`.
- State the rule in the prompt: the identifier's edge aligns with the mark's outer edge on the mark's side (right-aligned under a right-corner mark, left-aligned under a left-corner mark).
- **Eval cases:** FAIL-005, REJ-024, REJ-025, REJ-037, REJ-038.

## 5. Rounded corners

**Visa:** "The corners of the card must be squared." / "The artwork must not have rounded corners." The Visa submission lead also pre-screens this: "card shouldn't have rounded corner".

**Checker today:** no virtual check. `rounded_corners_cr80` exists only for physical cards, where rounding is *required*.

**Fix:**
- Add a deterministic tech check `square_corners` in `check_technical_specs.py`. It would flag transparent (alpha) or background-mismatched pixels in the four corner regions, where a rounded export leaves an arc.
- This is cheap and exact, so there's no need to spend model attention on it.
- **Eval cases:** REJ-009, REJ-037, REJ-038.

## 6. Product identifier typography

**Visa:**
- "Visa Platinum identifier is incorrect - it's italicized and needs to be straight"
- "the first letter must be capitalized"
- "The product identifier was modified. Please use the correct Visa logo with the Signature identifier"

**Pre-screens:** "the size of the font for the platinum and corporate identifier is too big" / "font for Signature is also wrong, they likely did not use template"

**Checker today:** `identifier_casing` covers casing only.

**Fix:**
- Add the reason codes `identifier_font_mismatch` (wrong typeface or style, including italic) and `identifier_size_mismatch`.
- Close examination works best from the existing `brand_mark` zoom crop. A reference render of the official lockup, mounted the way the physical flow mounts `reference_template.png`, would give the agent something to compare against.
- **Eval cases:** REJ-026, REJ-027, REJ-028.

## 7. Identifier tier vs. declared product

**Visa:** "Please update the product identifier, it should be Signature Corporate." / "Please confirm the BIN, now it does not match (Classic) vs. card image (Platinum)".

**Checker today:**
- `identifier_tier_mismatch` exists as a code.
- The virtual prompt (`buildVirtualVisualPrompt`) never receives the declared product, so the agent can only check that *some* valid identifier is present.
- The physical flow infers a tier from layer names or the filename. Nothing equivalent exists for virtual.

**Fix:**
- Accept a `declaredProduct` field on `/api/card-check` and `/api/card-art-check`. It could come from the Rocketlane form or the Rain back-office caller.
- Include it in the virtual prompt so the agent can compare the identifier against it.
- Until then, these eval cases are tagged `needs_declared_product` and reported outside the headline.
- **Eval cases:** REJ-014, REJ-022, REJ-023.

## 8. Official lockup artwork

**Visa:** "Use the correct Visa Corporate Logo" / "Please use the logo available in VPBS" / "The product identifier was modified."

**Checker today:** no reason code for a lockup that is present and legible but isn't Visa's artwork (redrawn, re-typeset, or the wrong variant).

**Fix:**
- Add the reason code `lockup_not_official_artwork` under `product_identifier`.
- A pixel comparison against the official lockup files is the durable fix, and it is the same asset gap as #6.
- **Eval cases:** REJ-017, REJ-018, REJ-019.

## 9. Contactless indicator

**Visa:** "Please rotate 180 degrees the Contactless indicator." / "The Contactless indicator is incorrect, please update it." Visa asks for a *correct* indicator, not for its removal: one internal flag said "there shouldn't be a tap icon", and Visa approved that card with the icon.

**Checker today:** `lib/pipeline.js:177` tells the agent the indicator is allowed and not to flag it. There is no check that it is the official glyph in the correct orientation.

**Fix:**
- Add a virtual check `contactless_indicator` (severity `required`) with the reason codes `contactless_indicator_incorrect` and `contactless_indicator_rotated`. It passes when the indicator is absent, or present and correct.
- Keep "presence alone is not a failure" (FAIL-002 is now an expected pass).
- **Eval cases:** REJ-042, REJ-043, REJ-044.

## 10. Partner logo and the border guidelines

**Visa:** "Please adjust the partner logo to ensure it complies with the border guidelines." / "Please add the missing Visa logo and adjust the borders to ensure they comply with the established guidelines."

**Checker today:** the prompt and `references/visa-requirements.md:39,84` state that the 56px margin applies **only** to the Visa Brand Mark.

**Fix:**
- Find out what border rule Visa applies to partner and issuer logos: the same 56px, or a separate safe area. This is an open question.
- Then add a check such as `issuer_logo_within_border` and correct the "only the Visa mark" wording.
- **Eval cases:** REJ-031, REJ-032.

## 11. White border lines

**Pre-screens only** (no verbatim Visa feedback yet): "the card design has white border lines, pls review and modify" / "automatically rejected due to it having white border lines".

**Fix:**
- Lower confidence. Add the reason code `border_frame_present`, either under `no_physical_card_photography` (a framed card-on-background render) or as its own check.
- A thin uniform-color frame along all four edges can also be detected deterministically.
- These eval cases are tagged `prescreen_label`.
- **Eval cases:** REJ-039, REJ-040, REJ-041.

## 12. Spec-script mark detection

This isn't a Visa reason, but it silently blocks gap #1.

- On three Visa-approved cards with light or metallic marks, `check_bleed_zone` returns `mark_detected: false`.
- On one approved card with a patterned background, it locks onto the pattern and reports 213/153px.
- In both cases the margin verdict falls back to the agent's eyeball, or is simply wrong.

**Fix:** make detection robust to light-on-light and metallic marks, and to line patterns near the corner. The failing cards are a ready-made regression set.

**Eval cases:** PASS-003, PASS-004, PASS-005 (not detected); PASS-009 (misdetected).

---

## Physical-only reasons (outside the virtual eval)

- **Chip on art submitted through the digital flow:** "Please remove the Chip from the card art" (≈4).
- **Manufacturer code on the back doesn't match the job number** (1). There is no physical check for this.

## Keeping this list current

- The reason list lives with the eval data (`rejection-reasons.csv`), and every reason maps to a catalog check or is marked as a gap.
- When Visa returns a new rejection, add the design as an eval case under its reason.
- When a reason here gets a check, its gap cases start counting toward the headline recall, so the eval shows whether the fix works.

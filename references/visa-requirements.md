# Virtual / Digital Card Art Requirements Reference

*Source: Visa Digital Card Brand Standards (September 2025), updated with the rules Visa enforces in submission feedback (2025-09 to 2026-09; see `docs/visa-rejection-gaps.md`)*

---

## Technical Specifications

| Spec | Required Value |
|------|---------------|
| Dimensions | 1536 × 969 pixels |
| Aspect ratio | ISO ID-1 card proportional |
| File format | PNG |
| Resolution | 72 DPI (declared density) |
| Orientation for review submission | Horizontal (landscape) only |

> DPI is the density the file declares (PNG pHYs, JPEG JFIF/EXIF). Visa rejects files
> that declare any other value. A file with no density metadata reads as 72 and passes.
> The pixel size is checked separately (1536 × 969).

---

## Basic Graphic Elements (Required)

Per Visa Digital Card Brand Standards, these elements must appear on every digital card:

| Element | Requirement |
|---------|-------------|
| **A — Issuer logo** | Must be present and legible, and stay out of the 56px bleed zone (at least 53px from every edge). |
| **B — Issuer card art** | The card design itself. Design elements may extend to the card edge. |
| **C — Visa Brand Mark** | Must be present, legible, and not distorted |

---

## Visa Brand Mark Requirements

- Must be present and clearly legible
- Positioned in **upper-left or upper-right** corner only — no lower-edge placement allowed
- Placed **at 56px** from the nearest top/bottom edge **and** the nearest side edge. This is exact placement, not a minimum: Visa rejects a mark that sits too **far** from the edge with the same sentence it uses for one too close ("The Visa logo should be placed at 56 pixels from the edges of the card"). The checker accepts 53–59px on the strict letter-tip distances (letter tips like the "A" in VISA included); Visa-approved cards in the eval set measure 53–59px, most 54–57px. This is the **#1 reason Visa rejects card art**.
- Must not be distorted or stretched
- Must be the 109px lockup (see below)
- Must be a permitted color version, flat (see below)
- **Must have strong color contrast against the card background** — both the "VISA" wordmark and the product identifier (Signature, Platinum, Infinite, Debit, etc.) must be clearly readable. If the background is medium or bright, use white. If the background is very light, use dark. Avoid gray/silver text on colored backgrounds — Visa has rejected cards for insufficient contrast (e.g., silver "Platinum" on pink).
- When cards are stacked in a digital wallet, Brand Mark must be visible in upper-left or upper-right

### Visa Brand Mark Lockup Size

Visa's submission feedback describes a single lockup geometry on a 1536×969 card:

| Dim | Value | Description |
|-----|-------|-------------|
| C | 109 px | Height of Visa Brand Mark |
| D | 170 px | Distance from top of Visa Brand Mark to baseline of the product identifier |
| E | 56 px | Distance from nearest card edges to Visa Brand Mark (exact placement) |
| F | — | Lower-left area reserved for personalization, must be free of marks/graphics |

Visa's wording: "Please ensure the Visa logo is set to a height of 109 px. Composite logo is set to a 170px height." Approved cards measure 104–109px on the wordmark.

Visa's official lockup files (Platinum, Signature, Infinite, Corporate) set exactly this geometry: a 109px mark at 56px from the top and side edges, the identifier's cap height 35px, and its baseline 170px below the mark's top. On an upper-right lockup the identifier is right-aligned with the mark; on an upper-left lockup it starts under the foot of the V. Rendered copies live in `assets/lockups/`; the checker compares every submission against them and mounts the matching one for the agent.

> **Retired Option Two (142 px mark, 220 px to the identifier baseline).** Earlier
> guidance allowed this for Signature/Platinum/Infinite. Visa's current lockup is
> 109px, and a 142px mark now fails like any other wrong size.

### Visa Brand Mark Color

Permitted versions: **white**, **black**, **Visa Blue (R20 G52 B203)**, or the **Visa Gold / Silver premium ink** versions. Every version is **flat**: no gradient, metallic shading or sheen. Brown or dark-gold marks are rejected ("Please update the Visa logo with Signature identifier to black or Visa Blue color"); the checker treats a gold mark as a warning because Visa's feedback on Signature cards names white, black or Visa Blue only. Visa's wording: "Please update the Visa logo to black or Visa Blue color. The color used is not a valid version." / "Use the Visa Gold Premium or Foil ink logo, don't add a gradient".

> Note: Not all digital wallets or mobile applications are able to support placement of the
> Visa Brand Mark in the upper left or upper right position. Check with the Solution Provider
> regarding allowed placements.
- **Artwork and background elements have no margin requirement** — they may bleed to the card edge. Partner and issuer logos keep out of the 56px bleed zone (see Bleed Rules).

---

## Orientation Rules

- **Preferred display**: Landscape (horizontal)
- **Allowed in-app display**: Portrait (vertical) on devices that support it
- **For Visa review submission**: **Always submit in horizontal (landscape) orientation**
- When displayed vertically, the Brand Mark must still be in upper-left or upper-right

---

## Bleed Rules

- The **56px placement rule is specific to the Visa Brand Mark**
- Design elements, artwork, and background **may extend to the card edge** (full bleed is allowed)
- **Partner and issuer logos stay out of the 56px bleed zone**, like the Visa Brand Mark: no part of a logo within 53px (56px, −3px tolerance) of any card edge. Visa: "Please adjust the partner logo to ensure it complies with the border guidelines." Unlike the mark, a logo may sit farther in — Visa has approved logos at 71px and 112px.

## Canvas Edges

- **Square corners only.** "The corners of the card must be squared." / "The artwork must not have rounded corners." The wallet applies its own corner mask; a rounded export leaves transparent or matte arcs in the corners.
- **No border lines.** White border lines, transparent padding along an edge, or a frame around the art (a card-on-background render) are rejected at pre-screen. Export the design full-bleed to the 1536×969 canvas.

---

## Prohibited Elements

The following must NOT appear on digital card art:

| Prohibited Element | Reason |
|-------------------|--------|
| Cardholder name | Security |
| Full PAN / card number | Security |
| Expiry date | Security |
| EMV chip contacts / chip graphic | Physical-only element |
| Hologram imagery (static pictures of holograms, Visa Dove) | Physical-only dynamic element |
| Magnetic stripe graphics | Physical-only element |
| 3D shading / embossed effects making it look physical | Digital art must be flat |
| Physical card photographs or highly detailed card illustrations | No physical representations |
| Labels describing embossed attributes | Physical-only element |
| Any graphics in the lower-left area | Reserved for dynamic personalization (last 4 PAN digits) |

---

## Permitted Elements

- **Contactless Indicator ( ))) )** — allowed even if the physical card is not contactless enabled. Its absence is fine. When present it must be the official EMVCo symbol in the correct orientation: four arcs radiating to the right, growing left to right. Visa rejects a rotated or incorrect indicator ("Please rotate 180 degrees the Contactless indicator." / "The Contactless indicator is incorrect, please update it.").
- Partial card image — acceptable only after the user has already seen the full digital card art
- Gradients and flat color designs

---

## Lower-Left Reserved Zone

- The **lower-left area** of the card is reserved for card personalization (last 4 PAN digits) and **must not contain any marks or graphics**
- This means: no issuer logos, brand names, icons, design elements, text, or any other visual content
- Only the card's background color or pattern should be visible in this area
- The Visa Brand Mark must also never be placed in the lower-left
- **Common rejection reason**: issuers frequently place their logo in the bottom-left corner, which will be rejected

---

## Product Identifier Protection

- The Visa product identifier text (Signature, Platinum, Infinite, etc.) must remain clearly legible
- Design elements, artwork, and logos must not obscure, overlap, or touch the product identifier
- Ensure sufficient clear space around the identifier text

---

## Product Identifier Requirement (Rain)

Every Rain-issued card **must** display a Visa product identifier in the product
lockup with the Visa Brand Mark. Rain no longer offers the Classic tier, so a product
identifier is **always required** — there is no valid case where it can be absent.

- **Required identifier — one of four**:
  - Consumer cards: `Visa Platinum`, `Visa Signature`, or `Visa Infinite`
  - Business / corporate cards: `Corporate`, or the business/corporate variant of a tier (e.g. `Signature Corporate`)
- **Anchoring**: The identifier must be placed directly below or immediately adjacent
  to the Visa Brand Mark, in the **same upper corner** (upper-left or upper-right).
- **Reserved zone**: The identifier must never be placed in the lower-left
  personalization-reserved zone.
- **Disassociation**: The identifier must not be in the opposite corner from the
  Brand Mark, or separated from it by unrelated graphic elements.
- **Canonical text** (case-insensitive match, casing deviations are a warning):
  `Visa Platinum`, `Visa Signature`, `Visa Infinite`, `Corporate`.
- **Alignment**: the identifier's edge aligns with the mark's outer edge on the
  mark's side — right-aligned under an upper-right mark, left-aligned under an
  upper-left mark. Approved lockups align within 3px.
- **Typography**: Visa's identifier type, upright (not italic), first letter capitalized,
  sized to the 170px lockup. Visa rejects modified identifiers ("it's italicized and
  needs to be straight", "The product identifier was modified").
- **Official artwork**: the lockup must be Visa's own file (VPBS), not redrawn,
  re-typeset, distorted, or the wrong variant. (The flag on the top-left of the V is
  part of the official wordmark.) The identifier's size relative to the mark must
  match the official lockup within about ±15%.
- **Failure conditions**:
  1. No identifier visible on the card.
  2. Identifier in the opposite corner from the Brand Mark.
  3. Identifier in the lower-left personalization zone.
  4. Identifier separated from the Brand Mark by unrelated artwork.
  5. Identifier misaligned with the Brand Mark.
  6. Wrong typeface, style (italic), or size; modified lettering.
  7. Lockup is not Visa's official artwork.
  8. Identifier tier does not match the declared product (when the caller supplies
     `declaredProduct` — e.g. "Please update the product identifier, it should be
     Signature Corporate").

> Tier-match validation needs the provisioned product. Callers pass it as
> `declaredProduct`; without it the checker only verifies that a valid identifier
> is present.

---

## Display Rules

- Must appear in full color on color-capable screens
- Do not alter the position of card elements from the approved layout
- Card art is NOT required to match the physical card design
- Card art must not include shading or three-dimensional elements attempting to look like a physical card

---

## Fallback RGB Color Values (Required from Issuer)

Submitted separately from the card art image. Used as fallbacks when the card image cannot render (low bandwidth, connectivity issues):

| Color Field | Purpose | How to Identify |
|-------------|---------|-----------------|
| `background_color` | Shown when card image can't render | Dominant card background color |
| `foreground_color` | For variable values: last 4 PAN digits | Color used for prominent text/numbers |
| `label_color` | For labels on the card (e.g., "Debit", "Credit") | Color used for descriptive labels |

---

## What "Digital" Means (vs. Physical)

Digital card art is NOT required to match the physical card. Key differences:
- No chip graphic
- No hologram graphic
- No magnetic stripe graphic
- No 3D/embossed effects
- No physical card photography
- Flat design appropriate for screen display
- Contactless Indicator is allowed (unlike other physical elements)
- Must include last 4 PAN digit placeholder (physical cards do not require this in design artwork)
- Visa Brand Mark must be upper-left or upper-right only (no lower-edge placement)

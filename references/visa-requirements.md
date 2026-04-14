# Virtual / Digital Card Art Requirements Reference

*Source: Visa Digital Card Brand Standards (September 2025)*

---

## Technical Specifications

| Spec | Required Value |
|------|---------------|
| Dimensions | 1536 × 969 pixels |
| Aspect ratio | ISO ID-1 card proportional |
| File format | PNG |
| Resolution | ≥72 DPI (calculated from pixel width ÷ 3.375″) |
| Orientation for review submission | Horizontal (landscape) only |

> DPI is calculated from image resolution — not read from file metadata.
> Formula: `pixel_width ÷ 3.375` (ISO ID-1 card width in inches).
> At the standard 1536px width, calculated DPI is ~455, well above the 72 DPI minimum.

---

## Basic Graphic Elements (Required)

Per Visa Digital Card Brand Standards, these elements must appear on every digital card:

| Element | Requirement |
|---------|-------------|
| **A — Issuer logo** | Must be present and legible. May bleed to edge — no margin requirement. |
| **B — Issuer card art** | The card design itself. Design elements may extend to the card edge. |
| **C — Visa Brand Mark** | Must be present, legible, and not distorted |

---

## Visa Brand Mark Requirements

- Must be present and clearly legible
- Positioned in **upper-left or upper-right** corner only — no lower-edge placement allowed
- Minimum margin of **56px** from nearest card edges — **this margin applies ONLY to the Visa Brand Mark**. Zero tolerance: any part of the brand mark (including letter tips like the "A" in VISA, and product identifier text) crossing this boundary is a hard fail. This is the **#1 reason Visa rejects card art**.
- Must not be distorted or stretched
- Must match one of two allowed size options (see below)
- **Must have strong color contrast against the card background** — both the "VISA" wordmark and the product identifier (Signature, Platinum, Infinite, Debit, etc.) must be clearly readable. If the background is medium or bright, use white. If the background is very light, use dark. Avoid gray/silver text on colored backgrounds — Visa has rejected cards for insufficient contrast (e.g., silver "Platinum" on pink).
- When cards are stacked in a digital wallet, Brand Mark must be visible in upper-left or upper-right

### Visa Brand Mark Size Options

Only two size options are permitted for the Visa Brand Mark on a 1536×969 card:

**Option One — With Debit Identifier** (Debit cards):
| Dim | Value | Description |
|-----|-------|-------------|
| C | 109 px | Height of Visa Brand Mark |
| D | 56 px | Distance from nearest card edge to Visa Brand Mark |
| E | 56 px | Distance from baseline of debit identifier to top of Visa Brand Mark |
| F | 50 px | Minimum height of debit identifier |
| G | — | Lower-left area reserved for personalization, must be free of marks/graphics |

**Option Two — Standalone or with Product Identifier** (Signature, Platinum, Infinite, etc.):
| Dim | Value | Description |
|-----|-------|-------------|
| C | 142 px | Height of Visa Brand Mark |
| D | 220 px | Distance from top of Visa Brand Mark to baseline of product identifier (when present) |
| E | 56 px | Distance from nearest card edge to Visa Brand Mark |
| F | — | Lower-left area reserved for personalization, must be free of marks/graphics |

> Note: Not all digital wallets or mobile applications are able to support placement of the
> Visa Brand Mark in the upper left or upper right position. Check with the Solution Provider
> regarding allowed placements.
- **Other logos and design elements have NO margin requirement** — they may bleed to the card edge

---

## Orientation Rules

- **Preferred display**: Landscape (horizontal)
- **Allowed in-app display**: Portrait (vertical) on devices that support it
- **For Visa review submission**: **Always submit in horizontal (landscape) orientation**
- When displayed vertically, the Brand Mark must still be in upper-left or upper-right

---

## Bleed Rules

- The **56px margin requirement applies ONLY to the Visa Brand Mark**
- Issuer logos, design elements, artwork, and other visuals **may extend to the card edge** (full bleed is allowed)
- Do NOT flag non-Visa elements for being too close to the edge

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

- **Contactless Indicator (⟳ / )))** — allowed even if the physical card is not contactless enabled
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

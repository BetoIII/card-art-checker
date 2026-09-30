#!/usr/bin/env python3
"""
Technical spec checker for Visa virtual/digital AND physical card art.

VIRTUAL (PNG, 1536x969):
  Dimensions, format (PNG), DPI (pixel_width / CARD_WIDTH_INCHES),
  Visa Brand Mark lockup (placed at 56px, 109px mark height, identifier
  alignment, permitted flat ink color), square corners, no border frame,
  RGB color extraction.

PHYSICAL (.ai / .eps vector, or .png raster):
  File format, CR80 aspect ratio (~1.586:1), minimum rendered resolution,
  56px Visa Brand Mark bleed zone, color mode (vector only: CMYK/PMS
  preferred), layer-separation heuristic (vector only).
  Front required; back optional. Vectors are rasterized via Ghostscript
  at 455 DPI to produce a 1536-wide preview that matches Rain's physical
  card template spec.

Usage:
    # Virtual (default — preserves pre-physical behavior):
    python3 check_technical_specs.py <image_path> [--output-dir /path]
    python3 check_technical_specs.py <image_path> --card-type virtual [--output-dir /path]

    # Physical:
    python3 check_technical_specs.py <front_file> --card-type physical [--back <back_file>]

    # Annotated results PDF (either card type) — pass the visual-inspection
    # results and the script renders the full Card Art Checker Results page:
    python3 check_technical_specs.py <file> --card-type <type> \
        --visual-results-file results.json --output-dir /path

Outputs JSON with technical check results; virtual also emits RGB color
suggestions. Physical emits a rendered_preview_path that the visual turn
and the PDF report can use as a raster preview. With --visual-results[-file],
virtual renders the single-card annotated report and physical renders the
front/back review panes with the same status/spec/visual sections.
"""

import sys
import io
import json
import os
import argparse
import textwrap

try:
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
except ImportError as e:
    # No runtime self-install: every environment this runs in (agent sandbox,
    # Vercel function via requirements.txt, local venv) pre-installs the deps.
    raise ImportError(
        "Pillow and numpy are required — install them in the host environment "
        "(pip install Pillow numpy)"
    ) from e


REQUIRED_WIDTH = 1536
REQUIRED_HEIGHT = 969
REQUIRED_FORMAT = "PNG"
CARD_WIDTH_INCHES = 3.375   # ISO ID-1 standard credit card width
MIN_DPI_DIGITAL = 72        # Visa minimum DPI for digital card display
VISA_MARK_EDGE_MARGIN = 56  # pixels — applies ONLY to the Visa Brand Mark

# --- Virtual Visa Brand Mark lockup geometry (1536x969 scale) ---
# Visa places the mark AT 56px, not "at least" 56px: it rejects marks that sit
# too far from the edge with the same sentence it uses for too-close marks.
# Visa-approved cards in the eval set measure 53-59px strict on both nearest
# edges (most 54-57; one explicitly approved fix at 53/59), and the nearest
# margin rejection is ~64px, so the band is 56 +/- 3 on the strict
# letter-tip distances.
VISA_MARK_MARGIN_TOLERANCE = 3
# Visa's feedback describes one lockup: a 109px mark, and 170px from the top
# of the mark to the product identifier's baseline. Approved cards measure
# 104-109px tall on the wordmark (anti-aliased letter tips vary a few px).
VISA_MARK_HEIGHT_PX = 109
VISA_MARK_HEIGHT_TOLERANCE_PX = 7
# The 142px "Option Two" in references/visa-requirements.md has no approved
# example and Visa's recent feedback asks for 109px; a mark at that size is a
# warning to confirm, not a pass.
VISA_MARK_LEGACY_HEIGHT_PX = 142
VISA_LOCKUP_COMPOSITE_PX = 170
# Identifier edge vs. the mark's outer edge. Approved lockups sit within 3px.
IDENTIFIER_ALIGN_TOLERANCE_PX = 6
IDENTIFIER_ALIGN_FAIL_PX = 15
# Visa Blue, per Visa's feedback ("R20 G52 B203").
VISA_BLUE_RGB = (20, 52, 203)

# --- Physical card constants (CR80, per ISO/IEC 7810) ---
CR80_ASPECT_RATIO = 3.375 / 2.125            # ≈ 1.5882
CR80_ASPECT_TOLERANCE = 0.05                 # ±5% tolerance
# CR80 / ID-1 trim size in PDF points (85.60 x 53.98 mm). Rain's canonical
# physical templates carry these exact dims in their TrimBox, with an 18pt
# (0.25") bleed on every side (MediaBox = BleedBox = trim + 2x18pt).
CR80_TRIM_LONG_PT = 242.65
CR80_TRIM_SHORT_PT = 153.01
TRIM_TOLERANCE_PT = 2.0
MIN_BLEED_PT = 9.0        # 1/8" — industry minimum; below this is a FAIL
CANONICAL_BLEED_PT = 18.0  # 0.25" — Rain's canonical templates; below is a WARN
# Visa Brand Mark quiet zone for PHYSICAL cards, in render pixels at 455 DPI,
# measured from the TRIM edge. Rain's canonical templates place the mark
# 52-54px (~3mm) from trim, so the physical threshold is calibrated to pass
# them; virtual keeps the original 56px@1536w digital-template rule.
PHYSICAL_MARK_EDGE_MARGIN = 50
PHYSICAL_MIN_RENDERED_WIDTH_PX = 1000         # minimum usable raster width
PHYSICAL_VECTOR_EXTS = {".ai", ".eps"}
PHYSICAL_RASTER_EXTS = {".png"}
PHYSICAL_ACCEPTED_EXTS = PHYSICAL_VECTOR_EXTS | PHYSICAL_RASTER_EXTS
# 455 DPI × 3.375" = 1536px wide. This matches Rain's 1536×969 physical card
# templates, which were designed with a 56px Visa Brand Mark bleed zone —
# the same threshold used for virtual cards. Keeping render width at 1536
# lets check_bleed_zone reuse VISA_MARK_EDGE_MARGIN directly.
PHYSICAL_RENDER_DPI = 455

# Status colors
COLOR_PASS = (34, 139, 34)       # forest green
COLOR_FAIL = (207, 34, 46)      # red
COLOR_WARNING = (210, 140, 20)  # amber/orange
COLOR_UNVERIFIED = (140, 140, 140)  # gray
COLOR_ESTIMATED = (210, 140, 20)

STATUS_COLORS = {
    "pass": COLOR_PASS,
    "fail": COLOR_FAIL,
    "warning": COLOR_WARNING,
    "estimated": COLOR_ESTIMATED,
    "unverified": COLOR_UNVERIFIED,
    "not submitted": COLOR_UNVERIFIED,
}

STATUS_LABELS = {
    "pass": "PASS",
    "fail": "FAIL",
    "warning": "WARN",
    "estimated": "EST.",
    "unverified": "N/V",
    "not submitted": "N/S",
}


def extract_colors(img):
    """Extract background, foreground, and label color suggestions from the image."""
    rgb_img = img.convert("RGB")
    arr = np.array(rgb_img)

    # Background color: sample corners (avoid logo areas)
    corner_size = 40
    corners = [
        arr[:corner_size, :corner_size],
        arr[:corner_size, -corner_size:],
        arr[-corner_size:, :corner_size],
        arr[-corner_size:, -corner_size:],
    ]
    corner_pixels = np.concatenate([c.reshape(-1, 3) for c in corners], axis=0)
    bg_color = corner_pixels.mean(axis=0).astype(int).tolist()

    # Dominant colors — sample a grid of pixels
    sample = arr[::8, ::8].reshape(-1, 3)

    from collections import Counter
    quantized = (sample // 16) * 16
    counts = Counter(map(tuple, quantized.tolist()))
    most_common = counts.most_common(10)

    dominant_colors = [
        {"rgb": list(color), "hex": "#{:02X}{:02X}{:02X}".format(*color), "count": cnt}
        for color, cnt in most_common
    ]

    # Background luminance for contrast decisions
    bg_luminance = 0.299 * bg_color[0] + 0.587 * bg_color[1] + 0.114 * bg_color[2]

    # Separate dominant colors into "background-like" and "accent" colors
    accent_colors = []
    for dc in dominant_colors:
        c = dc["rgb"]
        lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        contrast = abs(lum - bg_luminance)
        is_chromatic = max(c) - min(c) > 20
        if contrast > 40:
            accent_colors.append({"rgb": c, "lum": lum, "contrast": contrast,
                                  "chromatic": is_chromatic, "count": dc["count"]})

    # Foreground color: prefer a chromatic accent color with good contrast
    suggested_fg = [255, 255, 255] if bg_luminance < 128 else [30, 30, 30]
    for ac in accent_colors:
        if ac["chromatic"] and ac["contrast"] > 60:
            suggested_fg = ac["rgb"]
            break
    if suggested_fg in ([255, 255, 255], [30, 30, 30]):
        for ac in sorted(accent_colors, key=lambda x: x["contrast"], reverse=True):
            if ac["contrast"] > 60:
                suggested_fg = ac["rgb"]
                break

    # Label color: prefer white or light color on dark bg, dark on light bg
    if bg_luminance < 128:
        suggested_label = [255, 255, 255]
        for ac in accent_colors:
            if ac["lum"] > 180:
                suggested_label = ac["rgb"]
                break
    else:
        suggested_label = [30, 30, 30]
        for ac in accent_colors:
            if ac["lum"] < 80:
                suggested_label = ac["rgb"]
                break

    return {
        "background": {
            "rgb": bg_color,
            "hex": "#{:02X}{:02X}{:02X}".format(*bg_color),
            "description": "Suggested background — shown when card image cannot render",
            "note": "Based on dominant card background color"
        },
        "foreground": {
            "rgb": suggested_fg,
            "hex": "#{:02X}{:02X}{:02X}".format(*suggested_fg),
            "description": "Suggested foreground — for last 4 PAN digits and variable values",
            "note": "Chosen for contrast against the background color"
        },
        "label": {
            "rgb": suggested_label,
            "hex": "#{:02X}{:02X}{:02X}".format(*suggested_label),
            "description": "Suggested label color — for static labels on the card",
            "note": "Chosen for readability against the background color"
        },
        "dominant_colors": dominant_colors,
    }


def _density_filter(mask, kernel=12, min_neighbors=8):
    """
    Remove isolated mark pixels (decorative lines/patterns) by requiring
    a minimum number of mark-pixel neighbors within a local window.
    Text characters form dense clusters; thin decorative lines do not.
    """
    mm = mask.astype(float)
    rh, rw = mm.shape
    k = kernel
    padded = np.zeros((rh + k, rw + k))
    padded[:rh, :rw] = mm
    cs = np.cumsum(np.cumsum(padded, axis=0), axis=1)
    density = cs[k:rh + k, k:rw + k] - cs[k:rh + k, :rw] - cs[:rh, k:rw + k] + cs[:rh, :rw]
    return mask & (density >= min_neighbors)


def check_bleed_zone(img, trim_offsets=None, margin_px=None):
    """
    Measure the pixel distance from the Visa Brand Mark to card edges.

    PHYSICAL only: virtual art uses check_virtual_mark, which locates the mark
    in either polarity and applies Visa's "placed at 56px" rule. Here the mark
    must clear a minimum quiet zone from the trim edge.

    trim_offsets: optional {left, right, top, bottom} pixel offsets of the
    TrimBox inside the raster (from _check_physical_side's PDF-box pass).
    When given, the analysis crops to the trim rectangle first, so every
    distance is measured from the TRIM edge — files with bleed would
    otherwise report margins inflated by the bleed width.

    margin_px: optional quiet-zone size in pixels of THIS raster's scale
    (56px at 455 DPI ≈ 0.123"). Defaults to VISA_MARK_EDGE_MARGIN.

    The algorithm uses a two-pass approach:
    1. LOCALIZATION: Finds the Visa mark center in a safe interior zone using
       a strict brightness threshold + density filtering to distinguish the
       mark text from decorative patterns (metallic effects, line art, etc.)
    2. MEASUREMENT: Measures exact pixel distance from mark edges to card edges
       within a focused area around the localized mark.

    The mark is detected via brightness: white text on dark backgrounds, or
    dark text on light backgrounds. A density filter removes sparse decorative
    elements (thin lines, scattered highlights) that would otherwise create
    false distance readings.

    Returns a dict with per-edge measurements and an overall pass/fail.
    The verdict is driven by the strict distances (nearest mark pixel to the
    edge, anti-aliased letter tips included): FAIL below 56px, BORDERLINE at
    exactly 56px.
    """
    gray = np.array(img.convert("L"), dtype=float)
    if trim_offsets:
        full_h, full_w = gray.shape
        t = trim_offsets
        gray = gray[
            max(0, int(t.get("top") or 0)):full_h - max(0, int(t.get("bottom") or 0)),
            max(0, int(t.get("left") or 0)):full_w - max(0, int(t.get("right") or 0)),
        ]
    h, w = gray.shape
    m = int(margin_px or VISA_MARK_EDGE_MARGIN)
    BORDERLINE_MAX = m  # only warn at exactly the minimum (Visa approves min+1 routinely)
    MIN_MARK_PIXELS_PER_LINE = 8  # min mark pixels in a row/col to count as content

    # Determine background from the card interior (exclude the outer ~10% to
    # avoid logos). Proportional so 455-DPI renders and vertical cards sample
    # the same relative interior as the original 1536x969 tuning.
    iy, ix = max(1, round(h * 0.10)), max(1, round(w * 0.065))
    interior = gray[iy:h - iy, ix:w - ix]
    bg_median = float(np.median(interior))
    is_dark_bg = bg_median < 128

    # === PASS 1: Locate the Visa Brand Mark in a safe interior zone ===
    # Search both upper-right and lower-right corners (mark can be in either).
    # Window sizes are proportional to the raster (tuned on 1536x969: inset
    # 40px ≈ 3-4%, band 250x400px ≈ 26%) so any render scale or orientation
    # searches the same relative corner region.
    inset_y = max(10, round(h * 0.04))
    inset_x = max(10, round(w * 0.026))
    band_h = round(h * 0.26)
    band_w = round(w * 0.30)
    candidates = []
    for corner in ["upper-right", "lower-right"]:
        if corner == "upper-right":
            sy1, sy2 = inset_y, min(band_h, h // 2)
        else:
            sy1, sy2 = max(h // 2, h - band_h), h - inset_y
        sx1, sx2 = max(w // 2, w - band_w), w - inset_x
        if sy2 <= sy1 or sx2 <= sx1:
            continue

        safe = gray[sy1:sy2, sx1:sx2]

        # Cascade from strict to moderate threshold
        if is_dark_bg:
            thresholds = [240, 200, 160, max(bg_median + 80, 130)]
        else:
            thresholds = [40, 60, 80, min(bg_median - 80, 100)]

        for thr in thresholds:
            mask = safe > thr if is_dark_bg else safe < thr
            dense = _density_filter(mask, kernel=20, min_neighbors=20)
            n = int(np.sum(dense))
            if n >= 100:
                ys, xs = np.where(dense)
                cy = sy1 + int(np.median(ys))
                cx = sx1 + int(np.median(xs))
                candidates.append((corner, cy, cx, n, thr))
                break

    if not candidates:
        return {
            "passed": True,
            "actual": "Visa Brand Mark not detected",
            "note": (
                "Could not programmatically detect the Visa Brand Mark for "
                "margin measurement. Visual verification required."
            ),
            "mark_detected": False,
            "background_median": round(bg_median, 1),
        }

    # Pick the candidate with the most mark pixels (most confident detection)
    candidates.sort(key=lambda c: c[3], reverse=True)
    corner, cy, cx, _, mark_thr = candidates[0]

    # === PASS 2: Measure distances using contiguous-region expansion ===
    # Instead of scanning the entire strip from mark to card edge (which
    # picks up decorative patterns like concentric circles and line art),
    # we expand outward from the localized mark center and stop at gaps.
    # This isolates the contiguous mark text from nearby decorative elements.
    pad_y = max(120, round(h * 0.13))
    pad_x = max(200, round(w * 0.13))
    search_y1 = max(0, cy - pad_y)
    search_y2 = min(h, cy + pad_y)
    search_x1 = max(0, cx - pad_x)
    search_x2 = w  # extend right to measure right-edge distance

    if corner == "upper-right":
        search_y1 = 0  # extend to top edge
    else:
        search_y2 = h  # extend to bottom edge

    focused = gray[search_y1:search_y2, search_x1:search_x2]

    # Use the same strict threshold for measurement that was used for localization.
    # No density filter here — it over-filters on some cards (e.g. KEM) and shifts
    # real measurements. Instead, we use a high per-line pixel threshold (40px)
    # to skip anti-aliased fringes while keeping solid mark text (100+px per row).
    raw_mask = focused > mark_thr if is_dark_bg else focused < mark_thr

    row_counts = np.sum(raw_mask, axis=1)
    col_counts = np.sum(raw_mask, axis=0)

    # Row threshold: 40px skips anti-aliased top/bottom fringes (~10-25px) while
    # retaining solid Visa mark text rows (100+px per row). Prevents 1-2px
    # measurement errors from anti-aliasing on the mark's outer edges.
    # Column threshold: 8px (lower) because text strokes are narrow — even solid
    # mark text columns only have ~10-30px due to thin character strokes.
    MIN_ROW_PIXELS = 40
    MIN_COL_PIXELS = MIN_MARK_PIXELS_PER_LINE  # 8
    sub_rows = row_counts >= MIN_ROW_PIXELS
    sub_cols = col_counts >= MIN_COL_PIXELS

    if not (np.any(sub_rows) and np.any(sub_cols)):
        # Fall back to lower threshold for smaller marks
        sub_rows = row_counts >= MIN_MARK_PIXELS_PER_LINE
        sub_cols = col_counts >= MIN_MARK_PIXELS_PER_LINE

    if not (np.any(sub_rows) and np.any(sub_cols)):
        # Relax threshold for edge cases
        sub_rows = row_counts >= 3
        sub_cols = col_counts >= 3

    if not (np.any(sub_rows) and np.any(sub_cols)):
        return {
            "passed": True,
            "actual": "Visa Brand Mark not measurable",
            "note": (
                "Detected Visa Brand Mark region but could not measure precise "
                "margins. Visual verification required."
            ),
            "mark_detected": False,
            "background_median": round(bg_median, 1),
        }

    # Expand outward from the mark center to find the contiguous mark region.
    # Stop at the first gap of consecutive rows/cols without mark pixels.
    # This prevents decorative elements (concentric circles, line art) that
    # are separated from the mark text by even a few blank rows from being
    # counted as part of the mark.
    GAP_TOLERANCE = 3  # allow up to 3 blank rows/cols (handles anti-aliasing)

    center_row = cy - search_y1  # mark center in focused-region coordinates
    center_col = cx - search_x1

    # Expand upward from center to find the mark's top edge
    mark_top_row = center_row
    gap = 0
    for r in range(center_row - 1, -1, -1):
        if sub_rows[r]:
            mark_top_row = r
            gap = 0
        else:
            gap += 1
            if gap > GAP_TOLERANCE:
                break

    # Expand downward from center to find the mark's bottom edge
    mark_bottom_row = center_row
    gap = 0
    for r in range(center_row + 1, len(sub_rows)):
        if sub_rows[r]:
            mark_bottom_row = r
            gap = 0
        else:
            gap += 1
            if gap > GAP_TOLERANCE:
                break

    # Expand rightward from center to find the mark's right edge
    mark_right_col = center_col
    gap = 0
    for c in range(center_col + 1, len(sub_cols)):
        if sub_cols[c]:
            mark_right_col = c
            gap = 0
        else:
            gap += 1
            if gap > GAP_TOLERANCE:
                break

    # Expand leftward from center to find the mark's left edge (bounds the
    # strict scan below so decorative elements to the left stay excluded)
    mark_left_col = center_col
    gap = 0
    for c in range(center_col - 1, -1, -1):
        if sub_cols[c]:
            mark_left_col = c
            gap = 0
        else:
            gap += 1
            if gap > GAP_TOLERANCE:
                break

    # Convert to card-level coordinates
    mark_top_y = search_y1 + mark_top_row
    mark_bottom_y = search_y1 + mark_bottom_row
    mark_right_x = search_x1 + mark_right_col

    if corner == "upper-right":
        near_edge_label = "top"
        near_distance = mark_top_y
    else:
        near_edge_label = "bottom"
        near_distance = h - mark_bottom_y - 1

    right_distance = w - mark_right_x - 1
    top_distance = near_distance  # alias for output

    # === Strict measurement: nearest mark pixel to each edge ===
    # The per-line minimums above skip anti-aliased fringes — right for locating
    # the mark body, but they understate how close individual letter tips get to
    # the edge (a per-pixel re-measure finds 56px where the line-filtered pass
    # reports 58px). Re-scan the contiguous mark's bounding box, padded a few px,
    # at a moderate threshold with no per-line minimums so anti-aliased tips
    # count. The pass/borderline/fail verdict is driven by these strict numbers.
    STRICT_PAD = 6
    strict_thr = min(200.0, mark_thr) if is_dark_bg else max(100.0, mark_thr)
    strict_r1 = max(0, mark_top_row - STRICT_PAD)
    strict_r2 = min(focused.shape[0], mark_bottom_row + STRICT_PAD + 1)
    strict_c1 = max(0, mark_left_col - STRICT_PAD)
    strict_c2 = min(focused.shape[1], mark_right_col + STRICT_PAD + 1)
    strict_box = focused[strict_r1:strict_r2, strict_c1:strict_c2]
    strict_mask = strict_box > strict_thr if is_dark_bg else strict_box < strict_thr
    if np.any(strict_mask):
        ys, xs = np.where(strict_mask)
        strict_top_y = search_y1 + strict_r1 + int(ys.min())
        strict_bottom_y = search_y1 + strict_r1 + int(ys.max())
        strict_right_x = search_x1 + strict_c1 + int(xs.max())
        strict_near = (
            strict_top_y if corner == "upper-right" else h - strict_bottom_y - 1
        )
        strict_right = w - strict_right_x - 1
    else:
        strict_near, strict_right = near_distance, right_distance

    # === Pass / borderline / fail determination (strict numbers) ===
    near_fail = strict_near < m
    right_fail = strict_right < m
    near_borderline = m <= strict_near <= BORDERLINE_MAX
    right_borderline = m <= strict_right <= BORDERLINE_MAX

    passed = not (near_fail or right_fail)
    borderline = near_borderline or right_borderline

    # Build result note
    near_label = near_edge_label.capitalize()
    detail_parts = []
    if near_fail:
        detail_parts.append(
            f"{near_label} edge: {strict_near}px strict (FAIL — must be >= {m}px)"
        )
    elif near_borderline:
        detail_parts.append(
            f"{near_label} edge: {strict_near}px strict (BORDERLINE — only "
            f"{strict_near - m + 1}px above the {m}px minimum; "
            f"Visa may reject borderline placements)"
        )

    if right_fail:
        detail_parts.append(
            f"Right edge: {strict_right}px strict (FAIL — must be >= {m}px)"
        )
    elif right_borderline:
        detail_parts.append(
            f"Right edge: {strict_right}px strict (BORDERLINE — only "
            f"{strict_right - m + 1}px above the {m}px minimum; "
            f"Visa may reject borderline placements)"
        )

    measured = (
        f"{near_label}: {strict_near}px, Right: {strict_right}px "
        f"(strict, anti-aliased letter tips included; line-filtered mark body: "
        f"{near_label.lower()} {near_distance}px, right {right_distance}px)"
    )
    if not passed:
        note = (
            f"FAIL — Visa Brand Mark is too close to the card edge. "
            f"{measured} (minimum: {m}px). "
            f"This is the #1 reason for Visa card art rejection. "
            + " | ".join(detail_parts)
        )
    elif borderline:
        note = (
            f"BORDERLINE — Visa Brand Mark margin is at exactly the {m}px minimum. "
            f"{measured}. "
            f"Visa may reject placements with zero safety buffer — recommend "
            f"increasing margin to at least {m + 2}px. "
            + " | ".join(detail_parts)
        )
    else:
        note = (
            f"Visa Brand Mark margins are within spec. "
            f"{measured} (minimum: {m}px)."
        )

    strict_near_key = "strict_top_px" if corner == "upper-right" else "strict_bottom_px"
    return {
        "passed": passed,
        "borderline": borderline,
        "actual": (
            f"{near_label}: {strict_near}px, Right: {strict_right}px"
            if passed else "Content within margin zone"
        ),
        "note": note,
        "mark_detected": True,
        "mark_corner": corner,
        "top_distance": top_distance,
        "right_distance": right_distance,
        "min_distance": min(near_distance, right_distance),
        strict_near_key: strict_near,
        "strict_right_px": strict_right,
        "strict_min_px": min(strict_near, strict_right),
        "margin_px": m,
        "measured_from": "trim" if trim_offsets else "render_edge",
        "background_median": round(bg_median, 1),
        "mark_threshold": round(mark_thr, 1),
    }


# ─────────────────────────────────────────────────────────────────
# Virtual Visa Brand Mark lockup
# ─────────────────────────────────────────────────────────────────
#
# check_bleed_zone above assumes one polarity (a white mark on a dark card, or
# dark on light) with fixed brightness thresholds. That misses light-on-light
# and metallic marks and can latch onto line patterns near the corner, so the
# margin verdict falls back to the agent's eyeball or is simply wrong.
# Virtual cards use this locator instead. Physical keeps check_bleed_zone,
# whose thresholds are calibrated against Rain's canonical templates.
#
# The locator measures contrast against a LOCAL background (a coarse median,
# so gradients and metallic textures cancel out) in either polarity, and finds
# the wordmark by shape rather than brightness: letter-sized glyphs on one
# line, about 3.1 times as wide as tall. The same pass yields the mark height,
# the identifier baseline and alignment, and the mark's ink color.

_WORDMARK_ASPECT = 3.1
_MARK_CORNERS = ("upper-right", "lower-right", "upper-left")


def _box_sum(mask, k):
    """Count of True pixels in the k x k window centered on each pixel."""
    m = mask.astype(np.int32)
    h, w = m.shape
    r = k // 2
    padded = np.zeros((h + k, w + k), dtype=np.int32)
    padded[r:r + h, r:r + w] = m
    cs = np.zeros((h + k + 1, w + k + 1), dtype=np.int32)
    cs[1:, 1:] = np.cumsum(np.cumsum(padded, axis=0), axis=1)
    return cs[k:k + h, k:k + w] - cs[:h, k:k + w] - cs[k:k + h, :w] + cs[:h, :w]


def _binary_open(mask, k):
    """Erode then dilate with a k x k square: drops strokes thinner than k."""
    eroded = _box_sum(mask, k) == k * k
    return _box_sum(eroded, k) > 0


def _label_components(mask, min_area=30):
    """Bounding boxes of the 8-connected components of a boolean mask."""
    from collections import deque
    h, w = mask.shape
    grid = mask.tolist()
    seen = [[False] * w for _ in range(h)]
    comps = []
    for y0, x0 in zip(*[a.tolist() for a in np.nonzero(mask)]):
        if seen[y0][x0]:
            continue
        seen[y0][x0] = True
        queue = deque([(y0, x0)])
        area, y1, y2, x1, x2 = 0, y0, y0, x0, x0
        while queue:
            y, x = queue.popleft()
            area += 1
            y1, y2, x1, x2 = min(y1, y), max(y2, y), min(x1, x), max(x2, x)
            for yy in (y - 1, y, y + 1):
                if yy < 0 or yy >= h:
                    continue
                row, seen_row = grid[yy], seen[yy]
                for xx in (x - 1, x, x + 1):
                    if 0 <= xx < w and row[xx] and not seen_row[xx]:
                        seen_row[xx] = True
                        queue.append((yy, xx))
        if area >= min_area:
            comps.append({"area": area, "y1": y1, "y2": y2, "x1": x1, "x2": x2})
    return comps


def _merge_split_glyphs(comps):
    """
    Rejoin a glyph the threshold split in two (a metallic "S" often breaks at
    its waist). Pieces merge only when they overlap horizontally, are similar
    in height, and are each well short of the joined height — which keeps the
    wordmark from merging with the identifier line beneath it.
    """
    merged = []
    for c in sorted(comps, key=lambda c: c["x1"]):
        for o in merged:
            overlap = min(o["x2"], c["x2"]) - max(o["x1"], c["x1"])
            narrower = min(o["x2"] - o["x1"], c["x2"] - c["x1"]) + 1
            joined_h = max(o["y2"], c["y2"]) - min(o["y1"], c["y1"]) + 1
            h1, h2 = o["y2"] - o["y1"] + 1, c["y2"] - c["y1"] + 1
            vgap = max(c["y1"] - o["y2"], o["y1"] - c["y2"])
            if (overlap >= 0.5 * narrower and vgap <= 0.2 * joined_h + 2
                    and max(h1, h2) <= 0.65 * joined_h
                    and min(h1, h2) >= 0.5 * max(h1, h2)):
                o.update(area=o["area"] + c["area"],
                         y1=min(o["y1"], c["y1"]), y2=max(o["y2"], c["y2"]),
                         x1=min(o["x1"], c["x1"]), x2=max(o["x2"], c["x2"]))
                break
        else:
            merged.append(dict(c))
    return merged


def _text_lines(comps, min_h, max_h, max_gap_ratio=0.45, same_height=None):
    """Group glyph boxes into left-to-right runs on one line."""
    glyphs = sorted((c for c in comps if min_h <= c["y2"] - c["y1"] + 1 <= max_h),
                    key=lambda c: c["x1"])
    lines, used = [], set()
    for i, first in enumerate(glyphs):
        if i in used:
            continue
        line = [first]
        used.add(i)
        for j in range(i + 1, len(glyphs)):
            if j in used:
                continue
            c = glyphs[j]
            top = min(g["y1"] for g in line)
            bottom = max(g["y2"] for g in line)
            line_h, glyph_h = bottom - top + 1, c["y2"] - c["y1"] + 1
            gap = c["x1"] - max(g["x2"] for g in line)
            overlap = min(bottom, c["y2"]) - max(top, c["y1"])
            if (gap <= max_gap_ratio * line_h and overlap >= 0.5 * min(glyph_h, line_h)
                    and (same_height is None or abs(glyph_h - line_h) <= same_height * line_h)):
                line.append(c)
                used.add(j)
        lines.append(line)
    return lines


def _line_box(line):
    return {
        "n": len(line),
        "x1": min(g["x1"] for g in line), "x2": max(g["x2"] for g in line),
        "y1": min(g["y1"] for g in line), "y2": max(g["y2"] for g in line),
        "area": sum(g["area"] for g in line),
        "bottoms": sorted(g["y2"] for g in line),
    }


def _luminance(rgb):
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def _local_background(rgb, scale=8, size=21):
    """Coarse median background: ~170px windows at 1536w, wider than the mark."""
    from PIL import ImageFilter
    h, w, _ = rgb.shape
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    small = im.resize((max(1, w // scale), max(1, h // scale)), Image.BOX)
    med = small.filter(ImageFilter.MedianFilter(size))
    return np.array(med.resize((w, h), Image.BILINEAR), dtype=float)


def _locate_visa_mark(img):
    """
    Find the Visa wordmark in the upper-right, lower-right or upper-left corner.

    Returns None when no glyph run looks like the wordmark. Otherwise returns
    the mark's box in card pixels (edges measured on the half-contrast
    anti-aliased boundary, letter tips included), the product identifier line
    beneath it when one is found, and the mark's core ink color.

    Oversized art is located at the 1536px canvas scale (the thresholds and
    background window are tuned there) and reported in native pixels.
    """
    native_w, native_h = img.size
    factor = 1.0
    if native_w > REQUIRED_WIDTH * 1.25:
        factor = native_w / REQUIRED_WIDTH
        img = img.convert("RGB").resize(
            (REQUIRED_WIDTH, max(1, round(native_h / factor))), Image.LANCZOS)
    rgb = np.array(img.convert("RGB"), dtype=float)
    h, w, _ = rgb.shape
    open_k = max(3, int(round(h * 0.006)) | 1)
    best = None

    for corner in _MARK_CORNERS:
        wh, ww = round(h * 0.34), round(w * 0.36)
        wy = 0 if corner.startswith("upper") else h - wh
        wx = w - ww if corner.endswith("right") else 0
        win = rgb[wy:wy + wh, wx:wx + ww]
        bg = _local_background(win)
        dist = np.sqrt(((win - bg) ** 2).sum(axis=-1))
        lighter = _luminance(win) > _luminance(bg)

        for polarity, side in (("light", lighter), ("dark", ~lighter)):
            contrast = np.where(side, dist, 0.0)
            peak = float(np.percentile(contrast, 99.5))
            if peak < 40:
                continue
            raw = contrast > 0.5 * peak
            opened = _binary_open(raw, open_k)
            glyphs = _merge_split_glyphs(_label_components(opened))
            for line in _text_lines(glyphs, 0.05 * h, 0.25 * h, same_height=0.35):
                box = _line_box(line)
                box_h = box["y2"] - box["y1"] + 1
                box_w = box["x2"] - box["x1"] + 1
                aspect, fill = box_w / box_h, box["area"] / (box_h * box_w)
                if box["n"] < 2 or not 2.3 <= aspect <= 4.1 or not 0.3 <= fill <= 0.65:
                    continue
                score = (-3 * abs(np.log(aspect / _WORDMARK_ASPECT))
                         - 0.4 * abs(box["n"] - 4) - 2 * abs(fill - 0.45))
                if best is None or score > best["score"]:
                    best = {"score": score, "corner": corner, "polarity": polarity,
                            "peak": peak, "box": box, "wy": wy, "wx": wx,
                            "win": win, "contrast": contrast, "raw": raw,
                            "opened": opened, "glyphs": glyphs}

    if best is None:
        return None

    # Refine the box on the unopened mask: opening shaves anti-aliased tips
    # and thin tapers (the flag on the V is the leftmost point of an
    # upper-left mark). Grow the solid glyph bodies back along connected mark
    # pixels, a bounded distance, so tapers return but pattern lines that
    # merely come near the mark stay out of the measurement. Tapers only run
    # sideways — the top and bottom are flat letter ends — so the vertical
    # reach stays short and an identifier set close beneath is never absorbed.
    b, raw, opened = best["box"], best["raw"], best["opened"]
    pad = 3 * open_k
    ry1, ry2 = max(0, b["y1"] - open_k), min(raw.shape[0], b["y2"] + open_k + 1)
    rx1, rx2 = max(0, b["x1"] - pad), min(raw.shape[1], b["x2"] + pad + 1)
    body = np.zeros_like(opened)
    for g in best["glyphs"]:
        if g["x1"] >= b["x1"] and g["x2"] <= b["x2"] and g["y1"] >= b["y1"] and g["y2"] <= b["y2"]:
            body[g["y1"]:g["y2"] + 1, g["x1"]:g["x2"] + 1] |= opened[g["y1"]:g["y2"] + 1, g["x1"]:g["x2"] + 1]
    raw_box = raw[ry1:ry2, rx1:rx2]
    grown = body[ry1:ry2, rx1:rx2] & raw_box
    for _ in range(pad):
        nxt = (_box_sum(grown, 3) > 0) & raw_box
        if nxt.sum() == grown.sum():
            break
        grown = nxt
    ys, xs = np.nonzero(grown)
    top, bottom = ry1 + int(ys.min()), ry1 + int(ys.max())
    left, right = rx1 + int(xs.min()), rx1 + int(xs.max())
    mark_h = bottom - top + 1
    # The wordmark's edges along its baseline (bottom 15% of rows): the
    # italic VISA leans right, so a left-aligned identifier lines up with the
    # V's foot, not the flag tip above it.
    base_rows = ys >= (ys.max() - max(2, int(0.15 * mark_h)))
    base_left, base_right = rx1 + int(xs[base_rows].min()), rx1 + int(xs[base_rows].max())

    # Product identifier: the text line directly beneath the wordmark. Light
    # opening only — identifier strokes are a few px wide.
    identifier = None
    if best["corner"].startswith("upper"):
        zy1 = bottom + 3
        zy2 = min(raw.shape[0], bottom + int(1.4 * mark_h))
        zx1 = max(0, left - int(0.5 * (right - left)))
        zx2 = min(raw.shape[1], right + int(0.1 * (right - left)) + 1)
        if zy2 > zy1:
            zone = _binary_open(raw[zy1:zy2, zx1:zx2], 3)
            lines = [_line_box(l) for l in _text_lines(
                _label_components(zone, min_area=12), 0.12 * mark_h, 0.75 * mark_h,
                max_gap_ratio=0.8)]
            lines = [l for l in lines if l["n"] >= 3]
            if lines:
                main = max(lines, key=lambda l: l["area"])
                row = [l for l in lines if abs(l["y2"] - main["y2"]) < 0.3 * mark_h]
                bottoms = sorted(v for l in row for v in l["bottoms"])
                identifier = {
                    "top": zy1 + min(l["y1"] for l in row),
                    # Median glyph bottom: descenders (g, p) are a minority.
                    "baseline": zy1 + bottoms[len(bottoms) // 2],
                    "left": zx1 + min(l["x1"] for l in row),
                    "right": zx1 + max(l["x2"] for l in row),
                }

    # Core ink: well inside the strokes, clear of anti-aliasing.
    core = (best["contrast"][top:bottom + 1, left:right + 1] > 0.75 * best["peak"]) & \
        opened[top:bottom + 1, left:right + 1]
    ink = best["win"][top:bottom + 1, left:right + 1][core]
    if not len(ink):
        ink = best["win"][top:bottom + 1, left:right + 1][raw[top:bottom + 1, left:right + 1]]
    ink_l = _luminance(ink)

    wy, wx = best["wy"], best["wx"]

    # Window -> native card pixels. A far edge (bottom/right) maps to the last
    # native pixel the located pixel covers, so edge distances stay exact.
    def _near(v, offset):
        return int(round((v + offset) * factor))

    def _far(v, offset):
        return int(round((v + offset + 1) * factor)) - 1

    n_top, n_bottom = _near(top, wy), _far(bottom, wy)
    n_left, n_right = _near(left, wx), _far(right, wx)
    return {
        "baseline_left": _near(base_left, wx), "baseline_right": _far(base_right, wx),
        "corner": best["corner"],
        "polarity": best["polarity"],
        "top": n_top, "bottom": n_bottom, "left": n_left, "right": n_right,
        "height": n_bottom - n_top + 1, "width": n_right - n_left + 1,
        "card_width": native_w, "card_height": native_h,
        "identifier": ({
            "top": _near(identifier["top"], wy),
            "baseline": _far(identifier["baseline"], wy),
            "left": _near(identifier["left"], wx),
            "right": _far(identifier["right"], wx),
        } if identifier else None),
        "ink_rgb": [int(round(v)) for v in np.median(ink, axis=0)],
        "ink_luminance_spread": int(round(float(
            np.percentile(ink_l, 95) - np.percentile(ink_l, 5)))),
    }


def _mark_scale(mark):
    """Pixels per 1536px-canvas pixel — Visa's geometry is set at 1536x969."""
    return mark["card_width"] / REQUIRED_WIDTH


def _virtual_margin_check(mark):
    """
    The Visa Brand Mark sits AT 56px from its nearest top/bottom edge and its
    nearest side edge, within +/-2px on the strict letter-tip distances.
    """
    scale = _mark_scale(mark)
    target = round(VISA_MARK_EDGE_MARGIN * scale)
    tol = max(1, round(VISA_MARK_MARGIN_TOLERANCE * scale))
    lo, hi = target - tol, target + tol
    w, h = mark["card_width"], mark["card_height"]
    corner = mark["corner"]

    near_label = "top" if corner.startswith("upper") else "bottom"
    side_label = "right" if corner.endswith("right") else "left"
    near = mark["top"] if near_label == "top" else h - 1 - mark["bottom"]
    side = w - 1 - mark["right"] if side_label == "right" else mark["left"]

    def _judge(label, px):
        if px < lo:
            return f"{label.capitalize()} edge {px}px is {lo - px}px inside the {target}px placement (min {lo}px)", "margin_below_minimum"
        if px > hi:
            return f"{label.capitalize()} edge {px}px is {px - hi}px farther than the {target}px placement (max {hi}px)", "margin_above_target"
        return None, None

    problems = [p for p in (_judge(near_label, near), _judge(side_label, side)) if p[0]]
    passed = not problems
    measured = f"{near_label.capitalize()}: {near}px, {side_label.capitalize()}: {side}px"
    if passed:
        note = (f"Visa Brand Mark is placed at {target}px. {measured} "
                f"(strict, anti-aliased letter tips included; accepted {lo}-{hi}px).")
    else:
        note = (f"FAIL — Visa places the Brand Mark AT {target}px from the nearest edges, "
                f"not merely at least {target}px. {measured}. "
                + " | ".join(p[0] for p in problems))
    result = {
        "passed": passed,
        "actual": measured,
        "required": f"{target}px from the nearest {near_label} and {side_label} edges (±{tol}px)",
        "note": note,
        "mark_detected": True,
        "mark_corner": corner,
        f"strict_{near_label}_px": near,
        f"strict_{side_label}_px": side,
        "strict_min_px": min(near, side),
        "strict_max_px": max(near, side),
        "margin_px": target,
        "margin_tolerance_px": tol,
        "measured_from": "render_edge",
        "mark_box": [mark["left"], mark["top"], mark["right"], mark["bottom"]],
    }
    if problems:
        result["reason_code"] = problems[0][1]
    return result


def _virtual_size_check(mark):
    """109px wordmark, 170px from the top of the mark to the identifier baseline."""
    scale = _mark_scale(mark)
    target = round(VISA_MARK_HEIGHT_PX * scale)
    tol = max(1, round(VISA_MARK_HEIGHT_TOLERANCE_PX * scale))
    legacy = round(VISA_MARK_LEGACY_HEIGHT_PX * scale)
    composite_target = round(VISA_LOCKUP_COMPOSITE_PX * scale)
    height = mark["height"]

    ident = mark.get("identifier")
    composite = (ident["baseline"] - mark["top"]) if ident else None
    lockup = (f"; mark top to identifier baseline {composite}px (Visa: {composite_target}px)"
              if composite is not None else "")

    result = {
        "actual": f"Mark height {height}px{lockup}",
        "required": f"{target}px mark height (±{tol}px); {composite_target}px from the top of the mark to the identifier baseline",
        "mark_detected": True,
        "mark_height_px": height,
        "expected_mark_height_px": target,
        "lockup_height_px": composite,
        "expected_lockup_height_px": composite_target,
    }
    if abs(height - target) <= tol:
        result.update(passed=True, note=f"Visa Brand Mark height {height}px matches the {target}px lockup{lockup}.")
    elif abs(height - legacy) <= tol:
        result.update(
            passed=True, borderline=True, reason_code="size_oversized",
            note=(f"Mark height {height}px matches the legacy {legacy}px \"Option Two\". Visa's "
                  f"recent feedback asks for a {target}px mark with a {composite_target}px "
                  f"lockup — confirm before submitting."))
    else:
        code = "size_undersized" if height < target else "size_oversized"
        result.update(
            passed=False, reason_code=code,
            note=(f"FAIL — Visa Brand Mark is {height}px tall; Visa asks for {target}px "
                  f"(accepted {target - tol}-{target + tol}px){lockup}."))
    return result


def _virtual_identifier_alignment_check(mark):
    """
    The identifier's edge aligns with the mark's outer edge on the mark's side:
    right-aligned under a right-corner mark, left-aligned under a left one.
    """
    ident = mark.get("identifier")
    side = "right" if mark["corner"].endswith("right") else "left"
    if not ident:
        return {
            "passed": None,
            "actual": "Product identifier not detected beneath the mark",
            "required": f"identifier {side}-aligned with the Visa Brand Mark",
            "note": "Could not locate the identifier line programmatically. Verify alignment visually.",
            "identifier_detected": False,
        }
    scale = _mark_scale(mark)
    tol = max(1, round(IDENTIFIER_ALIGN_TOLERANCE_PX * scale))
    fail_at = max(tol + 1, round(IDENTIFIER_ALIGN_FAIL_PX * scale))
    # Measured against the wordmark's baseline edge (see _locate_visa_mark).
    offset = ((mark["baseline_right"] - ident["right"]) if side == "right"
              else (ident["left"] - mark["baseline_left"]))
    direction = "inside" if offset > 0 else "past"
    actual = (f"Identifier {side} edge {abs(offset)}px {direction} the mark's {side} edge"
              if offset else f"Identifier {side} edge flush with the mark's {side} edge")
    result = {
        "actual": actual,
        "required": f"identifier {side}-aligned with the Visa Brand Mark (±{tol}px)",
        "identifier_detected": True,
        "aligned_to": side,
        "offset_px": offset,
        "identifier_box": [ident["left"], ident["top"], ident["right"], ident["baseline"]],
    }
    if abs(offset) <= tol:
        result.update(passed=True, note=f"Product identifier is {side}-aligned with the Visa Brand Mark.")
    elif abs(offset) < fail_at:
        result.update(passed=True, borderline=True, reason_code="identifier_misaligned",
                      note=f"{actual} — Visa asks for the identifier to align with the mark's {side} edge.")
    else:
        result.update(passed=False, reason_code="identifier_misaligned",
                      note=f"FAIL — {actual}. Visa asks for the identifier to align with the mark's {side} edge.")
    return result


def _classify_mark_ink(rgb):
    """Name a mark ink against Visa's permitted versions, or None if not permitted."""
    r, g, b = (float(v) for v in rgb)
    if np.linalg.norm(np.array([r, g, b]) - np.array(VISA_BLUE_RGB)) <= 60:
        return "Visa Blue"
    chroma = max(r, g, b) - min(r, g, b)
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if chroma <= 36:
        if lum >= 225:
            return "white"
        if lum <= 50:
            return "black"
        return "silver/gray"
    # Gold premium ink: a warm yellow-orange hue that reads as gold, not brown.
    # Brown marks (luminance ~78) are the "not a valid version" Visa rejects.
    if lum < 110:
        return None
    mx = max(r, g, b)
    if mx == r:
        hue = (60 * ((g - b) / chroma)) % 360
    elif mx == g:
        hue = 60 * ((b - r) / chroma) + 120
    else:
        hue = 60 * ((r - g) / chroma) + 240
    if 30 <= hue <= 60:
        return "gold"
    return None


def _virtual_color_check(mark):
    """White, black, Visa Blue, or gold/silver premium ink — flat, no gradient."""
    ink = mark["ink_rgb"]
    spread = mark["ink_luminance_spread"]
    name = _classify_mark_ink(ink)
    hex_code = "#{:02X}{:02X}{:02X}".format(*ink)
    color = f"R{ink[0]} G{ink[1]} B{ink[2]} ({hex_code})"
    result = {
        "actual": f"{name or 'non-standard color'} {color}" + (f", luminance varies {spread} levels across the mark" if spread > 30 else ", flat"),
        "required": "white, black, Visa Blue (R20 G52 B203), or gold/silver premium ink — flat, no gradient",
        "mark_detected": True,
        "ink_rgb": ink,
        "ink_hex": hex_code,
        "color_class": name,
        "luminance_spread": spread,
    }
    if spread > 30:
        result.update(passed=False, reason_code="mark_gradient_applied",
                      note=(f"FAIL — the Visa Brand Mark carries a gradient (luminance varies {spread} "
                            f"levels across the letters). Visa requires a flat mark in a permitted color."))
    elif name is None:
        result.update(passed=False, reason_code="mark_color_not_permitted",
                      note=(f"FAIL — mark color {color} is not a permitted version. Use white, black, "
                            f"or Visa Blue (R20 G52 B203), or the gold/silver premium ink version."))
    elif name == "gold":
        # Visa's feedback on Signature cards names white, black or Visa Blue
        # only; the gold premium version is not a safe default.
        result.update(passed=True, borderline=True, reason_code="mark_color_not_permitted",
                      note=(f"Mark is gold {color}. The gold premium ink version is reserved for "
                            f"premium products — confirm, or use white, black, or Visa Blue."))
    else:
        result.update(passed=True, note=f"Visa Brand Mark is flat {name} {color}.")
    return result


def check_virtual_mark(img):
    """
    Deterministic Visa Brand Mark checks for virtual art, from one locator pass:
    bleed_zone (placed at 56px), mark_size, identifier_alignment, mark_color.

    When the mark is not found every check reports passed=None (unverified)
    rather than a pass: an undetected mark is not evidence of compliance.
    """
    mark = _locate_visa_mark(img)
    if mark is None:
        unverified = {
            "passed": None,
            "actual": "Visa Brand Mark not detected",
            "note": ("Could not locate the Visa Brand Mark programmatically. "
                     "Visual verification required."),
            "mark_detected": False,
        }
        return {
            "bleed_zone": dict(unverified, required=f"{VISA_MARK_EDGE_MARGIN}px from the nearest edges (±{VISA_MARK_MARGIN_TOLERANCE}px)"),
            "mark_size": dict(unverified, required=f"{VISA_MARK_HEIGHT_PX}px mark height"),
            "identifier_alignment": dict(unverified, required="identifier aligned with the Visa Brand Mark",
                                         identifier_detected=False),
            "mark_color": dict(unverified, required="white, black, Visa Blue, or gold/silver premium ink — flat"),
        }
    return {
        "bleed_zone": _virtual_margin_check(mark),
        "mark_size": _virtual_size_check(mark),
        "identifier_alignment": _virtual_identifier_alignment_check(mark),
        "mark_color": _virtual_color_check(mark),
    }


def _corner_runs(rgba, corner, max_run):
    """
    Run lengths, from one card corner, of pixels matching the corner pixel —
    along the edge row, the edge column and the diagonal.
    """
    h, w, _ = rgba.shape
    sy, sx = (1 if corner[0] == "t" else -1), (1 if corner[1] == "l" else -1)
    y0, x0 = (0 if sy > 0 else h - 1), (0 if sx > 0 else w - 1)
    ref = rgba[y0, x0].astype(float)

    def _like(px):
        px = px.astype(float)
        if ref[3] < 128 or px[3] < 128:  # transparency decides alone
            return (ref[3] < 128) == (px[3] < 128)
        return float(np.abs(px[:3] - ref[:3]).max()) <= 30

    def _run(dy, dx):
        n = 0
        while n < max_run:
            y, x = y0 + sy * dy * n, x0 + sx * dx * n
            if not (0 <= y < h and 0 <= x < w) or not _like(rgba[y, x]):
                break
            n += 1
        return n

    return {"row": _run(0, 1), "col": _run(1, 0), "diag": _run(1, 1),
            "transparent": bool(ref[3] < 128)}


def check_square_corners(img):
    """
    Virtual card art must have square corners — a rounded export leaves an arc
    of transparent or matte pixels in each corner.

    A circular corner of radius R leaves ~R pixels along each edge but only
    ~0.29R along the diagonal. Square art, a solid background, or a full-width
    stripe all fail that shape test.
    """
    rgba = np.array(img.convert("RGBA"))
    h, w, _ = rgba.shape
    max_run = max(8, int(min(w, h) * 0.2))
    rounded = []
    radii = []
    for corner in ("tl", "tr", "bl", "br"):
        r = _corner_runs(rgba, corner, max_run + 1)
        edge = min(r["row"], r["col"])
        arc = (r["diag"] >= 2 and edge >= 2 * r["diag"]
               and r["row"] <= max_run and r["col"] <= max_run)
        if arc:
            rounded.append((corner, r["transparent"]))
            radii.append(round((r["row"] + r["col"]) / 2))
    transparent = [c for c, t in rounded if t]
    names = {"tl": "top-left", "tr": "top-right", "bl": "bottom-left", "br": "bottom-right"}
    # Transparent arcs are unambiguous; an opaque matte arc needs 3 corners.
    if transparent or len(rounded) >= 3:
        where = ", ".join(names[c] for c, _ in rounded)
        kind = "transparent" if transparent else "matte-colored"
        return {
            "passed": False,
            "actual": f"Rounded corners (~{int(np.median(radii))}px radius, {kind}): {where}",
            "required": "square corners",
            "note": ("FAIL — the artwork has rounded corners. Visa requires square-cornered "
                     "virtual art; the wallet applies its own corner mask."),
            "rounded_corners": [names[c] for c, _ in rounded],
            "radius_px": int(np.median(radii)),
        }
    return {"passed": True, "actual": "Square corners", "required": "square corners", "note": ""}


def check_border_frame(img):
    """
    Flag border lines around the art: the canvas edge is padding, not artwork.

    The rejected cases take two shapes. Transparent padding on any side (the
    art was placed on a wider canvas), or thin uniform lines of 2px or more on
    two or more sides (white border lines from an export or a mockup). A 1px
    hairline is below what Visa has flagged and is typical of resampling, so
    it is ignored. Every length is judged at the 1536px canvas scale.
    """
    rgba = np.array(img.convert("RGBA"), dtype=float)
    h, w, _ = rgba.shape
    scale = w / REQUIRED_WIDTH
    depth = max(3, int(min(w, h) * 0.03))
    min_band = 2 * scale
    names = ("top", "bottom", "left", "right")

    def _lines(side):
        # Middle 90% of each edge-parallel line, outermost first. The ends
        # are skipped so corner rounding never reads as padding.
        n = depth + 4
        if side == "top":
            return [rgba[i, int(w * 0.05):int(w * 0.95)] for i in range(n)]
        if side == "bottom":
            return [rgba[h - 1 - i, int(w * 0.05):int(w * 0.95)] for i in range(n)]
        if side == "left":
            return [rgba[int(h * 0.05):int(h * 0.95), i] for i in range(n)]
        return [rgba[int(h * 0.05):int(h * 0.95), w - 1 - i] for i in range(n)]

    transparent, lined = {}, {}
    for side in names:
        lines = _lines(side)
        clear = 0
        while clear < len(lines) and (lines[clear][:, 3] < 128).mean() >= 0.9:
            clear += 1
        if clear >= min_band:
            transparent[side] = clear
            continue
        rest = lines[clear:]
        color = np.median(rest[0][:, :3], axis=0)
        thickness = 0
        for line in rest:
            if np.abs(line[:, :3] - color).max(axis=1).mean() > 6:
                break
            thickness += 1
        if not min_band <= thickness <= depth:
            continue
        # The artwork must visibly start past the band (allowing for an
        # anti-aliased transition line or two).
        after = rest[thickness:thickness + 3]
        contrast = max(np.abs(l[:, :3] - color).max(axis=1).mean() for l in after) if after else 0
        if contrast >= 25:
            lined[side] = (thickness, [int(round(v)) for v in color])

    if not transparent and len(lined) < 2:
        return {"passed": True, "actual": "No border lines", "required": "art fills the canvas edge to edge", "note": ""}

    parts = []
    if transparent:
        parts.append("transparent padding on the " + ", ".join(
            f"{side} ({px}px)" for side, px in transparent.items()))
    if len(lined) >= 2:
        parts.append("uniform border lines on the " + ", ".join(
            f"{side} ({t}px R{c[0]} G{c[1]} B{c[2]})" for side, (t, c) in lined.items()))
    sides = list(transparent) + [s for s in lined if len(lined) >= 2]
    return {
        "passed": False,
        "actual": "; ".join(parts).capitalize(),
        "required": "art fills the canvas edge to edge",
        "note": ("FAIL — the art does not reach the canvas edge: " + "; ".join(parts) + ". Visa "
                 "rejects art with white border lines; export the design full-bleed to the "
                 "1536x969 canvas."),
        "border_sides": sides,
        "frame_px": max([*transparent.values(), *[t for t, _ in lined.values()]] or [0]),
    }


def generate_zoom_crops(img, bleed_result=None, side="front", trim_offsets=None):
    """
    Pre-rendered zoom crops for the visual-inspection agent.

    Replaces the agent's own PIL cropping/zooming rounds with cheap `read`
    calls. Crop boxes are fractions of the TRIM rectangle when trim_offsets
    is given (physical vectors carry bleed — cropping the full render would
    shift every zone), of the full image otherwise (virtual PNGs).

    Front: the brand-mark corner (2x, follows the corner check_bleed_zone
    localized), the issuer corner (2x), and the lower-left zone (native).
    Back (physical): the magstripe band zone (native) and the issuer-text
    zone (2x) per Rain's standardized back.

    Returns {name: PNG bytes}.
    """
    w, h = img.size
    rgb = img.convert("RGB")
    corner = (bleed_result or {}).get("mark_corner") or "upper-right"

    t = trim_offsets or {}
    tx = int(t.get("left") or 0)
    ty = int(t.get("top") or 0)
    tw = w - tx - int(t.get("right") or 0)
    th = h - ty - int(t.get("bottom") or 0)
    if tw <= 0 or th <= 0:
        tx, ty, tw, th = 0, 0, w, h

    def _box(fx1, fy1, fx2, fy2):
        return (tx + int(tw * fx1), ty + int(th * fy1),
                tx + int(tw * fx2), ty + int(th * fy2))

    def _png(box, scale=1):
        region = rgb.crop(box)
        if scale != 1:
            region = region.resize(
                (region.width * scale, region.height * scale), Image.LANCZOS
            )
        buf = io.BytesIO()
        region.save(buf, "PNG")
        return buf.getvalue()

    if side == "back":
        return {
            "magstripe": _png(_box(0.0, 0.0, 1.0, 0.30)),
            "issuer_text": _png(_box(0.0, 0.18, 0.70, 0.50), scale=2),
        }

    # Front. The brand-mark crop follows the detected corner; vertical
    # fronts keep the lockup lower-right (canonical templates).
    if corner == "lower-right":
        brand_box = _box(0.55, 0.55, 1.0, 1.0)
    elif corner == "upper-left":
        brand_box = _box(0.0, 0.0, 0.45, 0.45)
    else:  # upper-right
        brand_box = _box(0.55, 0.0, 1.0, 0.45)

    return {
        "brand_mark": _png(brand_box, scale=2),
        "issuer": _png(_box(0.0, 0.0, 0.45, 0.40), scale=2),
        "lower_left": _png(_box(0.0, 0.55, 0.50, 1.0)),
    }


_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")


def _load_font(size, bold=False):
    """Try to load a font at the given size. Returns ImageFont.

    Vendored fonts (scripts/fonts/) come first so the layout is identical
    everywhere the script runs — agent sandbox, Vercel function, local dev —
    with system fonts as fallback. Without a TrueType hit, PIL's tiny bitmap
    default font would wreck the annotated report layout.
    """
    bold_fonts = [
        os.path.join(_FONTS_DIR, "DejaVuSans-Bold.ttf"),
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica Bold.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    regular_fonts = [
        os.path.join(_FONTS_DIR, "DejaVuSans.ttf"),
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    candidates = (bold_fonts + regular_fonts) if bold else (regular_fonts + bold_fonts)
    for font_name in candidates:
        if os.path.exists(font_name):
            try:
                return ImageFont.truetype(font_name, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _draw_dashed_rect(draw, rect, color, width=2, dash_len=16, gap_len=10):
    """Draw a dashed rectangle on an ImageDraw surface."""
    x0, y0, x1, y1 = rect
    for start, end, horizontal in [
        ((x0, y0), (x1, y0), True),
        ((x1, y0), (x1, y1), False),
        ((x1, y1), (x0, y1), True),
        ((x0, y1), (x0, y0), False),
    ]:
        if horizontal:
            length = abs(end[0] - start[0])
            step = 1 if end[0] >= start[0] else -1
            pos = 0
            while pos < length:
                seg_end = min(pos + dash_len, length)
                sx = start[0] + pos * step
                ex = start[0] + seg_end * step
                draw.line([(sx, start[1]), (ex, start[1])], fill=color, width=width)
                pos += dash_len + gap_len
        else:
            length = abs(end[1] - start[1])
            step = 1 if end[1] >= start[1] else -1
            pos = 0
            while pos < length:
                seg_end = min(pos + dash_len, length)
                sy = start[1] + pos * step
                ey = start[1] + seg_end * step
                draw.line([(start[0], sy), (start[0], ey)], fill=color, width=width)
                pos += dash_len + gap_len


def _draw_marker(draw, cx, cy, number, status, font, size=34):
    """Draw a numbered marker circle on the card at (cx, cy)."""
    color = STATUS_COLORS.get(status, COLOR_UNVERIFIED)
    # Outer white ring for visibility
    draw.ellipse([cx - size // 2 - 2, cy - size // 2 - 2,
                  cx + size // 2 + 2, cy + size // 2 + 2],
                 fill=(255, 255, 255))
    # Colored circle
    draw.ellipse([cx - size // 2, cy - size // 2,
                  cx + size // 2, cy + size // 2],
                 fill=color)
    # Number text centered
    text = str(number)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((cx - tw // 2, cy - th // 2 - 1), text, fill=(255, 255, 255), font=font)


def _wrap_text(draw, text, font, max_width):
    """Wrap text to fit within max_width pixels. Returns list of lines."""
    if not text:
        return [""]
    words = text.split()
    lines = []
    current = ""
    for word in words:
        test = f"{current} {word}".strip()
        bbox = draw.textbbox((0, 0), test, font=font)
        if bbox[2] - bbox[0] <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def _truncate_text(draw, text, font, max_width):
    """Truncate text with '...' if it exceeds max_width pixels."""
    if not text:
        return ""
    bbox = draw.textbbox((0, 0), text, font=font)
    if bbox[2] - bbox[0] <= max_width:
        return text
    while len(text) > 4:
        text = text[:-4] + "..."
        bbox = draw.textbbox((0, 0), text, font=font)
        if bbox[2] - bbox[0] <= max_width:
            return text
    return text


def _measure_table_height(draw, headers, rows, col_ratios, width, fonts,
                          row_height=52, wrap_last_col=False):
    """Pre-measure total table height (header + all data rows)."""
    cell_pad_x = 16
    cell_pad_y = 14
    col_widths = [int(r * width) for r in col_ratios]
    col_widths[-1] = width - sum(col_widths[:-1])
    last_col = len(headers) - 1
    line_h = fonts['cell'].size + 6
    total = row_height  # header row
    for row in rows:
        cells = row['cells']
        if wrap_last_col and last_col < len(cells):
            max_text_w = col_widths[last_col] - 2 * cell_pad_x
            lines = _wrap_text(draw, cells[last_col], fonts['cell'], max_text_w)
            needed = len(lines) * line_h + 2 * cell_pad_y
            total += max(row_height, needed)
        else:
            total += row_height
    return total


def _draw_table(draw, x, y, width, headers, rows, col_ratios, fonts,
                row_height=52, wrap_last_col=False):
    """
    Draw a table on the canvas. Returns total height consumed.

    headers: list of column header strings
    rows: list of dicts with keys:
        'cells': list of cell strings (one per column)
        'status': 'pass'|'fail'|'warning' (colors the Result column)
        'marker_num': int or None (for Ref column marker indicator)
    col_ratios: list of floats summing to ~1.0
    fonts: dict with 'header' and 'cell' ImageFont objects
    wrap_last_col: if True, wrap text in the last column instead of truncating
    """
    header_bg = (30, 34, 44)
    header_fg = (255, 255, 255)
    row_bg_even = (246, 247, 252)
    row_bg_odd = (255, 255, 255)
    border_color = (220, 224, 232)
    text_color_default = (24, 28, 38)
    cell_pad_x = 16
    cell_pad_y = 14

    # Compute pixel widths for columns
    col_widths = [int(r * width) for r in col_ratios]
    col_widths[-1] = width - sum(col_widths[:-1])  # fill remainder

    # Pre-compute row heights for text wrapping
    last_col = len(headers) - 1
    line_h = fonts['cell'].size + 6
    row_heights = []
    wrapped_texts = []

    for row in rows:
        cells = row['cells']
        if wrap_last_col and last_col < len(cells):
            max_text_w = col_widths[last_col] - 2 * cell_pad_x
            lines = _wrap_text(draw, cells[last_col], fonts['cell'], max_text_w)
            needed = len(lines) * line_h + 2 * cell_pad_y
            row_heights.append(max(row_height, needed))
            wrapped_texts.append(lines)
        else:
            row_heights.append(row_height)
            wrapped_texts.append(None)

    current_y = y

    # --- Header row (vertically centered text) ---
    hx = x
    hdr_bbox = draw.textbbox((0, 0), "Ag", font=fonts['header'])
    hdr_text_h = hdr_bbox[3] - hdr_bbox[1]
    hdr_text_y = current_y + (row_height - hdr_text_h) // 2
    for header_text, cw in zip(headers, col_widths):
        draw.rectangle([hx, current_y, hx + cw, current_y + row_height],
                       fill=header_bg, outline=border_color)
        draw.text((hx + cell_pad_x, hdr_text_y), header_text,
                  fill=header_fg, font=fonts['header'])
        hx += cw
    current_y += row_height

    # --- Data rows ---
    for ri, row in enumerate(rows):
        bg = row_bg_even if ri % 2 == 0 else row_bg_odd
        cells = row['cells']
        status = row.get('status', 'pass')
        marker_num = row.get('marker_num')
        rh = row_heights[ri]
        wrapped = wrapped_texts[ri]

        rx = x
        for ci, (cell_text, cw) in enumerate(zip(cells, col_widths)):
            draw.rectangle([rx, current_y, rx + cw, current_y + rh],
                           fill=bg, outline=border_color)

            cell_color = text_color_default
            cell_font = fonts['cell']

            # Ref column (first column): draw marker indicator if present
            if ci == 0 and marker_num is not None:
                marker_color = STATUS_COLORS.get(status, COLOR_UNVERIFIED)
                dot_r = 14
                dot_cx = rx + cw // 2
                dot_cy = current_y + rh // 2
                draw.ellipse([dot_cx - dot_r, dot_cy - dot_r,
                              dot_cx + dot_r, dot_cy + dot_r],
                             fill=marker_color)
                num_text = str(marker_num)
                nb = draw.textbbox((0, 0), num_text, font=fonts['marker'])
                draw.text((dot_cx - (nb[2] - nb[0]) // 2,
                           dot_cy - (nb[3] - nb[1]) // 2 - 1),
                          num_text, fill=(255, 255, 255), font=fonts['marker'])
                rx += cw
                continue

            # Result column: color text by status + center horizontally
            is_result_col = (ci == len(cells) - 2 or (len(headers) == 3 and ci == 1))
            if is_result_col:
                if "PASS" in cell_text.upper():
                    cell_color = COLOR_PASS
                    cell_font = fonts['header']  # bold
                elif "FAIL" in cell_text.upper():
                    cell_color = COLOR_FAIL
                    cell_font = fonts['header']
                elif "WARN" in cell_text.upper():
                    cell_color = COLOR_WARNING
                    cell_font = fonts['header']
                elif "EST" in cell_text.upper():
                    cell_color = COLOR_ESTIMATED
                    cell_font = fonts['header']
                elif cell_text.upper().startswith("N/"):
                    # N/V (not verifiable) and N/S (not submitted) render gray
                    cell_color = COLOR_UNVERIFIED
                    cell_font = fonts['header']

            # Last column with wrapping enabled
            if ci == last_col and wrapped is not None:
                ty = current_y + cell_pad_y
                for line in wrapped:
                    draw.text((rx + cell_pad_x, ty), line,
                              fill=cell_color, font=cell_font)
                    ty += line_h
            elif is_result_col:
                # Center Result column text horizontally and vertically
                txt_bbox = draw.textbbox((0, 0), cell_text or " ", font=cell_font)
                txt_w = txt_bbox[2] - txt_bbox[0]
                txt_h = txt_bbox[3] - txt_bbox[1]
                text_x = rx + (cw - txt_w) // 2
                text_y = current_y + (rh - txt_h) // 2
                draw.text((text_x, text_y), cell_text,
                          fill=cell_color, font=cell_font)
            else:
                # Vertically center single-line text
                txt_bbox = draw.textbbox((0, 0), cell_text or " ", font=cell_font)
                txt_h = txt_bbox[3] - txt_bbox[1]
                text_y = current_y + (rh - txt_h) // 2
                display = _truncate_text(draw, cell_text, cell_font, cw - 2 * cell_pad_x)
                draw.text((rx + cell_pad_x, text_y), display,
                          fill=cell_color, font=cell_font)
            rx += cw
        current_y += rh

    return current_y - y


def generate_output_image(img, colors, output_path):
    """
    Generate a basic review image showing:
    - The card art with a red dashed 56px quiet zone drawn INSIDE the card
    - A sample last-4 PAN in the suggested foreground color
    - RGB color values displayed to the right of the card
    """
    card_w, card_h = img.size
    quiet_zone = VISA_MARK_EDGE_MARGIN

    bg_rgb = tuple(colors["background"]["rgb"])
    fg_rgb = tuple(colors["foreground"]["rgb"])
    label_rgb = tuple(colors["label"]["rgb"])

    padding = 50
    right_panel_w = 600
    canvas_w = padding + card_w + padding + right_panel_w + padding
    canvas_h = padding + card_h + padding

    bg_lum = 0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]
    if bg_lum < 128:
        canvas_bg = tuple(min(255, c + 80) for c in bg_rgb)
    else:
        canvas_bg = tuple(max(0, c - 40) for c in bg_rgb)

    canvas = Image.new("RGB", (canvas_w, canvas_h), canvas_bg)
    draw = ImageDraw.Draw(canvas)

    card_x = padding
    card_y = padding
    card_rgb = img.convert("RGB")
    canvas.paste(card_rgb, (card_x, card_y))

    quiet_rect = [
        card_x + quiet_zone, card_y + quiet_zone,
        card_x + card_w - quiet_zone, card_y + card_h - quiet_zone,
    ]
    _draw_dashed_rect(draw, quiet_rect, color=(255, 0, 0), width=3, dash_len=18, gap_len=12)

    font_pan = _load_font(88, bold=True)
    pan_text = "\u2022\u2022\u2022\u2022 6789"
    pan_x = card_x + quiet_zone + 10
    pan_y = card_y + card_h - quiet_zone - 110
    draw.text((pan_x, pan_y), pan_text, fill=fg_rgb, font=font_pan)

    font_panel = _load_font(36, bold=True)
    swatch_size = 40
    line_spacing = 90
    num_entries = 3
    total_panel_height = num_entries * line_spacing - (line_spacing - 40)
    panel_x = card_x + card_w + padding + 10
    panel_y = card_y + (card_h - total_panel_height) // 2

    color_entries = [
        ("Background color:", bg_rgb),
        ("Foreground color:", fg_rgb),
        ("Label color:", label_rgb),
    ]

    for i, (label_text, rgb_val) in enumerate(color_entries):
        y = panel_y + i * line_spacing
        text_color = rgb_val
        text_lum = 0.299 * rgb_val[0] + 0.587 * rgb_val[1] + 0.114 * rgb_val[2]
        canvas_lum = 0.299 * canvas_bg[0] + 0.587 * canvas_bg[1] + 0.114 * canvas_bg[2]
        contrast = abs(text_lum - canvas_lum)
        if contrast < 50:
            outline_color = (0, 0, 0) if canvas_lum > 128 else (255, 255, 255)
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                draw.text((panel_x + dx, y + dy), label_text, fill=outline_color, font=font_panel)

        draw.text((panel_x, y), label_text, fill=text_color, font=font_panel)
        bbox = draw.textbbox((panel_x, y), label_text, font=font_panel)
        label_end_x = bbox[2] + 16
        swatch_y = y + 4
        draw.rectangle(
            [label_end_x, swatch_y, label_end_x + swatch_size, swatch_y + swatch_size],
            fill=rgb_val, outline=None
        )
        rgb_text = f"  {rgb_val[0]},{rgb_val[1]},{rgb_val[2]}"
        value_x = label_end_x + swatch_size + 4
        if contrast < 50:
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                draw.text((value_x + dx, y + dy), rgb_text, fill=outline_color, font=font_panel)
        draw.text((value_x, y), rgb_text, fill=text_color, font=font_panel)

    canvas.save(output_path, "PNG")
    return output_path


def generate_results_image(img, colors, tech_checks, visual_checks,
                           overall_status, overall_description, output_path):
    """
    Generate the full Card Art Checker Results image as a single PNG page.

    Layout (top to bottom):
    1. Card Art Review Pane — card with numbered markers + color panel on right
    2. Overall Status — status badge + description
    3. Technical Specifications table
    4. Visual Design Compliance table (with Ref column linking to markers)

    Args:
        img: PIL Image of the card art
        colors: dict from extract_colors() with background/foreground/label
        tech_checks: dict from check_image()['checks'] with dimensions/file_format/dpi
        visual_checks: list of dicts, each with:
            'name': str — check name
            'result': 'pass'|'fail'|'warning'
            'notes': str (optional)
            'marker_x': float 0.0-1.0 (optional — horizontal position on card)
            'marker_y': float 0.0-1.0 (optional — vertical position on card)
        overall_status: str — 'APPROVED', 'REQUIRES CHANGES', or 'APPROVED WITH NOTES'
        overall_description: str — summary text
        output_path: str — path to save the PNG
    """
    card_w, card_h = img.size
    quiet_zone = VISA_MARK_EDGE_MARGIN

    bg_rgb = tuple(colors["background"]["rgb"])
    fg_rgb = tuple(colors["foreground"]["rgb"])
    label_rgb = tuple(colors["label"]["rgb"])

    # --- Fonts ---
    font_section = _load_font(34, bold=True)
    font_status = _load_font(36, bold=True)
    font_desc = _load_font(26)
    font_table_header = _load_font(22, bold=True)
    font_table_cell = _load_font(20)
    font_marker_num = _load_font(18, bold=True)
    font_card_marker = _load_font(36, bold=True)
    font_panel = _load_font(32, bold=True)
    font_pan = _load_font(88, bold=True)
    font_legend = _load_font(17)

    # --- Identify markers (location-based warnings/failures) ---
    markers = []
    for vc in visual_checks:
        if vc.get("marker_x") is not None and vc.get("marker_y") is not None:
            if vc["result"] in ("fail", "warning"):
                markers.append(vc)
    # Assign sequential numbers
    for i, m in enumerate(markers):
        m["_marker_num"] = i + 1

    # --- Layout dimensions ---
    padding = 50
    section_gap = 36
    section_pad = 28          # inner padding within white section cards
    right_panel_w = 500
    card_section_w = padding + card_w + padding + right_panel_w + padding
    content_w = card_section_w - 2 * padding  # width for tables
    canvas_w = card_section_w
    table_x = padding + 24
    table_w = content_w - 48

    # Card section height
    card_section_h = padding + card_h + padding

    # Overall status section height (badge is inline with title, not stacked)
    status_title_h = 48
    desc_max_w = content_w - 56
    desc_line_h = 36
    # Temporary draw for text measurement
    _tmp = Image.new("RGB", (1, 1))
    _tmp_draw = ImageDraw.Draw(_tmp)
    desc_lines = _wrap_text(_tmp_draw, overall_description, font_desc, desc_max_w)
    status_desc_h = len(desc_lines) * desc_line_h
    status_section_h = status_title_h + 16 + status_desc_h + section_pad

    # Tech spec table — build row data early for height measurement
    tech_row_h = 52
    tech_table_title_h = 52
    tech_headers = ["Check", "Result", "Detail"]
    tech_col_ratios = [0.28, 0.12, 0.60]
    tech_rows_data = []
    check_order = ["dimensions", "file_format", "dpi", "bleed_zone", "mark_size",
                   "identifier_alignment", "mark_color", "square_corners", "border_frame"]
    check_labels = {
        "dimensions": "Dimensions (1536x969 px)",
        "file_format": "File Format (PNG)",
        "dpi": "DPI (>= 72 for digital)",
        "bleed_zone": "Visa Brand Mark placed at 56px",
        "mark_size": "Visa Brand Mark size (109px)",
        "identifier_alignment": "Identifier aligned with mark",
        "mark_color": "Visa Brand Mark color",
        "square_corners": "Square corners",
        "border_frame": "No border frame",
    }
    for key in check_order:
        if key not in tech_checks:
            continue
        ck = tech_checks[key]
        passed = ck.get("passed", False)
        if ck.get("borderline"):
            status = "warning"
        elif passed is None:
            status = "unverified"  # e.g. Brand Mark not located
        elif passed:
            status = "pass"
        else:
            status = "fail"
        label = STATUS_LABELS[status]
        detail = ck.get("actual", "")
        if ck.get("note"):
            detail = ck["note"] if len(ck["note"]) < 80 else ck["actual"]
        tech_rows_data.append({
            "cells": [check_labels.get(key, key), label, detail],
            "status": status,
        })
    table_fonts = {'header': font_table_header, 'cell': font_table_cell,
                   'marker': font_marker_num}
    tech_table_h = _measure_table_height(
        _tmp_draw, tech_headers, tech_rows_data, tech_col_ratios,
        table_w, table_fonts, row_height=tech_row_h)
    tech_section_h = tech_table_title_h + 10 + tech_table_h + 16

    # Visual design table — build row data early for height measurement
    vis_row_h = 52
    vis_table_title_h = 52
    vis_headers = ["Ref", "Check", "Result", "Notes"]
    vis_col_ratios = [0.04, 0.36, 0.09, 0.51]
    vis_rows_data = []
    marker_lookup = {}
    for m in markers:
        for vi, vc in enumerate(visual_checks):
            if (vc.get("marker_x") == m.get("marker_x") and
                    vc.get("marker_y") == m.get("marker_y") and
                    vc.get("name") == m.get("name")):
                marker_lookup[vi] = m["_marker_num"]
    for vi, vc in enumerate(visual_checks):
        status = vc.get("result", "pass")
        label = STATUS_LABELS.get(status, "PASS")
        notes = vc.get("notes", "")
        mnum = marker_lookup.get(vi)
        vis_rows_data.append({
            "cells": ["", vc["name"], label, notes],
            "status": status,
            "marker_num": mnum,
        })
    vis_table_h = _measure_table_height(
        _tmp_draw, vis_headers, vis_rows_data, vis_col_ratios,
        table_w, table_fonts, row_height=vis_row_h, wrap_last_col=True)
    vis_legend_h = 36 if markers else 0
    vis_section_h = vis_table_title_h + 10 + vis_table_h + 16 + vis_legend_h

    canvas_h = (padding +
                status_section_h + section_gap +
                card_section_h + section_gap +
                tech_section_h + section_gap +
                vis_section_h + padding)

    # --- Canvas background ---
    canvas_bg = (240, 242, 246)
    canvas = Image.new("RGB", (canvas_w, canvas_h), canvas_bg)
    draw = ImageDraw.Draw(canvas)

    # =====================================================================
    # SECTION 0: Art Checker Results (moved to top)
    # =====================================================================
    current_y = padding
    status_rect = [padding, current_y,
                   canvas_w - padding, current_y + status_section_h]
    draw.rectangle(status_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    sx = padding + section_pad
    sy = current_y + 20

    # Section header (title case)
    draw.text((sx, sy), "Art Checker Results", fill=(24, 28, 38), font=font_section)

    # Status badge — top-right corner of section
    status_upper = overall_status.upper()
    if "APPROVED" in status_upper and "NOTES" in status_upper:
        badge_color = COLOR_WARNING
        badge_text = "APPROVED WITH NOTES"
    elif "APPROVED" in status_upper:
        badge_color = COLOR_PASS
        badge_text = "APPROVED"
    else:
        badge_color = COLOR_FAIL
        badge_text = "REQUIRES CHANGES"

    badge_bbox = draw.textbbox((0, 0), badge_text, font=font_status)
    badge_w = badge_bbox[2] - badge_bbox[0] + 40
    badge_h = badge_bbox[3] - badge_bbox[1] + 22
    badge_x = canvas_w - padding - section_pad - badge_w
    badge_y = sy - 2
    draw.rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h],
                   fill=badge_color)
    draw.text((badge_x + 20, badge_y + 9), badge_text, fill=(255, 255, 255), font=font_status)
    sy += status_title_h + 12

    # Description text (wrapped) — high contrast
    for line in desc_lines:
        draw.text((sx, sy), line, fill=(28, 32, 42), font=font_desc)
        sy += desc_line_h

    current_y += status_section_h + section_gap

    # =====================================================================
    # SECTION 1: Card Art Review Pane
    # =====================================================================
    card_x = padding
    card_y = current_y + padding

    # Card background panel (slight shadow effect)
    panel_rect = [card_x - 6, card_y - 6,
                  card_x + card_w + padding + right_panel_w + 6,
                  card_y + card_h + 6]
    draw.rectangle(panel_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    # Paste card image
    card_rgb = img.convert("RGB")
    canvas.paste(card_rgb, (card_x, card_y))

    # Draw 56px quiet zone as red dashed rectangle
    quiet_rect = [
        card_x + quiet_zone, card_y + quiet_zone,
        card_x + card_w - quiet_zone, card_y + card_h - quiet_zone,
    ]
    _draw_dashed_rect(draw, quiet_rect, color=(255, 0, 0), width=3, dash_len=18, gap_len=12)

    # Sample PAN overlay
    pan_text = "\u2022\u2022\u2022\u2022 6789"
    pan_x = card_x + quiet_zone + 10
    pan_y = card_y + card_h - quiet_zone - 110
    draw.text((pan_x, pan_y), pan_text, fill=fg_rgb, font=font_pan)

    # --- Draw markers on the card ---
    for m in markers:
        mx = card_x + int(m["marker_x"] * card_w)
        my = card_y + int(m["marker_y"] * card_h)
        _draw_marker(draw, mx, my, m["_marker_num"], m["result"], font_card_marker, size=68)

    # --- Color panel (right of card) ---
    swatch_size = 36
    line_spacing = 82
    num_entries = 3
    total_panel_height = num_entries * line_spacing - (line_spacing - 36)
    cpanel_x = card_x + card_w + padding + 10
    cpanel_y = card_y + (card_h - total_panel_height) // 2

    color_entries = [
        ("Background:", bg_rgb),
        ("Foreground:", fg_rgb),
        ("Label:", label_rgb),
    ]

    for i, (lbl, rgb_val) in enumerate(color_entries):
        cy = cpanel_y + i * line_spacing
        text_color = rgb_val

        # Ensure readability against canvas panel (white)
        text_lum = 0.299 * rgb_val[0] + 0.587 * rgb_val[1] + 0.114 * rgb_val[2]
        if text_lum > 200:
            outline_color = (100, 100, 100)
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                draw.text((cpanel_x + dx, cy + dy), lbl, fill=outline_color, font=font_panel)

        draw.text((cpanel_x, cy), lbl, fill=text_color, font=font_panel)
        bbox = draw.textbbox((cpanel_x, cy), lbl, font=font_panel)
        label_end_x = bbox[2] + 12

        # Swatch
        swatch_y = cy + 6
        draw.rectangle([label_end_x, swatch_y,
                        label_end_x + swatch_size, swatch_y + swatch_size],
                       fill=rgb_val, outline=(180, 180, 180))

        # RGB value
        rgb_text = f" {rgb_val[0]},{rgb_val[1]},{rgb_val[2]}"
        value_x = label_end_x + swatch_size + 4
        if text_lum > 200:
            for dx, dy in [(-1, -1), (-1, 1), (1, -1), (1, 1)]:
                draw.text((value_x + dx, cy + dy), rgb_text, fill=outline_color, font=font_panel)
        draw.text((value_x, cy), rgb_text, fill=text_color, font=font_panel)

    current_y = card_y + card_h + padding + section_gap

    # =====================================================================
    # SECTION 3: Spec Check
    # =====================================================================
    tech_bg_rect = [padding, current_y,
                    canvas_w - padding, current_y + tech_section_h]
    draw.rectangle(tech_bg_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    tx = padding + section_pad
    ty = current_y + 16
    draw.text((tx, ty), "Spec Check", fill=(24, 28, 38), font=font_section)
    ty += tech_table_title_h

    _draw_table(draw, table_x, ty, table_w,
                tech_headers, tech_rows_data,
                col_ratios=tech_col_ratios,
                fonts=table_fonts,
                row_height=tech_row_h)

    current_y += tech_section_h + section_gap

    # =====================================================================
    # SECTION 4: Visual Design Compliance Table
    # =====================================================================
    vis_bg_rect = [padding, current_y,
                   canvas_w - padding, current_y + vis_section_h]
    draw.rectangle(vis_bg_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    vx = padding + section_pad
    vy = current_y + 16
    draw.text((vx, vy), "Visual Check", fill=(24, 28, 38), font=font_section)
    vy += vis_table_title_h

    _draw_table(draw, table_x, vy, table_w,
                vis_headers, vis_rows_data,
                col_ratios=vis_col_ratios,
                fonts=table_fonts,
                row_height=vis_row_h,
                wrap_last_col=True)

    # Legend note if markers exist
    if markers:
        legend_y = vy + vis_table_h + 8
        legend_text = "Numbered markers on the card art above correspond to the Ref column in this table."
        draw.text((table_x + 8, legend_y), legend_text,
                  fill=(80, 84, 96), font=font_legend)

    # Save as PDF or PNG. output_path may also be a file-like object
    # (e.g. BytesIO from api/spec-check.py) — always saved as PDF then.
    if hasattr(output_path, "write") or output_path.lower().endswith(".pdf"):
        canvas.save(output_path, "PDF", resolution=150)
    else:
        canvas.save(output_path, "PNG")
    return output_path


PHYSICAL_CHECK_ORDER = ["file_format", "trim_size", "bleed_margin",
                        "cr80_aspect_ratio", "min_resolution",
                        "bleed_zone", "magstripe_band", "color_mode",
                        "layers_present"]
PHYSICAL_CHECK_LABELS = {
    "file_format": "File Format (.ai/.eps/.png)",
    "trim_size": "Trim Size (CR80 3.370\"x2.125\")",
    "bleed_margin": "Bleed Margin (>= 1/8\", 0.25\" canonical)",
    "cr80_aspect_ratio": "CR80 Aspect Ratio (~1.586:1)",
    "min_resolution": f"Min Resolution (>= {PHYSICAL_MIN_RENDERED_WIDTH_PX}px wide)",
    "bleed_zone": "Visa Brand Mark Quiet Zone",
    "magstripe_band": "Magstripe Band (back)",
    "color_mode": "Color Mode (CMYK/PMS)",
    "layers_present": "Layers Present",
}


def _physical_check_status(ck):
    """Map a physical tech-check dict to a table status string."""
    if ck.get("borderline"):
        return "warning"
    passed = ck.get("passed")
    if passed is True:
        return "pass"
    if passed is False:
        return "fail"
    return "unverified"  # passed: None — e.g. color mode / layers on PNG input


def generate_physical_results_image(tech_result, visual_checks,
                                    overall_status, overall_description,
                                    output_path, display_width=1536):
    """
    Generate the full Physical Card Art Checker Results image as a single page.

    Layout (top to bottom):
    1. Art Checker Results — status badge + description
    2. Card Art Review Pane (Front) — rendered preview with 56px quiet-zone
       overlay, numbered markers, and a File Info panel on the right
    3. Card Art Review Pane (Back) — same, when a back file was submitted;
       otherwise a "not submitted" note strip
    4. Spec Check — per-side technical check tables
    5. Visual Check — table with a Ref column linking to the markers

    Args:
        tech_result: full dict from check_physical() —
            {card_type, front: {side, file, source_format, checks{...},
             rendered_preview_path}, back: {...}|None, errors}
        visual_checks: list of dicts, each with:
            'name': str — check name
            'result': 'pass'|'fail'|'warning'|'not submitted'
            'notes': str (optional)
            'marker_x': float 0.0-1.0 (optional — relative to that side's preview)
            'marker_y': float 0.0-1.0 (optional)
            'marker_side': 'front'|'back' (optional — defaults to front)
        overall_status: str — 'APPROVED', 'REQUIRES CHANGES', or 'APPROVED WITH NOTES'
        overall_description: str — summary text
        output_path: str — path to save the PDF (or PNG)
        display_width: int — width previews are scaled to (56px overlay and
            marker positions scale by the same factor)
    """
    DISPLAY_W = display_width
    quiet_zone = VISA_MARK_EDGE_MARGIN

    # --- Fonts ---
    font_section = _load_font(34, bold=True)
    font_status = _load_font(36, bold=True)
    font_desc = _load_font(26)
    font_table_header = _load_font(22, bold=True)
    font_table_cell = _load_font(20)
    font_marker_num = _load_font(18, bold=True)
    font_card_marker = _load_font(36, bold=True)
    font_caption = _load_font(28, bold=True)
    font_subhead = _load_font(26, bold=True)
    font_info_label = _load_font(26, bold=True)
    font_info_value = _load_font(22)
    font_note = _load_font(24)
    font_legend = _load_font(17)

    # --- Identify markers (location-based warnings/failures) ---
    markers = []
    for vc in visual_checks:
        if vc.get("marker_x") is not None and vc.get("marker_y") is not None:
            if vc.get("result") in ("fail", "warning"):
                markers.append(vc)
    for i, m in enumerate(markers):
        m["_marker_num"] = i + 1

    # --- Load and scale side previews ---
    def load_side_preview(side):
        if not side:
            return None
        path = side.get("rendered_preview_path")
        if not path or not os.path.exists(path):
            return None
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            return None
        img_w, img_h = img.size
        disp = img.resize((DISPLAY_W, max(1, round(img_h * DISPLAY_W / img_w))), Image.LANCZOS)
        # The preview may have been downscaled for transport (api/spec-check.py
        # records the measurement raster's true size as render_full_width/height).
        # The 56px quiet zone and the File Info dimensions must reflect the
        # ORIGINAL render the checks measured against, not the shrunken copy.
        orig_w = side.get("render_full_width") or img_w
        orig_h = side.get("render_full_height") or img_h
        return {"disp": disp, "scale": DISPLAY_W / orig_w, "orig_w": orig_w, "orig_h": orig_h}

    front_side = tech_result.get("front") or {}
    back_side = tech_result.get("back")
    front_prev = load_side_preview(front_side)
    back_prev = load_side_preview(back_side)

    def info_entries(side, prev):
        """(label, value, color) rows for the File Info panel."""
        fmt = (side.get("source_format") or "unknown").lower()
        is_vector = fmt in ("ai", "eps")
        text_dark = (24, 28, 38)
        entries = [("Source:", f".{fmt.upper()} ({'vector' if is_vector else 'raster'})", text_dark)]
        if prev:
            dpi = side.get("render_dpi") or PHYSICAL_RENDER_DPI
            if is_vector:
                entries.append(("Rendered:", f"{prev['orig_w']}x{prev['orig_h']} @ {dpi:g} DPI", text_dark))
            else:
                entries.append(("Supplied:", f"{prev['orig_w']}x{prev['orig_h']} PNG", text_dark))
        if side.get("orientation"):
            entries.append(("Orientation:", side["orientation"].capitalize(), text_dark))
        checks = side.get("checks") or {}
        for key, lbl in (("trim_size", "Trim:"), ("bleed_margin", "Bleed:"),
                         ("color_mode", "Color mode:"), ("layers_present", "Layers:")):
            ck = checks.get(key)
            if not ck:
                continue
            status = _physical_check_status(ck)
            entries.append((lbl, str(ck.get("actual", "")),
                            STATUS_COLORS.get(status, COLOR_UNVERIFIED)))
        return entries

    # --- Layout dimensions (mirror the virtual report's geometry) ---
    padding = 50
    section_gap = 36
    section_pad = 28
    right_panel_w = 500
    canvas_w = padding + DISPLAY_W + padding + right_panel_w + padding
    content_w = canvas_w - 2 * padding
    table_x = padding + 24
    table_w = content_w - 48

    _tmp = Image.new("RGB", (1, 1))
    _tmp_draw = ImageDraw.Draw(_tmp)

    # Status section height
    status_title_h = 48
    desc_max_w = content_w - 56
    desc_line_h = 36
    desc_lines = _wrap_text(_tmp_draw, overall_description, font_desc, desc_max_w)
    status_section_h = status_title_h + 16 + len(desc_lines) * desc_line_h + section_pad

    # Review pane blocks: ('pane', caption, side, prev) or ('note', text)
    caption_h = 44
    note_strip_h = 64
    pane_blocks = []
    if front_prev:
        pane_blocks.append(("pane", "Front", front_side, front_prev))
    else:
        pane_blocks.append(("note", "Front preview unavailable (render failed - see Spec Check)", None, None))
    if back_side is None:
        pane_blocks.append(("note", "Back: not submitted (optional)", None, None))
    elif back_prev:
        # The canonical back is always horizontal, even under a vertical
        # front — label it so a mixed-orientation report doesn't read as an
        # inconsistency.
        back_caption = (
            "Back (standardized horizontal back)"
            if (front_side.get("orientation") == "vertical")
            else "Back"
        )
        pane_blocks.append(("pane", back_caption, back_side, back_prev))
    else:
        pane_blocks.append(("note", "Back preview unavailable (render failed - see Spec Check)", None, None))

    def pane_height(prev):
        return section_pad + caption_h + 12 + prev["disp"].height + section_pad

    panes_total_h = 0
    for kind, _, _, prev in pane_blocks:
        panes_total_h += (pane_height(prev) if kind == "pane" else note_strip_h) + section_gap

    # Spec Check tables — per side
    tech_row_h = 52
    tech_table_title_h = 52
    tech_headers = ["Check", "Result", "Detail"]
    tech_col_ratios = [0.28, 0.12, 0.60]
    table_fonts = {'header': font_table_header, 'cell': font_table_cell,
                   'marker': font_marker_num}

    def build_spec_rows(side):
        checks = side.get("checks") or {}
        rows = []
        for key in PHYSICAL_CHECK_ORDER:
            ck = checks.get(key)
            if ck is None:
                # bleed_zone is the #1 rejection check — surface its absence
                # (exception path) instead of silently dropping the row.
                # Backs never run it (the Visa mark lives on the front).
                if key == "bleed_zone" and (side.get("side") or "front") == "front":
                    rows.append({"cells": [PHYSICAL_CHECK_LABELS[key], "N/V",
                                           "Bleed zone analysis failed - see errors"],
                                 "status": "unverified"})
                continue
            status = _physical_check_status(ck)
            detail = ck.get("actual", "")
            if ck.get("note"):
                detail = ck["note"]
            rows.append({"cells": [PHYSICAL_CHECK_LABELS.get(key, key),
                                   STATUS_LABELS[status], detail],
                         "status": status})
        return rows

    subhead_h = 44
    spec_tables = [("Front", build_spec_rows(front_side))]
    if back_side:
        spec_tables.append(("Back", build_spec_rows(back_side)))
    spec_section_h = tech_table_title_h + 10
    for _, rows in spec_tables:
        th = _measure_table_height(_tmp_draw, tech_headers, rows, tech_col_ratios,
                                   table_w, table_fonts, row_height=tech_row_h,
                                   wrap_last_col=True)
        spec_section_h += subhead_h + th + 20
    spec_section_h += 8

    # Visual Check table
    vis_row_h = 52
    vis_table_title_h = 52
    vis_headers = ["Ref", "Check", "Result", "Notes"]
    vis_col_ratios = [0.04, 0.36, 0.09, 0.51]
    vis_rows_data = []
    for vc in visual_checks:
        status = vc.get("result", "pass")
        label = STATUS_LABELS.get(status, "N/V")
        vis_rows_data.append({
            "cells": ["", vc.get("name", ""), label, vc.get("notes", "")],
            "status": status,
            "marker_num": vc.get("_marker_num"),
        })
    vis_table_h = _measure_table_height(
        _tmp_draw, vis_headers, vis_rows_data, vis_col_ratios,
        table_w, table_fonts, row_height=vis_row_h, wrap_last_col=True)
    vis_legend_h = 36 if markers else 0
    vis_section_h = vis_table_title_h + 10 + vis_table_h + 16 + vis_legend_h

    canvas_h = (padding +
                status_section_h + section_gap +
                panes_total_h +
                spec_section_h + section_gap +
                vis_section_h + padding)

    # --- Canvas background ---
    canvas_bg = (240, 242, 246)
    canvas = Image.new("RGB", (canvas_w, canvas_h), canvas_bg)
    draw = ImageDraw.Draw(canvas)

    # =====================================================================
    # SECTION: Art Checker Results (status + summary)
    # =====================================================================
    current_y = padding
    status_rect = [padding, current_y,
                   canvas_w - padding, current_y + status_section_h]
    draw.rectangle(status_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    sx = padding + section_pad
    sy = current_y + 20
    draw.text((sx, sy), "Art Checker Results", fill=(24, 28, 38), font=font_section)

    status_upper = overall_status.upper()
    if "APPROVED" in status_upper and "NOTES" in status_upper:
        badge_color = COLOR_WARNING
        badge_text = "APPROVED WITH NOTES"
    elif "APPROVED" in status_upper:
        badge_color = COLOR_PASS
        badge_text = "APPROVED"
    else:
        badge_color = COLOR_FAIL
        badge_text = "REQUIRES CHANGES"

    badge_bbox = draw.textbbox((0, 0), badge_text, font=font_status)
    badge_w = badge_bbox[2] - badge_bbox[0] + 40
    badge_h = badge_bbox[3] - badge_bbox[1] + 22
    badge_x = canvas_w - padding - section_pad - badge_w
    badge_y = sy - 2
    draw.rectangle([badge_x, badge_y, badge_x + badge_w, badge_y + badge_h],
                   fill=badge_color)
    draw.text((badge_x + 20, badge_y + 9), badge_text, fill=(255, 255, 255), font=font_status)
    sy += status_title_h + 12

    for line in desc_lines:
        draw.text((sx, sy), line, fill=(28, 32, 42), font=font_desc)
        sy += desc_line_h

    current_y += status_section_h + section_gap

    # =====================================================================
    # SECTION: Card Art Review Panes (Front / Back)
    # =====================================================================
    for kind, caption, side, prev in pane_blocks:
        if kind == "note":
            note_rect = [padding, current_y,
                         canvas_w - padding, current_y + note_strip_h]
            draw.rectangle(note_rect, fill=(255, 255, 255), outline=(220, 222, 228))
            nb = draw.textbbox((0, 0), caption, font=font_note)
            draw.text((padding + section_pad,
                       current_y + (note_strip_h - (nb[3] - nb[1])) // 2),
                      caption, fill=(110, 114, 126), font=font_note)
            current_y += note_strip_h + section_gap
            continue

        p_h = pane_height(prev)
        pane_rect = [padding, current_y, canvas_w - padding, current_y + p_h]
        draw.rectangle(pane_rect, fill=(255, 255, 255), outline=(220, 222, 228))

        draw.text((padding + section_pad, current_y + section_pad),
                  caption, fill=(24, 28, 38), font=font_caption)

        img_x = padding + section_pad
        img_y = current_y + section_pad + caption_h + 12
        disp = prev["disp"]
        canvas.paste(disp, (img_x, img_y))

        # Trim line (solid blue, when the source carried a TrimBox) and the
        # Visa Brand Mark quiet zone (dashed red) inset from the TRIM edge —
        # not the render edge, which includes bleed on canonical templates.
        scale = prev["scale"]
        t = side.get("trim_offset_px") or {}
        t_l = round((t.get("left") or 0) * scale)
        t_r = round((t.get("right") or 0) * scale)
        t_t = round((t.get("top") or 0) * scale)
        t_b = round((t.get("bottom") or 0) * scale)
        if any((t_l, t_r, t_t, t_b)):
            trim_rect = [
                img_x + t_l, img_y + t_t,
                img_x + DISPLAY_W - t_r, img_y + disp.height - t_b,
            ]
            draw.rectangle(trim_rect, outline=(30, 100, 220), width=3)
        side_quiet = ((side.get("checks") or {}).get("bleed_zone") or {}).get(
            "margin_px") or quiet_zone
        quiet_disp = max(1, round(side_quiet * scale))
        quiet_rect = [
            img_x + t_l + quiet_disp, img_y + t_t + quiet_disp,
            img_x + DISPLAY_W - t_r - quiet_disp,
            img_y + disp.height - t_b - quiet_disp,
        ]
        _draw_dashed_rect(draw, quiet_rect, color=(255, 0, 0), width=3, dash_len=18, gap_len=12)

        # Markers for this side (side dict carries the canonical side name —
        # captions may be decorated, e.g. "Back (standardized horizontal back)")
        side_label = (side.get("side") or caption.split(" ")[0]).lower()
        for m in markers:
            if (m.get("marker_side") or "front").lower() != side_label:
                continue
            mx = img_x + int(float(m["marker_x"]) * DISPLAY_W)
            my = img_y + int(float(m["marker_y"]) * disp.height)
            _draw_marker(draw, mx, my, m["_marker_num"], m["result"], font_card_marker, size=68)

        # File Info panel (right of preview)
        info_x = img_x + DISPLAY_W + 40
        info_max_w = canvas_w - padding - section_pad - info_x
        iy = img_y + 8
        for lbl, val, col in info_entries(side, prev):
            draw.text((info_x, iy), lbl, fill=(24, 28, 38), font=font_info_label)
            iy += 34
            for line in _wrap_text(draw, val, font_info_value, info_max_w - 12):
                draw.text((info_x + 12, iy), line, fill=col, font=font_info_value)
                iy += 30
            iy += 14

        current_y += p_h + section_gap

    # =====================================================================
    # SECTION: Spec Check (per side)
    # =====================================================================
    spec_bg_rect = [padding, current_y,
                    canvas_w - padding, current_y + spec_section_h]
    draw.rectangle(spec_bg_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    ty = current_y + 16
    draw.text((padding + section_pad, ty), "Spec Check", fill=(24, 28, 38), font=font_section)
    ty += tech_table_title_h

    for side_label, rows in spec_tables:
        draw.text((table_x, ty), side_label, fill=(24, 28, 38), font=font_subhead)
        ty += subhead_h
        consumed = _draw_table(draw, table_x, ty, table_w,
                               tech_headers, rows,
                               col_ratios=tech_col_ratios,
                               fonts=table_fonts,
                               row_height=tech_row_h,
                               wrap_last_col=True)
        ty += consumed + 20

    current_y += spec_section_h + section_gap

    # =====================================================================
    # SECTION: Visual Check
    # =====================================================================
    vis_bg_rect = [padding, current_y,
                   canvas_w - padding, current_y + vis_section_h]
    draw.rectangle(vis_bg_rect, fill=(255, 255, 255), outline=(220, 222, 228))

    vy = current_y + 16
    draw.text((padding + section_pad, vy), "Visual Check", fill=(24, 28, 38), font=font_section)
    vy += vis_table_title_h

    _draw_table(draw, table_x, vy, table_w,
                vis_headers, vis_rows_data,
                col_ratios=vis_col_ratios,
                fonts=table_fonts,
                row_height=vis_row_h,
                wrap_last_col=True)

    if markers:
        legend_y = vy + vis_table_h + 8
        legend_text = "Numbered markers on the front/back panes above correspond to the Ref column in this table."
        draw.text((table_x + 8, legend_y), legend_text,
                  fill=(80, 84, 96), font=font_legend)

    # Save as PDF or PNG. output_path may also be a file-like object
    # (e.g. BytesIO from api/spec-check.py) — always saved as PDF then.
    if hasattr(output_path, "write") or output_path.lower().endswith(".pdf"):
        canvas.save(output_path, "PDF", resolution=150)
    else:
        canvas.save(output_path, "PNG")
    return output_path


# ─────────────────────────────────────────────────────────────────
# Physical card checks (vector: .ai / .eps)
# ─────────────────────────────────────────────────────────────────

def _render_base(vector_path: str) -> str:
    """Output-file base for a vector's page renders. '%' is stripped because
    gs treats the OutputFile argument as a format string. A short identity
    hash (path + size + mtime) keeps distinct sources with the same basename
    — e.g. vertical/Signature.ai vs horizontal/Signature.ai — from colliding
    in a shared cache/output directory."""
    import hashlib
    base = os.path.splitext(os.path.basename(vector_path))[0].replace("%", "_")
    try:
        st = os.stat(vector_path)
        ident = f"{os.path.abspath(vector_path)}|{st.st_size}|{st.st_mtime_ns}"
    except OSError:
        ident = os.path.abspath(vector_path)
    return f"{base}_{hashlib.sha1(ident.encode()).hexdigest()[:8]}"


def _collect_page_renders(directory: str, base: str, src_mtime: float) -> "list[str]":
    """Ordered page renders ({base}_render_<n>.png) in a directory, valid when
    every page file is non-empty and at least as new as the source. Returns []
    when no valid, gap-free page sequence starting at 1 exists."""
    prefix = f"{base}_render_"
    pages = {}
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    for name in names:
        if not (name.startswith(prefix) and name.endswith(".png")):
            continue
        num = name[len(prefix):-len(".png")]
        if not num.isdigit():
            continue
        path = os.path.join(directory, name)
        try:
            if os.path.getsize(path) > 0 and os.path.getmtime(path) >= src_mtime:
                pages[int(num)] = path
        except OSError:
            return []
    if not pages or set(pages) != set(range(1, len(pages) + 1)):
        return []
    return [pages[n] for n in sorted(pages)]


def _render_vector_pages(vector_path: str, out_dir: str) -> "list[str]":
    """
    Rasterize every page of a .ai or .eps file to PNGs using Ghostscript.
    Adobe Illustrator saves .ai files PDF-compatible by default, so gs handles
    both — and Rain's canonical physical templates are 2-page files (page 1 =
    front, page 2 = back), so pages must render to separate outputs: a single
    -sOutputFile makes gs overwrite page 1 with page 2.
    Reuses cached page renders from an earlier run in the same sandbox.
    Returns the ordered list of absolute page-PNG paths.
    """
    import subprocess
    base = _render_base(vector_path)
    try:
        src_mtime = os.path.getmtime(vector_path)
    except OSError:
        src_mtime = 0.0
    for directory in (out_dir, os.path.dirname(os.path.abspath(vector_path))):
        cached = _collect_page_renders(directory, base, src_mtime)
        if cached:
            return cached
    out_pattern = os.path.join(out_dir, f"{base}_render_%d.png")
    cmd = [
        "gs",
        "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
        f"-r{PHYSICAL_RENDER_DPI}",
        "-sDEVICE=png16m",
        f"-sOutputFile={out_pattern}",
        vector_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    except FileNotFoundError:
        raise RuntimeError(
            "Ghostscript (gs) is not installed in this environment. "
            "Install with: apt-get install -y ghostscript"
        )
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="ignore") if e.stderr else ""
        raise RuntimeError(f"Ghostscript render failed: {stderr[:400]}")
    pages = _collect_page_renders(out_dir, base, src_mtime)
    if not pages:
        raise RuntimeError("Ghostscript completed but produced no PNG output")
    return pages


# PMS numbers the card vendors offer for manufactured elements (card core,
# magstripe, decorative edge) — from the designers' "Card Core and Magstripe
# Color Options" sheet. Advisory only: these are ordering options, not
# artwork pass/fail criteria.
VENDOR_PMS_NUMBERS = {
    # Vendor 1 core / magstripe
    "1805", "114", "1595", "2301", "2144", "287",
    "8640", "877", "7484", "2955", "180",
    # Vendor 2 core / magstripe / decorative edge
    "361", "165", "193", "1255", "8385", "295", "341", "342",
    "108", "2035", "511", "7462", "561", "425", "419", "802", "803", "806",
}


def _iter_flate_streams(data: bytes, max_streams: int = 300,
                        max_total_bytes: int = 40_000_000):
    """Yield decompressed FlateDecode stream payloads (bounded for the 60s
    serverless budget). Non-Flate or corrupt streams are skipped."""
    import re
    import zlib
    total = 0
    count = 0
    for m in re.finditer(rb"stream\r?\n", data):
        if count >= max_streams or total >= max_total_bytes:
            return
        # The stream dict immediately precedes the `stream` keyword.
        dict_window = data[max(0, m.start() - 600):m.start()]
        if b"/FlateDecode" not in dict_window:
            continue
        end = data.find(b"endstream", m.end())
        if end == -1:
            continue
        payload = data[m.end():end]
        try:
            out = zlib.decompress(payload)
        except zlib.error:
            try:
                out = zlib.decompressobj().decompress(payload, 8_000_000)
            except zlib.error:
                continue
        count += 1
        total += len(out)
        yield out


def _pdf_name_to_text(raw: bytes) -> str:
    """Decode a PDF name token (with #XX escapes) to text."""
    import re
    return re.sub(
        rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), raw
    ).decode("latin-1", "replace")


def _detect_color_mode(vector_path: str) -> dict:
    """
    Color-mode detection for .ai/.eps.

    Preferred path (PDF-compatible .ai): decompress content streams and look
    at what actually draws — CMYK operators (k/K), RGB operators (rg/RG),
    and /Separation spot-ink colorants (enumerated by name, with vendor PMS
    cross-referencing as an advisory note).
    Fallback (.eps / undecidable): the original byte-marker heuristic.

    Returns { actual, passed, note, spot_inks }. passed=True when drawing is
    CMYK/spot; False when RGB drawing operators are found.
    """
    import re
    try:
        with open(vector_path, "rb") as f:
            data = f.read()
    except Exception as e:
        return {"passed": None, "actual": "unknown",
                "required": "CMYK or PMS",
                "note": f"Could not read file for color-mode detection: {e}"}

    sep_re = re.compile(rb"/Separation\s*/([^\s/\[\]<>()]+)")
    rgb_op_re = re.compile(rb"[\d.]\s+(?:rg|RG)[\s]")
    cmyk_op_re = re.compile(rb"[\d.]\s+(?:k|K)[\s]")
    devrgb_re = re.compile(rb"/DeviceRGB\b")

    spot_inks = set()
    rgb_ops = 0
    cmyk_ops = 0
    device_rgb = 0
    scanned_any = False

    for chunk in (data, *(_iter_flate_streams(data))):
        scanned_any = True
        for m in sep_re.finditer(chunk):
            name = _pdf_name_to_text(m.group(1)).strip()
            # 'All' is the registration pseudo-colorant, not an ink.
            if name and name.lower() != "all":
                spot_inks.add(name)
        rgb_ops += len(rgb_op_re.findall(chunk))
        cmyk_ops += len(cmyk_op_re.findall(chunk))
        device_rgb += len(devrgb_re.findall(chunk))

    spot_list = sorted(spot_inks)
    result_extra = {"spot_inks": spot_list}

    def _pms_note():
        if not spot_list:
            return ""
        detected_nums = set()
        for ink in spot_list:
            detected_nums.update(re.findall(r"\b(\d{3,4})\b", ink))
        matched = sorted(detected_nums & VENDOR_PMS_NUMBERS)
        note = f" Spot inks: {', '.join(spot_list)}."
        if matched:
            note += (f" PMS {', '.join(matched)} appear(s) in the card vendors' "
                     "core/magstripe/edge options — if intended as a manufactured "
                     "element color, confirm the choice on the order.")
        return note

    if rgb_ops and not cmyk_ops and not spot_list:
        # Rain's own canonical templates are RGB-mode Illustrator documents,
        # so RGB drawing is a warning (convert before production), not a fail
        # — template-derived submissions would otherwise always fail.
        return {"passed": True, "borderline": True,
                "actual": f"RGB ({rgb_ops} RGB drawing ops)",
                "required": "CMYK or PMS at production",
                "note": ("Artwork draws in RGB (as Rain's canonical templates "
                         "do). Confirm the file is converted to CMYK/PMS with "
                         "the card vendor before production."), **result_extra}
    if (cmyk_ops or spot_list) and not rgb_ops and not device_rgb:
        actual = "CMYK" + (" + spot inks" if spot_list else "")
        return {"passed": True, "actual": actual,
                "required": "CMYK or PMS",
                "note": ("Drawing operations are CMYK/spot — matches the "
                         "print-ready requirement." + _pms_note()), **result_extra}
    if cmyk_ops and (rgb_ops or device_rgb):
        return {"passed": True, "borderline": True,
                "actual": f"CMYK ({cmyk_ops} ops) + RGB ({rgb_ops or device_rgb} refs)",
                "required": "CMYK or PMS",
                "note": ("Mostly CMYK with some RGB references — likely embedded "
                         "RGB assets. Confirm all placed images are converted to "
                         "CMYK before production." + _pms_note()), **result_extra}

    # Nothing conclusive in the streams — fall back to byte markers.
    text = data[:200_000].decode("latin-1", errors="ignore")
    has_cmyk = any(m in text for m in ("setcmykcolor", "DeviceCMYK",
                                        "DocumentProcessColors: (Cyan",
                                        "/DeviceN", "CMYK"))
    has_rgb = any(m in text for m in ("setrgbcolor", "DeviceRGB", "RGB"))
    if has_cmyk and not has_rgb:
        return {"passed": True, "actual": "CMYK",
                "required": "CMYK or PMS",
                "note": "CMYK color space detected in vector header", **result_extra}
    if has_rgb and not has_cmyk:
        return {"passed": True, "borderline": True, "actual": "RGB",
                "required": "CMYK or PMS at production",
                "note": ("Only RGB color markers detected (Rain's canonical "
                         "templates are also RGB-mode). Confirm conversion to "
                         "CMYK/PMS with the card vendor before production."),
                **result_extra}
    return {"passed": None,
            "actual": "undetermined" + (" + spot inks" if spot_list else ""),
            "required": "CMYK or PMS",
            "note": ("Could not conclusively determine the drawing color mode — "
                     "verify the document color mode is CMYK before production."
                     + _pms_note()), **result_extra}


# Layer names in Rain's canonical physical templates (verified across all 24
# designer .ai files): four shared structural layers plus exactly one
# tier-name layer that identifies which of the 12 Visa products the template
# is for (the Debit template's tier layer is uppercased "DEBIT").
CANONICAL_COMMON_LAYERS = {
    "Background Artwork [PLACE DESIGN HERE]",
    "Card Back Info",
    "Instructions",
    "Specs & Outline [DO NOT PRINT]",
}
CANONICAL_NONPRINT_LAYERS = {"Specs & Outline [DO NOT PRINT]", "Instructions"}
CANONICAL_TIER_LAYERS = {
    "DEBIT": "Debit",
    "Business Debit": "Business Debit",
    "Corporate": "Corporate",
    "Platinum": "Platinum",
    "Platinum Business": "Platinum Business",
    "Platinum Corporate": "Platinum Corporate",
    "Signature": "Signature",
    "Signature Business": "Signature Business",
    "Signature Corporate": "Signature Corporate",
    "Infinite": "Infinite",
    "Infinite Business": "Infinite Business",
    "Infinite Corporate": "Infinite Corporate",
}


def _extract_ocg_layer_names(data: bytes) -> "list[str]":
    """OCG (PDF layer) names from a PDF-compatible .ai, both dict orderings,
    literal and hex string forms."""
    import re
    lit = rb"\(((?:[^()\\]|\\.)*)\)"
    hexs = rb"<([0-9A-Fa-f\s]+)>"
    patterns = [
        rb"/Name\s*" + lit + rb"\s*/Type\s*/OCG",
        rb"/Type\s*/OCG\s*/Name\s*" + lit,
        rb"/Name\s*" + hexs + rb"\s*/Type\s*/OCG",
        rb"/Type\s*/OCG\s*/Name\s*" + hexs,
    ]
    names = []
    for i, pat in enumerate(patterns):
        for m in re.finditer(pat, data):
            raw = m.group(1)
            if i >= 2:  # hex string
                try:
                    b = bytes.fromhex(raw.decode("ascii").replace(" ", "").replace("\n", ""))
                    name = (b[2:].decode("utf-16-be", "replace")
                            if b[:2] == b"\xfe\xff" else b.decode("latin-1", "replace"))
                except (ValueError, UnicodeDecodeError):
                    continue
            else:
                name = re.sub(rb"\\(.)", rb"\1", raw).decode("latin-1", "replace")
            if name and name not in names:
                names.append(name)
    return names


def _detect_layers(vector_path: str) -> dict:
    """
    Layer-structure check for .ai/.eps, aligned with Rain's canonical
    templates: extracts OCG layer names and validates the canonical set
    (common structural layers + a tier-name layer). Files with named layers
    that aren't template-derived fall back to the old count heuristic.

    Returns { actual, passed, borderline, note, layer_names, product_tier }.
    """
    try:
        with open(vector_path, "rb") as f:
            data = f.read()
    except Exception as e:
        return {"passed": None, "actual": 0,
                "note": f"Could not read file for layer detection: {e}"}

    names = _extract_ocg_layer_names(data)
    common_found = CANONICAL_COMMON_LAYERS & set(names)
    tiers_found = [n for n in names if n in CANONICAL_TIER_LAYERS]
    product_tier = CANONICAL_TIER_LAYERS[tiers_found[0]] if tiers_found else None

    if len(common_found) >= 3:
        # Template-derived submission — validate the canonical structure.
        notes = []
        missing = CANONICAL_COMMON_LAYERS - common_found
        nonprint_present = CANONICAL_NONPRINT_LAYERS & set(names)
        borderline = False
        if nonprint_present:
            # Illustrator's per-layer print flag isn't recoverable from the
            # saved PDF stream, so presence gets a warning, not a fail.
            borderline = True
            notes.append(
                f"Template guide layers present ({', '.join(sorted(nonprint_present))}) — "
                "confirm they are set to non-printing (or removed) before production."
            )
        if "Background Artwork [PLACE DESIGN HERE]" in missing:
            borderline = True
            notes.append(
                "The template's 'Background Artwork [PLACE DESIGN HERE]' layer is "
                "missing — confirm the design was placed per the template rather "
                "than flattened."
            )
        if product_tier:
            notes.append(f"Tier layer identifies the product as: {product_tier}.")
        else:
            borderline = True
            notes.append(
                "No canonical tier layer (e.g. 'Signature', 'DEBIT') found — the "
                "product identifier cannot be inferred from layers."
            )
        return {
            "passed": True,
            "borderline": borderline,
            "actual": f"{len(names)} layers (canonical template structure)",
            "note": " ".join(notes) or "Canonical template layer structure intact.",
            "layer_names": names,
            "product_tier": product_tier,
        }

    # Non-template files: fall back to the count heuristic.
    text = data.decode("latin-1", errors="ignore")
    count = max(text.count("%AI5_BeginLayer"), len(names))
    if count >= 2:
        return {"passed": True, "actual": count, "layer_names": names,
                "product_tier": product_tier,
                "note": (f"Detected {count} named layer(s) (not Rain's canonical "
                         "template structure). Verify each design element is on "
                         "its own layer per Visa guidelines — Rain's canonical "
                         "templates are the preferred starting point.")}
    if count == 1:
        return {"passed": None, "actual": 1, "layer_names": names,
                "product_tier": product_tier,
                "note": ("Only one named layer detected. Visa requires each "
                         "design element on its own layer — manual verification needed.")}
    return {"passed": None, "actual": 0, "layer_names": names,
            "product_tier": product_tier,
            "note": ("Could not detect named layers (heuristic only). "
                     "Manual verification required: each design element should be on its own layer.")}


def _extract_page_boxes(vector_path: str) -> "list[dict]":
    """
    Per-page PDF boxes for a PDF-compatible .ai (or PDF) file, in page order.

    Illustrator writes page dicts uncompressed, so a targeted regex pass is
    enough: resolve the catalog's page tree, walk /Kids in order, and pull
    /MediaBox /TrimBox /BleedBox /ArtBox out of each page object's dict.
    Values are [x1, y1, x2, y2] floats in points (PDF origin: bottom-left).

    Returns [] for files where the structure can't be resolved (.eps, exotic
    PDFs with compressed object streams) — callers fall back to
    rendered-pixel measurement.
    """
    import re
    try:
        with open(vector_path, "rb") as f:
            data = f.read()
    except OSError:
        return []

    box_re = re.compile(
        rb"/(MediaBox|TrimBox|BleedBox|ArtBox)\s*\[\s*"
        rb"(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]"
    )

    def _object_window(obj_num: int) -> "bytes | None":
        m = re.search(rb"(?<![\d])%d\s+0\s+obj\b" % obj_num, data)
        if not m:
            return None
        return data[m.start():m.start() + 4000]

    def _boxes_in(window: bytes) -> dict:
        found = {}
        for m in box_re.finditer(window):
            name = m.group(1).decode("ascii")
            key = {"MediaBox": "media", "TrimBox": "trim",
                   "BleedBox": "bleed", "ArtBox": "art"}[name]
            if key not in found:
                found[key] = [float(m.group(i)) for i in range(2, 6)]
        return found

    # Catalog -> root /Pages ref; fall back to any /Type/Pages object.
    root_ref = None
    cat = re.search(rb"/Type\s*/Catalog", data)
    if cat:
        window = data[max(0, cat.start() - 800):cat.start() + 800]
        m = re.search(rb"/Pages\s+(\d+)\s+0\s+R", window)
        if m:
            root_ref = int(m.group(1))

    def _collect_pages(obj_num: int, depth: int = 0) -> "list[bytes]":
        if depth > 4:
            return []
        window = _object_window(obj_num)
        if window is None:
            return []
        # Trim the window to this object to avoid reading into the next one.
        end = window.find(b"endobj")
        if end != -1:
            window = window[:end]
        if re.search(rb"/Type\s*/Pages\b", window):
            kids = re.search(rb"/Kids\s*\[([^\]]*)\]", window)
            if not kids:
                return []
            pages = []
            for ref in re.finditer(rb"(\d+)\s+0\s+R", kids.group(1)):
                pages.extend(_collect_pages(int(ref.group(1)), depth + 1))
            return pages
        if re.search(rb"/Type\s*/Page\b", window):
            return [window]
        return []

    page_windows = []
    if root_ref is not None:
        page_windows = _collect_pages(root_ref)
    if not page_windows:
        return []

    boxes = []
    for window in page_windows:
        found = _boxes_in(window)
        if "media" not in found:
            continue
        found.setdefault("trim", None)
        found.setdefault("bleed", None)
        found.setdefault("art", None)
        boxes.append(found)
    return boxes


def _detect_magstripe_band(img, side_result: dict) -> dict:
    """
    Best-effort magstripe detector for physical BACK sides.

    Rain's canonical back places the magstripe ~5.2mm below the trim top,
    ~8.3mm tall. Looks for a contiguous horizontal band in the 2-18mm zone
    whose row brightness departs from the card background. Soft verdict:
    True when found, None (verify visually) when not — never a hard fail,
    since stripe/background contrast can legitimately be too subtle for a
    brightness heuristic and the visual agent double-checks.
    """
    gray = np.array(img.convert("L"), dtype=float)
    h, w = gray.shape
    t = side_result.get("trim_offset_px") or {}
    top, bottom = int(t.get("top") or 0), int(t.get("bottom") or 0)
    left, right = int(t.get("left") or 0), int(t.get("right") or 0)
    trim = gray[top:h - bottom if bottom else h, left:w - right if right else w]
    th, tw = trim.shape
    dpi = side_result.get("render_dpi") or PHYSICAL_RENDER_DPI
    px_per_mm = dpi / 25.4

    y0 = int(round(2.0 * px_per_mm))
    y1 = min(th, int(round(18.0 * px_per_mm)))
    if y1 - y0 < 4:
        return {"passed": None, "actual": "not measurable",
                "note": "Preview too small to scan for the magstripe band."}

    lower = trim[min(th - 1, int(round(20.0 * px_per_mm))):, :]
    bg = float(np.median(lower)) if lower.size else float(np.median(trim))
    rowmean = trim[y0:y1, :].mean(axis=1)
    band_rows = np.abs(rowmean - bg) > 25

    best = cur = 0
    band_start = start = None
    for i, is_band in enumerate(band_rows):
        if is_band:
            if start is None:
                start = i
            cur += 1
            if cur > best:
                best, band_start = cur, start
        else:
            cur, start = 0, None
    band_mm = best / px_per_mm

    if band_mm >= 5.0:
        top_mm = (y0 + (band_start or 0)) / px_per_mm
        return {
            "passed": True,
            "actual": f"band ~{band_mm:.1f}mm tall starting ~{top_mm:.1f}mm below trim top",
            "required": "magstripe band near the top of the back (~5mm down, >=6mm tall)",
            "note": (f"Detected a horizontal band ~{band_mm:.1f}mm tall starting "
                     f"~{top_mm:.1f}mm below the trim top — consistent with the "
                     "canonical magstripe placement."),
        }
    return {
        "passed": None,
        "actual": "no distinct band detected",
        "required": "magstripe band near the top of the back",
        "note": ("Could not distinguish a magstripe band from the background in "
                 "the 2-18mm zone (low contrast is common and not necessarily a "
                 "problem) — verify visually."),
    }


def _check_physical_side(source_path: str, side_label: str, out_dir: str,
                         page_index: int = 0) -> dict:
    """
    Run the physical-card technical checks on one side (front or back).

    Accepts either:
      - .ai / .eps  — rasterize via Ghostscript at 455 DPI, run all checks.
                      page_index selects which rendered page is this side's
                      raster (Rain's canonical templates are one 2-page file:
                      page 1 = front, page 2 = back).
      - .png        — use directly as the preview raster; skip vector-only
                      checks (color mode heuristic, layer count).

    Returns the per-side result dict, including a rendered preview path and
    — regardless of source format — a bleed_zone check measured against
    the 56px Visa Brand Mark margin that Rain's physical templates enforce.
    """
    ext = os.path.splitext(source_path)[1].lower()
    file_format_ok = ext in PHYSICAL_ACCEPTED_EXTS
    is_vector = ext in PHYSICAL_VECTOR_EXTS
    is_raster = ext in PHYSICAL_RASTER_EXTS

    file_label = os.path.basename(source_path)
    if is_vector and page_index > 0:
        file_label = f"{file_label} (page {page_index + 1})"

    side_result = {
        "side": side_label,
        "file": file_label,
        "source_format": ext.lstrip(".") if ext else "unknown",
        "checks": {
            "file_format": {
                "passed": file_format_ok,
                "actual": ext or "unknown",
                "required": ".ai, .eps, or .png",
                "note": (
                    "" if file_format_ok else
                    f"Physical card art must be .ai, .eps, or .png; got {ext}"
                ),
            },
        },
        "rendered_preview_path": None,
        "errors": [],
    }

    if not file_format_ok:
        side_result["errors"].append(
            "Skipping raster-dependent checks because file format is not accepted"
        )
        return side_result

    # Resolve to a raster PNG for bleed/aspect/resolution measurement.
    if is_vector:
        try:
            pages = _render_vector_pages(source_path, out_dir)
            side_result["source_pages"] = len(pages)
            if page_index >= len(pages):
                side_result["errors"].append(
                    f"Requested page {page_index + 1} but the file has only "
                    f"{len(pages)} page(s)"
                )
                return side_result
            preview_path = pages[page_index]
            side_result["rendered_preview_path"] = preview_path
        except Exception as e:
            side_result["errors"].append(str(e))
            return side_result
    else:
        # Raster submission: use the input itself as the preview.
        preview_path = source_path
        side_result["rendered_preview_path"] = preview_path

    try:
        img = Image.open(preview_path)
        w, h = img.size
    except Exception as e:
        side_result["errors"].append(f"Could not open raster: {e}")
        return side_result

    # Geometry. Preferred path: the vector's own PDF boxes — Rain's canonical
    # templates carry an exact CR80 TrimBox inside an 18pt-bleed MediaBox, so
    # the rendered raster is trim + bleed and its raw aspect ratio is NOT the
    # CR80 1.586:1. Fallback (raster submissions, box-less vectors): rendered
    # pixel dimensions, orientation-aware.
    page_boxes = None
    if is_vector:
        try:
            all_boxes = _extract_page_boxes(source_path)
            if page_index < len(all_boxes):
                page_boxes = all_boxes[page_index]
        except Exception as e:
            side_result["errors"].append(f"PDF box extraction failed: {e}")

    if page_boxes and page_boxes.get("trim"):
        media = page_boxes["media"]
        trim = page_boxes["trim"]
        trim_w = trim[2] - trim[0]
        trim_h = trim[3] - trim[1]
        orientation = "horizontal" if trim_w >= trim_h else "vertical"
        short_pt, long_pt = sorted((trim_w, trim_h))
        trim_ok = (abs(long_pt - CR80_TRIM_LONG_PT) <= TRIM_TOLERANCE_PT
                   and abs(short_pt - CR80_TRIM_SHORT_PT) <= TRIM_TOLERANCE_PT)
        side_result["checks"]["trim_size"] = {
            "passed": trim_ok,
            "actual": (f"TrimBox {trim_w:.1f}x{trim_h:.1f}pt "
                       f"({trim_w/72:.3f}\"x{trim_h/72:.3f}\", {orientation})"),
            "required": (f"CR80 {CR80_TRIM_LONG_PT:.0f}x{CR80_TRIM_SHORT_PT:.0f}pt "
                         f"(3.370\"x2.125\", either orientation, "
                         f"±{TRIM_TOLERANCE_PT:.0f}pt)"),
            "note": (
                f"TrimBox matches the CR80 card size ({orientation})."
                if trim_ok else
                f"TrimBox {trim_w:.1f}x{trim_h:.1f}pt does not match the CR80 "
                f"card size {CR80_TRIM_LONG_PT:.0f}x{CR80_TRIM_SHORT_PT:.0f}pt "
                f"(±{TRIM_TOLERANCE_PT:.0f}pt, either orientation). Rain's "
                "canonical templates define the correct artboard."
            ),
        }

        margins = {
            "left": trim[0] - media[0],
            "bottom": trim[1] - media[1],
            "right": media[2] - trim[2],
            "top": media[3] - trim[3],
        }
        min_margin = min(margins.values())
        margins_str = ", ".join(
            f"{k} {v/72:.3f}\"" for k, v in margins.items()
        )
        bleed_fail = min_margin < MIN_BLEED_PT
        bleed_warn = not bleed_fail and min_margin < CANONICAL_BLEED_PT
        side_result["checks"]["bleed_margin"] = {
            "passed": not bleed_fail,
            "borderline": bleed_warn,
            "actual": f"min {min_margin/72:.3f}\" ({margins_str})",
            "required": (f">= {MIN_BLEED_PT/72:.3f}\" per side "
                         f"({CANONICAL_BLEED_PT/72:.2f}\" per Rain template)"),
            "note": (
                f"Bleed margin below the {MIN_BLEED_PT/72:.3f}\" (1/8\") minimum — "
                "artwork must extend past the trim line on every side. "
                f"Per-side: {margins_str}."
                if bleed_fail else
                f"Bleed margin {min_margin/72:.3f}\" is above the 1/8\" minimum but "
                f"below the {CANONICAL_BLEED_PT/72:.2f}\" used by Rain's canonical "
                f"templates — confirm with the card vendor. Per-side: {margins_str}."
                if bleed_warn else
                f"Bleed margins match Rain's canonical {CANONICAL_BLEED_PT/72:.2f}\" "
                f"template spec. Per-side: {margins_str}."
            ),
        }

        # True render scale + trim offsets in render pixels (PNG origin is
        # top-left; PDF boxes are bottom-left) — downstream consumers: the
        # trim-relative bleed-zone measurement and the report overlay.
        media_w_pt = media[2] - media[0]
        dpi = w * 72.0 / media_w_pt if media_w_pt else PHYSICAL_RENDER_DPI
        px = dpi / 72.0
        side_result["orientation"] = orientation
        side_result["render_dpi"] = round(dpi, 1)
        side_result["trim_offset_px"] = {
            "left": round(margins["left"] * px),
            "right": round(margins["right"] * px),
            "top": round(margins["top"] * px),
            "bottom": round(margins["bottom"] * px),
        }
    else:
        # Rendered-pixel fallback — orientation-aware: vertical cards are the
        # transpose of CR80, so compare the long:short ratio.
        actual_ratio = w / h if h else 0
        orientation = "horizontal" if w >= h else "vertical"
        long_short = max(actual_ratio, 1 / actual_ratio) if actual_ratio else 0
        ratio_diff = abs(long_short - CR80_ASPECT_RATIO) / CR80_ASPECT_RATIO
        aspect_ok = ratio_diff <= CR80_ASPECT_TOLERANCE
        side_result["orientation"] = orientation
        side_result["checks"]["cr80_aspect_ratio"] = {
            "passed": aspect_ok,
            "actual": f"{w}x{h} ({actual_ratio:.3f}:1, {orientation})",
            "required": (f"~{CR80_ASPECT_RATIO:.3f}:1 long:short "
                         f"(±{int(CR80_ASPECT_TOLERANCE*100)}%, either orientation)"),
            "note": (
                f"Aspect ratio is within {CR80_ASPECT_TOLERANCE*100:.0f}% of CR80 "
                f"({orientation})."
                if aspect_ok else
                f"Long:short ratio {long_short:.3f}:1 differs from CR80 "
                f"{CR80_ASPECT_RATIO:.3f}:1 by {ratio_diff*100:.1f}% "
                f"(>{CR80_ASPECT_TOLERANCE*100:.0f}% tolerance). If the file "
                "includes bleed, submit with a proper TrimBox (.ai/.eps saved "
                "PDF-compatible) so trim and bleed can be measured separately."
            ),
        }

    # Minimum rendered / supplied resolution.
    min_ok = w >= PHYSICAL_MIN_RENDERED_WIDTH_PX
    if is_vector:
        actual_label = f"{w}px wide @ {PHYSICAL_RENDER_DPI} DPI render"
        note_pass = "Rendered resolution is sufficient for print verification."
        note_fail = (
            f"Rendered width {w}px is below the {PHYSICAL_MIN_RENDERED_WIDTH_PX}px minimum. "
            "Source vector may be too small — check original artboard dimensions."
        )
    else:
        actual_label = f"{w}px wide (supplied PNG)"
        note_pass = "Supplied PNG resolution is sufficient for bleed-zone verification."
        note_fail = (
            f"Supplied PNG is {w}px wide, below the {PHYSICAL_MIN_RENDERED_WIDTH_PX}px minimum. "
            "Rain's physical card templates are 1536×969 — request a larger submission."
        )
    side_result["checks"]["min_resolution"] = {
        "passed": min_ok,
        "actual": actual_label,
        "required": f">= {PHYSICAL_MIN_RENDERED_WIDTH_PX}px wide",
        "note": note_pass if min_ok else note_fail,
    }

    # Color mode / layers — only meaningful for the vector source. PNG
    # submissions lose this information during rasterization, so we emit
    # N/V rows (passed=None) rather than false positives.
    if is_vector:
        side_result["checks"]["color_mode"] = _detect_color_mode(source_path)
        side_result["checks"]["layers_present"] = _detect_layers(source_path)
    else:
        side_result["checks"]["color_mode"] = {
            "passed": None,
            "actual": "RGB (PNG)",
            "required": "CMYK or PMS in print-ready source",
            "note": (
                "PNG submissions are RGB. Verify that the print-ready .ai/.eps "
                "source uses CMYK or PMS colors before production."
            ),
        }
        side_result["checks"]["layers_present"] = {
            "passed": None,
            "actual": "N/V (PNG — layer info lost in rasterization)",
            "note": (
                "Layer separation cannot be verified from a PNG. Confirm "
                "against the print-ready .ai/.eps source."
            ),
        }

    # Quiet zone — the #1 Visa rejection reason. Front only: the check finds
    # the Visa Brand Mark, which lives on the front; on the canonical back it
    # would latch onto the magstripe band and report a false failure. When
    # the vector carried a TrimBox, measure from the TRIM edge (bleed would
    # otherwise inflate the margins) and scale the pixel threshold to this
    # raster's true DPI. Raster/box-less submissions keep the legacy
    # full-image behavior.
    if side_label == "front":
        try:
            trim_offsets = side_result.get("trim_offset_px")
            margin = None
            if trim_offsets:
                dpi = side_result.get("render_dpi") or PHYSICAL_RENDER_DPI
                margin = max(1, round(
                    PHYSICAL_MARK_EDGE_MARGIN * dpi / PHYSICAL_RENDER_DPI))
            side_result["checks"]["bleed_zone"] = check_bleed_zone(
                img, trim_offsets=trim_offsets, margin_px=margin)
        except Exception as e:
            side_result["errors"].append(f"Bleed zone analysis failed: {e}")
    else:
        # Canonical backs carry a magstripe near the trim top — soft detector
        # (pass or verify-visually, never fail).
        try:
            side_result["checks"]["magstripe_band"] = _detect_magstripe_band(
                img, side_result)
        except Exception as e:
            side_result["errors"].append(f"Magstripe detection failed: {e}")

    # Zoom crops for the visual turn — trim-relative and orientation-aware.
    # Front: brand-mark corner, issuer corner, lower-left zone. Back:
    # magstripe band, issuer-text zone. Written next to the rendered preview
    # so the in-session agent reads them directly; paths ride along in the
    # result JSON as `zoom_crops`. Best effort — a crop failure must not
    # sink the checks.
    try:
        crops = generate_zoom_crops(
            img,
            side_result["checks"].get("bleed_zone"),
            side=side_label,
            trim_offsets=side_result.get("trim_offset_px"),
        )
        crop_paths = {}
        for name, png in crops.items():
            crop_path = os.path.join(out_dir, f"{side_label}_crop_{name}.png")
            with open(crop_path, "wb") as f:
                f.write(png)
            crop_paths[name] = crop_path
        side_result["zoom_crops"] = crop_paths
    except Exception as e:
        side_result["errors"].append(f"Crop generation failed: {e}")

    return side_result


def check_physical(front_path: str, back_path: "str | None" = None,
                   out_dir: "str | None" = None) -> dict:
    """
    Run technical checks on a physical card submission.
    Front is required; back is optional. A multi-page vector front (Rain's
    canonical templates are one 2-page .ai: page 1 = front, page 2 = back)
    supplies the back automatically when no separate back file is given.
    """
    render_dir = out_dir or os.path.dirname(os.path.abspath(front_path))
    os.makedirs(render_dir, exist_ok=True)

    front = _check_physical_side(front_path, "front", render_dir)
    result = {
        "card_type": "physical",
        "front": front,
        "back": None,
        "errors": [],
    }
    front_pages = front.get("source_pages") or 1
    if back_path:
        result["back"] = _check_physical_side(back_path, "back", render_dir)
        if front_pages >= 2:
            result["errors"].append(
                f"Front file has {front_pages} pages AND a separate back file was "
                "submitted — the separate back file was used; the front file's "
                "extra pages were ignored."
            )
    elif front_pages >= 2:
        # Page renders are cached, so this re-entry costs no second gs run.
        result["back"] = _check_physical_side(front_path, "back", render_dir,
                                              page_index=1)
    if front_pages >= 3:
        result["errors"].append(
            f"Front file has {front_pages} pages — expected 2 (front, back). "
            "Only pages 1-2 were checked."
        )
    return result


# ─────────────────────────────────────────────────────────────────
# Virtual card checks (PNG, 1536x969)
# ─────────────────────────────────────────────────────────────────

def check_image(image_path: str) -> dict:
    results = {
        "card_type": "virtual",
        "file": os.path.basename(image_path),
        "checks": {},
        "colors": {},
        "output_image": None,  # deprecated — no review PNG generated
        "errors": []
    }

    try:
        img = Image.open(image_path)
    except Exception as e:
        results["errors"].append(f"Could not open image: {e}")
        return results

    # --- Dimensions ---
    w, h = img.size
    results["checks"]["dimensions"] = {
        "passed": w == REQUIRED_WIDTH and h == REQUIRED_HEIGHT,
        "actual": f"{w}x{h}",
        "required": f"{REQUIRED_WIDTH}x{REQUIRED_HEIGHT}",
        "note": "" if (w == REQUIRED_WIDTH and h == REQUIRED_HEIGHT) else f"Image is {w}x{h}, expected {REQUIRED_WIDTH}x{REQUIRED_HEIGHT}"
    }

    # --- File Format ---
    fmt = img.format or os.path.splitext(image_path)[1].lstrip(".").upper()
    results["checks"]["file_format"] = {
        "passed": fmt == REQUIRED_FORMAT,
        "actual": fmt,
        "required": REQUIRED_FORMAT,
        "note": "" if fmt == REQUIRED_FORMAT else f"File format is {fmt}, expected {REQUIRED_FORMAT}"
    }

    # --- DPI (calculated from image resolution, not metadata) ---
    calculated_dpi = round(w / CARD_WIDTH_INCHES, 1)
    dpi_ok = calculated_dpi >= MIN_DPI_DIGITAL
    results["checks"]["dpi"] = {
        "passed": dpi_ok,
        "actual": f"{calculated_dpi} DPI (calculated)",
        "required": f">= {MIN_DPI_DIGITAL} DPI for digital display (Visa spec)",
        "note": (
            f"Calculated from image width: {w}px / {CARD_WIDTH_INCHES}\" = {calculated_dpi} DPI. "
            + ("Meets Visa digital display requirement." if dpi_ok
               else f"Below Visa minimum of {MIN_DPI_DIGITAL} DPI. A wider source image is needed.")
        )
    }

    # --- Visa Brand Mark lockup: placed at 56px (bleed_zone), mark size,
    # identifier alignment, mark color — one locator pass ---
    try:
        results["checks"].update(check_virtual_mark(img))
    except Exception as e:
        results["errors"].append(f"Brand Mark analysis failed: {e}")

    # --- Canvas edges: square corners, no border frame ---
    for key, fn in (("square_corners", check_square_corners), ("border_frame", check_border_frame)):
        try:
            results["checks"][key] = fn(img)
        except Exception as e:
            results["errors"].append(f"{key} check failed: {e}")

    # --- Color Extraction ---
    try:
        colors = extract_colors(img)
        results["colors"] = colors
    except Exception as e:
        results["errors"].append(f"Color extraction failed: {e}")
        colors = None

    # Review PNG generation removed — the results PDF is the sole visual output.

    return results


def main():
    parser = argparse.ArgumentParser(description="Check virtual or physical card art technical specs")
    parser.add_argument("image_path", help="Path to the card art image (virtual: PNG; physical: .ai, .eps, or .png front)")
    parser.add_argument("--card-type", choices=["virtual", "physical"], default="virtual",
                        help="Card type (default: virtual)")
    parser.add_argument("--back", default=None,
                        help="Physical only — optional path to back-of-card .ai, .eps, or .png file")
    parser.add_argument("--output-dir", help="Directory to save the output review image / rendered previews", default=None)
    parser.add_argument("--visual-results", help="JSON string with visual inspection results", default=None)
    parser.add_argument("--visual-results-file", help="Path to JSON file with visual inspection results", default=None)
    args = parser.parse_args()

    # If visual results provided, the full results image is generated too.
    visual_data = None
    if args.visual_results:
        visual_data = json.loads(args.visual_results)
    elif args.visual_results_file:
        with open(args.visual_results_file, "r") as f:
            visual_data = json.load(f)

    # Physical path.
    if args.card_type == "physical":
        result = check_physical(args.image_path, back_path=args.back, out_dir=args.output_dir)
        if visual_data:
            try:
                out_dir = args.output_dir or os.path.dirname(os.path.abspath(args.image_path))
                os.makedirs(out_dir, exist_ok=True)
                base_name = os.path.splitext(os.path.basename(args.image_path))[0]
                results_path = os.path.join(out_dir, f"{base_name}_card_art_checker_results.pdf")
                generate_physical_results_image(
                    result,
                    visual_data.get("visual_checks", []),
                    visual_data.get("overall_status", "REQUIRES CHANGES"),
                    visual_data.get("overall_description", ""),
                    results_path)
                result["results_image"] = results_path
                print(f"Results image saved to: {results_path}", file=sys.stderr)
            except Exception as e:
                result["errors"].append(f"Results image generation failed: {e}")
        print(json.dumps(result, indent=2))
        return

    # Virtual path — existing behavior unchanged below.
    result = check_image(args.image_path)

    if visual_data:
        try:
            img = Image.open(args.image_path)
            colors = result.get("colors", {})
            if not colors:
                colors = extract_colors(img)

            tech_checks = result.get("checks", {})
            visual_checks = visual_data.get("visual_checks", [])
            overall_status = visual_data.get("overall_status", "REQUIRES CHANGES")
            overall_description = visual_data.get("overall_description", "")

            if args.output_dir:
                os.makedirs(args.output_dir, exist_ok=True)
                out_dir = args.output_dir
            else:
                out_dir = os.path.dirname(os.path.abspath(args.image_path))

            base_name = os.path.splitext(os.path.basename(args.image_path))[0]
            results_path = os.path.join(out_dir, f"{base_name}_card_art_checker_results.pdf")
            generate_results_image(img, colors, tech_checks, visual_checks,
                                   overall_status, overall_description, results_path)
            result["results_image"] = results_path
            print(f"Results image saved to: {results_path}", file=sys.stderr)
        except Exception as e:
            result["errors"].append(f"Results image generation failed: {e}")

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

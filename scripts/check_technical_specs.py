#!/usr/bin/env python3
"""
Technical spec checker for Visa virtual/digital card art.
Checks dimensions, format, and DPI (calculated from image resolution).
Extracts dominant colors and suggests background, foreground, and label RGB values.
Generates an output image showing the 56px bleed border, suggested RGB values,
and a sample last-4 PAN overlay.

Can also generate a full results image with numbered markers on the card,
overall status, tech spec table, and visual design compliance table.

DPI is calculated as: pixel_width / CARD_WIDTH_INCHES
where CARD_WIDTH_INCHES = 3.375 (ISO ID-1 standard credit card width).
For Visa digital card display, a minimum of 72 DPI is required.
At the standard 1536px width, calculated DPI is ~455, well above the minimum.

Usage:
    python3 check_technical_specs.py <image_path> [--output-dir /path/to/dir]
    python3 check_technical_specs.py <image_path> --visual-results '<json>' [--output-dir /path]
    python3 check_technical_specs.py <image_path> --visual-results-file results.json [--output-dir /path]

Outputs JSON with technical check results and extracted colors.
Also saves an output image to the same directory as the input (or --output-dir).
"""

import sys
import json
import os
import argparse
import textwrap

try:
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow", "numpy", "-q"])
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np


REQUIRED_WIDTH = 1536
REQUIRED_HEIGHT = 969
REQUIRED_FORMAT = "PNG"
CARD_WIDTH_INCHES = 3.375   # ISO ID-1 standard credit card width
MIN_DPI_DIGITAL = 72        # Visa minimum DPI for digital card display
VISA_MARK_EDGE_MARGIN = 56  # pixels — applies ONLY to the Visa Brand Mark

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
}

STATUS_LABELS = {
    "pass": "PASS",
    "fail": "FAIL",
    "warning": "WARN",
    "estimated": "EST.",
    "unverified": "N/V",
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


def check_bleed_zone(img):
    """
    Measure the pixel distance from the Visa Brand Mark to card edges.

    The Visa Brand Mark must be at least 56px from the nearest card edges.
    This is the #1 reason for Visa card art rejection.

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
    FAIL if distance < 56px, WARN if 56-58px (borderline).
    """
    gray = np.array(img.convert("L"), dtype=float)
    h, w = gray.shape
    m = VISA_MARK_EDGE_MARGIN  # 56px
    BORDERLINE_MAX = 56  # only warn at exactly 56px (Visa approves 57+px routinely)
    MIN_MARK_PIXELS_PER_LINE = 8  # min mark pixels in a row/col to count as content

    # Determine background from the card interior (exclude outer 100px to avoid logos)
    interior = gray[100:h - 100, 100:w - 100]
    bg_median = float(np.median(interior))
    is_dark_bg = bg_median < 128

    # === PASS 1: Locate the Visa Brand Mark in a safe interior zone ===
    # Search both upper-right and lower-right corners (mark can be in either)
    candidates = []
    for corner in ["upper-right", "lower-right"]:
        if corner == "upper-right":
            sy1, sy2 = 40, min(250, h // 2)
        else:
            sy1, sy2 = max(h // 2, h - 250), h - 40
        sx1, sx2 = max(w // 2, w - 400), w - 40
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
    search_y1 = max(0, cy - 120)
    search_y2 = min(h, cy + 120)
    search_x1 = max(0, cx - 200)
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

    # === Pass / borderline / fail determination ===
    near_fail = near_distance < m
    right_fail = right_distance < m
    near_borderline = m <= near_distance <= BORDERLINE_MAX
    right_borderline = m <= right_distance <= BORDERLINE_MAX

    passed = not (near_fail or right_fail)
    borderline = near_borderline or right_borderline

    # Build result note
    near_label = near_edge_label.capitalize()
    detail_parts = []
    if near_fail:
        detail_parts.append(
            f"{near_label} edge: {near_distance}px (FAIL — must be >= {m}px)"
        )
    elif near_borderline:
        detail_parts.append(
            f"{near_label} edge: {near_distance}px (BORDERLINE — only "
            f"{near_distance - m + 1}px above the {m}px minimum; "
            f"Visa may reject borderline placements)"
        )

    if right_fail:
        detail_parts.append(
            f"Right edge: {right_distance}px (FAIL — must be >= {m}px)"
        )
    elif right_borderline:
        detail_parts.append(
            f"Right edge: {right_distance}px (BORDERLINE — only "
            f"{right_distance - m + 1}px above the {m}px minimum; "
            f"Visa may reject borderline placements)"
        )

    if not passed:
        note = (
            f"FAIL — Visa Brand Mark is too close to the card edge. "
            f"{near_label}: {near_distance}px, Right: {right_distance}px "
            f"(minimum: {m}px). "
            f"This is the #1 reason for Visa card art rejection. "
            + " | ".join(detail_parts)
        )
    elif borderline:
        note = (
            f"BORDERLINE — Visa Brand Mark margin is at exactly the {m}px minimum. "
            f"{near_label}: {near_distance}px, Right: {right_distance}px. "
            f"Visa may reject placements with zero safety buffer — recommend "
            f"increasing margin to at least {m + 2}px. "
            + " | ".join(detail_parts)
        )
    else:
        note = (
            f"Visa Brand Mark margins are within spec. "
            f"{near_label}: {near_distance}px, Right: {right_distance}px "
            f"(minimum: {m}px)."
        )

    return {
        "passed": passed,
        "borderline": borderline,
        "actual": (
            f"{near_label}: {near_distance}px, Right: {right_distance}px"
            if passed else "Content within margin zone"
        ),
        "note": note,
        "mark_detected": True,
        "mark_corner": corner,
        "top_distance": top_distance,
        "right_distance": right_distance,
        "min_distance": min(near_distance, right_distance),
        "background_median": round(bg_median, 1),
        "mark_threshold": round(mark_thr, 1),
    }


def _load_font(size, bold=False):
    """Try to load a system font at the given size. Returns ImageFont."""
    bold_fonts = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica Bold.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    regular_fonts = [
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
    check_order = ["dimensions", "file_format", "dpi", "bleed_zone"]
    check_labels = {
        "dimensions": "Dimensions (1536x969 px)",
        "file_format": "File Format (PNG)",
        "dpi": "DPI (>= 72 for digital)",
        "bleed_zone": "56px Margin Zone (Visa Brand Mark)",
    }
    for key in check_order:
        if key not in tech_checks:
            continue
        ck = tech_checks[key]
        passed = ck.get("passed", False)
        if ck.get("borderline"):
            status = "warning"
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

    # Save as PDF or PNG
    if output_path.lower().endswith(".pdf"):
        canvas.save(output_path, "PDF", resolution=150)
    else:
        canvas.save(output_path, "PNG")
    return output_path


def check_image(image_path: str) -> dict:
    results = {
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

    # --- Bleed Zone Analysis (56px Visa Brand Mark margin) ---
    try:
        bleed_result = check_bleed_zone(img)
        results["checks"]["bleed_zone"] = bleed_result
    except Exception as e:
        results["errors"].append(f"Bleed zone analysis failed: {e}")

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
    parser = argparse.ArgumentParser(description="Check virtual card art technical specs")
    parser.add_argument("image_path", help="Path to the card art image")
    parser.add_argument("--output-dir", help="Directory to save the output review image", default=None)
    parser.add_argument("--visual-results", help="JSON string with visual inspection results", default=None)
    parser.add_argument("--visual-results-file", help="Path to JSON file with visual inspection results", default=None)
    args = parser.parse_args()

    # Always run tech checks first
    result = check_image(args.image_path)

    # If visual results provided, generate the full results image
    visual_data = None
    if args.visual_results:
        visual_data = json.loads(args.visual_results)
    elif args.visual_results_file:
        with open(args.visual_results_file, "r") as f:
            visual_data = json.load(f)

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

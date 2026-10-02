"""
Deterministic virtual checks in scripts/check_technical_specs.py, exercised on
synthetic cards (the eval set's partner art stays out of this public repo).

Run: npm run test:py   (or: python3 -m unittest discover -s tests -p 'test_*.py')

Each synthetic card draws a "VISA" wordmark in the bundled DejaVu Sans Bold at
the Visa lockup geometry, so a case only has to change the one thing under test.
"""
import io
import os
import sys
import unittest

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import check_technical_specs as specs  # noqa: E402
import numpy as np  # noqa: E402

BOLD = os.path.join(ROOT, "scripts", "fonts", "DejaVuSans-Bold.ttf")
REGULAR = os.path.join(ROOT, "scripts", "fonts", "DejaVuSans.ttf")
W, H = 1536, 969


def _fit(draw, text, path, cap_height):
    """Font whose rendered `text` is `cap_height` px tall."""
    size = int(cap_height * 1.37)
    for _ in range(3):
        font = ImageFont.truetype(path, size)
        box = draw.textbbox((0, 0), text, font=font)
        size = max(4, int(size * cap_height / (box[3] - box[1])))
    font = ImageFont.truetype(path, size)
    return font, draw.textbbox((0, 0), text, font=font)


def card(bg=(20, 24, 40), ink=(255, 255, 255), top=56, right=56, mark_h=109,
         identifier=True, ident_offset=0, scale=1, background=None, mark_fill=None):
    """A virtual card with a VISA wordmark in the upper-right corner."""
    w, h = W * scale, H * scale
    im = background(w, h) if background else Image.new("RGB", (w, h), bg)
    draw = ImageDraw.Draw(im)
    font, box = _fit(draw, "VISA", BOLD, mark_h * scale)
    x, y = w - right * scale - box[2], top * scale - box[1]
    if mark_fill is None:
        draw.text((x, y), "VISA", font=font, fill=ink)
    else:  # e.g. a gradient: paint through the glyph mask
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).text((x, y), "VISA", font=font, fill=255)
        im.paste(mark_fill(w, h), (0, 0), mask)
    if identifier:
        ifont, ibox = _fit(draw, "Platinum", REGULAR, 40 * scale)
        # Visa's lockup: 170px from the mark top to the identifier baseline
        # at the 109px mark, scaling with the mark.
        baseline = (top + round(170 * mark_h / 109)) * scale
        draw.text((w - right * scale - ibox[2] - ident_offset * scale, baseline - ibox[3]),
                  "Platinum", font=ifont, fill=ink)
    return im


def lower_right_card(bottom=56, right=56, mark_h=109):
    """The VISA wordmark alone in the lower-right corner, 56px from both edges."""
    im = Image.new("RGB", (W, H), (20, 24, 40))
    draw = ImageDraw.Draw(im)
    font, box = _fit(draw, "VISA", BOLD, mark_h)
    draw.text((W - right - box[2], H - bottom - box[3]), "VISA", font=font, fill=(255, 255, 255))
    return im


def chevrons(w, h):
    """Dark card with mid-contrast diagonal line art running under the corner."""
    im = Image.new("RGB", (w, h), (16, 25, 36))
    draw = ImageDraw.Draw(im)
    for i in range(-h, w, 34):
        draw.line([(i, 0), (i + h, h)], fill=(70, 78, 92), width=2)
    return im


def gold_gradient(w, h):
    im = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(im)
    for x in range(w):
        t = x / w
        draw.line([(x, 0), (x, h)], fill=(int(120 + 110 * t), int(95 + 100 * t), int(40 + 50 * t)))
    return im


def silver_gradient(w, h):
    im = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(im)
    for y in range(h):
        v = int(120 + 135 * ((y % 120) / 120))
        draw.line([(0, y), (w, y)], fill=(v, v, v))
    return im


def ramp_to_light(light):
    """Navy under the V rising to `light` under the A, as on REJ-010."""
    def make(w, h):
        x = np.clip((np.arange(w) - 1150 * w / W) / (330 * w / W), 0, 1)[None, :, None]
        art = np.array((5, 20, 45)) * (1 - x) + np.array(light) * x
        return Image.fromarray(np.broadcast_to(art, (h, w, 3)).astype(np.uint8).copy())
    return make


class VisaMarkPlacement(unittest.TestCase):
    """Visa places the mark AT 56px (±3), on both nearest edges."""

    def test_mark_at_56px_passes(self):
        zone = specs.check_virtual_mark(card())["bleed_zone"]
        self.assertTrue(zone["passed"], zone["note"])
        self.assertEqual(zone["mark_corner"], "upper-right")
        self.assertTrue(53 <= zone["strict_top_px"] <= 59)
        self.assertTrue(53 <= zone["strict_right_px"] <= 59)

    def test_mark_too_far_fails(self):
        for kw in ({"top": 70}, {"right": 90}):
            zone = specs.check_virtual_mark(card(**kw))["bleed_zone"]
            self.assertIs(zone["passed"], False, kw)
            self.assertEqual(zone["reason_code"], "margin_above_target", kw)

    def test_mark_too_close_fails(self):
        zone = specs.check_virtual_mark(card(top=50))["bleed_zone"]
        self.assertIs(zone["passed"], False)
        self.assertEqual(zone["reason_code"], "margin_below_minimum")

    def test_band_edges(self):
        for top, passed in ((53, True), (59, True), (52, False), (61, False)):
            zone = specs.check_virtual_mark(card(top=top))["bleed_zone"]
            self.assertIs(zone["passed"], passed, (top, zone["actual"]))
            self.assertFalse(zone.get("borderline"))

    def test_light_mark_on_light_card_is_located(self):
        # Gray-on-white marks were invisible to the fixed-polarity detector.
        zone = specs.check_virtual_mark(card(bg=(246, 246, 246), ink=(187, 187, 187)))["bleed_zone"]
        self.assertTrue(zone["mark_detected"])
        self.assertTrue(zone["passed"], zone["note"])

    def test_white_mark_on_gold_gradient_is_located(self):
        zone = specs.check_virtual_mark(card(background=gold_gradient))["bleed_zone"]
        self.assertTrue(zone["mark_detected"])
        self.assertTrue(zone["passed"], zone["note"])

    def test_line_pattern_near_the_corner_is_ignored(self):
        # The old detector latched onto line art and reported ~213/153px.
        zone = specs.check_virtual_mark(card(ink=(190, 190, 190), background=chevrons))["bleed_zone"]
        self.assertTrue(zone["passed"], zone["note"])

    def test_mark_over_the_light_end_of_a_gradient_is_located(self):
        # The "A" falls under half the V's contrast; the second, lower pass
        # still finds all four letters.
        zone = specs.check_virtual_mark(card(background=ramp_to_light((130, 190, 200))))["bleed_zone"]
        self.assertTrue(zone["passed"], zone["note"])
        self.assertTrue(53 <= zone["strict_right_px"] <= 59)

    def test_partial_wordmark_is_never_measured(self):
        # "VIS" without its "A" once read as the mark, 185px from the edge.
        for light in ((120, 200, 215), (200, 240, 245)):
            zone = specs.check_virtual_mark(card(background=ramp_to_light(light)))["bleed_zone"]
            self.assertIsNot(zone["passed"], False, (light, zone["actual"]))

    def test_oversized_canvas_is_measured_at_scale(self):
        zone = specs.check_virtual_mark(card(scale=2))["bleed_zone"]
        self.assertEqual(zone["margin_px"], 112)
        self.assertTrue(zone["passed"], zone["note"])

    def test_missing_mark_is_unverified_not_passed(self):
        checks = specs.check_virtual_mark(Image.new("RGB", (W, H), (30, 30, 30)))
        for key in ("bleed_zone", "mark_size", "identifier_alignment", "mark_color"):
            self.assertIsNone(checks[key]["passed"], key)
            self.assertFalse(checks[key]["mark_detected"], key)


class VisaMarkPosition(unittest.TestCase):
    """Visa places the mark in an upper corner only."""

    def test_upper_right_mark_passes(self):
        position = specs.check_virtual_mark(card())["mark_position"]
        self.assertTrue(position["passed"], position["note"])
        self.assertEqual(position["mark_corner"], "upper-right")

    def test_lower_right_mark_fails_even_at_56px(self):
        checks = specs.check_virtual_mark(lower_right_card())
        self.assertEqual(checks["mark_position"]["mark_corner"], "lower-right")
        self.assertIs(checks["mark_position"]["passed"], False)
        self.assertEqual(checks["mark_position"]["reason_code"], "position_lower_edge")
        # The margin itself is right; only the corner is wrong.
        self.assertTrue(checks["bleed_zone"]["passed"], checks["bleed_zone"]["note"])

    def test_undetected_mark_is_unverified(self):
        position = specs.check_virtual_mark(Image.new("RGB", (W, H), (20, 24, 40)))["mark_position"]
        self.assertIsNone(position["passed"])


class VisaMarkLockup(unittest.TestCase):
    def test_109px_mark_passes(self):
        size = specs.check_virtual_mark(card())["mark_size"]
        self.assertTrue(size["passed"], size["note"])
        self.assertTrue(160 <= size["lockup_height_px"] <= 180)

    def test_undersized_mark_fails(self):
        size = specs.check_virtual_mark(card(mark_h=71))["mark_size"]
        self.assertIs(size["passed"], False)
        self.assertEqual(size["reason_code"], "size_undersized")

    def test_retired_142px_mark_fails(self):
        size = specs.check_virtual_mark(card(mark_h=142))["mark_size"]
        self.assertIs(size["passed"], False)
        self.assertEqual(size["reason_code"], "size_oversized")
        self.assertIn("Option Two", size["note"])

    def test_aligned_identifier_passes(self):
        align = specs.check_virtual_mark(card())["identifier_alignment"]
        self.assertTrue(align["passed"], align["note"])
        self.assertEqual(align["aligned_to"], "right")

    def test_misaligned_identifier_fails(self):
        align = specs.check_virtual_mark(card(ident_offset=40))["identifier_alignment"]
        self.assertIs(align["passed"], False)
        self.assertEqual(align["reason_code"], "identifier_misaligned")

    def test_missing_identifier_is_unverified(self):
        align = specs.check_virtual_mark(card(identifier=False))["identifier_alignment"]
        self.assertIsNone(align["passed"])


class VisaMarkColor(unittest.TestCase):
    def test_permitted_flat_colors_pass(self):
        for bg, ink, name in (
            ((20, 24, 40), (255, 255, 255), "white"),
            ((240, 240, 240), (0, 0, 0), "black"),
            ((250, 250, 250), specs.VISA_BLUE_RGB, "Visa Blue"),
            ((250, 250, 250), (5, 9, 46), "black"),       # near-black navy
            ((246, 246, 246), (187, 187, 187), "silver/gray"),
        ):
            color = specs.check_virtual_mark(card(bg=bg, ink=ink))["mark_color"]
            self.assertTrue(color["passed"], color["note"])
            self.assertEqual(color["color_class"], name)

    def test_off_palette_color_fails(self):
        color = specs.check_virtual_mark(card(ink=(230, 40, 140)))["mark_color"]
        self.assertIs(color["passed"], False)
        self.assertEqual(color["reason_code"], "mark_color_not_permitted")

    def test_gradient_mark_fails(self):
        color = specs.check_virtual_mark(card(mark_fill=silver_gradient))["mark_color"]
        self.assertIs(color["passed"], False)
        self.assertEqual(color["reason_code"], "mark_gradient_applied")


def rounded(im, radius, matte=None):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width - 1, im.height - 1], radius=radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    if matte is None:
        return out
    flat = Image.new("RGBA", im.size, matte + (255,))
    flat.alpha_composite(out)
    return flat.convert("RGB")


class CanvasEdges(unittest.TestCase):
    def test_square_corners_pass(self):
        self.assertTrue(specs.check_square_corners(card())["passed"])
        self.assertTrue(specs.check_square_corners(Image.new("RGB", (W, H), (200, 30, 90)))["passed"])

    def test_rounded_corners_fail(self):
        for radius in (12, 57, 90):
            for matte in (None, (255, 255, 255)):
                result = specs.check_square_corners(rounded(card(), radius, matte))
                self.assertIs(result["passed"], False, (radius, matte))
                self.assertEqual(len(result["rounded_corners"]), 4, (radius, matte))

    def test_border_lines_fail(self):
        for width in (2, 4, 12):
            im = card()
            ImageDraw.Draw(im).rectangle([0, 0, W - 1, H - 1], outline=(255, 255, 255), width=width)
            result = specs.check_border_frame(im)
            self.assertIs(result["passed"], False, width)
            self.assertEqual(result["frame_px"], width)

    def test_hairline_frame_on_all_four_sides_fails(self):
        # Visa rejected REJ-053's 1px gray frame as white border lines.
        im = card()
        ImageDraw.Draw(im).rectangle([0, 0, W - 1, H - 1], outline=(128, 128, 128), width=1)
        result = specs.check_border_frame(im)
        self.assertIs(result["passed"], False)
        self.assertEqual(sorted(result["border_sides"]), ["bottom", "left", "right", "top"])
        self.assertEqual(result["frame_px"], 1)

    def test_hairline_on_fewer_sides_is_ignored(self):
        # 1px edges on some sides come from resampling.
        im = card()
        draw = ImageDraw.Draw(im)
        draw.line([(0, 0), (W - 1, 0)], fill=(150, 150, 150))            # top
        draw.line([(0, H - 1), (W - 1, H - 1)], fill=(150, 150, 150))    # bottom
        draw.line([(0, 0), (0, H - 1)], fill=(150, 150, 150))            # left
        self.assertTrue(specs.check_border_frame(im)["passed"])

    def test_transparent_padding_fails(self):
        # Art placed on a wider transparent canvas, even on one side only.
        im = card().convert("RGBA")
        pad = Image.new("RGBA", (40, H), (0, 0, 0, 0))
        im.paste(pad, (0, 0))
        result = specs.check_border_frame(im)
        self.assertIs(result["passed"], False)
        self.assertEqual(result["border_sides"], ["left"])

    def test_full_bleed_art_has_no_frame(self):
        self.assertTrue(specs.check_border_frame(card())["passed"])
        self.assertTrue(specs.check_border_frame(card(background=chevrons))["passed"])
        self.assertTrue(specs.check_border_frame(Image.new("RGB", (W, H), (255, 255, 255)))["passed"])

    def test_lines_on_two_sides_fail_one_side_does_not(self):
        im = card()
        draw = ImageDraw.Draw(im)
        draw.rectangle([0, 0, 2, H - 1], fill=(255, 255, 255))            # left, 3px
        self.assertTrue(specs.check_border_frame(im)["passed"], "a single edge line is design")
        draw.rectangle([0, H - 3, W - 1, H - 1], fill=(255, 255, 255))    # bottom, 3px
        result = specs.check_border_frame(im)
        self.assertIs(result["passed"], False)
        self.assertEqual(sorted(result["border_sides"]), ["bottom", "left"])


def official_card(tier="platinum", bg=(24, 30, 52), ident_scale=1.0, logo=None):
    """
    A card carrying Visa's official lockup (assets/lockups), in the upper
    right at the official geometry. ident_scale resizes only the identifier;
    logo=(text, left, top) draws a partner wordmark.
    """
    ref = Image.open(os.path.join(specs.LOCKUP_DIR, f"{tier}.png")).convert("L")
    ink = ref.point(lambda v: 255 if v > 200 else 0)
    im = Image.new("RGB", (W, H), bg)
    mark = ink.crop((1100, 40, 1536, 176))
    im.paste((255, 255, 255), (1100, 40), mark)
    ident = ink.crop((1200, 178, 1536, 250))
    if ident_scale != 1.0:
        ident = ident.resize((round(ident.width * ident_scale), round(ident.height * ident_scale)))
        ident = ident.crop((0, 0, min(ident.width, W - 1200), ident.height))
    # Right-align the identifier with the mark, as the lockup does.
    x = 1200 + (336 - ident.width)
    im.paste((255, 255, 255), (x, 178), ident)
    if logo:
        text, left, top = logo
        font, box = _fit(ImageDraw.Draw(im), text, BOLD, 60)
        ImageDraw.Draw(im).text((left - box[0], top - box[1]), text, font=font, fill=(255, 255, 255))
    return im


class OfficialLockup(unittest.TestCase):
    def test_every_official_tier_is_identified(self):
        for tier in specs.LOCKUP_TIERS:
            match = specs.check_virtual_mark(official_card(tier))["lockup_match"]
            self.assertTrue(match["passed"], (tier, match["note"]))
            self.assertEqual(match["identifier_tier"], tier)
            self.assertGreaterEqual(match["wordmark_iou"], 0.9)

    def test_declared_product_mismatch_fails(self):
        match = specs.check_virtual_mark(official_card("platinum"), "Signature")["lockup_match"]
        self.assertIs(match["passed"], False)
        self.assertEqual(match["reason_code"], "identifier_tier_mismatch")
        ok = specs.check_virtual_mark(official_card("platinum"), "Platinum")["lockup_match"]
        self.assertTrue(ok["passed"], ok["note"])

    def test_oversized_identifier_fails(self):
        match = specs.check_virtual_mark(official_card("platinum", ident_scale=1.35))["lockup_match"]
        self.assertIs(match["passed"], False)
        self.assertEqual(match["reason_code"], "identifier_size_mismatch")

    def test_redrawn_wordmark_fails(self):
        # The DejaVu "VISA" of card() is not Visa's artwork.
        match = specs.check_virtual_mark(card())["lockup_match"]
        self.assertIs(match["passed"], False)
        self.assertEqual(match["reason_code"], "lockup_not_official_artwork")

    def test_reference_crop_matches_the_tier(self):
        single = Image.open(io.BytesIO(specs.reference_lockup_crop({"identifier_tier": "infinite"})))
        sheet = Image.open(io.BytesIO(specs.reference_lockup_crop({}, "upper-left")))
        self.assertEqual(single.size, (872, 480))   # one lockup at 2x
        self.assertEqual(sheet.size, (872, 480))    # four lockups at 1x
        closest = specs.reference_lockup_crop({"identifier_tier": None, "identifier_candidate_tier": "signature"})
        self.assertEqual(closest, specs.reference_lockup_crop({"identifier_tier": "signature"}))

    def test_unconfirmed_identifier_names_its_closest_tier(self):
        # A bolder weight drops the overlap below a confident read; the
        # closest tier still picks the reference the agent compares against.
        im = official_card("signature")
        im.paste(im.crop((1150, 180, 1536, 245)).filter(ImageFilter.MaxFilter(3)), (1150, 180))
        match = specs.check_virtual_mark(im)["lockup_match"]
        self.assertTrue(match["passed"], match["note"])
        self.assertIsNone(match["identifier_tier"])
        self.assertEqual(match["identifier_candidate_tier"], "signature")
        self.assertIsNone(specs.check_virtual_mark(official_card("signature"))["lockup_match"]["identifier_candidate_tier"])


class IdentifierClearance(unittest.TestCase):
    """Visa rejects artwork touching the identifier (FAIL-001, REJ-046)."""

    @staticmethod
    def traces(y_from, y_to):
        im = official_card()
        draw = ImageDraw.Draw(im)
        for x in (1260, 1330, 1400):   # gold circuit traces, as on FAIL-001
            draw.line([(x, y_from), (x + 40, y_to)], fill=(140, 110, 30), width=3)
        return im

    def test_artwork_touching_the_letters_fails(self):
        check = specs.check_virtual_mark(self.traces(260, 200))["identifier_clearance"]
        self.assertIs(check["passed"], False, check["actual"])
        self.assertEqual(check["reason_code"], "identifier_obstructed")
        self.assertGreaterEqual(check["foreign_px"], specs.IDENTIFIER_CLEARANCE_FAIL_PX)

    def test_artwork_kept_clear_passes(self):
        check = specs.check_virtual_mark(self.traces(300, 250))["identifier_clearance"]
        self.assertTrue(check["passed"], check["actual"])
        self.assertEqual(check["foreign_px"], 0)

    def test_plain_gradient_and_patterned_grounds_pass(self):
        for name, im in (("official", official_card()), ("chevrons", card(background=chevrons)),
                         ("gold gradient", card(background=gold_gradient)),
                         ("light", card(bg=(246, 246, 246), ink=(187, 187, 187)))):
            check = specs.check_virtual_mark(im)["identifier_clearance"]
            self.assertTrue(check["passed"], (name, check["actual"]))
            self.assertFalse(check.get("borderline"), name)

    def test_no_identifier_is_unverified(self):
        check = specs.check_virtual_mark(card(identifier=False))["identifier_clearance"]
        self.assertIsNone(check["passed"])


class PartnerLogoBorder(unittest.TestCase):
    def test_logo_at_or_beyond_the_zone_passes(self):
        for left, top in ((56, 56), (80, 80)):
            border = specs.check_virtual_mark(official_card(logo=("ACME PAY", left, top)))["issuer_logo_border"]
            self.assertTrue(border["passed"], (left, top, border["note"]))

    def test_logo_inside_the_zone_fails(self):
        border = specs.check_virtual_mark(official_card(logo=("ACME PAY", 30, 56)))["issuer_logo_border"]
        self.assertIs(border["passed"], False)
        self.assertEqual(border["reason_code"], "issuer_logo_in_bleed_zone")
        self.assertEqual(border["logos"][0]["corner"], "upper-left")

    def test_no_logo_is_unverified(self):
        self.assertIsNone(specs.check_virtual_mark(official_card())["issuer_logo_border"]["passed"])

    def test_art_running_off_the_edge_is_background_not_a_logo(self):
        # Background art bled off the lower right and was read as a logo 0-11px from the edge.
        im = official_card(logo=("ACME PAY", 80, 80))
        font, box = _fit(ImageDraw.Draw(im), "ART", BOLD, 60)
        ImageDraw.Draw(im).text((W - 270 - box[2], H - 5 - box[3]), "ART", font=font, fill=(255, 255, 255))
        border = specs.check_virtual_mark(im)["issuer_logo_border"]
        self.assertTrue(border["passed"], border["note"])
        self.assertEqual([b["corner"] for b in border["background_bleed"]], ["lower-right"])

    def test_icon_beside_a_clear_wordmark_only_warns(self):
        # A sparkle left of the name sat 39px from the edge while the name kept clear.
        im = official_card(logo=("ACME PAY", 80, 80))
        ImageDraw.Draw(im).polygon([(34, 80), (48, 110), (34, 140), (20, 110)], fill=(255, 255, 255))
        border = specs.check_virtual_mark(im)["issuer_logo_border"]
        self.assertIs(border["passed"], True, border["note"])
        self.assertIs(border.get("borderline"), True, border["note"])
        self.assertEqual(border["reason_code"], "issuer_logo_in_bleed_zone")
        self.assertLess(border["logos"][0]["edges_px"]["left"], 53)
        self.assertGreaterEqual(border["logos"][0]["wordmark_edges_px"]["left"], 53)

    def test_logo_inside_the_zone_but_off_the_edge_still_fails(self):
        im = official_card()
        font, box = _fit(ImageDraw.Draw(im), "ACME", BOLD, 60)
        ImageDraw.Draw(im).text((W - 40 - box[2], H - 64 - box[3]), "ACME", font=font, fill=(255, 255, 255))
        border = specs.check_virtual_mark(im)["issuer_logo_border"]
        self.assertIs(border["passed"], False, border.get("note"))
        self.assertEqual(border["logos"][0]["corner"], "lower-right")


class ZoomCrops(unittest.TestCase):
    def test_issuer_crop_takes_the_free_corner_and_the_side_band(self):
        im = Image.new("RGB", (W, H), (0, 0, 0))
        im.paste((255, 255, 255), (W // 2, 0, W, H))   # right half white
        for corner, value in (("upper-right", 0), ("upper-left", 255)):
            crop = Image.open(io.BytesIO(
                specs.generate_zoom_crops(im, {"mark_corner": corner})["issuer"])).convert("L")
            self.assertEqual(crop.getextrema(), (value, value), corner)
            # 2x of 45% x 55%: reaches past the 40% line where REJ-042's
            # contactless symbol sat between crops.
            self.assertEqual(crop.height, 2 * int(H * 0.55))
            self.assertAlmostEqual(crop.width, 2 * W * 0.45, delta=2)


class DeclaredDpi(unittest.TestCase):
    """Visa rejects art that isn't 72 DPI; the declared density decides."""

    def dpi(self, fmt="PNG", **save):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "card.png")
            official_card().save(path, fmt, **save)
            return specs.check_image(path)["checks"]["dpi"]

    def test_72_dpi_passes(self):
        for fmt in ("PNG", "JPEG"):
            check = self.dpi(fmt, dpi=(72, 72))
            self.assertTrue(check["passed"], (fmt, check["actual"]))
            self.assertEqual([round(v) for v in check["declared_dpi"]], [72, 72])

    def test_other_densities_fail(self):
        for fmt, dpi in (("PNG", 300), ("PNG", 144), ("JPEG", 94)):
            check = self.dpi(fmt, dpi=(dpi, dpi))
            self.assertIs(check["passed"], False, (fmt, dpi))
            self.assertEqual(check["reason_code"], "resolution_not_72dpi")
            self.assertEqual(check["actual"], f"{dpi} DPI (declared)")

    def test_no_density_metadata_passes(self):
        check = self.dpi("PNG")
        self.assertTrue(check["passed"])
        self.assertIsNone(check["declared_dpi"])


class CheckImage(unittest.TestCase):
    def test_virtual_check_image_emits_every_tech_check(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "card.png")
            official_card(logo=("ACME PAY", 56, 56)).save(path)
            result = specs.check_image(path, "Platinum")
        self.assertEqual(result["errors"], [])
        for key in ("dimensions", "file_format", "dpi", "bleed_zone", "mark_position", "mark_size",
                    "identifier_alignment", "mark_color", "lockup_match", "identifier_clearance",
                    "issuer_logo_border", "square_corners", "border_frame"):
            self.assertIn(key, result["checks"])
            self.assertTrue(result["checks"][key]["passed"], (key, result["checks"][key].get("note")))
        self.assertNotIn("working_copy", result)

    def test_oversized_upload_is_measured_on_a_working_copy(self):
        # An 8148px export ran the spec-check function out of memory.
        import tempfile
        big = rounded(official_card().resize((W * 5, H * 5), Image.LANCZOS), 300)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "card.png")
            big.save(path)
            result = specs.check_image(path, "Platinum")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["checks"]["dimensions"]["actual"], f"{W * 5}x{H * 5}")
        self.assertEqual((result["working_copy"]["width"], result["working_copy"]["height"]), (W, H))
        zone = result["checks"]["bleed_zone"]
        self.assertTrue(zone["passed"], zone["note"])
        self.assertTrue(53 <= zone["strict_top_px"] <= 59)
        self.assertIs(result["checks"]["square_corners"]["passed"], False)

    def test_scaled_export_fails_mark_size_at_its_own_size(self):
        # A 2048px export of correct art carries a ~145px mark.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "card.png")
            official_card().resize((2048, 1292), Image.LANCZOS).save(path)
            result = specs.check_image(path, "Platinum")
        size = result["checks"]["mark_size"]
        self.assertIs(result["checks"]["dimensions"]["passed"], False)
        self.assertIs(size["passed"], False, size["note"])
        self.assertEqual(size["reason_code"], "size_oversized")
        self.assertTrue(138 <= size["native_mark_height_px"] <= 152, size["native_mark_height_px"])

    def test_near_canvas_size_keeps_a_correct_mark(self):
        # 1538x971 is the wrong canvas, but its mark is still Visa's 109px.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "card.png")
            official_card().resize((1538, 971), Image.LANCZOS).save(path)
            result = specs.check_image(path, "Platinum")
        size = result["checks"]["mark_size"]
        self.assertIs(result["checks"]["dimensions"]["passed"], False)
        self.assertTrue(size["passed"], size["note"])

    def test_working_copy_leaves_canvas_sized_art_alone(self):
        im = official_card()
        self.assertIs(specs.working_copy(im), im)
        self.assertEqual(specs.working_copy(card().resize((1900, 1199))).size, (1900, 1199))


if __name__ == "__main__":
    unittest.main()

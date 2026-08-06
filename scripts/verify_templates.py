#!/usr/bin/env python3
"""
Ground-truth verification: Rain's canonical physical card templates must PASS
the technical spec checker, and byte-edited negative variants must FAIL the
intended check.

The 24 canonical .ai templates (12 products x vertical/horizontal, from the
designers' Drive folder) are proprietary and NOT committed — point the script
at a local copy:

    CARD_TEMPLATE_DIR=~/Downloads/templates python3 scripts/verify_templates.py

Expected layout: $CARD_TEMPLATE_DIR/{vertical,horizontal}/*.ai

Requires a system Ghostscript (brew install ghostscript / apt-get install
ghostscript) plus the repo's python deps (Pillow, numpy).

Assertions per template:
  - 2 pages detected; front + back both rendered
  - trim_size, bleed_margin, file_format, min_resolution: PASS (no warning)
  - bleed_zone (front): PASS (mark detected, not borderline)
  - magstripe_band (back): PASS
  - layers_present: PASS with the canonical structure + a product tier
  - NO check anywhere reports passed=False
  - warnings (borderline) allowed ONLY for layers_present (DO-NOT-PRINT
    guide layers) and color_mode (templates are RGB-mode)

Negative fixtures (generated in a temp dir by same-length byte edits, so PDF
xref offsets stay valid):
  - bleed margin shrunk below 1/8"  -> bleed_margin must FAIL
  - trim width off CR80             -> trim_size must FAIL
  - distorted raster PNG            -> cr80_aspect_ratio must FAIL
"""

import glob
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_technical_specs as specs  # noqa: E402

WARN_ALLOWED = {"layers_present", "color_mode"}

failures = []
checked = 0


def fail(label, msg):
    failures.append(f"{label}: {msg}")
    print(f"  FAIL  {label}: {msg}")


def assert_side(label, side, side_name):
    checks = side.get("checks") or {}
    for key, ck in checks.items():
        if ck.get("passed") is False:
            fail(label, f"{side_name}.{key} FAILED: {ck.get('note', '')[:140]}")
        elif ck.get("borderline") and key not in WARN_ALLOWED:
            fail(label, f"{side_name}.{key} unexpected WARNING: {ck.get('note', '')[:140]}")
    for key in ("trim_size", "bleed_margin", "file_format", "min_resolution"):
        ck = checks.get(key)
        if not ck or ck.get("passed") is not True:
            fail(label, f"{side_name}.{key} did not pass cleanly")
    if side.get("errors"):
        fail(label, f"{side_name} errors: {side['errors']}")


def verify_template(path):
    global checked
    label = "/".join(path.split(os.sep)[-2:])
    with tempfile.TemporaryDirectory() as tmp:
        res = specs.check_physical(path, out_dir=tmp)
        front, back = res.get("front"), res.get("back")
        if not front or not back:
            return fail(label, "front/back not both produced (2-page split broken)")
        if front.get("source_pages") != 2:
            fail(label, f"expected 2 pages, got {front.get('source_pages')}")

        assert_side(label, front, "front")
        assert_side(label, back, "back")

        bz = (front.get("checks") or {}).get("bleed_zone") or {}
        if not bz.get("mark_detected") or bz.get("passed") is not True or bz.get("borderline"):
            fail(label, f"front.bleed_zone not a clean pass: {bz.get('note', '')[:140]}")
        ms = (back.get("checks") or {}).get("magstripe_band") or {}
        if ms.get("passed") is not True:
            fail(label, f"back.magstripe_band not detected: {ms.get('note', '')[:120]}")
        layers = (front.get("checks") or {}).get("layers_present") or {}
        if layers.get("passed") is not True or not layers.get("product_tier"):
            fail(label, f"layers_present not canonical / no tier: {layers.get('note', '')[:120]}")

        orientation = front.get("orientation")
        expected = "vertical" if f"{os.sep}vertical{os.sep}" in path else "horizontal"
        if orientation != expected:
            fail(label, f"orientation {orientation}, expected {expected}")
        if back.get("orientation") != "horizontal":
            fail(label, "back orientation should always be horizontal")
    checked += 1
    print(f"  ok    {label}")


def _byte_edit(src, dst, old, new):
    assert len(old) == len(new), "negative-fixture edits must be same-length"
    data = open(src, "rb").read()
    assert old in data, f"marker not found in {src}"
    open(dst, "wb").write(data.replace(old, new))


def verify_negatives(sample_horizontal):
    """Each generated negative must FAIL its intended check."""
    with tempfile.TemporaryDirectory() as tmp:
        # (a) bleed below 1/8": trim stays CR80 but sits 8pt from the sheet edge
        bad_bleed = os.path.join(tmp, "bad_bleed.ai")
        _byte_edit(sample_horizontal, bad_bleed,
                   b"18.0 18.0 260.646 171.014",
                   b"08.0 08.0 250.646 161.014")
        res = specs.check_physical(bad_bleed, out_dir=tmp)
        ck = res["front"]["checks"].get("bleed_margin") or {}
        if ck.get("passed") is not False:
            fail("negative/bad_bleed", f"bleed_margin should FAIL, got {ck}")
        else:
            print("  ok    negative/bad_bleed fails bleed_margin as intended")

        # (b) trim width off CR80 (260.646 -> 240.646 keeps byte length)
        bad_trim = os.path.join(tmp, "bad_trim.ai")
        _byte_edit(sample_horizontal, bad_trim,
                   b"18.0 18.0 260.646 171.014",
                   b"18.0 18.0 240.646 171.014")
        res = specs.check_physical(bad_trim, out_dir=tmp)
        ck = res["front"]["checks"].get("trim_size") or {}
        if ck.get("passed") is not False:
            fail("negative/bad_trim", f"trim_size should FAIL, got {ck}")
        else:
            print("  ok    negative/bad_trim fails trim_size as intended")

        # (c) distorted raster: wrong aspect ratio PNG
        render = specs._render_vector_pages(sample_horizontal, tmp)[0]
        img = specs.Image.open(render)
        squashed = img.resize((img.width, img.width))  # square
        bad_png = os.path.join(tmp, "bad_aspect.png")
        squashed.save(bad_png)
        res = specs.check_physical(bad_png, out_dir=tmp)
        ck = res["front"]["checks"].get("cr80_aspect_ratio") or {}
        if ck.get("passed") is not False:
            fail("negative/bad_aspect", f"cr80_aspect_ratio should FAIL, got {ck}")
        else:
            print("  ok    negative/bad_aspect fails cr80_aspect_ratio as intended")


def main():
    if not shutil.which("gs"):
        print("ERROR: Ghostscript (gs) not on PATH. brew install ghostscript")
        return 2
    template_dir = os.environ.get("CARD_TEMPLATE_DIR") or (
        sys.argv[1] if len(sys.argv) > 1 else "test-fixtures/templates")
    paths = sorted(glob.glob(os.path.join(template_dir, "*", "*.ai")))
    if not paths:
        print(f"ERROR: no templates under {template_dir} "
              "(expected {vertical,horizontal}/*.ai — set CARD_TEMPLATE_DIR)")
        return 2

    print(f"Verifying {len(paths)} canonical templates from {template_dir}\n")
    for path in paths:
        verify_template(path)

    print("\nNegative fixtures:")
    horizontal = [p for p in paths if f"{os.sep}horizontal{os.sep}" in p]
    verify_negatives(horizontal[0] if horizontal else paths[0])

    print(f"\n{checked} templates checked, {len(failures)} failure(s)")
    if failures:
        print("\n".join(failures))
        return 1
    print("ALL PASS — canonical templates are green, negatives fail as intended.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

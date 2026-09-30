#!/usr/bin/env python3
"""Measure every on-disk eval image and reconcile its label with the objective rules.

Visa's feedback often names one problem and stays silent on others the same
file also breaks (a 6400px export rejected "for the 56px margin" is also the
wrong size). This pass measures each image with the production spec script
and, idempotently, rewrites cases.csv:

  - requires_changes + wrong dimensions / non-72 DPI  -> add the tech reason
  - a measurement that CONTRADICTS the label (an approved card whose mark is
    not at 56px, a margin rejection that measures at 56px, an approved card
    with the wrong size/DPI) -> tagged *_conflict for review, never flipped
  - requires_changes whose mark measures off 56px but Visa named no margin
    problem -> tagged margin_off56_unconfirmed for review, NOT given the reason

Margin readings are advisory: the production detector only searches the
right-hand corners, so an upper-left mark (or a busy pattern) yields a bogus
distance. Readings far outside any plausible placement are tagged
mark_misdetected_suspect instead of counting as a conflict.

The exact-56 rule: both nearest-edge strict (letter-tip) distances within
56 +/- 3 px on the 1536x969 canvas (53-59: the tightest band that fits every
explicit Visa verdict; an explicitly approved card measures 53/59). Visa's own feedback -- untouched -- stays
in `reasons_visa`; `reasons` is that plus what this audit derives.

    pip install -r requirements.txt   # Pillow, numpy
    python3 evals/card-art/audit_labels.py [--data DIR]
"""
import argparse
import csv
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'scripts'))
import check_technical_specs as specs  # noqa: E402
from PIL import Image  # noqa: E402

W, H, DPI, TARGET, TOL = 1536, 969, 72, 56, 3
AUDIT_TAGS = {'tech_reason_added', 'margin_reason_added', 'margin_conflict', 'margin_off56_unconfirmed',
              'tech_conflict_dimensions', 'tech_conflict_dpi', 'mark_undetected_by_script',
              'mark_misdetected_suspect', 'dpi_metadata_missing'}
PLAUSIBLE_MAX = 120  # px on the 1536 canvas; beyond this the detector latched onto something else
REASON_CHECKS = {'mark_margin_not_56': 'visa_brand_mark_margin', 'resolution_not_72dpi': 'tech:dpi',
                 'dimensions_not_1536x969': 'tech:dimensions'}


def find_image(data, image_file):
    stem = os.path.splitext(os.path.join(data, image_file))[0]
    return next((stem + e for e in ('.png', '.jpg', '.jpeg', '.PNG', '.JPG') if os.path.exists(stem + e)), None)


def measure(path):
    img = Image.open(path)
    w, h = img.size
    dpi = img.info.get('dpi')
    dpi = round(float(dpi[0])) if dpi else None
    bz = specs.check_bleed_zone(img.convert('RGB') if img.mode not in ('RGB', 'RGBA') else img)
    m = {'w': w, 'h': h, 'dpi': dpi, 'detected': bool(bz.get('mark_detected')), 'corner': bz.get('mark_corner')}
    if m['detected']:
        scale = W / w  # distances are compared on the 1536-wide canvas
        near = bz.get('strict_top_px', bz.get('strict_bottom_px'))
        right = bz.get('strict_right_px')
        m['near'] = round(near * scale) if near is not None else None
        m['right'] = round(right * scale) if right is not None else None
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.environ.get('CARD_ART_EVAL_DATA',
                                                     os.path.expanduser('~/Desktop/Rain Scratch/card-art-eval')))
    args = ap.parse_args()
    path = os.path.join(args.data, 'cases.csv')
    with open(path, newline='') as f:
        reader = csv.DictReader(f)
        fields = list(reader.fieldnames)
        rows = list(reader)
    for col in ('reasons_visa', 'measured'):
        if col not in fields:
            fields.insert(fields.index('reasons') + 1 if col == 'reasons_visa' else len(fields), col)
    changed = []
    for r in rows:
        if 'reasons_visa' not in r or r.get('reasons_visa') is None:
            r['reasons_visa'] = r['reasons']
        base = [x for x in r['reasons_visa'].split(';') if x]
        tags = [t for t in r['tags'].split(';') if t and t not in AUDIT_TAGS]
        img = find_image(args.data, r['image_file'])
        if not img or r['expected_outcome'] not in ('requires_changes', 'approved'):
            r['measured'] = r.get('measured') or ''
            continue
        m = measure(img)
        r['measured'] = (f"{m['w']}x{m['h']} {m['dpi'] or '?'}dpi "
                         + (f"{m['corner']} {m.get('near')}/{m.get('right')}" if m['detected'] else 'mark not detected'))
        reasons = list(base)
        wrong_dims = (m['w'], m['h']) != (W, H)
        wrong_dpi = m['dpi'] is not None and m['dpi'] != DPI
        upper = (m['corner'] or '').startswith('upper')
        at56 = m['detected'] and all(v is not None and abs(v - TARGET) <= TOL for v in (m.get('near'), m.get('right')))
        if m['dpi'] is None:
            tags.append('dpi_metadata_missing')
        if not m['detected']:
            tags.append('mark_undetected_by_script')
        suspect = m['detected'] and (not upper or any(v is None or v > PLAUSIBLE_MAX or v < 20 for v in (m.get('near'), m.get('right'))))
        if suspect:
            tags.append('mark_misdetected_suspect')
        trusted = m['detected'] and not suspect
        if r['expected_outcome'] == 'requires_changes':
            for bad, reason in ((wrong_dims, 'dimensions_not_1536x969'), (wrong_dpi, 'resolution_not_72dpi')):
                if bad and reason not in reasons:
                    reasons.append(reason); tags.append('tech_reason_added')
            if trusted and not at56 and 'mark_margin_not_56' not in reasons:
                tags.append('margin_off56_unconfirmed')
            if 'mark_margin_not_56' in base and trusted and at56:
                tags.append('margin_conflict')
        else:
            if wrong_dims: tags.append('tech_conflict_dimensions')
            if wrong_dpi: tags.append('tech_conflict_dpi')
            if trusted and not at56: tags.append('margin_conflict')
        new_tags = ';'.join(dict.fromkeys(tags))
        new_reasons = ';'.join(reasons)
        if new_reasons != r['reasons'] or new_tags != r['tags']:
            changed.append((r['case_id'], r['reasons'], new_reasons, r['tags'], new_tags, r['measured']))
        r['reasons'], r['tags'] = new_reasons, new_tags
    tmp = path + '.tmp'
    with open(tmp, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)
    measured = sum(1 for r in rows if r.get('measured'))
    conflicts = [r for r in rows if 'conflict' in r['tags']]
    print(f'{measured} images measured; {len(changed)} label(s) updated; {len(conflicts)} conflict(s) to review')
    for cid, old_r, new_r, old_t, new_t, meas in changed:
        added = sorted(set(new_r.split(';')) - set(old_r.split(';')) - {''})
        flags = sorted(set(new_t.split(';')) - set(old_t.split(';')) - {''})
        print(f'  {cid:14s} {meas:40s} +reasons {added or "-"}  +tags {flags or "-"}')
    for r in conflicts:
        print(f"  CONFLICT {r['case_id']:14s} {r['expected_outcome']:16s} {r['measured']:40s} {r['tags']}")


if __name__ == '__main__':
    main()

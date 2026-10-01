# Improving the rejection-reason dataset

The virtual card-art eval (`evals/card-art/`) scores the checker against Visa's real verdicts. This file covers what the case set can support today, and the changes that would make its numbers more trustworthy, in rough order of value.

The case data itself (partner card art, Visa feedback, PDR numbers) is private and lives outside this public repo. `REJ-###`, `FAIL-###` and `PASS-###` are opaque case IDs in that dataset.

## Where the set stands (2026-09-29)

- **Sources:** 424 records mined from the card-submission channel and its tracking canvas, covering 2025-09 to 2026-09. They include 197 rejections Visa relayed and 70 pre-submission flags.
- **Cases:** 88 active cases, 87 of them with an image.
  - **45 known-bad:** 38 carry Visa's own feedback and 7 are internal pre-screen flags.
  - **42 approved:** 29 of these are the approved fix of a rejected design.
- **Removed:** 7 cases were dropped or set aside because the art no longer exists (5), the file couldn't be told apart from its fix (1), or the design was internal rather than a partner's (1).

| Metric | Cases behind it | Noise at 3 reps | Supports |
|---|---|---|---|
| `recall_covered` (headline) | 35 | about ±10 pts | Baseline vs. variant decisions on large effects |
| `specificity` | 35 | about ±10 pts | A coarse false-alarm rate |
| `specificity_explicit` | 18 | about ±14 pts | A rough read only |
| Per-reason recall | 1–12 per reason | ±30–100 pts | Anecdotes, except the margin (12) and dimension (8) reasons |
| `recall_gap` / `recall_declared` | 7 / 3 | — | Case-by-case review, not percentages |

## 1. Add explicitly approved cards

Specificity is the weakest side. Only 18 of the 42 approved cards have a written Visa approval: 17 rest only on tokenization, which proved wrong at least once (a design tokenized a week before Visa rejected it), and 7 are files that probably aren't what Visa reviewed. Two partners account for 12 of the 42 approved cards.

- The tracking canvas lists about 300 tokenized designs. Pull the ones whose thread carries a written approval ("approved", "Visa approved the card art") and whose submitted file is still attached.
- Prefer partners not already in the set, and designs close to a rule boundary (a mark near 56px, busy backgrounds, light or metallic marks), because those are where false alarms come from.
- **Target:** 40+ explicit approvals, which brings `specificity_explicit` to about ±9 points.

## 2. Fill the thin reasons from rejections already logged

`rejection-reasons.csv`, in the data folder, counts every rejection seen. Most reasons have many more real examples than the eval uses:

| Reason | Visa rejections logged | In the eval |
|---|---|---|
| Brand Mark not at 56px | 53 | 12 |
| Brand Mark size (109px mark / 170px lockup) | 14 | 3 |
| Resolution not 72 DPI | 13 | not testable (see #3) |
| Dimensions not 1536×969 | 9 | 8 |
| Identifier misaligned with the mark | 8 | 4 |
| Brand Mark color not permitted | 8 | 4 |
| Identifier font / size / casing | 7 (+4 flags) | 3 |
| Rounded corners | 7 | 3 |
| Brand Mark on the bottom | 6 (+7 flags) | 4 |
| Identifier tier vs. BIN | 5 | 3 |

- **Target:** at least 5 real examples per reason, which is the point where a per-reason number stops being one or two cards.
- Pick the rejection *and* its approved fix wherever both files survive. The pair isolates exactly what Visa objected to.
- 22 rejections are unusable today because Slack only says "action required" and never quotes Visa's reason. Visa's original email usually has it. Recovering those emails would turn them into cases.

## 3. Keep the exact file Visa reviewed

Much of the data loss so far came from not having the exact bytes that were submitted:

- **Overwritten Drive folders:** 5 rejected designs are gone because the partner's Drive folder was reused for the fix.
- **Stripped DPI metadata:** Slack and Drive downloads strip it, so 79 of 80 copies have none. The "not 72 DPI" reason can't be tested at all, and one rejection (REJ-033) is pixel-identical to its approved fix.
- **Unknown submitted version:** 6 approved "fixes" are the wrong size or contradict a rule Visa enforces elsewhere. The submitted file was probably resized, or had its corners flattened, before it went to Visa.

**Process fix:** at submission time, save the exact file sent to Visa to a write-once location keyed by PDR (for example `submitted/<PDR>.png` in Blob storage, or a locked Drive folder), with its metadata intact. Record Visa's verdict against the same PDR. That one step removes all three failure modes.

## 4. Record verdicts in a structured way

Today the verdict lives in Slack prose, and approvals are often inferred from a tokenization message. A small structured record per PDR removes the guesswork:
- the verdict (approved or rejected) and its date
- Visa's feedback verbatim
- the reasons, as IDs from `rejection-reasons.csv`
- whether Rain disputed it

The canvas already tracks one line per program, so a few extra columns there would do.

## 5. Label every check, not only the one Visa mentioned

Visa's feedback usually names one problem. The label audit (`evals/card-art/audit_labels.py`) has already found rejected files that were also the wrong size, which Visa never mentioned. So `right_reason` probably understates the checker, and there is no per-check ground truth for false flags.

- For each case, have one person mark every catalog check pass or fail, and a second person for disputed cases. A 56px guide overlay settles margin calls in seconds.
- This makes `right_reason` exact and lets the eval report a per-check false-flag rate.

## 6. Resolve the open label conflicts

The audit flags these for a human decision rather than changing them. It still measures margins with the old right-corner-only detector, so the readings below come from the current mark locator (`check_virtual_mark`):

- **Tokenization-only approvals that measure off 56px:** REJ-003-FIXED (60/60) and REJ-025-FIXED (52/51). Confirm whether Visa approved these exact files. If it did, the ±3 band is too tight, since every Visa margin rejection has an edge at 70px or more.
- **REJ-043-FIXED:** its 66/59 reading came from the old detector, and it measures 56/57. It fails the mark-color check instead, and its approval is also tokenization-only.
- **Explicit approvals that contradict a rule:** REJ-021-FIXED (rounded corners), REJ-035-FIXED (65/65) and PASS-009 (identifier about 1.46× the official size). Find the file that was actually approved.
- **Two quarantined approved cards:** one has a lower-right mark and no identifier. The other stays out: the current locator confirms its 80/53px reading, and the art has rounded corners.
- **Six rejected cards that measure off 56px where Visa didn't mention the margin.** These are tagged `margin_off56_unconfirmed`, and a person should confirm each one.

## 7. Cover checks that never fail in real submissions

Nine virtual catalog checks have no real failing example. In a year of submissions, Visa never rejected a virtual design for:
- a chip, hologram, magstripe, cardholder name or expiry date
- card photography
- portrait orientation
- grayscale
- a missing issuer logo

The checker is still expected to catch these, and nothing tests it.

- Create mutations of approved cards with a known violation, each marked synthetic and scored outside the headline:
  - paste a chip or a magstripe
  - add a name or expiry text
  - rotate the card to portrait
  - convert it to grayscale
  - remove the issuer logo
- The label is known by construction, and the unmodified original serves as its own control.

## 8. Keep the set current

- **Add new rejections promptly:** when Visa returns one, add the design (and later its fix) within a week, under its reason in `rejection-reasons.csv`.
- **Re-run the label audit** after every download batch, and after any change to the rules (the 56px band, the size and DPI requirements).
- **Split before optimizing:** before prompt or rule tuning, hold out a random test slice stratified by reason, and report it every round. Tuning against the whole set rewards fitting the cases, not the rules.
- **Physical cards need their own eval.** The same channel holds physical rejections (a chip on art submitted through the digital flow, a manufacturer-code mismatch), and the canonical physical templates are a ready source of approved references.

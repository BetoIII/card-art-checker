# Virtual card-art eval

Scores the virtual checker against Visa's real verdicts. Every case is a design
submitted through the Visa card-submission channel: a version Visa rejected, or
the approved fix of the same design. Scoring is programmatic (no LLM judge):
`buildResult()` output vs. the expected outcome and the checks Visa's reasons map to.

**The case data is private and never lives in this repo** (the repo is public):
partner card art, Visa's feedback and PDR numbers stay in the data folder, by
default `~/Desktop/Rain Scratch/card-art-eval` (`--data` or `$CARD_ART_EVAL_DATA`).

| File | What it does |
|---|---|
| `run-eval.mjs` | Runs `runAnalysis()` → `buildResult()` per case and grades it. Resume-safe, jittered backoff, per-case wall-clock ceiling, served-model check, failures in `errors.jsonl` (never scored as misses), and a harness gate that refuses to run changed code until a human re-approves it. |
| `audit_labels.py` | Measures each image with `scripts/check_technical_specs.py` and reconciles labels: adds size reasons Visa didn't mention, flags margin/size conflicts for review. Margin readings are advisory (the production detector only searches the right-hand corners). |

## Run

```bash
# free: push synthetic results through the grader (no model call)
node evals/card-art/run-eval.mjs --variant baseline --model claude-opus-4-8 --grader-check oracle

# paid: pin the agent version so a prompt push can't change what a run measures
SELF_BASE_URL=https://card-art-checker.vercel.app \
  node --env-file=.env.local evals/card-art/run-eval.mjs \
  --variant baseline --model claude-opus-4-8 --agent-version 4 --reps 3
```

`SELF_BASE_URL` is the deployment whose `/api/spec-check` measures the tech specs. Point it at a
preview deploy to score unreleased spec-check changes as a new variant (`--variant v1`), and
override `AGENT_ID` to score a staged agent. The first paid run, and any run after the runner or
`_state.json.harness_paths` change, needs `--approve-harness` from a person who has reviewed the diff.

Metrics are defined in the data folder's `hillclimb/virtual/metrics.md`; the headline is
`recall_covered` (known-bad cards whose reasons the catalog covers, caught as REQUIRES CHANGES;
APPROVED WITH NOTES is a miss). `docs/visa-rejection-gaps.md` lists the rejection reasons the
checker couldn't catch when this eval was built.

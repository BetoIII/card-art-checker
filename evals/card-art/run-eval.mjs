#!/usr/bin/env node
// Built on the claude-api build-eval runner scaffold. Structural properties this encodes (so you don't have to remember them):
//   - parameterized by --variant / --model / --reps (no hardcoded A/B pair)
//   - rep-aware filenames + resume (traces/<id>_rep<k>.json)
//   - reads _state.json, never writes it (loop state belongs to the orchestrator) - 
//     the ONE exception is --approve-harness recording `harness_sha` (see below)
//   - refuses to run when the harness (this file + _state.json.harness_paths) has
//     changed since the sha a human last approved with --approve-harness, so a
//     round that edits the runner cannot execute unreviewed under a standing
//     session allowlist
//   - pairwise graders judge against frozen baseline/ref/<id>.* on disk
//   - writes rows as cases complete (crash-safe)
//   - jittered exponential backoff on transient 429/overloaded/5xx errors
//   - hard per-case wall-clock ceiling (--timeout-s; stream keepalives don't reset it)
//   - served-model assertion (response model must match --model; documented alias->snapshot
//     shapes tolerated: 'foo-latest'/'foo-0'/'foo' -> 'foo-20250101' / 'foo@20250101' / 'foo-2025-01-01')
//   - failed attempts land in errors.jsonl with a failure class and, when the call
//     completed, the billed model/usage (never in results.jsonl)
//   - row ids, trace filenames, and frozen refs share one path-safe id
//     (original id kept in meta.original_id when sanitization changed it)

// Card-art checker eval: virtual flow. Runs the REAL entry point
// (lib/pipeline.js runAnalysis -> lib/result-schema.js buildResult) on each
// case and grades the structured result against Visa's verdict. No Slack,
// Rocketlane, or result-webhook side effects: those live in the API routes,
// not in runAnalysis. The only side effects are the spec-check self-call and
// its transport blobs (deleted after each run).
//
// Case data (partner card art, Visa feedback) is private and lives OUTSIDE
// this public repo: --data (default $CARD_ART_EVAL_DATA or
// ~/Desktop/Rain Scratch/card-art-eval). Keep --flow there too.
//
//   node --env-file=.env.local evals/card-art/run-eval.mjs \
//     --flow "$HOME/Desktop/Rain Scratch/card-art-eval/hillclimb/virtual" \
//     --variant baseline --model claude-opus-4-8 --agent-version 4 --reps 3
//
// Needs ANTHROPIC_API_KEY, AGENT_ID, ENV_ID, BLOB_READ_WRITE_TOKEN, and
// SELF_BASE_URL (the deployment whose /api/spec-check measures the tech specs;
// production is https://card-art-checker.vercel.app).
//
// --only ID,ID  runs a subset (pilot). --grader-check oracle|approve-all|reject-all
// skips the model and pushes synthetic results through the grader, so the metric
// wiring can be verified for free before any paid pass.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- card-art eval ----------------------------------------------------------

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_DATA = process.env.CARD_ART_EVAL_DATA || join(homedir(), 'Desktop/Rain Scratch/card-art-eval');

// Rejection reason -> the catalog check ids that should FAIL for it (lib/check-catalog.js
// ids; `tech:<id>` is a deterministic spec-check id). Empty = the catalog has no check
// for it (docs/visa-rejection-gaps.md). Mirrors rejection-reasons.csv in the data dir.
const REASON_CHECKS = {
  mark_margin_not_56: ['visa_brand_mark_margin'],
  mark_position_bottom: ['visa_brand_mark_position'],
  mark_size_wrong: ['visa_brand_mark_size'],
  mark_color_invalid: [],
  mark_missing: ['visa_brand_mark_present'],
  lockup_not_official: ['product_identifier'],
  identifier_missing: ['product_identifier'],
  identifier_tier_mismatch: ['product_identifier'], // needs a declared product the prompt never gets
  identifier_misaligned: ['product_identifier'],
  identifier_typography: ['product_identifier'],
  identifier_obstructed: ['design_elements_clear_of_identifier'],
  identifier_contrast: ['visa_brand_mark_contrast'],
  lower_left_not_clear: ['lower_left_area_clear'],
  partner_logo_border: [],
  resolution_not_72dpi: ['tech:dpi'],
  dimensions_not_1536x969: ['tech:dimensions'],
  rounded_corners: [],
  white_border: [],
  contactless_indicator: [],
  pan_digits: ['no_pan'],
  chip_on_virtual: ['no_emv_chip'],
};
const NEEDS_DECLARED_PRODUCT = new Set(['identifier_tier_mismatch']);
// Approved files that are probably NOT the bytes Visa approved (resized on
// submission, or contradicting a rule Visa enforces elsewhere): scored apart.
const SUSPECT_FILE_TAGS = ['tech_conflict_dimensions', 'approved_file_mismatch_suspect'];

// REASON_CHECKS is frozen at the baseline catalog: it decides which headline
// column a case lands in, so a later variant that adds a check is scored on the
// SAME case populations and the gain shows up in recall_gap / right_reason_gap.
// REASON_ACCEPT is what counts as "caught for the right reason": any listed
// check failing catches that reason, including checks newer than the baseline
// (docs/visa-rejection-gaps.md) — absent checks simply never fail.
const REASON_ACCEPT = {
  ...Object.fromEntries(Object.entries(REASON_CHECKS).map(([k, v]) => [k, [...v]])),
  mark_margin_not_56: ['visa_brand_mark_margin', 'tech:bleed_zone'],
  mark_size_wrong: ['visa_brand_mark_size', 'tech:mark_size'],
  mark_color_invalid: ['visa_brand_mark_color', 'tech:mark_color'],
  identifier_misaligned: ['product_identifier', 'tech:identifier_alignment'],
  rounded_corners: ['tech:square_corners'],
  white_border: ['tech:border_frame'],
  contactless_indicator: ['contactless_indicator'],
};

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const split = s => String(s || '').split(';').map(x => x.trim()).filter(Boolean);

// Which headline column a requires_changes case scores into.
function coverageOf(reasons) {
  const covered = reasons.filter(r => (REASON_CHECKS[r] || []).length && !NEEDS_DECLARED_PRODUCT.has(r));
  if (covered.length) return { coverage: 'covered', covered };
  return { coverage: reasons.some(r => NEEDS_DECLARED_PRODUCT.has(r)) ? 'needs_declared_product' : 'gap_only', covered };
}

function findImage(dataDir, imageFile) {
  const stem = join(dataDir, imageFile).replace(/\.[^./]+$/, '');
  for (const e of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG']) if (existsSync(stem + e)) return stem + e;
  return null;
}

/** Return the list of input cases. Each must have a stable `id`. */
async function loadCases(ctx) {
  const rows = parseCsv(readFileSync(join(ctx.data, 'cases.csv'), 'utf8'));
  const cases = [], missing = [];
  for (const r of rows) {
    if (!['requires_changes', 'approved'].includes(r.expected_outcome)) continue;
    if (ctx.only && !ctx.only.has(r.case_id)) continue;
    const image = findImage(ctx.data, r.image_file);
    if (!image) { missing.push(r.case_id); continue; }
    // A DPI rejection can't be judged from a copy that lost its DPI metadata
    // (Slack/Drive downloads strip it), so that reason is not scored there.
    const reasons = split(r.reasons).filter(x => !(x === 'resolution_not_72dpi' && split(r.tags).includes('dpi_metadata_missing')));
    const { coverage, covered } = r.expected_outcome === 'requires_changes' ? coverageOf(reasons) : { coverage: 'approved', covered: [] };
    const expectedChecks = [...new Set(covered.flatMap(x => REASON_CHECKS[x]))];
    const tags = [
      r.expected_outcome === 'requires_changes' ? (reasons[0] || 'unlabeled') : 'approved',
      r.expected_outcome === 'requires_changes' ? coverage : null,
      ...split(r.tags).filter(t => t !== reasons[0] && t !== 'pass'),
    ].filter(Boolean);
    cases.push({
      id: r.case_id,
      prompt: `${r.partner}${r.card_name ? ` — ${r.card_name}` : ''} · expected ${r.expected_outcome}`
        + (reasons.length ? ` (${reasons.join(', ')})` : ''),
      tags,
      attachments: [{ kind: 'image', ref: relative(ctx.flow, image), alt: basename(image) }],
      meta: { partner: r.partner, label_source: r.label_source, feedback: r.feedback_verbatim || undefined },
      expected: r.expected_outcome, reasons, coverage, coveredReasons: covered, expectedChecks, image, caseTags: split(r.tags),
      declaredProduct: r.declared_product || undefined,
    });
  }
  if (missing.length) console.error(`note: ${missing.length} case(s) have no image yet and are NOT run: ${missing.join(' ')}`);
  return cases;
}

function eventsToTranscript(t, input) {
  const turns = [
    { role: 'system', content: `Managed agent ${t.agent?.id} v${t.agent?.version} (${t.agent?.model}). `
        + 'System prompt: prompts/agent-system-prompt.md as pushed to that agent version.' },
    { role: 'user', content: t.prompt, attachments: input.attachments },
  ];
  for (const e of t.events || []) {
    if (e.type === 'agent.message') turns.push({ role: 'assistant', content: e.text });
    else if (e.type === 'agent.tool_use') turns.push({ role: 'tool_call', name: e.name, content: JSON.stringify(e.input, null, 2) });
    else if (e.type === 'agent.tool_result') turns.push({ role: 'tool_result', content: (e.is_error ? '[error] ' : '') + e.text });
    else if (e.type === 'session.error') turns.push({ role: 'tool_result', content: `[session.error] ${JSON.stringify(e.error)}` });
  }
  return turns;
}

// Synthetic results for --grader-check: free, no model call.
function syntheticResult(input, mode) {
  const { getCatalog, TECH_CHECK_IDS } = SYNTH;
  const checks = getCatalog('virtual').map(c => ({ id: c.id, status: 'pass', severity: c.severity }));
  const tech = TECH_CHECK_IDS.virtual.map(id => ({ id, status: 'pass' }));
  let outcome = 'approved';
  if (mode === 'reject-all') { outcome = 'requires_changes'; checks.forEach(c => { c.status = 'fail'; }); tech.forEach(c => { c.status = 'fail'; }); }
  if (mode === 'oracle' && input.expected === 'requires_changes') {
    outcome = 'requires_changes';
    for (const id of input.reasons.flatMap(x => REASON_ACCEPT[x] || [])) {
      const hit = id.startsWith('tech:') ? tech.find(c => c.id === id.slice(5)) : checks.find(c => c.id === id);
      if (hit) hit.status = 'fail';
    }
  }
  return { outcome, checks, tech_checks: tech, unmapped_checks: [] };
}
let SYNTH = null;

/**
 * Run the app on one input. Return everything the grader and the report need.
 */
async function runCase(input, ctx) {
  if (ctx.graderCheck) {
    SYNTH ??= await import(join(REPO, 'lib/check-catalog.js'));
    return { output: syntheticResult(input, ctx.graderCheck), transcript: [], model: ctx.model,
             usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' };
  }
  const [{ runAnalysis }, { buildResult }] = await Promise.all([
    import(join(REPO, 'lib/pipeline.js')), import(join(REPO, 'lib/result-schema.js')),
  ]);
  const file = readFileSync(input.image);
  let out;
  try {
    out = await runAnalysis({
      file, fileName: basename(input.image), cardType: 'virtual',
      agentVersion: ctx.agentVersion, deadlineAt: Date.now() + ctx.timeoutS * 1000,
      // Ignored by code that predates the declared-product input (the baseline).
      ...(input.declaredProduct ? { declaredProduct: input.declaredProduct } : {}),
    });
  } catch (e) {
    // Carry billed usage onto the error row; name the failure so plumbing and
    // model failures stay distinguishable in errors.jsonl.
    if (e.telemetry) { e.model = e.telemetry.agent?.model; e.usage = e.telemetry.usage; }
    e.failure_class ??= /RESULTS_JSON/.test(e.message) ? 'agent_output_unparseable'
      : e.step === 'tech_specs' ? 'spec_check_error' : 'harness_error';
    throw e;
  }
  const t = out.telemetry;
  const result = buildResult({
    runId: `eval-${randomUUID().slice(0, 8)}`, results: out.results, techJson: out.techJson,
    cardType: 'virtual', fileName: basename(input.image), source: 'eval',
  });
  const transcript = eventsToTranscript(t, input);
  transcript.push({ role: 'assistant', content: '```json\n' + JSON.stringify(result, null, 2) + '\n```' });
  return {
    output: result, transcript, model: t.agent?.model, usage: t.usage, stop_reason: 'end_turn',
    agent_version: t.agent?.version, tool_calls: t.toolCalls, model_requests: t.modelRequests,
    // Verdicts enforced by code after the agent answered (lib/tech-verdicts.js,
    // where present) — separates the agent's own call from a deterministic one.
    tech_overrides: (t.techOverrides || []).length,
  };
}

/**
 * Grade one structured result. Programmatic, no judge. APPROVED WITH NOTES on a
 * known-bad card is a MISS: only outcome === 'requires_changes' counts as caught.
 * Metrics that do not apply to a case are omitted from its grade, not zeroed.
 */
async function gradeCase(input, run) {
  const r = run.output;
  const caught = r.outcome === 'requires_changes' ? 1 : 0;
  const status = id => id.startsWith('tech:')
    ? (r.tech_checks || []).find(c => c.id === id.slice(5))?.status
    : (r.checks || []).find(c => c.id === id)?.status;
  const grade = {}, explanation = {};
  if (input.expected === 'requires_changes') {
    grade.recall_all = caught;
    const reasonCaught = x => (REASON_ACCEPT[x] || []).some(id => status(id) === 'fail');
    const why = xs => xs.map(x => `${x}: ${(REASON_ACCEPT[x] || []).map(id => `${id}=${status(id) ?? 'absent'}`).join(',') || 'no check'}`).join('; ');
    if (input.coverage === 'covered') {
      grade.recall_covered = caught;
      grade.right_reason = input.coveredReasons.filter(reasonCaught).length / input.coveredReasons.length;
      explanation.right_reason = why(input.coveredReasons);
    } else if (input.coverage === 'gap_only') grade.recall_gap = caught;
    else grade.recall_declared = caught;
    const gapReasons = input.reasons.filter(x => !(REASON_CHECKS[x] || []).length && (REASON_ACCEPT[x] || []).length);
    if (gapReasons.length) {
      grade.right_reason_gap = gapReasons.filter(reasonCaught).length / gapReasons.length;
      explanation.right_reason_gap = why(gapReasons);
    }
    explanation.recall_all = `outcome ${r.outcome}; expected requires_changes (${input.reasons.join(', ')})`;
  } else {
    // An approved fix whose downloaded file is probably not what Visa approved
    // (SUSPECT_FILE_TAGS): flagging it is not a false alarm about a Visa-approved
    // card, so it scores in its own column.
    if (SUSPECT_FILE_TAGS.some(t => input.caseTags.includes(t))) grade.specificity_suspect = caught ? 0 : 1;
    else {
      grade.specificity = caught ? 0 : 1;
      if (!input.caseTags.includes('approval_inferred_from_tokenization')) grade.specificity_explicit = grade.specificity;
    }
    const flagged = [...(r.checks || []), ...(r.tech_checks || []).map(c => ({ ...c, id: `tech:${c.id}` }))]
      .filter(c => c.status === 'fail').map(c => c.id);
    grade.false_flags = flagged.length;
    explanation.specificity = `outcome ${r.outcome}; failing: ${flagged.join(', ') || 'none'}`;
  }
  return { grade, explanation };
}

// Per-metric mean with a 95% CI (reps averaged within a case first, so the
// interval reflects case-to-case spread), plus measured cost, latency, errors.
function summarize(vdir, st) {
  const read = p => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const rows = read(join(vdir, 'results.jsonl')), errs = read(join(vdir, 'errors.jsonl'));
  const scored = new Set(rows.map(r => `${r.prompt_id}\0${r.rep}`));
  const openErrs = errs.filter(e => !scored.has(`${e.prompt_id}\0${e.rep}`));
  const prices = { 'claude-opus-4-8': { in: 5, out: 25 }, ...(st.prices || {}) };
  const cost = r => { const p = prices[r.model]; const u = r.usage || {}; if (!p) return NaN;
    return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
      + (u.cache_read_input_tokens || 0) * p.in * 0.1 + (u.cache_creation_input_tokens || 0) * p.in * 1.25) / 1e6; };
  const lines = [`${basename(vdir)}: ${rows.length} scored attempt(s), ${new Set(rows.map(r => r.prompt_id)).size} case(s), ${openErrs.length} unresolved error(s)`];
  for (const m of st.metrics || []) {
    const byCase = new Map();
    for (const r of rows) if (r.grade?.[m.id] !== undefined) (byCase.get(r.prompt_id) || byCase.set(r.prompt_id, []).get(r.prompt_id)).push(r.grade[m.id]);
    const xs = [...byCase.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length);
    if (!xs.length) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    const half = 1.96 * sd / Math.sqrt(xs.length);
    const pct = m.kind === 'binary' || (m.scale ?? 1) === 1;
    const fmt = v => pct ? `${(100 * v).toFixed(1)}%` : v.toFixed(2);
    lines.push(`  ${m.id.padEnd(22)} ${fmt(mean).padStart(7)}  ±${fmt(half)}  (n=${xs.length} cases)`);
  }
  const costs = [...rows, ...errs].map(cost).filter(Number.isFinite);
  const lat = rows.map(r => r.latency_s).filter(Number.isFinite).sort((a, b) => a - b);
  const q = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0) : '-';
  lines.push(`  cost $${costs.reduce((a, b) => a + b, 0).toFixed(2)} total (incl. failed attempts), `
    + `$${(costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length)).toFixed(3)}/attempt; latency p50 ${q(0.5)}s p90 ${q(0.9)}s max ${q(1)}s; `
    + `${lat.filter(x => x > 300).length} over the 300s prod cap`);
  if (openErrs.length) lines.push(`  errors: ${Object.entries(openErrs.reduce((a, e) => ({ ...a, [e.failure_class]: (a[e.failure_class] || 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.error(lines.join('\n'));
}

/** Side-channel perf fields beyond the built-ins (latency_s etc.). */
function perfFrom(run) {
  return {
    outcome: run.output?.outcome, agent_version: run.agent_version,
    tool_calls: run.tool_calls, model_requests: run.model_requests, tech_overrides: run.tech_overrides,
    unmapped_checks: (run.output?.unmapped_checks || []).length,
  };
}

// --- harness (you usually won't need to touch below this line) --------------

function parseArgs(argv) {
  const a = { flow: join(DEFAULT_DATA, 'hillclimb/virtual'), variant: 'baseline',
              model: undefined, reps: 1, concurrency: 4, timeoutS: 600,
              approveHarness: false, data: DEFAULT_DATA, agentVersion: undefined,
              only: null, graderCheck: null };
  // A flag at the end of argv would otherwise consume undefined - which for
  // --model equals the default and silently disables the served-model check.
  const val = (i) => { if (argv[i] === undefined) { console.error(`missing value for ${argv[i - 1]}`); usage(); process.exit(2); } return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--flow') a.flow = val(++i);
    else if (k === '--variant') a.variant = val(++i);
    else if (k === '--model') a.model = val(++i);
    else if (k === '--reps') a.reps = +val(++i);
    else if (k === '--concurrency') a.concurrency = +val(++i);
    else if (k === '--timeout-s') a.timeoutS = +val(++i);
    else if (k === '--approve-harness') a.approveHarness = true;
    else if (k === '--data') a.data = val(++i);
    else if (k === '--agent-version') a.agentVersion = +val(++i);
    else if (k === '--only') a.only = new Set(val(++i).split(',').map(x => x.trim()).filter(Boolean));
    else if (k === '--grader-check') a.graderCheck = val(++i);
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${k}`); usage(); process.exit(2); }
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) {
    // The report only reads directories named 'baseline' or 'v<N>' - any other
    // name runs to completion but spends the pass into a directory the Summary,
    // trajectory, and budget arithmetic never see.
    console.error(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
    usage(); process.exit(2);
  }
  if (a.graderCheck && !['oracle', 'approve-all', 'reject-all'].includes(a.graderCheck)) {
    console.error(`--grader-check must be oracle, approve-all, or reject-all`); usage(); process.exit(2);
  }
  if (a.agentVersion !== undefined && !(Number.isInteger(a.agentVersion) && a.agentVersion >= 1)) {
    console.error('--agent-version must be a positive integer'); usage(); process.exit(2);
  }
  if (!Number.isFinite(a.timeoutS) || a.timeoutS < 0
      || a.timeoutS * 1000 > 2147483647 // setTimeout clamps >2^31-1 ms to 1 ms - the ceiling would fire instantly
      || !Number.isInteger(a.reps) || a.reps < 1
      || !Number.isInteger(a.concurrency) || a.concurrency < 1) { usage(); process.exit(2); }
  return a;
}
function usage() {
  console.error('usage: node --env-file=.env.local evals/card-art/run-eval.mjs [--flow DIR] --variant ID --model ID --agent-version N [--reps N] [--concurrency N] [--timeout-s N (0 = no ceiling)] [--data DIR] [--only ID,ID] [--grader-check oracle|approve-all|reject-all] [--approve-harness]');
}

// Harness integrity gate. The hillclimb loop gets this runner command
// allowlisted for the session and then runs rounds unattended, while the
// per-round change (proposed by an analyzer fed untrusted transcripts) may
// legitimately edit harness code. Without this gate a round that rewrites the
// runner would execute attacker-chosen code on the next unattended run under
// the user's one-time approval. So: sha256 over this file plus every path in
// `_state.json.harness_paths` (relative to the directory the runner is invoked
// from, i.e. the repo root); compare to `_state.json.harness_sha`; refuse on
// absent/mismatch unless a human passes --approve-harness, which records the
// new sha. That write is the one sanctioned exception to "never write
// _state.json".
function checkHarness(statePath, st, approve) {
  const self = fileURLToPath(import.meta.url);
  const listed = Array.isArray(st.harness_paths) ? st.harness_paths.map(String) : [];
  const paths = [...new Set([self, ...listed.map(p => resolve(p))])].sort();
  const h = createHash('sha256');
  const hashed = [];
  for (const p of paths) {
    let buf;
    try { buf = readFileSync(p); }
    catch (e) {
      if (p === self) throw e;
      console.error(`warning: harness path '${relative(process.cwd(), p)}' not readable (${e?.code || 'error'}) - skipped`);
      continue;
    }
    h.update(relative(process.cwd(), p)).update('\0').update(buf).update('\0');
    hashed.push(relative(process.cwd(), p));
  }
  const sha = h.digest('hex');
  if (st.harness_sha === sha) return;
  if (approve) {
    st.harness_sha = sha;
    writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n');
    console.error(`harness approved: sha256 ${sha.slice(0, 12)} over ${hashed.length} file(s) recorded in ${statePath}`);
    return;
  }
  if (st.harness_sha == null) {
    console.error(`no approved harness sha in ${statePath} (computed ${sha.slice(0, 12)} over: ${hashed.join(', ')}).`);
    console.error('Review the harness, then run once with --approve-harness to record it.');
  } else {
    console.error(`harness changed since last approved run (files: ${hashed.join(', ')}); `
      + `approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
    console.error('Re-run with --approve-harness after reviewing the diff.');
  }
  process.exit(2);
}

// Transient provider errors (429 / overloaded / 5xx) retry with jittered
// exponential backoff - a zero-delay retry loop multiplies cost invisibly
// under rate limits and can turn one transient 429 into a torn-down batch.
// The attempt count lands in the row's meta (or the errors sidecar) so retry
// churn is visible in the data, not just the bill.
async function withBackoff(fn, retry, deadline = Infinity, tries = 5) {
  for (let attempt = 0; ; attempt++) {
    // Checked before every attempt, not just before sleeps: once the case's
    // ceiling has passed, an abandoned chain must not issue another call
    // (e.g. a judge call after the app call consumed the whole ceiling).
    if (Date.now() >= deadline) {
      const e = new Error('wall-clock ceiling exceeded before attempt');
      e.failure_class = 'timeout';
      throw e;
    }
    try { return await fn(); } catch (e) {
      const status = e?.status ?? e?.response?.status;
      const transient = status === 429 || status === 529 || (status >= 500 && status < 600)
        || /overloaded|rate.?limit/i.test(String(e?.message ?? ''));
      if (!transient || attempt >= tries - 1) throw e;
      const delay = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      // Never start a retry that would outlive the case's wall-clock ceiling - 
      // otherwise an abandoned chain keeps issuing API calls after the case failed.
      if (Date.now() + delay >= deadline) throw e;
      retry.count++;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Hard per-case wall-clock ceiling, independent of stream liveness - a hung
// SSE stream can emit keepalives forever, defeating inactivity-based timers.
// The underlying call may keep running; the case fails and the slot is freed.
function withTimeout(promise, seconds, label) {
  if (!(seconds > 0)) return promise;
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: exceeded ${seconds}s wall-clock ceiling`);
      e.failure_class = 'timeout';
      reject(e);
    }, seconds * 1000);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Case ids appear in file paths AND as the row/file join key the report uses,
// so rows, trace filenames, and frozen refs all carry the same path-safe id.
// When sanitization changes the id, a short content hash keeps distinct ids
// distinct ('case/1' vs 'case_1'); the original rides in meta.original_id.
function pathSafeId(id) {
  const raw = String(id);
  const cleaned = raw.replace(/[^\w.-]/g, '_');
  // Idempotent by construction: anything already path-safe and within the
  // length bound - including this function's own truncated+suffixed output - 
  // passes through unchanged. Long ids (URLs, prompt text as id) truncate to
  // 120 chars plus an 8-hex hash of the full original, so they fail here, not
  // at the trace write after the spend, and distinct ids stay distinct.
  if (cleaned === raw && raw.length <= 129) return raw;
  return `${cleaned.slice(0, 120)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vdir = join(args.flow, args.variant);
  mkdirSync(join(vdir, 'traces'), { recursive: true });
  // _state.json is READ-ONLY here. The orchestrator owns it. Absent is fine
  // (a baseline-only run has no loop state yet), but present-and-unparsable
  // must not let the id-space gate below pass vacuously over a corrupt file.
  const statePath = join(args.flow, '_state.json');
  let st = {};
  if (existsSync(statePath)) {
    try { st = JSON.parse(readFileSync(statePath, 'utf8')) || {}; }
    catch (e) { console.error(`${statePath} exists but is not valid JSON (${e?.message || e}) - fix it before spending a pass`); process.exit(2); }
  }
  // --grader-check never calls the model or the app, so it is exempt from the
  // harness gate (which guards unattended paid runs).
  if (!args.graderCheck) checkHarness(statePath, st, args.approveHarness);
  if (!args.graderCheck && !(args.model && args.agentVersion)) {
    // An unpinned agent resolves to "latest": a prompt push mid-run would
    // silently mix two agents in one variant.
    console.error('paid runs need --model and --agent-version (see the agent\'s current version in the Console)');
    process.exit(2);
  }
  const ctx = { ...args, state: st };

  // Resume: which (id, rep) pairs already have a row?
  const resultsPath = join(vdir, 'results.jsonl');
  const done = new Set();
  if (existsSync(resultsPath))
    for (const ln of readFileSync(resultsPath, 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      try { const r = JSON.parse(ln); done.add(`${r.prompt_id}\0${r.rep}`); } catch {}
    }
  // Rows key on the path-safe id (see pathSafeId), so resume must too.

  const cases = await loadCases(ctx);
  // Validate the id space before spending anything: duplicate path-safe ids - 
  // including case-insensitive twins, which macOS/Windows filesystems collapse - 
  // would silently overwrite traces and frozen refs; and a _state.json split id
  // that matches no case would silently shrink the scored denominator.
  const seen = new Map();
  for (const c of cases) {
    const k = pathSafeId(c.id).toLowerCase();
    if (seen.has(k)) {
      console.error(`duplicate case id after sanitization: '${c.id}' collides with '${seen.get(k)}'`);
      process.exit(2);
    }
    seen.set(k, c.id);
  }
  const safeIds = new Set(cases.map(c => pathSafeId(c.id)));
  for (const sid of [...(st.train_ids ?? []), ...(st.val_ids ?? []), ...(st.test_ids ?? [])]) {
    const s = String(sid); // the adapter joins with String() on both sides - numeric ids are fine
    if (safeIds.has(s)) continue; // matches a loaded case - definitionally valid
    if (s !== pathSafeId(s)) {
      // Can never match a row: rows key on path-safe ids. This is the silent
      // shrunken-denominator bug - fail before anything is spent.
      console.error(`_state.json split id '${s}' is not a path-safe id - record split ids exactly as they appear in results.jsonl's prompt_id`);
      process.exit(2);
    }
    // Well-formed but absent is legitimate (a trimmed top-K subset run) - note it, don't fail.
    console.error(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
  }
  const refDir = join(args.flow, 'baseline', 'ref');
  const tasks = [];
  for (const c of cases) for (let rep = 0; rep < args.reps; rep++) {
    if (done.has(`${pathSafeId(c.id)}\0${rep}`)) continue;
    tasks.push({ c, rep });
  }
  console.error(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (id,rep) to run`);

  let i = 0, ok = 0, fail = 0;
  const errorsPath = join(vdir, 'errors.jsonl');
  // A hard crash (power loss, ENOSPC) can leave a torn final line with no
  // trailing newline; the next append would merge two rows into one permanently
  // unparseable line. Isolate any fragment before appending anything.
  for (const p of [resultsPath, errorsPath]) {
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    if (buf.length && buf[buf.length - 1] !== 0x0a) appendFileSync(p, '\n');
  }
  async function worker() {
    while (i < tasks.length) {
      const { c, rep } = tasks[i++];
      const safeId = pathSafeId(c.id);
      const t0 = Date.now();
      let lastRun = null;    // survives into the catch - billed spend on a failed attempt
      let rowWritten = false; // set once the results row lands - the attempt is scored
      const deadline = args.timeoutS > 0 ? t0 + args.timeoutS * 1000 : Infinity;
      const appRetry = { count: 0 }, judgeRetry = { count: 0 };
      try {
        // One ceiling over the whole case - app call, identity check, and grading - 
        // so a hung judge stream can't hold the slot either.
        const { run, g, latency_s } = await withTimeout((async () => {
          let tAttempt = t0;
          const run = await withBackoff(() => { tAttempt = Date.now(); return runCase(c, ctx); },
            appRetry, deadline);
          lastRun = run;
          // latency_s = the final app attempt only; backoff sleeps, failed
          // attempts, and judge time are excluded (retry counts are in meta).
          const latency_s = (Date.now() - tAttempt) / 1000;
          // Serving identity: fail loudly when the response was served by a model
          // other than the one requested. Accept exact match or a documented
          // alias->snapshot resolution - 'foo-latest'/'foo-0'/'foo' served as
          // 'foo-20250101', 'foo@20250101', or 'foo-2025-01-01'. Anything else - 
          // another snapshot of the requested pin, a sibling model, or the bare
          // base id ('foo-latest' served as 'foo', an unversioned echo that can
          // hide snapshot drift across rounds) - fails the attempt. Non-Anthropic
          // id schemes (e.g. Bedrock's 'anthropic.claude-...-v1:0') need their own
          // rule here.
          if (ctx.model && run.model && run.model !== ctx.model) {
            const base = ctx.model.replace(/-latest$|-0$/, '');
            const rest = String(run.model).startsWith(base)
              ? String(run.model).slice(base.length) : null;
            if (!(rest != null && /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest))) {
              const e = new Error(`served model ${run.model} != requested ${ctx.model}`);
              e.failure_class = 'serving_substitution';
              throw e;
            }
          }
          // Frozen pairwise reference (never regenerated): baseline/ref/<id>.*
          let ref = null;
          if (args.variant !== 'baseline') {
            const p = join(refDir, safeId);
            for (const ext of ['', '.html', '.txt', '.json'])
              if (existsSync(p + ext)) { ref = readFileSync(p + ext, 'utf8'); break; }
          }
          const g = await gradeCase(c, run, ref, ctx); // programmatic: no retries needed
          return { run, g, latency_s };
        })(), args.timeoutS, `${c.id} rep${rep}`);
        const row = {
          prompt_id: safeId, rep, prompt: c.prompt ?? c.input ?? c.id,
          tags: c.tags, attachments: c.attachments,
          meta: safeId !== String(c.id) || appRetry.count || judgeRetry.count
            ? { ...(c.meta ?? {}),
                ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
                ...(appRetry.count ? { retries: appRetry.count } : {}),
                ...(judgeRetry.count ? { judge_retries: judgeRetry.count } : {}) }
            : c.meta,
          model: run.model, usage: run.usage, stop_reason: run.stop_reason,
          judge_model: g.judge_model ?? run.judge_model,
          judge_usage: g.judge_usage ?? run.judge_usage,
          latency_s, ...perfFrom(run),
          grade: g.grade, explanation: g.explanation,
        };
        appendFileSync(resultsPath, JSON.stringify(row) + '\n');
        rowWritten = true; // past this point the attempt is scored - a later throw (trace write, ref freeze) must not also append an error row
        if (run.transcript)
          writeFileSync(join(vdir, 'traces', `${safeId}_rep${rep}.json`),
            JSON.stringify(run.transcript, null, 2));
        // For pairwise: on the baseline run, freeze the reference output once.
        if (args.variant === 'baseline' && run.output != null && !existsSync(join(refDir, safeId))) {
          mkdirSync(refDir, { recursive: true });
          writeFileSync(join(refDir, safeId),
            typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        }
        ok++;
      } catch (e) {
        fail++;
        if (rowWritten) {
          // The attempt scored; only a post-row write (trace, ref) failed. An error
          // row here would double-count the billed usage under the budget rule.
          console.error(`  [${args.variant}] ${c.id} rep${rep} scored, but a post-row write failed: ${e?.message || e}`);
          continue;
        }
        // Failed attempts are data too - but they must not occupy the (case, rep)
        // slot in results.jsonl, or resume would never re-run them.
        appendFileSync(errorsPath, JSON.stringify({
          prompt_id: safeId, rep,
          ...(safeId !== String(c.id) ? { original_id: String(c.id) } : {}),
          failure_class: e?.failure_class ?? 'error',
          error: String(e?.message || e),
          retries: appRetry.count, judge_retries: judgeRetry.count,
          // Billed-but-failed spend stays countable: when the app call completed
          // before the failure (e.g. a served-model mismatch, a judge-stage
          // ceiling), carry its identity and usage on the error row.
          model: lastRun?.model ?? e?.model, usage: lastRun?.usage ?? e?.usage,
          judge_model: e?.judge_model ?? lastRun?.judge_model,
          judge_usage: e?.judge_usage ?? lastRun?.judge_usage,
          latency_s: (Date.now() - t0) / 1000,
        }) + '\n');
        console.error(`  [${args.variant}] ${c.id} rep${rep} FAILED: ${e?.message || e}`);
      }
    }
  }
  // One progress line every 30s (and to <vdir>/progress.txt) so "how far along
  // is it?" is answerable from the background shell's output or one file read,
  // without the orchestrator parsing results.jsonl mid-write. ETA is a plain
  // rate extrapolation from this pass.
  const t0 = Date.now();
  const progress = () => {
    const done = ok + fail, total = tasks.length;
    const el = (Date.now() - t0) / 1000;
    const eta = done ? Math.round((el / done) * (total - done)) : null;
    const line = `[${args.variant}] ${done}/${total} done (${ok} ok, ${fail} failed), `
      + `${Math.round(el)}s elapsed` + (eta != null ? `, ~${eta}s left` : '');
    console.error(line);
    try { writeFileSync(join(vdir, 'progress.txt'), line + '\n'); } catch {}
  };
  const tick = setInterval(progress, 30_000);
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  clearInterval(tick); progress();
  console.error(`[${args.variant}] done - ${ok} ok, ${fail} failed -> ${resultsPath}`);
  summarize(vdir, st);
  process.exit(fail ? 1 : 0);
}

main();

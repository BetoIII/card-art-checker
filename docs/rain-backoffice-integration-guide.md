# Automating Rain review with the card art checker

**For:** the back-office card design team (`rain@hackathon/backOffice`)
**From:** Beto — card art checker service
**Contract reference:** [`card-art-check-api-contract.md`](./card-art-check-api-contract.md) — every request/response shape, enum, and check id.

---

## What you get

Submit card art, get back a structured verdict on **18 Visa compliance rules** plus 4
technical checks: which passed, which failed, why, and where on the art. Enough to
approve or reject a design without a human opening the file.

A worked example — the BRAZA submission — came back `requires_changes` with one blocking
failure: `visa_brand_mark_position`, because the Visa mark sat in the lower-right corner
instead of an upper one. That verdict, its one-sentence summary, and an annotated PDF are
all in the payload.

---

## 1. Where it lands in your lifecycle

**`validation.ts` is unchanged. The checker is a second step that runs after it**, and it
automates the Rain review — not the submission gate.

```
POST /cardArtForms
      │
      ├─ validation.ts ──── fails ──> 422, nothing stored     (inline, sub-second)
      │                                                        the invariant holds
      └─ passes ──> GCS upload ──> row: UNDER_RAIN_REVIEW ──> 201 to the tenant
                                          │
                                          └──> card art checker  (async, 100–160s)
                                                     │
                          ┌──────────────────────────┴─────────────┐
                          ▼                                        ▼
                    RAIN_APPROVED                            RAIN_REJECTED
                          │                                  + rejectionReason
                          ▼
                  UNDER_VISA_REVIEW ──> VISA_APPROVED / VISA_REJECTED
```

Two layers, each doing what it's shaped for:

| | Runs | Decides | On failure |
|---|---|---|---|
| `validation.ts` | inline, sub-second | is this **storable**? PNG, 1536×969, DPI, ≤20MB, icon, colors, contact | `422` with field errors — nothing is stored |
| card art checker | async, 100–160s | is this **compliant**? 18 Visa rules | `RAIN_REJECTED` + `rejectionReason` |

This ordering earns three things:

- **Your invariant survives.** `repos/cardArtForm.ts` promises that "submissions failing
  the automated checks are never stored" — still true, because the gate is still
  synchronous. A 100–160s agent check could never have held that line without making the
  tenant wait two and a half minutes.
- **Instant feedback survives.** A 1024×768 upload is still rejected in milliseconds with
  *"Image size is incorrect."* The tenant never waits on us to be told something obvious.
- **Junk never reaches a paid agent run.** Only structurally valid art gets that far.

### One consequence worth knowing

Every submission that reaches the checker has already passed `validation.ts`, so our four
`tech_checks` (`dimensions`, `file_format`, `dpi`, `bleed_zone`) should now *always* pass.
You can ignore them for the review decision — but a `tech_checks` failure would mean the
two layers disagree about the same file, which is worth an alert rather than a shrug.

The two layers measure DPI differently and it no longer matters: `validation.ts` rejects a
*declared* density that isn't exactly 72, and it runs first, so a 300-DPI PNG never
reaches our (more permissive) calculated ≥ 72 check.

---

## 2. Something to resolve first

Two enums in the branch disagree, and they can't both be right:

| Source | Values | Row born as |
|---|---|---|
| `rain-api/lib/api/repos/cardArtForm.ts` | `UNDER_RAIN_REVIEW`, `RAIN_APPROVED`, `RAIN_REJECTED`, `UNDER_VISA_REVIEW`, `VISA_APPROVED`, `VISA_REJECTED` | `UNDER_RAIN_REVIEW` |
| `packages/rain-api-contract/…/cardArtForms.schemas.ts` | `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `REJECTED` | `SUBMITTED` |

The contract package calls itself "single source of truth shared by rain-api,
rain-frontend and rain-admin; do not copy these values into app code" — but
`convertDatabaseCardArtFormStatusToApiStatus` maps the six DB values to six *camelCase*
wire values (`underRainReview`, …) that the contract package doesn't contain.

**This is yours to settle, not ours** — we just need to know which vocabulary the
transition code should write. Everything below uses the six-value `CardArtFormStatus`.

---

## 3. What you build

### 3.1 Config

```
CARD_ART_CHECKER_URL=https://card-art-checker.vercel.app
CARD_ART_CHECKER_SECRET=<ask Beto>
CARD_ART_RESULT_WEBHOOK_SECRET=<generate; give us the value>
```

### 3.2 Schema

Enough to correlate a result with its row and stay idempotent:

```sql
ALTER TABLE "card_art_forms" ADD COLUMN "checkRunId"    VARCHAR(64);
ALTER TABLE "card_art_forms" ADD COLUMN "checkedAt"     TIMESTAMPTZ;
ALTER TABLE "card_art_forms" ADD COLUMN "checkOutcome"  VARCHAR(32);
CREATE UNIQUE INDEX "card_art_forms_checkRunId_key" ON "card_art_forms" ("checkRunId");
```

`rejectionReason` already exists — that's where the verdict's summary goes.

### 3.3 Fire the check

In `createCardArtForm`, once the row exists and while you still hold the buffer:

```ts
const form = new FormData()
form.append("file", new Blob([body.cardArt.buffer], { type: "image/png" }), body.cardArt.filename)
form.append("cardType", "virtual")
form.append("reference", cardArtForm.id)   // comes back on trigger.reference

const res = await fetch(`${CARD_ART_CHECKER_URL}/api/card-check?async=1`, {
  method: "POST",
  headers: { Authorization: `Bearer ${CARD_ART_CHECKER_SECRET}` },
  body: form,
})
const { runId } = await res.json()
await fastify.prisma.cardArtForm.update({ where: { id: cardArtForm.id }, data: { checkRunId: runId } })
```

`?async=1` returns in well under a second — it responds as soon as the file is parsed and
runs the analysis in the background. **Don't let a checker outage fail the submission:**
wrap it, log it, leave the row `UNDER_RAIN_REVIEW` for a human or a retry. The tenant's
201 should not depend on us being up.

### 3.4 Receive the verdict

Stand up a route and tell us the URL — we'll point `RESULT_WEBHOOK_URL` at it, or
allowlist your host so per-request `callbackUrl` works. Until then you can poll
`GET /api/result/{runId}`, but push is less code on both sides.

```ts
// POST /internal/cardArtForms/checkResult
const raw = req.rawBody                       // verify BEFORE parsing — re-serializing changes the bytes
const ts  = req.headers["x-card-art-timestamp"]
const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")
const a = Buffer.from(expected), b = Buffer.from(req.headers["x-card-art-signature"] ?? "")
if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.status(401).send()

const { event, run_id, data } = JSON.parse(raw)
```

The timestamp is inside the signed material, so a captured request can't be replayed with
a fresh one. Same scheme as the Dock webhook you already verify, inverted. Reply `2xx`
quickly and do the work after — we retry `5xx` three times with backoff, and treat any
other `4xx` as final.

### 3.5 Transition

```ts
if (event === "card_art_check.failed") return   // the checker broke — NOT the design's fault
if (form.checkedAt) return                      // already applied; deliveries are at-least-once

const status =
  data.outcome === "approved"            ? CardArtFormStatus.RainApproved  :
  data.outcome === "approved_with_notes" ? CardArtFormStatus.UnderRainReview : // hold for a human
                                           CardArtFormStatus.RainRejected

await repo.update(form.id, {
  status,
  checkOutcome: data.outcome,
  checkedAt: new Date(),
  rejectionReason: status === CardArtFormStatus.RainRejected ? data.summary : null,
})
```

| Result | → | Status |
|---|---|---|
| `outcome: "approved"` | → | `RAIN_APPROVED` |
| `outcome: "approved_with_notes"` | → | stay `UNDER_RAIN_REVIEW` — clean enough to pass, worth a human glance |
| `outcome: "requires_changes"` | → | `RAIN_REJECTED` + `rejectionReason` |
| `event: "card_art_check.failed"` | → | **no transition** — retry or escalate |

Two rules worth stating plainly:

- **Branch on `outcome`, never `status`.** The payload's top-level `status` is a legacy
  two-state field where `approved_with_notes` collapses to `pass` — using it silently
  erases the distinction the review flow exists to make. (A third value, `error`, marks a
  broken run.)
- **Bind to `checks[].id`, never `checks[].name`.** The id is the contract; the name is
  display text the model may reword.

`data.summary` is 1–2 sentences and fits `VARCHAR(1024)`. For per-field errors in the
panel, `blocking_failures[]` gives you the ids to cite and each check carries `notes` and
a `reason_code` — the same `{field, code, message}` triple your 422 path already renders.

---

## 4. What we've already done

| | |
|---|---|
| `projectId` no longer required | Authenticated callers may omit it — you have a `tenantId`, not a Rocketlane project. Rocketlane lookup is skipped entirely rather than failing the run. |
| `?async=1` | Returns JSON with a `runId` immediately instead of a 160-second SSE stream. |
| `reference` | Your correlation id, echoed back on `trigger.reference`. |
| Signed push delivery | Verified end to end against a live receiver: signature verifies, tampered body/secret/timestamp all rejected, `5xx` retried 3× with backoff, `4xx` not retried, physical results never sent, lookalike hosts refused. |

Live in production, `main@0b0a759`.

---

## 5. What we need from you

1. **Which status vocabulary** the transition code should write (§2).
2. **A receiving URL**, plus a webhook secret you generate. Then push delivery is one
   config change on our side.
3. **Whether `approved_with_notes` should auto-approve** or hold for a human. We've
   assumed hold.

Settled: the checker is an additional step after `validation.ts`, which keeps its
structural checks and its role as the pre-store gate.

---

## 6. Known limits

- **Virtual only.** Physical results carry `schema_version: "0-internal"`, are never
  pushed, and their enums may change. Back-office art is PNG/virtual, so this shouldn't bite.
- **The icon is never analyzed** — only the card art.
- **`resultUrl` and `report.pdf_url` are public blob URLs.** Unguessable, but
  unauthenticated — treat them as secrets.
- **Every submission that clears `validation.ts` costs an agent run.** That's the point of
  keeping the structural gate in front.

Questions → Beto.

# Phase 12 — Planning-driven website imagery

Status: **implemented, off by default, not verified against a live provider.** Nothing in
this phase has been exercised against a real OpenRouter image call, a real Supabase
database, or the real Storage bucket. See "What is verified" at the end.

## Why

A fixed number of images per generation is wrong for every website: a landing page needs a
hero and maybe two supporting visuals, an e-commerce store needs product imagery per
product plus category and campaign art, and a large catalog needs far more than either. The
image count therefore has to be a *planning* decision — and the money it spends has to be a
*backend* decision. This phase separates the two.

## Authority model

| Question | Answered by | Never by |
|---|---|---|
| Which images does this site need? | Planning Agent (`images` in the plan JSON) | — |
| Is that plan structurally valid? | `validateImagePlan` (`src/lib/images/manifest.ts`) | the model |
| How many assets are paid for? | `approveImagePlan` + `imagePlanningPolicyFor` | the model |
| Is this asset allowed to call the provider now? | `claim_image_asset` (migration 33) | the stage |
| Is the asset ready? | `complete_image_asset` after upload | the provider |
| What did it cost? | provider-reported usage, or `NULL` + `cost_known = false` | an estimate presented as fact |

A model response can shrink these limits (fewer images than the budget) and can never
raise them. There is no code path in which agent output becomes configuration.

## Plan schema (version 1)

The planner adds two top-level fields to its existing plan JSON:

```jsonc
{
  "siteType": "landing" | "saas" | "content" | "local" | "ecommerce" | "catalog" | "other",
  "images": [
    {
      "assetId": "hero-home",          // ^[a-z0-9][a-z0-9_-]{0,63}$, unique in the plan
      "pagePath": "/",                  // site-relative, no scheme/host/traversal/whitespace
      "sectionId": "hero",              // optional, <= 64 chars
      "purpose": "hero" | "product" | "category" | "editorial" | "feature"
               | "background" | "team" | "testimonial" | "logo" | "other",
      "required": true,                 // a page is incomplete without it
      "priority": 1,                    // 1 (highest) .. 5
      "prompt": "…",                    // 1..1000 chars
      "aspectRatio": "16:9",            // the model's own enum only
      "productId": "arc-lamp",          // optional
      "productImageIndex": 0,           // optional, 0..20
      "reuseKey": "spring-campaign",    // optional: two placements, one generated asset
      "alt": "…"                        // optional, <= 200 chars
    }
  ]
}
```

Validation is all-or-nothing: a malformed entry rejects the **whole plan**, which the run
reports and the coding agent then works without. Building a site from a half-read image
manifest would put the wrong picture on a page and hide that the plan was broken. The
website plan itself is unaffected.

## Budget and approval

Planning guidance by site type (what the planner is told) and the backend ceiling (what it
can actually get) are different things:

| Site type | Guidance | Backend ceiling |
|---|---|---|
| landing / portfolio | 3–8 | `MAVLY_IMAGE_MAX_ASSETS` (default 40) |
| SaaS | 5–12 | same |
| blog / content | 5–15 | same |
| restaurant / local | 6–15 | same |
| e-commerce | 15–40 | same |
| large catalog | 40–80 | 80, only when the project is in `MAVLY_IMAGE_LARGE_CATALOG_PROJECTS` **and** the plan names a `catalog` |

Two independent ceilings apply: the asset count and `MAVLY_IMAGE_MAX_RUN_COST_USD`
(default 0.30, hard-capped at 1.00) against the model's verified price of **$0.007 per
output image**. Approval order is required-first, then priority, then `assetId`; everything
past either ceiling becomes `deferred` — recorded, named in the run summary and never
reported as ready.

`deferred`, `failed`, `pending` are distinct states. A deferred or failed placement is
described to the coding agent as unavailable, so the page keeps its layout slot with a
placeholder instead of inventing a URL.

## Execution

The stage is not a second pipeline. It runs inside the existing durable run, in
`src/lib/mavly/run-agent.ts`, between the persisted plan and the first code batch:

```
plan validated → policy resolved → approve → sync_image_plan (plan + rows)
  → per asset: claim_image_asset → generateImage → validate bytes → upload → complete_image_asset
  → finish_image_plan (settles status from the rows)
  → references handed to the coding batches
```

- **Idempotency.** `claim_image_asset` atomically flips one row to `generating` and
  increments its attempt count; a second worker (or a resumed run) gets `NULL` and makes no
  provider call. A stale `generating` claim is reclaimable after five minutes, so a crashed
  worker cannot strand an asset permanently. `sync_image_plan` never rewrites a `ready` or
  `generating` row.
- **Duplicates.** The visible contract is `(project_id, run_id, asset_key)`; a resumed run
  skips rows that are already `ready`, and the storage path
  `<project_id>/<run_id>/<asset_key>.<ext>` is deterministic with `upsert: true`, so a retry
  after a crash between upload and completion overwrites instead of duplicating.
- **Reuse.** Rows from an **earlier run of the same project** with a matching `reuse_key`
  are copied into the new row at a recorded cost of zero — no provider call. There is no
  cross-project or shared-asset scope, so one user's imagery can never satisfy another's
  plan.
- **Bounds.** `MAVLY_IMAGE_CONCURRENCY` (1..4, default 2), `MAVLY_IMAGE_TIMEOUT_MS`
  (5s..120s, default 45s), `MAVLY_IMAGE_MAX_ATTEMPTS` (1..3, default 2) and a stage
  deadline of at most 60s that always leaves 60s for the code batches and finalization.
  Each provider request is additionally capped by the time left in that slice, so one slow
  image cannot run past it. When the remaining run budget cannot spare the slice, the stage
  starts nothing and says so.
- **Cancellation.** The run's own ownership/cancellation fence is awaited before every
  claim; a cancelled run stops scheduling, keeps finished assets and reports the rest as
  pending. A provider request already in flight cannot be un-sent.
- **Cost.** Each attempt records the provider's reported cost when it reports one; a
  timeout or an unreadable response leaves `actual_cost_usd` NULL and `cost_known` false,
  because a timeout does not prove the provider did not generate and bill.

## Storage

Generated site imagery is public website content, so the bucket is public-read with a
server-derived, unguessable path and no listing. Uploads and updates require the owner's
project row (`storage.foldername(name))[1]` matched against `public.projects`). The plan and
asset rows stay owner-only through `projects` RLS. Binary bytes never enter Postgres, and
project files, secrets and credentials are never written to this bucket.

## What this phase deliberately does not do

- **No credit price.** The Phase 11 credit foundation prices generation runs. Charging per
  image would be a new charging policy, so this phase adds no reservation, charge, refund or
  settlement, and alters no credit, payment or pricing table. Provider spend is operator
  spend.
- **No second model, no fallback.** `MAVLY_IMAGE_MODEL` is a selector over a one-entry
  catalog; anything else resolves to the locked model.
- **No public preview URL for assets beyond the bucket URL**, no reference-image input, no
  post-processing (crop/resize), no cross-project asset library, no UI to edit a plan.
- **No credit or run-state change.** A failed image stage never fails the generation; a
  required image that failed is reported in the run message.

## QA / Security

QA and Security reviews (Phase 10) are advisory and run after the run is terminal; they do
not gate it. Consequently the image invariants that actually gate behaviour live in code,
not in a review: the plan validator, `approveImagePlan`, the SQL ceiling and the claim RPC.
The QA/Security prompt framing is unchanged.

## Rollout

1. Apply `supabase/migrations/33_project_image_assets.sql` (after 32 and after `03`;
   additive, non-destructive). It creates the two tables, the owner-checked RPCs, schema
   marker 33 and the `project-images` bucket.
2. Set `MAVLY_IMAGE_PLANNING_ENABLED=1`, keep `OPENROUTER_API_KEY` server-side.
3. Optionally tune `MAVLY_IMAGE_MAX_ASSETS`, `MAVLY_IMAGE_MAX_RUN_COST_USD`,
   `MAVLY_IMAGE_CONCURRENCY`, `MAVLY_IMAGE_TIMEOUT_MS`, `MAVLY_IMAGE_MAX_ATTEMPTS`,
   `MAVLY_IMAGE_STORAGE_BUCKET`.
4. To allow 80 images for a specific large catalog, add that project id to
   `MAVLY_IMAGE_LARGE_CATALOG_PROJECTS`. Never `*`.
5. Watch the `image.plan` / `image.stage` structured events: they carry the status, reason,
   approved/ready counts, model and reported cost (with `costKnown`). Plans with a high
   deferred count mean the ceiling, not the planner, is the binding constraint.

With the flag unset, the planner is never asked for images, the stage never runs, and
generation is exactly the previous behaviour.

## What is verified

- The model id, aspect-ratio enum, `n` range, `supports_streaming: false` and the $0.007
  per-image price were read from
  `https://openrouter.ai/api/v1/images/models/recraft/recraft-v4.1-flash/endpoints`
  on 2026-10-29. No paid generation was made.
- `tests/image-planning.test.ts` covers validation, approval/budget, reuse, idempotency,
  storage failure, uncertainty, cancellation, deadlines and the coding prompt contract
  with every provider/database call mocked.
- `tests/image-generation.test.ts` covers the model catalog, the request shape, response
  validation, failure classification and retry safety, also mocked.

**Not verified:** migration 33 against a real database, the RLS policies, the Storage
bucket policies, a real provider image, a real upload, and the end-to-end run with a live
model. Until those are exercised, treat this as unproven in production.

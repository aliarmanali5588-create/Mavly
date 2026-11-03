# Mavly generation reliability overhaul report

**Date:** 2026-11-03  
**Evidence class:** static repository inspection and focused implementation review

## Executive summary

The repository already contains durable generation runs, fenced worker leases,
checkpointed batches, streamed OpenRouter calls, bounded retries, image planning,
credit reservations, static verification, optional runtime verification, and
multi-agent orchestration.

This pass fixed a remaining deadline defect in the opt-in specialist layer. Planner
and UI/UX calls now inherit the parent run's remaining budget, preserve a 120-second
Coding reserve, clamp each provider call to the time actually available, and keep the
separate post-coding QA/Security review reserve. Insufficient time produces a
structured orchestration skip instead of silently starving Coding.

## Root cause

The orchestration workflow used its own configured wall-clock limit and passed each
role's full timeout to the provider. That deadline was independent of the durable
run's shared deadline. A slow specialist could consume the source-generation window
or extend the worker tick beyond its bounded execution budget.

## Files changed in this pass

- `src/lib/orchestration/engine.ts` — shared/pre-coding deadlines and per-role timeout clamping.
- `src/lib/mavly/run-agent.ts` — Coding reserve, eligibility-aware skip event, and review-window handoff.
- `tests/multi-agent-orchestration.test.ts` — static contract assertions for deadline propagation.
- `docs/architecture/generation-reliability.md` — root cause and evidence update.
- `docs/reports/generation-reliability-overhaul.md` — this report.

## Database migrations

None added. The fix uses existing run budgets and workflow persistence.

## Agent verification

| Role | Repository evidence | Live evidence |
|---|---|---|
| Planner | Implemented in orchestration engine; pinned model routing | Not run |
| UI/UX | Implemented as design review; pinned model routing | Not run |
| Coding | Existing `generateApp` is the only project-file writer | Not run |
| QA | Existing post-coding advisory review plus sandbox evidence path | Not run |
| Security | Existing advisory review plus deterministic static scan | Not run |
| Repair | Existing bounded diagnosis path | Not run |
| Deployment | Existing deterministic proposal/approval path | Not run |

The seven-role layer remains opt-in and worker/cohort scoped by product design.

## Detailed Phase 2 audit

### 1. Previous deadline fix: static verification

| Requirement | Repository evidence | Result |
|---|---|---|
| Parent run deadline | `run-agent.ts` computes `remainingRunMs(guard.budget, Date.now())` before orchestration and passes a bounded `maxWallClockMs` to `beginOrchestration`; `engine.ts` clamps it with `Math.min(config.maxWallClockMs, input.maxWallClockMs)` | Verified by inspection |
| Planner/UI/UX clamp | `engine.ts` gives `plan` and `design-review` an absolute `preCodingDeadlineAtMs`; each role timeout is `min(configured timeout, remaining - 10s)` | Verified by inspection |
| Coding reserve | `ORCHESTRATION_CODING_RESERVE_MS = 120_000`; orchestration is not started unless at least 30 seconds remain after that reserve | Verified by inspection |
| Post-coding reviews | `POST_CODING_REVIEW_RESERVE_MS = 20s × 2 + 10s`; the worker generation budget is derived from the same reserve and the orchestration handle receives the review window | Verified by inspection |
| Structured skip | An eligible run with less than the shared pre-coding window emits `orchestration.skipped` with `reason: insufficient_shared_budget`; setup failures emit `setup_failed` | Verified by inspection |
| Worker compatibility | The worker's 300-second function budget reserves 20 seconds for finalization, 10 seconds of margin and 50 seconds for QA/Security; the resulting generation budget is 220 seconds before earlier stages consume it | Verified by inspection |
| Negative remaining time | A negative orchestration window is used only by the `>= 30_000` gate; `generateApp` receives `Math.max(0, remainingRunMs(...))`; role calls refuse less than 20 seconds including their 10-second persistence reserve | Verified for the production call path |

The focused regression added in `tests/multi-agent-orchestration.test.ts` is a source-contract
test. It confirms that the deadline symbols and wiring exist, but does not invoke the engine
with a fake clock, provider, Supabase client or worker lease. The optional `BeginInput` fields
are not a public request surface; direct callers can still supply `NaN`/`Infinity`, so that
edge is not runtime-proven by the current test.

### 2. Exact seven-role execution matrix

The role catalog contains seven logical roles, but the engine does not execute seven model
calls for every prompt. The existing `generateApp` manifest planner is separate from the
optional Phase 10 Planner role.

| Role | Actual implementation | Execution condition | Output consumed | Failure visibility |
|---|---|---|---|---|
| Planner | `runPlanner()`; pinned `deepseek/deepseek-v4-pro` | Worker-dispatched project, ready multi-agent configuration, explicit cohort, and non-`simple` complexity | `planContext` is passed to UI/UX and the Coding prompt | Failed task is stored; Coding can continue because this plan is advisory |
| UI/UX | `runDesignReview()`; pinned `anthropic/claude-sonnet-5` | Same gates, only after Planner returns a usable `planContext` | `designDirectives` is passed to Coding | Failed task is stored; it is an optional dependency |
| Coding | Existing `generateApp()`; only `onBatch` path writes project files | Every generation, including non-cohort and inline runs; in a workflow it is marked as `implement` | Generates the manifest, image references, batches, checkpoints and source | Run failure is terminal/retryable under the ordinary generation state machine; workflow records the coding task |
| QA | `recordQa()`; pinned `openai/gpt-5.6-sol` plus recorded runtime evidence | Successful Coding completion inside an active orchestration workflow | Workflow task, checks and review summary; does not authorize or rewrite the run | Failed/pending result is visible in workflow and the post-run chat notice; it cannot undo a completed run |
| Security | `runSecurityReview()`; deterministic scan plus pinned `anthropic/claude-sonnet-5` review | Successful Coding completion inside an active orchestration workflow | Findings and workflow state; critical findings fail the workflow only | Task failure/critical findings are persisted and reported separately from the completed run |
| Repair | `runRepairDiagnosis()`; pinned `deepseek/deepseek-v4-pro` | Coding failure, repair flag enabled, a remaining bounded repair attempt, and an orchestration handle | Bounded path-validated suggestions become subordinate context on a later eligible Coding retry; Repair never writes source | Failed diagnosis is a failed task; no source change or fabricated recovery occurs |
| Deployment | `recordDeploymentTask()`; deterministic, no model | Task exists for `standard`/`complex` workflows after QA/Security; absent for `simple` | Records that deployment still needs an owner-approved proposal; never deploys | Skipped/deterministic state is visible in the workflow; approval is enforced separately by the deploy path |

The exact task sets are:

- `simple`: Coding, QA, Security. Planner, UI/UX and Deployment tasks are not created.
- `standard`/`complex`: Planner, UI/UX, Coding, QA, Security and Deployment.
- Repair is not in the happy-path graph; it is added only after Coding failure when enabled.
- Outside the worker/cohort gates, the existing Coding pipeline still runs, but the six
  orchestration-only specialist stages (Planner, UI/UX, QA, Security, Repair and Deployment)
  do not run as Phase 10 tasks.

The workflow is sequential in the current engine. `selectRunnable()` can express bounded
read-only concurrency, but `engine.ts` does not use it to fan out specialist provider calls.

### 3. Can an agent silently skip?

| Situation | Durable record | Operator/owner visibility |
|---|---|---|
| Feature disabled, invalid/missing cohort or missing worker/key | No workflow is created | Workflow API/panel reports disabled configuration; generation uses the existing pipeline |
| Inline run in a listed project | No workflow is created | `orchestration.skipped` is emitted with `orchestration_requires_worker_dispatch`; panel explains inline runs record no workflow |
| Insufficient shared budget | No workflow is created | Structured `orchestration.skipped` log with `insufficient_shared_budget`; no owner-visible durable event is added |
| Workflow setup/storage failure | Usually no usable workflow | Structured `orchestration.skipped` log with `setup_failed`; the existing generation remains non-fatal |
| Planner/provider/model/parser failure | Workflow/task row exists | Task is `failed` with an error class; Coding still may proceed because the specialist output is advisory |
| QA/Security failure after source completion | Workflow/task row exists | Workflow panel and post-run message report it; `project_runs` remains completed |
| Deployment role | Task is intentionally `skipped` | Workflow states that an owner proposal/approval is still required |

Therefore “failed agent execution is visible” is true for an existing workflow task and the
structured log path, but not every skip is durable or shown in the owner panel. In particular,
the current insufficient-budget and setup-failure events are log evidence, not rows in
`agent_workflow_events`. This is an observability limitation, not evidence that the role ran.

### 4. Human-run verification commands

These commands are copied from the repository's package/test configuration and runbooks. They
were not executed here.

Focused orchestration contract:

```bash
node --import ./tests/register.mjs --test tests/multi-agent-orchestration.test.ts
```

Focused generation, deadline, stream, checkpoint, worker and observability contracts:

```bash
node --import ./tests/register.mjs --test \
  tests/generation-reliability.test.ts \
  tests/generation-budget.test.ts \
  tests/provider-streaming.test.ts \
  tests/generation-checkpoints.test.ts \
  tests/generation-state-machine.test.ts \
  tests/generation-observability.test.ts \
  tests/generation-worker-config.test.ts \
  tests/generation-worker-migration.test.ts \
  tests/generation-claim-verification.test.ts \
  tests/generation-worker-route.test.ts
```

Image and verification contracts:

```bash
node --import ./tests/register.mjs --test \
  tests/image-planning.test.ts \
  tests/image-generation.test.ts \
  tests/image-generation-limits.test.ts \
  tests/static-verification.test.ts \
  tests/verification-policy.test.ts \
  tests/runtime-verification.test.ts \
  tests/runtime-verification-repair.test.ts \
  tests/verification-state.test.ts
```

Repository-wide checks:

```bash
npx tsc --noEmit
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run lint
npm run build
npm test
```

`npm test` requires Node 22.6+ in this repository. The application runtime remains Node 20+
per `AGENTS.md`.

For a disposable staging database, the Phase 10 runbook gives the migration and marker check:

```bash
psql "$DATABASE_URL" -f supabase/migrations/29_multi_agent_orchestration.sql
psql "$DATABASE_URL" -c "select public.multi_agent_schema_version();"
psql "$DATABASE_URL" -c "select public.generation_worker_schema_version(), public.account_restriction_schema_version();"
```

The worker must report marker 32 or newer and account-restriction marker 49 or newer before a
current worker tick is considered ready. Apply the normal migration history first; do not use
the marker query as proof that migrations were applied successfully. If image planning is
enabled, apply migration 33 through the normal migration workflow and confirm
`public.project_image_schema_version()` returns 33. If sandbox verification is enabled, the
runbook requires migrations 17 and 19 and `public.verification_schema_version()` returning 19.

### 5. Missing test coverage

The repository has strong pure/static contracts, but these cases remain untested:

1. A fake-clock integration of `beginOrchestration()` and `callRoleModel()` proving exact
   Planner/UI/UX timeout values at 20/30/120-second boundaries.
2. A test that asserts no provider call occurs when the shared-budget gate skips orchestration,
   and that the emitted skip event has the expected run/trace/worker identifiers.
3. A worker-shaped integration test covering Planner failure, optional UI/UX failure, Coding
   failure, Repair diagnosis, QA/Security failure and Deployment skip in one persisted task
   graph.
4. A test for setup failure and insufficient-budget visibility through the owner workflow API,
   not only source regexes and console events.
5. A real Supabase/RPC concurrency test for migration 29 task transitions, migration 16 lease
   fencing and the 2-user/8-global admission lock.
6. A migration-33 static contract suite; image tests currently exercise mocked storage/RPC
   seams and the provider parser, not the SQL/RLS/Storage bucket.
7. An end-to-end image test from a generated manifest through `runAgent`, persisted asset URL,
   generated app source, a real Next.js build and a browser/rendered image.
8. Provider, worker-restart, storage-failure, lease-expiry, credit-reconciliation and load
   failure-injection tests against disposable staging infrastructure.

### 6. Image lifecycle audit

The current image path is:

```text
manifest planner output
  → validateImagePlan / approveImagePlan
  → sync_image_plan (migration 33)
  → claim_image_asset
  → OpenRouter /api/v1/images
  → base64 decode + PNG/JPEG signature/size validation
  → Storage upload to project-images
  → complete_image_asset
  → persisted public URL/reference
  → coding batch prompt
  → generated Next.js source
```

The lifecycle is structurally bounded and idempotent, but these are the exact failure
boundaries:

| Boundary | Failure modes | Truthful result |
|---|---|---|
| Planning/validation | Missing/invalid image plan, duplicate ids/placements, unsafe page path, unsupported ratio, oversized model plan | Plan rejected; no paid image call |
| Backend approval | Flag off, missing provider key, Android project, cohort/count/spend ceiling, migration 33/RPC failure | Stage disabled, deferred or persist-failed; Coding proceeds with placeholders |
| Claim | Another worker owns the row, asset already ready, stale/attempt limit, RPC failure | No provider call for that asset; it remains pending or is reused |
| Provider request | Auth/configuration, invalid request, content filter, rate limit, transient response, timeout/network failure, URL-only or malformed body | Asset failed or remains uncertain/pending; unsafe retries are avoided |
| Bytes | Empty, invalid base64, non-PNG/JPEG signature, over provider response cap | Asset is not uploaded or marked ready |
| Storage | Upload failure, invalid derived path, bucket/RLS failure, missing public URL | Provider cost is retained; asset is failed and not ready |
| Metadata completion | `complete_image_asset` failure after bytes upload, lease/ownership failure, database outage | Bytes may exist, but the row remains pending and the URL is not supplied to Coding |
| Coding reference | Only persisted `result.references` are passed; deferred/failed assets are named without URLs | Generated source keeps a placeholder slot; it must not invent a URL |
| Preview | `preview.html` is explicitly forbidden from using remote image URLs | Static preview cannot prove image rendering; it uses CSS placeholders |
| Real app rendering | Generated Next.js source needs an isolated build/runtime and an authenticated/browser-capable observation path | Not verified in this repository |

The stage's current implementation intentionally reports a partial image set separately from
generation success. A ready row requires storage metadata and bytes, but the actual website is
not proven to render that URL until a real generated app is built and viewed. The current test
suite mocks provider, Storage and RPC seams; it does not perform that final lifecycle.

There is also a cost-accounting distinction worth preserving in staging results: an image
timeout/network/transient/unknown outcome has unknown provider spend, while a definite refusal
is recorded as zero. Images do not reserve or settle Mavly generation credits.

### 7. Controlled staging generation plan

Use a disposable Supabase project, a disposable OpenRouter account/project or approved test
quota, and one worker host. Do not point staging at production. Keep the image flag and
verification flag off for the first baseline, then enable them in separate passes.

#### Baseline pass: generation and orchestration

1. Apply the normal migrations required by the worker and the selected features. Confirm worker
   markers before admitting work; confirm migration 29 for workflow rows and migration 33 only
   before enabling planning-driven images.
2. Set one explicit multi-agent project cohort, keep repair disabled, and use the current
   default provider model. Record the exact environment configuration without recording secret
   values.
3. Submit one prompt in each category below, one at a time first. Use a stable client request
   id for each launch and record the returned `runId`.
4. For every run, join the run row, structured log lines, provider-attempt metadata, workflow
   tasks and generated file rows by `runId`/`traceId`.
5. Repeat each category at least 10 times before computing a rate; retain every failure rather
   than replacing it with a retry result.

| Case | Prompt shape | Expected orchestration shape |
|---|---|---|
| Simple landing page | One-page marketing landing page, no persistence | Coding + post-run QA/Security only in the workflow; no Phase 10 Planner/UI/UX task |
| Multi-page business | Home, services, about, contact, responsive navigation | Planner → UI/UX → Coding → QA/Security → Deployment proposal |
| E-commerce | Product listing/detail/cart prototype with named image placements | Same complex graph; image plan only when image planning is enabled |
| SaaS | Dashboard, pricing, auth/persistent data requirements as applicable | Complex graph; managed backend is a separate opt-in gate and must be recorded independently |
| Image-heavy | Catalog or editorial site with required and optional imagery | Image plan approval, claim/provider/storage/metadata counts and Coding URL references |

For each run capture:

```text
runId, traceId, projectId, dispatchMode, workerId, jobAttempt
queueLagMs, acceptedAt, claimedAt, firstProviderAt, lastProviderAt, finishedAt
workflow state and every task status/attempt/errorClass
provider request/attempt ids, role/phase, model, HTTP status, finish reason
prompt/completion/reasoning/total tokens, costUsd, costKnown
manifest path count, checkpoint count, files written, source hash
image planned/approved/ready/failed/deferred/pending, image costKnown
static verification status and checks
runtime/verification status if separately enabled
final project run status, terminal error class, total duration
```

#### Image pass

After the baseline, apply migration 33, enable image planning for one disposable project and
run the image-heavy case. Inspect:

```sql
select * from public.project_image_plans
 where project_id = '<project-id>' order by created_at desc limit 5;

select asset_key, status, attempt_count, cost_known, actual_cost_usd,
       storage_path, public_url, failure_code, completed_at
  from public.project_image_assets
 where project_id = '<project-id>' order by created_at;
```

Confirm that every URL supplied to the Coding prompt corresponds to a `ready` row and a
readable Storage object. Then enable the isolated verification sandbox for a cohort only if its
own migration/provider prerequisites are ready. A passing sandbox result still proves build,
runtime start and health only; it does not prove visual image rendering. Human browser/render
inspection is a separate evidence item.

#### Failure-injection pass

In disposable staging, inject one failure at a time through the approved provider/test seams or
provider test account: planner output limit, specialist timeout, malformed specialist JSON,
coding output limit, batch timeout, checkpoint write failure, worker termination after a
checkpoint, lease expiry, image 429, image timeout, image Storage failure, image completion RPC
failure, verification build failure and verification runtime/health failure. For each injection
confirm the durable state, retry/dead-letter behavior, checkpoint reuse, cost-known state and
owner-visible message. Never induce a failure by manually rewriting terminal rows.

### 8. Runtime observability requirements

The existing structured events are sufficient to correlate the main generation path if the
operator collects them centrally. At minimum retain:

- `generation.accepted`, `generation.claimed`, `generation.provider_attempt`,
  `generation.checkpoint`, `generation.retry_scheduled`, `generation.lease_recovered`,
  `generation.completed`, `generation.failed`, `generation.dead_letter` and
  `generation.worker_error`;
- `orchestration.skipped`, plus durable workflow/task rows and workflow events;
- `image.plan`, `image.stage`, image asset rows and Storage object metadata;
- verification lifecycle events, worker tick duration/status, queue SQL snapshots and credit
  reservation/settlement/release events when credits are enabled.

The allowlist intentionally excludes prompts, generated source, provider bodies and secrets.
For analysis, aggregate by `projectId` cohort, `dispatchMode`, `workerId`, role/phase, model,
error class, timeout classification, attempt number and whether cost was known. Record queue
wait separately from provider latency and total run duration. Treat missing event transport as
an observability gap, not as a successful run.

### 9. Concurrency bottleneck report and staged load plan

The current hard constraints are:

1. Migration 10 admits at most one unfinished run per project, two unfinished runs per user and
   eight unfinished runs globally. The global limit includes queued/retrying work, so adding EC2
   workers cannot raise admitted work.
2. One `runGenerationWorkerOnce()` invocation claims one generation job. A worker process polls
   serially; horizontal processes can claim distinct jobs through `FOR UPDATE SKIP LOCKED`, but
   share Supabase connections, database RPC capacity and OpenRouter quotas.
3. Each active worker holds a lease and can make several streamed provider calls, checkpoint
   writes, usage writes and terminal/credit operations. Orchestration adds sequential specialist
   calls for cohort projects.
4. Verification, Android builds and AWS publication are side queues that run only on otherwise
   empty generation ticks, so enabling them changes idle-tick work and queue latency.
5. Image generation can use bounded concurrency 1–4 inside one generation run, adding provider
   and Storage load without increasing generation admission capacity.
6. Supabase RPC/row locks serialize admission and protect the global limit; provider account
   rate limits and model-specific concurrency are not represented by a repository-wide limiter.

Do not increase the limits before measurement. Use a staging workload with fixed prompts and
provider quotas at concurrency levels 1, 2, 4, 8, then 16 only if the preceding level is
healthy. For each level run a warm-up, a fixed measurement window and a drain period. Measure
queue wait, active leases, worker CPU/memory/restarts, Supabase connection/lock pressure,
OpenRouter 429/5xx/timeouts, checkpoint latency, retry/dead-letter rate, image Storage latency,
credit reconciliation and p50/p95/p99 end-to-end duration. Stop or roll back on duplicate
ownership, lease loss, rising queue age, provider throttling, database errors, unknown-cost
growth or credit mismatch. A 1,000-job test is not meaningful until the 8-run admission gate
is deliberately changed in a separately reviewed migration and the provider/database limits
are known.

### 10. Ranked remaining blockers

| Severity | Blocker | Evidence needed |
|---|---|---|
| P0 | No live provider/database/worker execution has been verified | Human-run staging generation with durable rows and logs |
| P0 | No real build/runtime/image-render evidence | Verification sandbox plus human-rendered generated app evidence |
| P0 | No measured reliability, latency, cost or confidence interval | Repeated category runs with preserved failure population |
| P0 | No measured capacity beyond the 2/user and 8/global admission guard | Staged concurrency test with worker/database/provider telemetry |
| P1 | Specialist role model pins are configured but several are not provider-account verified | Confirm exact pinned ids against the OpenRouter deployment |
| P1 | Migration 29/RLS/RPC behavior is only statically inspected | Disposable database migration and owner/worker access checks |
| P1 | Image migration/RLS/Storage contract is not covered by a SQL test or live run | Apply migration 33 and inspect claim/completion/storage behavior |
| P1 | Skip/setup failures are structured logs rather than durable owner-visible workflow events | Decide whether log-only evidence meets operator requirements; if not, add a focused persistence design |
| P2 | Deadline semantics are relative windows rather than absolute timestamps at the orchestration boundary | Fake-clock integration around setup delay, planner/design refusal, Coding start and review reserve |
| P2 | No automated end-to-end generated-app image rendering test exists | Real generated source, isolated build, serving and visual/browser observation |

## Image and persistence verification

The image stage is present and durable: plan → approval → claim → provider bytes →
storage → ready row → Coding URL references. Required/deferred/failed assets remain
truthful. File batches use fenced atomic persistence and checkpoint hashes. Static
verification requires the create-mode entry files and complete `preview.html` before
terminal success.

No provider, storage, database, preview, or generated application was executed in
this pass.

## Automated and load-test results

Not run. Repository policy forbids agents from running tests, typechecks, lint,
builds, servers, browser probes, or load tests. Therefore:

- Test cases A–J: **not measured**.
- Worker restart/failure injection: **not measured**.
- Concurrency levels 1, 5, 10, 25, 50, 100, 250, 500, 1,000: **not measured**.
- p50/p95/p99 duration: **unavailable**.
- Cost per successful website: **unavailable**.
- Reliability rate, sample size, failure categories, confidence intervals: **not computed**.

The existing admission ceiling remains 2 unfinished runs per user and 8 globally;
there is no evidence to claim 1,000-job capacity or any five-nines reliability target.

## Remaining risks and operator checklist

Before production claims, the human developer/operator must run the focused tests,
typechecks, lint and build; apply the required migrations; execute controlled staging
failure-injection tests; and load-test against provider-approved limits. Record queue
wait, worker CPU/memory, database connections, provider throttling, lease recovery,
credit reconciliation, image outcomes, and p50/p95/p99 latency at each concurrency
level. Only then can admission limits or worker capacity be changed safely.

## Explicit verification statement

Verified here: source-level deadline propagation, timeout clamping, Coding reserve,
post-review reserve wiring, and truthful structured skip behavior by inspection.

Not verified here: live OpenRouter behavior, Supabase RPCs/migrations, worker
execution, generated websites, images, previews, runtime builds, credits, AWS,
Cloudflare, Render, staging load, production reliability, or 1,000 concurrent jobs.

## Final audit statement

The previous fix is statically consistent with parent-budget propagation, role timeout
clamping, the Coding reserve, post-coding review budgeting and structured skip logging. The
seven-role trace shows that only Coding runs for every generation; the other roles are optional,
cohort/worker/complexity/failure gated, and Deployment is deterministic. The image pipeline has
durable claim and readiness boundaries, but no generated website image has been rendered in a
real application here. The repository is ready for the human-run staging and verification
sequence above; it does not yet have runtime evidence for reliability, scale or seven-agent
execution.

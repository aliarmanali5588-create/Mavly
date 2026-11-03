# Generation reliability — audit and invariants

This document records a static audit of the website/Android generation pipeline and the
targeted fixes it produced. It is deliberately explicit about what was **read** and what
was **run**: nothing here was measured against a live deployment.

> ⚠️ No generation was executed for this audit. `AGENTS.md` forbids agents from running
> tests, typecheck, lint, build, servers or browser checks, and there is no stored
> generation corpus in this repository to analyze. Every claim below is a property of the
> code as read, not a measured success rate.

## 1. The path a prompt actually takes

```
POST /api/vcaas/projects/{id}/agent/start
  └── startAgentResponse                        src/lib/mavly/api.ts
        ├── isAiConfigured + model resolution
        ├── admitGeneration → create_generation_job (migration 10)
        │     1 active run per project · 2 per user · 8 global, advisory-locked
        ├── insertMessage("user", prompt)
        └── dispatch, decided BEFORE the run is written:
              dispatch_mode = "worker" → the scheduler's tick calls runAgent
              otherwise               → after(() => runAgent(...))

runAgent                                         src/lib/mavly/run-agent.ts
  ├── inline: claimRun (claimed_at lease)  |  worker: verified claim + lease_token
  └── execute()
        ├── project type (website | android) and ownership re-check
        ├── Figma design context (a linked frame is read, never invented)
        ├── current files → baseline snapshot (once per run)
        ├── OPTIONAL orchestration (worker + explicit cohort only)
        │     planner → design review → coding marker
        ├── checkpoint list → verifyCheckpointBatches → completedPaths
        ├── managed backend stage (before the first code batch)
        ├── image stage (before the first code batch)
        └── generateApp()                         src/lib/ai/agent.ts
              ├── manifest call (planner: files, plan, backend, images)
              ├── persisted manifest (resumable)
              └── batch loop: request → validate → checkpoint → next
complete()
  ├── result snapshot + diff
  ├── finishRun("done", stage: completed)   ← the ONLY success write
  ├── credits settle + usage record
  ├── post-coding reviews (worker + cohort)  ← after the terminal write
  └── maybeEnqueueVerification (worker runs only)
```

Success is written in exactly one place (`complete`), after every planned path is present
and validated. A failure writes one terminal row, optionally after a bounded retry.

## 2. The seven agents: what really executes

| Role | Real execution | Gate | Writes files? |
|---|---|---|---|
| Planner | One model call, parsed into `planContext` | worker dispatch + `MAVLY_MULTI_AGENT_PROJECTS` | no |
| UI/UX | One model call over selected existing files → `designDirectives` | same | no |
| Coding | `generateApp` — the only writer of `project_files` | every run | **yes** |
| QA | Post-run advisory source review | same; runs **after** the run row is terminal | no |
| Security | Post-run advisory review + deterministic static scan | same | no |
| Repair | Diagnosis only, passed as subordinate context to a later coding attempt | a durable retry/repair path | no |
| Deployment | Deterministic proposal | approval gate | no |

Consequences worth stating plainly:

- **Outside the multi-agent cohort, the six orchestration-only specialist stages never execute
  as Phase 10 tasks.** Coding still runs through the existing generation engine for every run;
  Planner, UI/UX, QA, Security, Repair and Deployment are not simulated. That is by design
  (`orchestration.skipped` is emitted when the relevant worker/cohort path is considered), not a
  crash. Even in a worker cohort, a simple update omits Planner, UI/UX and Deployment, while
  Repair is failure-gated. A "seven-role generation" therefore requires the applicable
  worker/cohort/complexity/failure conditions.
- **A failed QA/Security review cannot fail or refund a generation.** It runs after the
  terminal write, so it reports separately in the workflow and the chat.
- **No agent approves anything.** A review is not a verification `passed`, and neither is a
  deployment authorization.

## 3. Root causes found (in code, not in logs)

1. **The multi-agent tick reserved its review time twice.**
   `workerGenerationBudgetMs(POST_CODING_REVIEW_RESERVE_MS)` already subtracts 50 s of
   review reserve from the 300 s function limit, and `execute` then subtracted the same
   50 s again before handing the budget to `generateApp`. Generation — the only consumer
   left — started with roughly 95–160 s instead of 145–210 s. Fixed: generation receives
   what remains.
2. **The per-batch reserve could starve work at the end of the queue.**
   An earlier implementation reserved a fixed minimum for every queued group, then a
   later 40% reserve cap still allowed the current call to consume time needed by later
   groups. The current implementation uses `reserveForPendingFloors` to reserve each
   pending group's own floor, and `batchAttemptFloorMs`/`batchGroupFloorFor` scale a
   group's floor by its estimated bytes. The pre-check uses the next group's floor too.
   This preserves one absolute run deadline; it does not extend the budget or establish
   that a particular production timeout had this cause.

   **Historical issue, fixed in the current implementation.** A 40 % cap was not a fair share:
   with three groups left the current call could take 60 % and the two behind it 20 % each
   (a 200 s window became 120 s / 40 s / 40 s), and 40 s is below the batch class's own
   60 s floor. The tail of every multi-batch run was therefore starved, and the file named
   in the failure was simply whichever one sat at the end of the queue — which is why two
   unrelated small files (`components/ui/icon.tsx`, `app/globals.css`) reported the same
   error. A further defect made it worse: the loop applied the FULL-batch floor (60 s of a
   150 s call) to a single 2 KB file, so its compact retry was refused rather than sent and
   the loop's generic 20 s pre-check contradicted the scaled floor the call itself used.
   Fixed: `reserveForPendingFloors` reserves each queued group's own minimum (so the call
   being made keeps every millisecond the queue does not need — a slow but fitting batch is
   never shortened), `batchAttemptFloorMs`/`batchGroupFloorFor` scale a group's floor by its
   own estimated bytes, and the pre-check uses the next group's floor instead of 20 s. The
   same deadline is divided, never extended: no timeout, model or total budget changed.
3. **One unparseable file discarded its whole batch.** A multi-file response that was
   still not valid JSON after its single repair failed the entire run, throwing away every
   valid file in that batch. Fixed: it is **split** under the same bounded recovery budget,
   so the healthy files are persisted and a remaining failure names the single path.
4. **A file omitted twice failed the run.** Models routinely return most of a batch and
   drop one file. The retry existed but allowed only one re-request. Fixed: three total
   requests, then a failure that names the path.
5. **JSON extraction was first-brace → last-brace.** A model that closed its object and
   added one line of commentary containing `}` produced a slice that could not parse,
   costing a repair call or failing the batch. Fixed: a string/escape-aware balanced scan,
   with the old slice kept as a fallback.
6. **An escaping inline rejection was silent.** A rejection from `runAgent` inside
   `after()` left the run in `validating` with no message until the 10-minute stale
   interrupt. Fixed: it is caught, logged and reported as `generation.worker_error`
   (`inline_dispatch_failed`).
   The equivalent silent case in the worker path — orchestration setup throwing — now also
   emits `orchestration.skipped` (`setup_failed`) instead of only a console line.
7. **The planner had a 4k output ceiling and no truncation recovery.** OpenRouter sends
   the configured manifest ceiling as `max_tokens`, clamped to the selected model's
   catalog limit (24k for the default model, 32k for Claude Sonnet 5). A complete
   manifest can include every planned path plus applicable backend/image plans and
   optional planning context; the user prompt is not the only output-size factor. A
   `finish_reason: "length"` was correctly rejected and its partial response discarded,
   but planning failed immediately instead of reducing scope. Fixed: the manifest ceiling
   now reaches the highest catalog limit, and one compact complete-plan attempt follows an
   output-limit response. A versioned marker is saved through the existing fenced
   `generation_manifest` write before that retry; a later run resume continues directly
   with compact planning. Only a fully validated manifest replaces the marker. Provider
   usage remains attached to each attempt. No production response/usage logs were available
   for this diagnosis, so it describes repository behavior rather than measured incident
   tokens.
8. **A planned `package.json` could be delayed behind other generated files.** Batches
   followed planner manifest order, so the critical runtime manifest could be part of a
   larger request and not be checkpointed if that request timed out. Website generation
   now puts a planned `package.json` in its own first batch; remaining paths preserve
   their manifest order and the preview remains isolated. This reduces exposure to later
   timeouts but does not make the file deterministic or guarantee that its own provider
   request will finish.
9. **The opt-in specialist workflow had an independent deadline.** Its planner/design
   calls used their configured provider timeout even when the parent generation run had
   less time left, and the workflow budget was not tied to the worker's shared run budget.
   A specialist could therefore consume the Coding window or push the worker tick past its
   bounded execution budget. Fixed: the parent reserves a 120-second Coding window before
   starting orchestration; the planner/design phase receives only the remaining pre-coding
   window, while the same handle retains the worker's separate post-coding review reserve.
   Each role call is clamped to the time actually left while retaining a 10-second
   persistence/transition reserve. If the shared window is too small, orchestration emits
   a structured skip event rather than silently starving Coding.

### The reported `package.json` timeout

The reported failure is consistent with the single-file `TIMEOUT` branch in
`generateApp()`: after scope reduction, the one-file request still did not finish within
its usable call window, so the pipeline failed rather than checkpointing partial output.
The response/token contract distinguishes output truncation (`finish_reason: "length"`)
from timeout; neither partial response is persisted. A missing `package.json` is
consistent with an uncheckpointed failed request, not evidence that the run completed.

The code requests up to 12,000 output tokens for an ordinary batch, 16,000 for the
standalone preview, and up to 32,000 for planning; the OpenRouter adapter clamps each
request to the selected catalog model's maximum (24,000 for the default model, 32,000 for
Claude Sonnet 5). A normal batch can include up to eight files and a 48,000-byte estimate.
OpenRouter's reported prompt/completion/reasoning token usage and request ID are captured
per provider attempt when provided. However, the supplied incident has no run ID,
provider request ID, or attempt record. Therefore the exact production cause—provider
latency/stall, the absolute call deadline, local remaining-run budget, or a request that
was too broad—cannot be confirmed from the workspace message alone. The code change
addresses prioritization and recoverability, not that missing evidence.

## 4. Structural costs that are *not* bugs

- **`preview.html` doubles the work for one product.** Every create-mode website must
  contain a Next.js app *and* a standalone `preview.html` of the same site (its own batch,
  its own 16k-token ceiling) because the workspace previews the static document. It is the
  single largest output allocation in a run.
- **The provider-attempt ceiling is 12 by default** (`MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN`,
  4–40). Splits and repairs each consume one. A large site that needs many recoveries can
  reach the ceiling and stop honestly with `GENERATION_SPEND_LIMIT`; the run stays
  resumable.
- **The inline `after()` path has one continuation attempt**, and only with ≥90 s of its
  budget left. It has no queue and no lease, so a rate limit is terminal for that
  invocation.
- **Verification is off by default.** A completed generation therefore means "the files
  were generated and validated", not "it builds", "it renders" or "it passed". Those are
  separate facts, reported separately by the verification sandbox when it is enabled for
  the project.

### Current capacity boundary

The durable admission path still allows at most **one active run per project, two per
user, and eight globally**. These are database-enforced safety limits, not estimates of
worker capacity. `runGenerationWorkerOnce()` processes one claimed generation per tick;
additional worker processes can claim other jobs through the existing atomic queue, but
the repository has no production load measurements, provider-wide concurrency limiter,
or evidence that 1,000 concurrent users can be served. Do not raise the admission limits
to imply that capacity.

Before any scale claim, the operator should load-test against a non-production Supabase
project and provider account, increase worker capacity in controlled steps, and measure
queue wait, active runs, completion/failure rates, per-model throttling, provider latency,
worker memory/CPU, database connections, lease recoveries, retries, and credit
reconciliation. Set explicit stop/rollback thresholds before raising admission limits.
Horizontal worker count is not by itself a safe scale control: the database cap, provider
quotas, and any shared per-model concurrency budget must remain authoritative.

## 5. Invariants these fixes preserve

- A response with `finish_reason: "length"` is never a success, and half a `preview.html`
  is never persisted.
- A batch is written only after its whole response validates, and files plus checkpoint
  are one fenced transaction.
- A retry never repeats an oversized request identically: it reduces scope.
- Every rejection/skip that changes what the user gets is emitted as a structured event.
- No generation failure fabricates success, and no bounded repair can make a run pass by
  itself.

## 6. How to measure the real rate (operator, against stored state)

No statistic in this document is measured. The numbers a reliability claim needs are in
`public.project_runs` and the structured `generation.*` events, and this is the query that
produces them for a real window — run it, do not estimate:

```sql
-- attempts by outcome and terminal error class
select stage, error_class, count(*) as runs,
       round(avg(extract(epoch from (finished_at - started_at)))) as avg_seconds,
       round(avg(attempt_count), 2) as avg_provider_calls
from public.project_runs
where started_at > now() - interval '30 days'
group by 1, 2
order by runs desc;

-- success rate, and the same restricted to durable-worker-dispatched runs
select dispatch_mode,
       count(*) filter (where stage = 'completed') as completed,
       count(*) filter (where stage = 'failed') as failed,
       count(*) as total,
       round(100.0 * count(*) filter (where stage = 'completed') / count(*), 1) as pct
from public.project_runs
where started_at > now() - interval '30 days'
group by 1;

-- which failures were retried and recovered (a retry is a NEW row attempt on the same run)
select error_class, count(*) filter (where finished_at is null) as still_open,
       count(*) as rows
from public.project_runs
where stage in ('failed', 'interrupted') and started_at > now() - interval '30 days'
group by 1;
```

Interpretation rules that keep the number honest:

- **`completed` means the files were generated and validated, not that the app works.**
  A build/render/runtime result exists only when the verification sandbox is enabled for
  the project (`project_verifications`), and it is a separate count.
- A run that is `failed` but was resumed and later `completed` is one project with two
  rows over time; join on `project_id` before claiming a per-project success rate.
- `dispatch_mode = 'inline'` and `'worker'` must be reported separately: they have
  different budgets, different retry behaviour, and only the worker path enqueues
  verification.

## 7. Dispatch: platform-wide production worker and legacy hand-off

Production website and Android admissions now write `dispatch_mode = 'worker'` for every
project; no worker-specific flag or project allowlist gates dispatch. Local development and
Vercel previews retain the inline `after()` path. AWS is the designated production worker
host; its process repeatedly invokes the existing durable worker and uses the existing
Supabase queue, atomic claim, lease, retry and checkpoint machinery. Render remains
preserved but disabled by `MAVLY_RENDER_WORKER_DISABLED=true`. The legacy Cloudflare Cron
configuration remains in the repository with `MAVLY_CLOUDFLARE_WORKER_DISABLED=true`; the
scheduler no-ops before invoking a worker tick. Operators must still remove the deployed
Cron trigger and verify Render is disabled before treating AWS as the sole active host.
Atomic claiming prevents two hosts from owning the same run, but does not prevent two
active hosts from consuming different queued runs. No AWS, Render, or Cloudflare deployment
state was accessed or verified for this audit.

Migration 36 remains useful for legacy inline runs that cannot finish:

```
inline attempt → failure classified
   ├── inline continuation available (≥90 s left, class recoverable) → continue
   └── no continuation left
         ├── handoffDecision() says yes → persist usage → handoff_generation_job (36)
         │        → run becomes retry_wait / worker, checkpoints intact, no terminal write
         └── refused → existing terminal failure (unchanged)
```

The decision is pure and lives in `src/lib/generation/dispatch.ts`. It refuses when a
worker attempt already owns the run (`lease_token`), when this invocation does not hold
the inline claim, when the failure is not retryable, or when the current runtime uses
inline dispatch. Production has no worker project cohort; the worker claims across all
projects with `p_project_ids = NULL`.

The database side (`36_generation_worker_handoff.sql`) re-verifies ownership, the exact
`claimed_at` fence, a persisted manifest and at least one verified checkpoint, because a
hand-off without progress would make the worker start from zero. The transition is
once-only: it sets `dispatch_mode = 'worker'`, so a later resume also stays on the worker.

Safety properties preserved: idempotency (admission key), lease fencing (the RPC's
`claimed_at` check plus the worker's own `lease_token`), checkpoint recovery (the worker's
existing `verifyCheckpointBatches` path), ownership (both sides re-check), and the rule
that two workers never run one run (the queue claim is `FOR UPDATE SKIP LOCKED`, and the
inline attempt has returned before the row is claimable).

Observability: `generation.accepted` carries the dispatch mode, `generation.handoff_scheduled` records a
successful hand-off with its checkpoint count, and `generation.handoff_skipped` records the
exact refusal. `agent/status` already reports `dispatchMode`, `stage` and `jobAttempt`.

⚠️ **NOT DONE, AND WHY:** there is no size-based pre-dispatch heuristic and no automatic
"this prompt looks large" routing. Both would need a size estimate *before* the plan
exists, which the current admission contract cannot provide, and guessing would move small
generations onto a queue they do not need. The hand-off is the honest equivalent: the
workload proves its size by not finishing, and is moved instead of being killed.

## 8. Verification stages: what runs, what cannot

The four states stay separate, and only one of them is produced by Mavly itself today:

| Stage | Who can produce it | Status here |
|---|---|---|
| generated | `generateApp` + `complete()` | implemented |
| structurally valid (A: files, B: syntax) | `src/lib/verification/static.ts` | implemented, pure, reported |
| compiled (C: install + build) | verification sandbox (Vercel microVM) | **BLOCKED** — provider credentials + cohort |
| rendered / verified (D/E: runtime, browser) | sandbox + a browser runtime | **BLOCKED** — no authenticated browser execution |

Stages A and B run over the project's **current** files for a finished generation that has
no sandbox verification, and are returned by `agent/status` as `staticVerification`:
required/planned files present, no empty critical files, `package.json` parses, source
delimiters balance (catches a truncated response), every local `./` / `../` / `@/` import
resolves to a project file, and `preview.html` is a complete document. Every result carries
`compiled: false`, `rendered: false`, `verified: false` so it cannot be mistaken for a
verification pass, and a sandbox verification, when present, is never overridden.

Deliberately **not** implemented: JSX/TypeScript parsing (a real compiler in Mavly's
process is a liability and a partial one would produce false failures), and any form of
browser automation. E2B, E2B's public preview URL and the Phase 13 live preview already
cover the React + Vite case for a human to look at; Mavly-generated sites are Next.js App
Router, which that runtime does not serve.

**The exact unblockers for C/D/E** are already enumerated in AGENTS.md: for C/D, the
`MAVLY_VERIFICATION_SANDBOX_*` flag, an explicit project cohort and Vercel Sandbox
credentials (OIDC or team/project/token); for E, an authenticated browser runtime that
Mavly does not currently have — the provider's preview URL is public and unauthenticated,
which is why Phase 4 reports `preview.status = "unavailable"` on purpose.

## 9. preview.html: why it stays

The P1 ask is to build the preview deterministically instead of spending a 16k-token
batch on it. For the projects Mavly generates, that is not possible, and the reason is
structural rather than a matter of effort:

- A generated website is a **Next.js App Router** project. `app/page.tsx` is a React
  component tree with server/client boundaries; HTML only exists after `next build` and a
  render. Producing it deterministically would mean running the build — exactly the
  sandbox work that is blocked above.
- The static preview is served from a sandboxed, opaque-origin document with
  `connect-src 'none'`; it cannot execute the Next.js runtime.
- A deterministic preview built by *statically interpreting* the generated JSX would be a
  partial renderer: it would show something that is not the app, which is a worse outcome
  than a real hand-written prototype, and it would silently disagree with the app the user
  receives.

The current design already avoids the two costs that *can* be avoided: `preview.html` is
injected into the plan only for **create** mode (`requiredCreatePathsFor`), and the model is
instructed to update it only when the user-visible UI changes. No separate AI batch exists
to remove — the risk-shaped cost is the one 16k-token cap on that one file.

Two honest ways to remove it later, both product decisions:

1. unblock C (build in the sandbox), serve the built app, and drop `preview.html` for the
   cohort where a build is available;
2. ship a deliberately thinner preview document (a single screen, smaller cap) and accept
   a less complete preview in exchange for the tokens.

Neither was taken unilaterally here: the first is infrastructure-gated, and the second
changes what every user sees.

## 10. Measurements

**None were taken.** No generation was executed, and the changes are reasoned from
the code. In particular no before/after figure exists for output tokens, provider calls,
generation duration, file count or verification duration; the hand-off removes a *terminal
failure* for large inline runs, and the static stage adds a bounded in-process check with no
provider call, but neither claim is a measurement.

The specialist deadline fix is also a static correctness change. It has not been exercised
against a live worker, provider, database or production workload; no latency or reliability
improvement is claimed.

## 11. Unverified

No test, typecheck, build, live generation, provider call, worker tick or migration was
run while producing this document. This includes the new focused package-first test in
`tests/generation-reliability.test.ts`. The changes are based on static inspection; the
human developer must run the repository's focused suites before merge.

## 12. Bounded partial-response recovery and per-attempt evidence

The provider stream adapter now returns incomplete text only for bounded output-limit,
idle/absolute timeout, and premature-EOF failures. External cancellation is not checkpointed.
`generateApp` checkpoints at most 128 KiB for a single requested path, separately from
completed-file batches. The checkpoint is versioned inside the existing
`generation_manifest` value, retains legacy top-level manifest fields for status/verification
readers, and validates the source-content SHA-256 before reuse. A verified completed batch
always wins over a duplicate partial checkpoint. Recovery receives the incomplete bytes as
untrusted context and must return a complete replacement; only ordinary parsing,
validation, and the existing fenced batch RPC can persist a file. The partial entry is
cleared after the matching validated batch is checkpointed.

`generation.provider_attempt` structured events use the durable run ID and contain an
allowlisted provider request ID, model, run/phase attempt numbers, start/end timestamps,
latency, remaining budget, HTTP status, timeout/retry classification, finish reason, token
usage and provider-reported cost when available. They never contain prompts, response text,
secrets or raw provider errors. Completed attempt records are also checkpointed to the
existing run row through its lease/claim fence; credit usage RPCs and settlement semantics
are unchanged.

`runGenerationWorkerOnce()` remains one generation claim per tick. The AWS process polls
again after each tick; multiple worker processes use migration 16's atomic
`FOR UPDATE SKIP LOCKED` claim and random lease tokens, so they can work on different runs
without both owning the same live run. This does not make parallel hosts a singleton or
increase provider capacity. Migration 10 still serializes admissions at 2 unfinished runs
per user / 8 globally; the global ceiling includes queued work and can throttle new
admissions before more EC2 capacity helps. No cap was raised.

The legacy Cloudflare schedule remains in `wrangler.jsonc` for rollback, but the checked-in
`MAVLY_CLOUDFLARE_WORKER_DISABLED=true` guard makes scheduled invocations no-op before a
claim. To guarantee AWS-only operation, an operator must also remove the deployed Cron
trigger and verify Render remains disabled; see
[`../runbooks/aws-generation-worker.md`](../runbooks/aws-generation-worker.md).

## Human-run verification commands

`AGENTS.md` prohibits agents from running automated verification. The human developer can
run the focused reliability coverage:

```bash
node --import ./tests/register.mjs --test \
  tests/generation-reliability.test.ts \
  tests/provider-streaming.test.ts \
  tests/generation-observability.test.ts \
  tests/generation-worker-migration.test.ts \
  tests/generation-worker-config.test.ts \
  tests/generation-worker-route.test.ts \
  tests/android-build.test.ts
npx tsc --noEmit
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run lint
```

These commands were not run for this change. A static migration-contract test is not a
live concurrent-claim test; database concurrency and AWS/Cloudflare/Render operation remain
unverified.

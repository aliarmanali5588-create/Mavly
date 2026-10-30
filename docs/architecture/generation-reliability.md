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

- **Outside the multi-agent cohort, four of the seven roles never execute.** That is by
  design (`orchestration.skipped` is emitted with the reason), not a crash. A "seven-agent
  generation" only happens for a worker-dispatched cohort project.
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
2. **The per-batch reserve starved the batch being sent.**
   The loop asked `planProviderCall` to reserve `pending × minAttemptMs`, which for a
   batch class is `pending × 60 s`. The clamp then handed the *current* batch its bare
   minimum, so a full batch ran with a 60 s ceiling that it was expected to exceed. A
   timeout is answered by splitting the batch, which queues more calls and squeezes the
   next attempt further — a tight budget degraded into a run that failed with almost
   nothing written. Fixed with `reserveForPendingWork`, which caps the reserve at 40 % of
   the time actually left.
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

-- success rate, and the same restricted to the durable worker cohort
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

## 7. Dispatch: inline, worker, and the hand-off

**Why eligible projects were not consistently dispatched:** dispatch is decided by
`dispatchModeForProject` at admission, and it returns `worker` only when the whole worker
configuration is valid **and** the project id is listed in
`MAVLY_GENERATION_WORKER_PROJECTS`. There is no size heuristic anywhere — a project
outside the cohort ran inline no matter how large its generation was, and once an inline
run reached its deadline the only outcomes were one immediate continuation or a terminal
failure. `resume_generation_job` (migration 16) deliberately preserves `dispatch_mode`, so
even a manual resume put it back on the inline path.

**What changed:** an inline run that cannot finish now hands the job to the worker.

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
the inline claim, when the failure is not retryable, or when this deployment does not
dispatch the project to the worker. The last refusal is load-bearing: the worker claims
with `p_project_ids = cohort`, so handing off a project outside the cohort would park a
live run on a queue no worker reads — than which a clean terminal failure is better.

The database side (`36_generation_worker_handoff.sql`) re-verifies ownership, the exact
`claimed_at` fence, a persisted manifest and at least one verified checkpoint, because a
hand-off without progress would make the worker start from zero. The transition is
once-only: it sets `dispatch_mode = 'worker'`, so a later resume also stays on the worker.

Safety properties preserved: idempotency (admission key), lease fencing (the RPC's
`claimed_at` check plus the worker's own `lease_token`), checkpoint recovery (the worker's
existing `verifyCheckpointBatches` path), ownership (both sides re-check), and the rule
that two workers never run one run (the queue claim is `FOR UPDATE SKIP LOCKED`, and the
inline attempt has returned before the row is claimable).

Observability: `generation.accepted` now carries the inline reason
(`worker_unavailable` / `not_in_worker_cohort`), `generation.handoff_scheduled` records a
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

**None were taken.** No generation was executed, and the three changes are reasoned from
the code. In particular no before/after figure exists for output tokens, provider calls,
generation duration, file count or verification duration; the hand-off removes a *terminal
failure* for large inline runs, and the static stage adds a bounded in-process check with no
provider call, but neither claim is a measurement.

## 11. Unverified

No test, typecheck, build, live generation, provider call, worker tick or migration was
run while producing this document. The fixes above are reasoned from the code and are
covered by the existing pure suites (`tests/generation-reliability.test.ts`,
`tests/generation-budget.test.ts`) only when the human developer runs them.

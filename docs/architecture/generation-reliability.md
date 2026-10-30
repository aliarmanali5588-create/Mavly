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

## 7. Unverified

No test, typecheck, build, live generation, provider call, worker tick or migration was
run while producing this document. The fixes above are reasoned from the code and are
covered by the existing pure suites (`tests/generation-reliability.test.ts`,
`tests/generation-budget.test.ts`) only when the human developer runs them.

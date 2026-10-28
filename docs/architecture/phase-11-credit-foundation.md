# Phase 11 — Credit foundation

Status: **implemented, opt-in, not exercised against a live database.**

This phase makes credit accounting authoritative and atomic for generation runs. It does
not add a pricing engine, change credit-pack prices, add a billing flow, or charge for
anything outside an explicit cohort.

## 1. What was actually there before

- No credit table, balance column, ledger, reservation, RPC or Edge Function existed in the
  thirty migrations; `MAVLY_CLEAN_BASELINE.md` said so explicitly.
- The workspace indicator rendered a hardcoded `10`; the admin credits page was mock data;
  the top-up page was UI-only; `usePrice` read an unimplemented `GET /credit-costs`.
- The only real payment path was Phase 6 Razorpay for *generated customer apps*, not Mavly
  credits.
- Generation admission was already durable and atomic: `create_generation_job`
  (migrations 10/16) serializes with an advisory lock, enforces ownership, idempotency and
  2/user + 8/global caps. Runs are lease-fenced and checkpointed.

## 2. Accounting model

```
credit_accounts.balance_credits    credits owned           bigint
credit_accounts.reserved_credits   credits held for runs   bigint
available                          balance - reserved      (never stored)
```

- Credits are **whole units**. Every existing package and UI surface uses whole credits, so
  there is no historical fractional representation to preserve; a fractional or
  non-integer charge is refused (`INVALID_CREDIT_AMOUNT`).
- Every mutation is one transaction that updates the account, the reservation and exactly
  one ledger row.
- `credit_ledger` is the audit authority and is **append-only**: a trigger raises on UPDATE
  or DELETE. Corrections are new compensating rows.
- Invariants: `sum(amount_credits) = balance_credits` and
  `sum(reserved_delta_credits) = reserved_credits`. `balance >= reserved >= 0` is a check
  constraint, not a convention.
- A hold writes a ledger row with amount `0` and a positive reserved delta, so releases are
  auditable without pretending the balance moved.

## 3. Request lifecycle

```
agent/start
  └─ server derives opt-in project cohort and worker dispatch
       └─ create_generation_job_with_credits        SERVICE ROLE, ONE TRANSACTION
       ├─ create_generation_job (advisory lock, caps, idempotency)
       ├─ duplicate key with a different prompt/model → conflict
       ├─ lock account, check available >= cost
       ├─ insufficient → RAISE (job insert rolls back)
       ├─ hold credits + reservation + ledger row
       └─ run row committed
  └─ durable worker claim only

run reaches a terminal state
  ├─ completed  → terminal run write + settle_generation_reservation (one DB transaction)
  └─ failed/cancelled → terminal run write + release_generation_reservation (one DB transaction)
```

Migration 32 installs the terminal trigger that performs the reservation transition in
the same transaction as the fenced `project_runs` terminal update. Worker follow-up
settlement/reconciliation calls are harmless no-ops when the trigger has already applied
the ledger entry. Owner reconciliation remains a recovery path for successful terminal
holds; it cannot release failures.

`credit_project_policies` is the database-owned mirror of the explicit application cohort
and fixed generation cost. The service-role admission RPC checks project ownership, policy
cost and worker dispatch; a policy guard refuses activation while existing runs are inline
or unreserved, rejects pre-existing holds at a different price, and makes the project id
immutable. A run-state trigger also blocks authenticated inserts/updates on an enabled
credit project and rejects service-role inserts/resumes unless they carry the transaction-
local admission/resume marker set by the credit-aware RPC. This closes the legacy
`create_generation_job` / `resume_generation_job` bypass at the database boundary.

The policy table is an operator-managed deployment invariant: its enabled project ids and
costs must match `MAVLY_CREDITS_PROJECTS` and `MAVLY_CREDITS_GENERATION_COST`. A mismatch
fails closed. Activating a policy before application configuration may temporarily refuse
generation; that is preferable to admitting a free run.

`settle` requires `finished_at`, `status = 'done'`, `stage = 'completed'`. The owner may
reconcile only successful runs; failed/cancelled holds are released only by the durable
worker or the service-role terminal handler. `release` requires `finished_at` and NOT a
successful completion. Neither acts on an already-settled reservation, so a duplicate
completion or retry cannot double-charge.

A resume is a new attempt: `resume_generation_job_with_credits` reopens the run and takes a
fresh hold only when the previous hold was released. A duplicate resume of a run that is
still active is refused (`not_resumable`, reason `run_active`) without starting or charging
a second execution. If the run is terminal but its hold was never released (a crash between
the terminal run write and the release), that hold is released inside the same transaction
**before** the new one is taken — the one-live-hold-per-run index makes any other order
impossible. If credits are exhausted, the resume is refused and the run is not reopened.

A hold whose run row no longer exists (a deleted project cascades its runs) cannot be
settled or released by run id. `release_orphaned_credit_reservations` (service role, bounded,
one-hour grace) reverses exactly those holds with a ledger entry, so `available` cannot stay
reduced forever; the launch path also releases the hold before it deletes a project it just
created.

## 4. Idempotency and concurrency

| Boundary | Mechanism |
|---|---|
| Logical generation request | `(project_id, idempotency_key)` unique on `project_runs`; the credit wrapper also rejects a reused key with different parameters |
| Logical launch (project + prompt) | `projects.creation_request_id` (migration 25) resolves a retried launch to the same project, so the run key resolves to the same run; the workspace sends one stable `clientRequestId` per launch and a keyed launch never deletes a project it did not create |
| One live hold per run | partial unique index `(run_id) WHERE status = 'reserved'` |
| Reservation / settle / release / refund | unique `(user_id, idempotency_key)`; settle/release only act on `reserved` rows |
| Concurrent spend | `SELECT … FOR UPDATE` on the account row (created with `INSERT … ON CONFLICT`) inside the admission transaction |
| Duplicate worker delivery | existing lease token + `claimed_at` fencing; credit settlement reads the terminal run row |
| Usage rows | unique `attempt_key`; `ON CONFLICT DO NOTHING` |
| Duplicate provider-attempt start | only the transaction that inserts the UUID marker receives `started`; a repeated start returns `existing` and the caller refuses to dispatch it again |
| Provider result write lost | migration 32's pre-dispatch row remains uncertain; a later run-row reconciliation can update that same row when the response was durably persisted |

Admission and policy activation share the global generation advisory lock, acquired before
the policy/account/run work by migration 32's ordered wrappers. This preserves
`create_generation_job` idempotency while preventing the migration 31 policy/account lock
order from deadlocking with concurrent admissions. Database uniqueness and the account
row lock remain the final duplicate/overspend protections.

## 5. AI usage and cost metering

`ai_usage_attempts` records one row per provider attempt:

- run/workflow/role/task identity, attempt index, model, provider, provider request id;
- prompt, completion, reasoning, total and cached read/write tokens (NULL when the provider
  did not report them);
- `actual_cost_usd` = provider-reported cost, or NULL;
- `estimated_cost_usd` = rate-card estimate, or NULL;
- `cost_source` (`provider_reported` | `rate_card` | `unavailable`),
  `reconciliation_status` (`reconciled` | `unreconciled` | `uncertain` | `unavailable`),
  and `uncertain` for a timeout/network failure that may have reached the provider.

Migration 32 inserts one uncertain attempt row before each worker provider dispatch and
updates that row by stable attempt UUID when a result arrives. A crash or ambiguous timeout
therefore remains unknown rather than being recorded as zero; this does not make external
provider execution exactly-once. If result metadata is later persisted on the run,
`record_ai_usage_attempts(run_id)` reconciles that same row instead of inserting a
duplicate. Both provider-attempt RPCs and the run-derived usage recorder are service-role
only; owner reconciliation cannot submit usage. Orchestration specialist calls use the
same durable attempt lifecycle.

`ai_cost_rates` is empty by default. Without an operator-installed rate row an estimate is
explicitly unavailable — it is never zero. Provider-reported cost is never converted into
credits here; credits and USD are separate ledgers.

## 6. Role-specific models

`src/lib/ai/model-roles.ts` pins roles through the existing OpenRouter provider abstraction;
role selection has no environment override or implicit fallback. Only two model IDs are
currently treated as verified by the repository: `deepseek/deepseek-v4.1-flash` and the
cohort-gated `cohere/north-mini-code:free`. The requested specialist IDs below are not in
the verified catalog, so current model roles are explicitly pinned to the verified
DeepSeek V4.1 Flash entry until each replacement is verified:

| Role | Model | Kind |
|---|---|---|
| Planner | `deepseek/deepseek-v4.1-flash` | Advisory plan |
| UI/UX | `deepseek/deepseek-v4.1-flash` | Advisory design review |
| Coding | `deepseek/deepseek-v4.1-flash` | Existing generation engine |
| QA | `deepseek/deepseek-v4.1-flash` | Advisory source review; sandbox remains authoritative |
| Security | `deepseek/deepseek-v4.1-flash` | Advisory source review plus deterministic scan |
| Repair | `deepseek/deepseek-v4.1-flash` | Bounded diagnosis; suggestions re-enter only through Coding |
| Deployment | — | Deterministic; no model call |

The originally requested `deepseek/deepseek-v4-pro`, `anthropic/claude-sonnet-5`, and
`openai/gpt-5.6-sol` IDs are intentionally not allowlisted until verified. A role whose
explicitly pinned model is absent or disabled fails rather than falling back to a requested
or global model. Specialist usage is recorded per provider attempt by migrations 31/32;
unknown provider cost stays `NULL`, and actual USD is never converted into credits here.

Model output never authorizes a deployment, a charge, a refund or an approval.

## 7. Security boundaries

- Authenticated users may SELECT only their own rows (RLS on `user_id`).
- They have no INSERT/UPDATE/DELETE grant on any credit table.
- Owner-checked RPCs: successful settlement, balance, owner reconciliation.
- Service-role-only RPCs: `grant_credits`, `refund_generation_reservation`,
  `begin_ai_provider_attempt`, `complete_ai_provider_attempt`,
  `record_ai_usage_attempt(s)`, `maintain_credit_reservations`,
  `release_orphaned_credit_reservations`, credit admission/resume/release and terminal
  failure/cancellation.
- An enabled `credit_project_policies` row blocks authenticated writes to generation runs,
  including direct use of the legacy admission/resume RPCs. The only exception for
  service-role creation/resume is the transaction-local marker set inside the credit-aware
  RPC; those RPCs independently re-check ownership, policy and the fixed price.
- Migration 32's provider-attempt start RPC checks project ownership and the live worker
  lease before inserting a durable uncertain marker.
- New admission and owner-facing credit RPCs are disabled when
  `MAVLY_CREDITS_ENABLED` is off. Existing held runs still settle atomically, and the
  enabled worker continues recovery/usage reconciliation for already-admitted work.
- The database policy continues to block unreserved legacy runs even if the application
  flag is accidentally turned off. Disable the cohort/policy only after draining active
  runs and holds; see the runbook.
- No client-supplied balance, cost, refund amount or entitlement is trusted anywhere.
- A hold cannot be released for a completed run, so a direct client call cannot escape a
  legitimate charge.

## 8. Known limitations

1. **There is no Mavly credit-funding flow.** Credits can only be created through the
   service-role `grant_credits` RPC. Enabling a charge without granting credits blocks
   generation by design.
2. **No automatic refund policy.** Refunds are service-role-only operator actions; the
   automatic path returns an unused hold, it never reverses a charge.
3. **Terminal accounting depends on migration 32.** The trigger settles/releases a live
   reservation in the same transaction as the terminal run update. The worker sweep and
   owner balance read remain recovery paths for stranded successful holds, but cannot
   prove whether a provider call that crashed before returning was billed.
4. **No live database test.** The migration, RLS, RPCs and concurrency behaviour have not
   been run against Postgres in this repository; the tests are unit/static contracts.
5. **External provider exactly-once is impossible.** A timed-out call is recorded as
   uncertain; reconciliation depends on the provider's own reporting.
6. **Credits and USD are not linked.** No exchange rate or credit-per-dollar rule exists.

# Phase 10 — Multi-agent orchestration and deployment approval

> This document describes the multi-agent orchestration layer added on top of the
> existing durable generation pipeline. It is unrelated to the archived
> `phase-10-token-harbor-provider.md` (a removed provider experiment); the two
> happen to share a historical phase number.

## Scope

This phase adds a **role-specific specialist workflow** around the existing
generation engine, plus a **server-enforced owner approval** before production
deployment. It does **not** add a second queue, a second generation pipeline, a
second provider, an autonomous deploy path, or change credit/billing economics.

The existing `project_runs` row remains the only job and the only lease owner.
`generateApp` remains the only writer of `project_files`. The provider remains
OpenRouter through `src/lib/ai/provider.ts`.

## What existed before

| Area | Existing behavior (reused unchanged) |
|---|---|
| Job/lease | `project_runs` with durable stages, `create_generation_job` admission, fenced worker leases, retry/backoff, recovery and dead letters (migrations 10 and 16). |
| Provider | `chatCompletion` through `src/lib/ai/provider.ts` → `src/lib/ai/openrouter.ts`; verified catalog in `src/lib/ai/models.ts`; server-only `OPENROUTER_API_KEY`. |
| Generation | `generateApp` plans a manifest, generates bounded batches, writes checkpoints and snapshots; `finish_reason: "length"` is never success. |
| Verification | Opt-in isolated Vercel Sandbox build + loopback runtime/health check (Phases 3/4), where `passed` requires all three. |
| Snapshots | `project_snapshots` + restore points. |
| Deployment | Optional static/shared hosting and Phase 5 full-stack hosting, both gated on explicit flags/cohorts. |
| Memory | Phase 8 bounded context (off by default), unchanged. |

## Architecture

```
project_runs (only job + lease)
   │  worker tick
   ▼
run-agent.ts ── beginOrchestration() ──► agent_workflows (1:1 run_id)
   │                                        agent_tasks (dependencies)
   │                                        agent_workflow_events
   ├── runPlanningAgents() ─ verified DeepSeek V4.1 Flash planner + UI/UX
   │        └─ planContext / designDirectives injected as SUBORDINATE prompt context
   ├── generateApp() ───── verified DeepSeek V4.1 Flash, existing only writer of project_files
   ├── recordCodingCompleted()
   │        ├─ QA source review + sandbox delegation (only the sandbox proves build/runtime)
   │        ├─ verified DeepSeek V4.1 Flash security review + deterministic security scan
   │        └─ deployment proposal task (skipped; can never deploy)
   └── recordCodingFailed() ─ verified DeepSeek V4.1 Flash repair diagnosis; bounded suggestions
            are passed as subordinate context to the existing coding engine on retry
```

The layer activates only when **all** of the following hold:

- `MAVLY_MULTI_AGENT_ENABLED` is truthy;
- `MAVLY_MULTI_AGENT_PROJECTS` is a non-empty, explicit cohort (never `*`);
- the durable generation worker is fully configured (`parseWorkerConfig`);
- `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` are present;
- `OPENROUTER_API_KEY` is present;
- the run is **worker-dispatched** (`input.worker` is set), so a confined
  service-role client exists.

An inline `after()` run and a project outside the cohort keep the existing
pipeline and record no workflow. There is no simulated fallback.

## Roles

| Role | Task kind | Model call | Writes files | Authority |
|---|---|---|---|---|
| Planner | `plan` | `deepseek/deepseek-v4-pro` (45 s, 2k tokens) | No | Advisory implementation plan. |
| UI/UX | `design_review` | `anthropic/claude-sonnet-5` (30 s, 1.5k tokens) | No | Advisory design/accessibility/responsive directives. |
| Coding | `implement` | `anthropic/claude-sonnet-5` via existing pipeline | **Yes** (only writer) | The existing generation engine and its checkpoint path. |
| QA | `verify` | `openai/gpt-5.6-sol` (20 s, 1.5k tokens) | No | Advisory source review plus sandbox delegation; model output never proves a build/runtime pass. |
| Repair | `repair` | `deepseek/deepseek-v4-pro` (45 s, 1.5k tokens) | No | Bounded diagnosis; validated suggestions are handed to the existing coding engine on a durable retry. |
| Security | `security_review` | `anthropic/claude-sonnet-5` plus deterministic scan | No | Bounded source review; the deterministic scan remains a separate required check, and source-backed critical model findings may fail the workflow for owner review. |
| Deployment | `deployment_proposal` | No | No | Can only propose that the owner review a deployment. Never deploys. |

Every role output is bounded and normalized before persistence (`normalizeAgentOutput`):
summary ≤1,500 chars, ≤200 changed paths, ≤40 findings, bounded data fields.
The role IDs are fixed in `src/lib/ai/model-roles.ts` to the finalized mapping above. All
five entries are catalog entries that are sent verbatim. There is no environment override,
and specialist calls do not fall back to a requested or global default model: a role whose
pinned id is missing from the catalog fails as unavailable, and a role whose id the provider
rejects fails with that exact id. **Configured is not verified:** only
`deepseek/deepseek-v4.1-flash` and the explicitly cohort-gated
`cohere/north-mini-code:free` are `verified: true`. The three specialist ids are
`verified: false` until an operator confirms them against the deployment's OpenRouter
account, and `roleModelStatus` reports `configured`, `resolved` and `verified` separately.
The deployment's own function limit bounds the reviews: `POST_CODING_REVIEW_RESERVE_MS`
reserves two 20 s review caps plus a 10 s margin, and the worker's generation budget is
derived from that reserve (`workerGenerationBudgetMs`) so a tick cannot be killed after the
terminal run write. Each specialist API attempt is recorded through the
service-role `record_ai_usage_attempt` RPC from migration 31 with provider
tokens, request id and reported cost (NULL remains unknown). Coding usage remains
on the existing run-attempt accounting path; no credit price, reservation or
settlement rule changes here. Deployment remains deterministic.

If a failed generation has no eligible worker retry, its repair suggestions
remain diagnostic and are not applied. When a retry occurs, only suggestions
whose paths remain in the saved manifest are included as subordinate context;
the repair model never writes `project_files` or bypasses generation batches.

### Tool scopes

`src/lib/orchestration/tools.ts` validates every requested tool against
`ROLE_CATALOG` and the current project files. There is no shell, arbitrary URL,
database client or provider credential. `apply_file_changes` is available only to
the coding role, refuses secret/binary paths, unknown deletions and size/count
bounds. `run_project_checks` and `inspect_preview` describe a request the existing
pipeline may satisfy; they never execute anything in this layer.

## Workflow and task model

Workflow states: `queued`, `planning`, `executing`, `verifying`,
`waiting_for_dependency`, `retrying`, `awaiting_approval`, `completed`, `failed`,
`cancelled`.

Task statuses: `pending`, `waiting_for_dependency`, `queued`, `running`,
`completed`, `failed`, `skipped`, `cancelled`.

- Transitions are declared in `src/lib/orchestration/workflow.ts`. A terminal
  state cannot be reopened; the only resume edge is `failed → queued` for a
  user-requested run resume.
- Dependencies are explicit `{ key, required }` pairs. A failed **required**
  dependency blocks its dependents; a failed **optional** dependency is skipped
  over.
- `selectRunnable` allows bounded concurrent read-only tasks but never two
  writers (max concurrency is clamped to 4).
- Complexity is deterministic. A short update with no integration terms is
  `simple` and does not pay for a design review or a deployment proposal; Android
  creation and large/integration-heavy prompts are `complex`.

### Budgets, deadlines, retries, cancellation, recovery

- Provider calls are reserved before each model call and clamped to 1–24 per
  workflow (default 8); the persisted count survives a resume. The wall-clock
  window is clamped to 30 s–15 min (default 240 s) **per orchestration attempt**,
  so a resumed run is not instantly refused by an exhausted old window. The
  worker lease and the existing 240 s generation budget remain authoritative.
- Repair attempts are clamped to 0–2 (default 1 when enabled) and disabled by
  default.
- A model call that fails or times out records a truthful failed task with a
  redacted error class; it never becomes a fabricated success.
- A specialist result is discarded if OpenRouter reports a model different from
  the role's pinned ID. A usage row that cannot be recorded is logged and left
  absent; it does not discard an advisory result the provider already produced,
  and no cost is claimed for the missing row. Unknown provider cost stays unknown;
  it is never replaced with an invented value.
- Worker cancellation (`cancelWorkflowForRun`) and unexpected failure
  (`failWorkflowForRun`) settle the workflow without changing the run's own retry
  or failure classification. A completed/cancelled workflow is never reopened by a
  duplicate delivery.
- Recovery is ordinary: a resumed run calls `beginOrchestration`, which recovers
  the existing workflow/tasks, reopens only a `failed` workflow, and reuses
  completed planning/design output.

## Persistence and migration 29

`supabase/migrations/29_multi_agent_orchestration.sql` is additive and
non-destructive. It adds:

| Table | Purpose |
|---|---|
| `agent_workflows` | One row per run (`run_id` unique), state, complexity, plan/design context, cost fields. |
| `agent_tasks` | Task definitions + persisted status, attempts, bounded output, dependencies, idempotency key. |
| `agent_workflow_events` | Bounded audit events (no prompts, no file content, no secrets). |
| `deployment_proposals` | Server-derived target, snapshot, source hash, status, approval and consumption timestamps. |

Access model:

- RLS is enabled on all four tables.
- The authenticated role has **SELECT only**, scoped through `projects`
  ownership; column grants exclude nothing sensitive because the row itself holds
  no prompt/file/secret content.
- Workflow/task/event writes are service-role only (the confined worker client).
- Proposal writes go through owner-checked `SECURITY DEFINER` RPCs:
  `create_deployment_proposal`, `approve_deployment_proposal`,
  `revoke_deployment_proposal` and the atomic `consume_deployment_approval`.
- `cancel_agent_workflow` is the only authenticated workflow mutation and checks
  project ownership.
- `multi_agent_schema_version()` returns `29` as the deployment preflight marker.

Apply order: after migration 28 (and after 16 and 26, which the worker and Android
paths use). The migration is safe to apply while the previous application version
is still deployed.

## Deployment approval gate

The gate is **independent** of orchestration:

- `MAVLY_DEPLOYMENT_APPROVAL_REQUIRED` enables it platform-wide.
- It is also enabled automatically for every project in the multi-agent cohort.
- With the gate off and the project outside any cohort, legacy deployment behavior
  is unchanged.

Flow:

1. The owner (or the workspace) asks for a proposal. The server derives the
   artifact itself: for full-stack, the exact PASSED verification snapshot and
   source hash; for static, the exact publish file set and its SHA-256.
2. The proposal records project, target, snapshot and hash. **Creating it does not
   deploy.**
3. The owner explicitly approves it. Approval has a bounded TTL
   (`MAVLY_DEPLOYMENT_APPROVAL_TTL_MINUTES`, 5–1,440, default 60).
4. `POST …/deployments/deploy` carries the approval id. Immediately before any
   provider mutation, the deploy path re-derives the artifact and calls
   `consume_deployment_approval`, which atomically re-checks project, target,
   snapshot, hash, approval state, expiry and prior consumption.
5. The approval is burned **before** the provider call. A provider failure after
   consumption requires a fresh proposal and approval — this is deliberate.

Refusals are explicit:

| Condition | HTTP | Code |
|---|---|---|
| Gate required, no approval id | 428 | `DEPLOYMENT_APPROVAL_REQUIRED` |
| Expired/revoked/consumed/mismatched | 409 | `DEPLOYMENT_APPROVAL_INVALID` |
| Missing migration / Supabase | 503 | `BACKEND_NOT_CONFIGURED` |
| Not the owner | 403 | `FORBIDDEN` |
| No such proposal | 404 | `NOT_FOUND` |

A model, a QA result, a clean security scan and a client-supplied hash are never
approval. The browser never supplies the source hash.

## Verification and versioning truthfulness

- QA’s build and runtime checks remain **pending** unless the existing verification
  sandbox recorded a result for the same source. The orchestrator does not run
  commands, builds, tests or browsers.
- `passed` still means build + runtime + sandbox-local health (Phases 3/4). A
  pending check is never rendered as a pass.
- Security combines the deterministic static scan with a bounded advisory source
  review; authorization is reported `unavailable` because static text cannot prove
  it. A source-backed critical finding can fail the workflow, but cannot change the
  already-terminal generation run.
- Post-coding QA and Security reviews run after `project_runs` is marked done, so
  a failed workflow review does not rewrite the generation run's terminal state or
  trigger a generation retry. **Moving them earlier is not free:** migration 32's
  trigger settles a completed run and releases a failed one, so failing the run on a
  review result would refund a delivered generation — a credit-policy change this
  phase must not make. Instead `recordCodingCompleted` returns a
  `CodingReviewOutcome`, and the run appends a second chat message that states the
  review outcome separately from the run's own result. The run and the workflow are
  therefore never presented as contradicting each other, and neither is presented as
  a success the other denies.
- No new snapshot is created by this layer. The coding pipeline keeps its existing
  immutable snapshots and restore points.

## Workspace observability

`ProjectWorkflowPanel` (More → **Agents & approvals**) reads only:

- `GET …/agent/workflow` — `enabled`, `approvalRequired`, `migrationRequired`, the
  workflow projection and its tasks/checks;
- `GET …/deployments/proposals` — proposal state and TTL.

It provides truthful disabled/migration/pending states, a cancel control for the
workflow record, proposal create/approve/revoke controls, and a **Deploy this
approval** action that sends only the approval id. It never calls a raw `/api/*`
path and never auto-deploys.

## Provider, credits and cost

- This phase does not charge or reserve credits, and it does not change pricing
  or billing. The Phase 11 credit foundation exists, but specialist usage
  metering records provider usage only; it does not debit credits or change
  generation reservation settlement.
- Planner, UI/UX, QA, Security and Repair calls use the fixed role-to-model mapping
  in `src/lib/ai/model-roles.ts` and go through the existing OpenRouter boundary.
  When `MAVLY_CREDITS_ENABLED` is truthy, each specialist attempt records
  provider-reported tokens, request id and USD cost through migration 31. When
  the flag is off, no credit/usage RPC is called. Unknown provider cost stays
  `NULL`; no estimate is presented as actual cost. Coding usage remains on the
  existing generation-run accounting path.
- A specialist result is discarded and its task is failed if OpenRouter reports a
  model different from the pinned role model. A failed usage write is logged (and
  with `MAVLY_CREDITS_ENABLED` off no usage RPC is called at all); the result is kept
  and the usage row stays absent, so nothing is fabricated. Neither outcome alters
  credit settlement.

## Security invariants

1. The service-role client stays confined to the worker path; orchestration uses
   the client it is given and never creates another.
2. A role cannot write files except through the existing coding pipeline.
3. Tool arguments are validated against the project’s real files; secret/binary
   paths are refused.
4. Generated source is data. Nothing in this layer executes it.
5. Deployment approval is owner-scoped, artifact-bound, expiring and single-use.
6. No prompt, model response body, file content or secret is stored in workflow
   events.
7. A browser cannot approve on behalf of another user, cannot supply a hash, and
   cannot reuse an approval.

## Limitations

- **Inline runs record no workflow.** Orchestration requires the durable worker.
- **Specialists run sequentially, not concurrently.** The engine executes its phases
  one after another because the coding role is the only writer of `project_files`.
  `selectRunnable()` in `workflow.ts` is the tested dependency/dependency-graph
  primitive that expresses ready tasks, but the engine does not use it to fan out
  parallel provider calls in this phase. Bounded per-call timeouts, budgets and
  retries still apply; there is no measured latency or throughput improvement.
- **No model tool-call loop in this phase.** Specialist roles receive bounded
  context and return JSON; they do not drive a multi-turn tool protocol. The
  scoped tool registry (`validateToolRequest`, `roleAllowsTool`) is the enforced
  allowlist for any tool request and is covered by unit tests, but only the
  existing coding pipeline writes files.
- **Repair is diagnostic only** and never edits `project_files`. For a failed
  generation, validated suggestions for paths still in the saved manifest may be
  passed as subordinate context to the existing coding engine on an eligible
  durable retry. Without that retry, suggestions remain unapplied. QA/Security
  findings arise after the generation run is terminal and do not trigger repair.
- **QA does not execute the project here.** Its source review is advisory; without
  the verification sandbox, build and runtime stay `pending`/`unavailable`.
- **No benchmark claims.** Tests are unit/static only; no live Supabase, provider,
  sandbox or Vercel deployment was exercised by the authoring agent.
- **Migration 29, RLS and the RPCs are unverified against a real database.**
- The approval gate’s `consume` step burns an approval even if the provider call
  then fails; this is intentional but means a retry needs a new approval.
- The workflow record is observability, not authorization. It cannot deploy,
  merge or bypass any existing control.

## Manual acceptance (human-run)

Run the repository commands documented in `AGENTS.md`. In particular:

```bash
npx tsc --noEmit
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test
npm run lint
npm run build
```

Then apply migration 29 in a disposable environment and verify the runbook
checklist in `docs/runbooks/multi-agent-orchestration.md`.

# Mavly generation engine final overhaul

**Date:** 2026-11-03  
**Evidence class:** static implementation and contract inspection  
**Execution status:** no automated checks, provider calls, database migrations, sandbox runs, AWS operations, browser probes or load tests were executed by the agent. The repository policy assigns those checks to the human operator.

## Executive summary

The confirmed Phase 3 blocker was observability: the multi-agent workflow persisted
task status and output, but did not persist enough lifecycle facts to distinguish an
ineligible role, a scheduled role, an executed role, a produced output and a consumed
output. The workflow also had no owner-facing projection separating source generation
from structural, build, render, functional, security and deployment evidence.

This pass adds an additive lifecycle migration and wires the existing worker-owned
orchestration path to record those facts. Coding remains the only mandatory source
writer, the locked role-to-model mapping is unchanged, and no second queue/provider/
generation pipeline was introduced.

## Implemented

### Agent lifecycle transparency

Changed:

- `src/lib/orchestration/contracts.ts`
- `src/lib/orchestration/workflow.ts`
- `src/lib/orchestration/store.ts`
- `src/lib/orchestration/engine.ts`
- `src/lib/mavly/run-agent.ts`
- `src/lib/vcaas-types.ts`
- `src/components/workspace/v2/ProjectWorkflowPanel.tsx`
- `supabase/migrations/58_multi_agent_lifecycle_observability.sql`

The durable task projection now carries:

- eligibility and eligibility reason;
- scheduling timestamp and scheduling reason;
- started/finished timestamps and duration;
- provider and resolved/pinned model id;
- output produced versus output consumed;
- retry count;
- explicit skip and failure reasons;
- final task status.

The image-stage fallback was also tightened in `src/lib/mavly/run-agent.ts`: when
planning validation, configuration, time budget or image execution fails, planned
placements are sent to Coding as explicit unavailable placeholders. Coding receives
no invented URL and cannot mistake an unattempted asset for a ready one.

All seven locked roles are represented when a workflow is created. Complexity gates
mark Planner, UI/UX and Deployment explicitly ineligible for simple requests;
Repair is registered as failure-only and is activated only on a bounded repair path.
The task list therefore does not imply that an absent role executed.

### Verification projection

`deriveWorkflowVerification()` now exposes independent owner-facing evidence for:

1. generated;
2. structurally valid;
3. compiled;
4. rendered;
5. functionally verified;
6. security reviewed;
7. deployment verified;
8. `fullyVerified`.

The projection never upgrades generated source, a ready dev server, or an advisory
model review into a complete verification pass. The existing isolated sandbox and
deployment gates remain the authorities for build/runtime/deployment claims.
`fullyVerified` is the pre-deployment application-evidence projection; deployment
verification remains a separate field and is never implied by it.

The deterministic security scan remains the blocking security gate. An unavailable
advisory QA/Security model review is persisted as unavailable and remains visible; it
does not silently become a pass or unnecessarily rewrite a valid generation as a
source/build failure. Critical static findings still fail the security task and block
workflow completion.

### Existing reliability paths inspected and preserved

- Durable run claims, leases, checkpoints, cancellation and credit settlement remain
  in the existing generation path.
- Specialist calls continue through the pinned OpenRouter adapter with bounded clocks,
  provider-attempt accounting and no model fallback.
- Image planning persists approved assets before paid calls, validates image bytes,
  uploads through server-derived Storage paths and exposes only ready URLs to Coding.
- `preview.html` remains self-contained and is not presented as proof that the real
  Next.js application rendered its remote assets.
- Verification remains isolated and off by default; generated code is not executed on
  a Mavly worker.
- AWS publication completion remains worker-fenced and follows S3 verification plus
  owner-route verification. Browser-callable status reads do not become the
  authoritative verified-state write.

## Database migration

Apply:

```text
supabase/migrations/58_multi_agent_lifecycle_observability.sql
```

Prerequisite: migration 29. Migration 58 adds lifecycle columns, bounded constraints,
an index, authenticated read grants for the new metadata, a backfill for derivable
legacy facts, and schema marker 58. It is additive and non-destructive.

## Seven-role verification matrix

| Role | Policy | Model/provider | Source writes | Current evidence |
|---|---|---|---:|---|
| Planner | Standard/complex only | DeepSeek V4 Pro / OpenRouter | No | Persisted plan output and lifecycle row |
| UI/UX | Standard/complex only | Claude Sonnet 5 / OpenRouter | No | Persisted design output and lifecycle row |
| Coding | Mandatory | Claude Sonnet 5 / OpenRouter plus existing generation engine | Yes | Durable batches/checkpoints and lifecycle row |
| QA | Required review stage | GPT-5.6-SOL / OpenRouter | No | Static checks plus recorded sandbox evidence |
| Security | Required review stage | Claude Sonnet 5 / OpenRouter plus deterministic scan | No | Findings and security verification output |
| Repair | Failure-only, bounded | DeepSeek V4 Pro / OpenRouter | No direct writes | Diagnosis is subordinate context for a later Coding retry |
| Deployment | Authorization-dependent deterministic stage | Deterministic | No | Proposal/approval/deployment records; never model approval |

Configured specialist model availability is not live provider verification. The exact
ids remain pinned and no fallback is introduced.

## Image and preview status

**Implemented in repository:** planning, bounded approval, claim fencing, provider
byte validation, Storage upload, ready-row completion, cost-known/unknown handling,
reuse, pending/deferred reporting and Coding URL restrictions.

**Not executed:** an end-to-end provider → Storage → generated Next.js build → runtime
render → actual image load. The existing image tests cover the pure lifecycle and
mocked stage contracts, but a real provider, Storage bucket, sandbox and generated
application are required for the product acceptance claim.

**Preview policy:** `preview.html` remains the truthful lightweight fallback. A
runtime sandbox is separate evidence and is not silently substituted. No preview
implementation was removed.

## AWS, Neon, E2B and credits

- **AWS frontend hosting:** existing S3 publication, KVS route activation, route
  verification, fencing, lease renewal, failure recovery and rollback paths were
  inspected. No live AWS deployment or health probe was run.
- **E2B/runtime sandbox:** configuration, template selection, path filtering, command
  allowlists, bounded logs, readiness checks and cleanup paths were inspected. The
  configured E2B template must be operator-validated to contain the required Node,
  npm and Vite toolchain; no template was assumed to be production-ready based on
  static code alone.
- **Neon:** the existing managed-backend requirement, additive schema compiler,
  verification and gateway readiness flow remains unchanged. No live Neon project,
  schema run or gateway request was executed.
- **Credits:** no pricing, entitlement or settlement rules changed. Existing durable
  reservation, provider-attempt, terminal settlement/release and image cost-known
  semantics remain in force. No live credit reconciliation was run.

## Tests added or updated

`tests/multi-agent-orchestration.test.ts` now covers:

- explicit eligibility for all seven roles;
- complexity-gated and failure-only roles;
- independent verification projection;
- migration 58 lifecycle columns and schema marker;
- workspace presence of lifecycle metadata.

The test file was not executed under the repository's agent verification policy.

## Operator verification commands

Run only against disposable/staging infrastructure with the required credentials:

```bash
npm install
npx tsc --noEmit
npm run lint
npm test
npm run build
```

Apply migrations in order through the staging Supabase migration process, including
29 and 58, then verify:

```sql
select public.multi_agent_schema_version();
select public.multi_agent_lifecycle_schema_version();
select public.aws_frontend_fencing_schema_version();
```

For a worker-dispatched cohort project, execute and capture evidence for simple,
standard, complex, Android, image-enabled, provider-failure, worker-restart and
verification-failure generations. Record the run id, workflow id, task lifecycle
rows, provider attempts, image rows, snapshot/source hash, verification row, AWS
publication row where applicable, duration, token usage, reported cost and credit
ledger/reservation outcome.

For image acceptance, additionally confirm the real stored URL returns the expected
image bytes and that the isolated generated application references and loads it. A
static preview or ready Storage row alone is insufficient.

For scalability, keep the current 2-user/8-global admission caps and stage controlled
loads at 8, 16, 25, 50, 100, 250, 500 and 1,000 only after lower levels are healthy.
Capture success/failure counts, queue wait, p50/p95/p99 duration, provider throttling,
worker/database/sandbox resource use, image outcomes and credit reconciliation.

## Rollback

The code change is additive. Disable the multi-agent cohort/feature flag to return
generation to the existing Coding pipeline. Do not drop migration 58 or its columns;
the old workflow rows remain compatible with the new projection after the migration is
applied. Revert the application revision only after draining or fencing active worker
attempts according to the generation-worker runbook.

## Evidence classification

| Area | Classification |
|---|---|
| Lifecycle metadata implementation | Implemented; static inspected |
| Verification projection | Implemented; static inspected |
| Existing image lifecycle | Implemented in code; live rendering not executed |
| Preview fallback | Implemented and preserved; comparative measurement not executed |
| E2B execution | Blocked by infrastructure/operator credentials |
| AWS deployment | Blocked by infrastructure/operator credentials |
| Neon provisioning | Blocked by infrastructure/operator credentials |
| Credit reconciliation | Not executed |
| Automated tests/typecheck/lint/build | Not executed by agent policy |
| Failure injection | Not executed |
| Concurrency/load testing | Not executed |
| p50/p95/p99 and cost per successful generation | Not measured |

No reliability percentage or production-readiness claim is made without those runtime
measurements.

## Final acceptance matrix

| Requirement | Classification | Evidence/next action |
|---|---|---|
| Complete files and truthful generated state | Implemented in existing durable pipeline | Run staged generation scenarios |
| All applicable roles have terminal lifecycle state | Implemented | Apply migration 58 and inspect workflow rows |
| Ineligible roles are explicit | Implemented | Verify simple/standard/complex projections |
| Provider/model and duration metadata | Implemented | Confirm against provider-attempt rows |
| Output produced versus consumed | Implemented | Confirm plan/design/repair handoff rows |
| Structural verification projection | Implemented | Static regression test added, not executed |
| Isolated build/runtime verification | Implemented in existing sandbox path | Requires operator credentials and staging run |
| Functional/browser evidence | Not implemented as a claim | Requires a separate approved functional suite |
| Security critical findings block unsafe workflow/deploy | Implemented | Exercise critical static finding and deployment gate |
| Advisory QA/Security model failure visibility | Implemented | Exercise malformed/timeout specialist response |
| Real image bytes and Storage persistence | Implemented in image stage | Requires live OpenRouter and Storage |
| Generated application image rendering | Not executed | Run the image rendering staging scenario |
| Static preview fallback | Preserved | Compare with runtime preview in staging |
| E2B/runtime template readiness | Blocked by infrastructure | Validate configured template/toolchain |
| AWS artifact publication and route verification | Existing implementation inspected | Run staged AWS publication/rollback |
| AWS verified-state authority | Preserved | Worker completion remains authoritative |
| Neon provisioning and gateway readiness | Existing implementation inspected | Run staging Neon lifecycle |
| Credit reservation/settlement | Preserved | Reconcile run, usage, ledger and reservation rows |
| Provider retry and output limits | Existing implementation inspected | Inject timeout/429/5xx/malformed output |
| Worker restart/lease recovery | Existing implementation inspected | Kill a staging worker during a claimed run |
| Queue backpressure/fairness | Not measured | Progressive staging load |
| p50/p95/p99 duration | Not measured | Capture at each load tier |
| Cost per successful generation | Not measured | Include provider/image/repair/verification spend |
| 1,000 concurrent capacity | Not executed | Stop on first resource/credit/duplicate invariant failure |
| Aspirational reliability rate | Not claimed | Calculate only from production evidence and confidence intervals |

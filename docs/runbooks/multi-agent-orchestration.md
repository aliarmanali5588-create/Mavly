# Runbook — Multi-agent orchestration and deployment approval

Operator guidance for the Phase 10 layer. It is **off by default** and changes
nothing for an inline run, a project outside the cohort, or a deployment with the
approval gate disabled.

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Migrations 10, 16 | The durable run/worker lease model this layer reuses. |
| Migration 29 | Workflows, tasks, events, proposals, RPCs and the schema marker. |
| Durable worker enabled and scheduled | The only execution context with a confined service-role client. |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` | Worker persistence. |
| `OPENROUTER_API_KEY` | Planner/UI-UX/repair model calls. |
| A scheduled `POST|GET /api/generation/worker` invocation | See `docs/runbooks/generation-worker.md`. |

A half-configured deployment stays off. `GET …/agent/workflow` reports `enabled:
false` and an exact `note`, and a generation keeps the existing pipeline.

## 2. Enable

1. Apply migration 29:

   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/29_multi_agent_orchestration.sql
   ```

2. Confirm the marker:

   ```sql
   select public.multi_agent_schema_version(); -- 29
   ```

3. Set the configuration for one disposable project first:

   ```dotenv
   MAVLY_MULTI_AGENT_ENABLED=1
   MAVLY_MULTI_AGENT_PROJECTS=<one-project-id>
   MAVLY_MULTI_AGENT_REPAIR_ENABLED=0
   MAVLY_MULTI_AGENT_MAX_PROVIDER_CALLS=8
   MAVLY_MULTI_AGENT_MAX_WALL_CLOCK_MS=240000
   MAVLY_DEPLOYMENT_APPROVAL_REQUIRED=1
   MAVLY_DEPLOYMENT_APPROVAL_TTL_MINUTES=60
   ```

   The approval gate is enabled automatically for cohort projects even when
   `MAVLY_DEPLOYMENT_APPROVAL_REQUIRED` is unset. Set it explicitly so the
   platform-wide intent is visible.

4. Redeploy the application with the new server environment. The worker and the
   web app must share the same Supabase project.

5. Submit a prompt to the cohort project and confirm a workflow appears:

   ```sql
   select id, run_id, state, complexity, provider_calls, cost_known,
          reported_cost_usd, error_class
     from public.agent_workflows
    order by created_at desc
    limit 5;
   ```

   A run outside the cohort, or an inline run, records **no** workflow. That is
   correct, not a failure.

## 3. Observe

### API (owner session)

```bash
curl -sS -b "$COOKIE" \
  "$APP_URL/api/vcaas/projects/<project-id>/agent/workflow" | jq

curl -sS -b "$COOKIE" \
  "$APP_URL/api/vcaas/projects/<project-id>/deployments/proposals" | jq
```

### SQL

```sql
-- Tasks and recorded checks for the latest workflow.
select t.task_key, t.role, t.status, t.attempt, t.error_class,
       t.output -> 'verification' ->> 'status' as verification
  from public.agent_tasks t
 where t.workflow_id = (select id from public.agent_workflows
                         order by created_at desc limit 1)
 order by t.created_at;

-- Proposal lifecycle.
select id, target, status, approved_at, expires_at, consumed_at, revoked_at
  from public.deployment_proposals
 order by created_at desc
 limit 20;

-- Bounded audit events (no prompts or file content).
select created_at, kind, task_key, message
  from public.agent_workflow_events
 order by id desc
 limit 50;
```

### Workspace

More → **Agents & approvals** shows task state, verification checks, reported
cost, proposal status and the approval controls.

## 4. Approval and deploy procedure

1. **Create proposal** in the workspace (or `POST …/deployments/proposals`).
   The server derives the target, snapshot and source hash.
2. Review the summary (target, file count/entry point, verification state, risks).
3. **Approve** as the project owner. An agent cannot approve.
4. **Deploy this approval**. The deploy request carries only the approval id; the
   server re-derives the source and consumes the approval atomically.
5. Verify the result with the existing deployment status route. A consumed
   approval cannot be reused, and a provider failure after consumption needs a
   fresh proposal.

## 5. Failure handling

| Symptom | Meaning | Action |
|---|---|---|
| `428 DEPLOYMENT_APPROVAL_REQUIRED` | Gate is on and no approval id was sent. | Create → approve → deploy the approval. |
| `409 DEPLOYMENT_APPROVAL_INVALID` | Expired, revoked, consumed, wrong project/target/snapshot/hash. | Create and approve a fresh proposal. |
| `503 BACKEND_NOT_CONFIGURED` | Migration 29 missing, or Supabase not configured. | Apply migration 29 / fix server config. |
| Workflow `failed`, `error_class=security_critical` | Static scan found critical material. | Inspect the task findings in the workspace; fix the source. |
| Workflow `failed`, `error_class=workflow_deadline` | The per-attempt wall-clock budget was reached. | Raise `MAVLY_MULTI_AGENT_MAX_WALL_CLOCK_MS` within 15 min, but keep it below the worker lease window and remember the 240 s generation budget; or reduce scope. |
| `error_class=provider_calls` | Model-call budget reached. | Raise the cap within 24, or use a simpler prompt. |
| QA `pending` | The verification sandbox has not recorded a result. | Enable/verify the sandbox; this layer will not claim a build. |
| `enabled: false` with a note | Config/worker prerequisite missing. | Read the note and fix the named prerequisite. |

The ordinary run view and worker runbook remain authoritative for run retries,
leases, dead letters and cancellation.

## 6. Cancellation

- **Stop** in the chat cancels the run; the worker then also settles the workflow
  record (`cancelWorkflowForRun`).
- **Cancel workflow record** in Agents & approvals only settles the orchestration
  record; it does not fence the run. Use Stop when you need the run stopped.
- A cancelled/completed workflow is never reopened by a duplicate delivery.

## 7. Pause, drain and rollback

1. **Pause** — remove `MAVLY_MULTI_AGENT_ENABLED` (or clear the cohort) and
   redeploy. New runs use the existing pipeline and record no workflow.
2. **Drain** — let in-flight worker runs finish or cancel them. Existing workflow
   rows remain readable.
3. **Approval gate** — do **not** disable `MAVLY_DEPLOYMENT_APPROVAL_REQUIRED` on a
   cohort deployment without a decision: cohort membership re-enables the gate
   automatically.
4. **Schema rollback is not required.** Migration 29 is additive and its tables can
   stay. Dropping them is a separate, destructive operation that also removes the
   approval audit trail; do not do it during an incident.
5. Existing deployments keep their status and takedown behavior when the flags are
   turned off. The deploy paths remain owner-authenticated.

## 8. Capacity and limits

- Admission limits are unchanged (1 active run per project, 2 per user, 8 global).
- Orchestration adds at most **two** model calls before coding (planner + design)
  and **one** after a failure (repair), each bounded and budgeted. It reuses the
  same `OPENROUTER_API_KEY` and provider account.
- No credits are charged. Only the provider-reported USD cost is recorded, and it
  is marked unknown rather than estimated when the provider omits it.
- Approvals expire (default 60 min) and are single-use; a stale row is harmless.

## 9. Manual acceptance checklist

- [ ] `npx tsc --noEmit` and `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- [ ] `npm test` (Node 22.6+) including `tests/multi-agent-orchestration.test.ts`
- [ ] `npm run lint` and `npm run build`
- [ ] Migration 29 applied; `multi_agent_schema_version()` returns 29
- [ ] Worker scheduled; a cohort run records a workflow with tasks
- [ ] An inline/non-cohort run records no workflow and still generates
- [ ] QA shows `pending` when the sandbox is off (never `passed`)
- [ ] A critical static finding fails the workflow
- [ ] Deploy without approval → 428; approve → deploy succeeds; reuse → 409
- [ ] Revoke makes the approval unusable
- [ ] A static source edit after approval invalidates it
- [ ] Disabling the flags leaves legacy deployments working

Record actual results. Do not mark an item complete unless it was run.

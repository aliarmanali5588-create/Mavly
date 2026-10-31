# Runbook — credits

The credit foundation is **off by default** and has not been exercised against a live
database. Treat every step below as unverified until you run it in staging.

## Enable

1. Apply `supabase/migrations/31_credit_foundation.sql` (after migration 30), then
   `supabase/migrations/32_credit_reliability_hardening.sql`. Both are forward-only; 32
   adds consistent lock ordering, atomic terminal accounting, durable provider-attempt
   tracking and the schema marker required by the worker.
2. Verify the marker:

   ```sql
   select public.credit_schema_version();  -- 32
   ```

3. Configure and verify the platform-wide Render Background Worker.
   Credit-aware runs are worker-only; they never fall back to `after()` inline execution.
   Production dispatch is automatic for every project; the credit feature still requires
   the existing service-managed policy and its explicit `MAVLY_CREDITS_PROJECTS` cohort.

4. Configure server-side only:

   ```
   MAVLY_CREDITS_ENABLED=1
   MAVLY_CREDITS_PROJECTS=<one disposable project id>   # never '*'
   MAVLY_CREDITS_GENERATION_COST=<whole credits, 1..100000>
   ```

5. Add the database-owned mirror for each explicitly enabled project, using the same fixed
   cost. This table is the database enforcement boundary; a missing or mismatched row
   refuses credit admission. The trigger refuses activation while there are inline or
   unreserved active runs, when existing holds have a different cost, or when live holds
   exist during a policy change:

   ```sql
   insert into public.credit_project_policies (
     project_id, generation_cost_credits, enabled
   ) values (
     '<disposable project id>', 25, true
   )
   on conflict (project_id) do update set
     generation_cost_credits = excluded.generation_cost_credits,
     enabled = true,
     updated_at = now();
   ```

   Keep this database cohort and price synchronized with the application environment.
   This is a staged rollout: mismatches fail closed, and an enabled database policy also
   blocks legacy direct `create_generation_job` / `resume_generation_job` calls.

6. **Fund the test account before generating.** There is no credit-pack or subscription
   grant flow. Use the service-role RPC:

   ```sql
   select public.grant_credits(
     '<user uuid>',
     25,
     'staging acceptance grant',
     'acceptance-grant-1'      -- idempotent
   );
   ```

   `grant_credits` requires a service-role JWT; it cannot be called from the browser.

7. Open the workspace and confirm the indicator shows available credits (not `10`, not
   `—`). If it shows `—`, check `GET /api/vcaas/credits`; a `503 MIGRATION_REQUIRED` means
   step 1 did not apply.

If `MAVLY_CREDITS_ENABLED` is set but the cohort or cost is missing, generation is
not admitted through the credit-aware path and `/api/vcaas/credits` reports the exact
configuration problem. An enabled database policy independently blocks unreserved legacy
run writes, so do not enable policy rows before the application rollout is coordinated.

## Acceptance checklist

Do these in a staging database with a disposable account and project.

- [ ] Launch once with enough credits. Available credits drop by the hold at admission;
      the balance itself drops only after the run completes.
- [ ] `select balance_credits, reserved_credits from credit_accounts where user_id = …;`
      shows `reserved_credits` increasing at admission, then returning to zero while
      `balance_credits` decreases by exactly the configured cost after success.
- [ ] `select operation, amount_credits, reserved_delta_credits, idempotency_key
      from credit_ledger where user_id = … order by created_at;` shows one
      `generation_reserved` (amount 0) and one `generation_consumed` (negative amount).
- [ ] Re-submit the same launch with the same `clientRequestId`: the same run is returned,
      there is no second reservation, and no second ledger consumption.
- [ ] Re-submit the same key with a different prompt: `409 CONFLICT`.
- [ ] Force a failed run: the durable worker (or service-role terminal handler) releases
      the hold, the balance is unchanged, and the ledger has `generation_released` with
      amount 0. Owner balance reconciliation settles successes only.
- [ ] Cancel a running run: the trusted worker/server terminal path releases the hold; a
      browser cannot directly release it.
- [ ] Resume a released failed run with enough credits: exactly one new hold appears.
- [ ] Resume with insufficient credits: `402 INSUFFICIENT_CREDITS`, the run stays failed.
- [ ] Two concurrent launches that would overdraw the last credits: exactly one run is
      created; the other receives `402`, and no negative balance exists.
- [ ] Two concurrent workers cannot both consume the same reservation (only one
      `generation_consumed` row per reservation id).
- [ ] A terminal run update and its `generation_consumed` or `generation_released`
      ledger write commit or roll back together.
- [ ] Repeating the same provider-attempt start UUID returns `existing` and does not
      dispatch a second request; a crash/timeout without a result leaves that attempt
      marked uncertain rather than assigning a zero cost.

## Reconciliation

The owner read (`GET /api/vcaas/credits`) runs `reconcile_owner_credits()` first: up to 25
successful terminal-run reservations are settled. It never releases failed/cancelled
holds or records provider usage. Migration 32's terminal trigger normally settles/releases
the hold in the same transaction as the terminal run update. The durable worker runs
`maintain_credit_reservations(100)` once per tick; that tick first calls
`release_orphaned_credit_reservations`, which returns holds whose run row was deleted (a
deleted project cascades its runs) and reports `orphansReleased`. The worker sweep remains
enabled for recovery even if the current `MAVLY_CREDITS_ENABLED` flag is off.

Manual checks:

```sql
-- ledger and account must agree
select a.user_id,
       a.balance_credits,
       coalesce(sum(l.amount_credits), 0) as ledger_balance,
       a.reserved_credits,
       coalesce(sum(l.reserved_delta_credits), 0) as ledger_reserved
from credit_accounts a
left join credit_ledger l on l.user_id = a.user_id
group by a.user_id, a.balance_credits, a.reserved_credits
having a.balance_credits <> coalesce(sum(l.amount_credits), 0)
    or a.reserved_credits <> coalesce(sum(l.reserved_delta_credits), 0);

-- a live hold must belong to an unfinished run
select r.*
from credit_reservations r
join project_runs p on p.id = r.run_id
where r.status = 'reserved' and p.finished_at is not null;

-- a live hold must belong to a run that still exists (older than the grace window)
select r.*
from credit_reservations r
where r.status = 'reserved'
  and r.created_at < now() - interval '1 hour'
  and not exists (select 1 from project_runs p where p.id = r.run_id);

-- unknown cost must stay unknown
select count(*) from ai_usage_attempts
where actual_cost_usd is null and cost_source <> 'unavailable';
```

A mismatch is an incident: do not edit the ledger (it is append-only). Record a
compensating entry with `grant_credits` / `refund_generation_reservation`, or escalate.

## Refunds

`refund_generation_reservation(run_id, amount, reason, idempotency_key)` is
**service-role only** and requires a consumed reservation. It is idempotent on
`(user, key)` and cannot refund more than the reservation amount. If the key is omitted,
the database derives one from the reservation and amount, so an identical retry is harmless;
provide distinct keys for intentional repeated partial refunds of the same amount. There is
no automatic customer refund policy in this build; a refund is an explicit operator decision.

## Pause / rollback

- To pause new admissions for one project, first remove it from
  `MAVLY_CREDITS_PROJECTS` while leaving `MAVLY_CREDITS_ENABLED=1` and the Render worker running.
  The database policy continues to block the legacy unreserved path. Let active runs reach
  terminal states and confirm the worker sweep has cleared every live reservation for that
  project.
- Only after the project has no active runs or live holds, set its `enabled` policy to
  `false`. The application project cohort and database policy must stay aligned; with the
  row disabled and project removed from the cohort, its generation returns to the
  pre-credit behavior.
- To disable all credit accounting, drain all credited projects, verify they have no live
  reservations, disable their database policies, remove the application cohort, and only
  then set `MAVLY_CREDITS_ENABLED=0`. With the flag off, admission and owner-facing credit
  reads make no credit/usage RPC calls; the durable worker still runs its recovery sweep
  while enabled. Do not rely on that sweep if the worker itself is disabled.
- Never turn off the flag while policy rows are still enabled unless intentionally
  blocking generation. The database policy is independent of the application flag and
  continues to reject legacy unreserved run writes. Disabling or changing a policy with a
  live reservation is rejected by its trigger.
- Do not drop the tables to "roll back": the ledger is the audit trail. Disable the feature
  and leave the data.
- To stop the sweeps, stop the durable worker only after no active run/hold requires
  settlement or release; owner reconciliation is success-only and cannot release failures.

## Cost rate card (optional)

`ai_cost_rates` is empty. To enable estimates, install verified rates (service role):

```sql
insert into public.ai_cost_rates (
  model, provider, input_usd_per_million, output_usd_per_million,
  cached_input_usd_per_million, version
) values (
  'deepseek/deepseek-v4.1-flash', 'openrouter', 0.00, 0.00, 0.00, 'operator-2026-10'
)
on conflict (model) do update set
  input_usd_per_million = excluded.input_usd_per_million,
  output_usd_per_million = excluded.output_usd_per_million,
  cached_input_usd_per_million = excluded.cached_input_usd_per_million,
  version = excluded.version,
  updated_at = now();
```

The placeholder numbers above are **not** verified prices. An incorrect rate card produces
incorrect estimates; it never changes a credit balance.

## Alerting

Emit/scan for:

- `credits.settlement_deferred` — settlement/release could not be applied; the sweep should
  repair it. A repeated line means the sweep is not running.
- `credits.refused` — a user hit `INSUFFICIENT_CREDITS`. Expected before funding exists.
- `credit_ledger_immutable` / `CREDIT_LEDGER_APPEND_ONLY` errors — an attempted mutation;
  investigate immediately.
- `CREDIT_ACCOUNT_INCONSISTENT` — settle/release found fewer reserved credits than the
  reservation. Stop settlement operations and reconcile manually.

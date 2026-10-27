# Runbook — production hardening (Phase 7)

## Preconditions

- Migrations applied in order: 18 (admin allowlist), 21 (business
  integrations), 23 (durable payment limits).
- Server environment as in `.env.example`; no new Phase 7 variable was added.
- `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` backed up outside the database.
- Mavly's own Razorpay billing untouched.
- Supabase backup/PITR policy confirmed by the operator (the repository does not
  implement platform-wide database backups).

## Staged rollout

1. **Admin surface:** apply 18, deploy, confirm `/adminsh/dashboard` redirects a
   signed-out browser to `/login` and returns 404 to a signed-in non-admin.
2. **Durable limits:** apply 23 (additive; the previous app build still works),
   then deploy the Phase 7 build. Until 23 is present, payment gateway calls
   return 503 and the owner panel shows the migration warning.
3. **Payment cohort:** keep `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS` to one test
   project. Save test keys, create one order, verify it, and resend a webhook.
4. **Worker/deployment cohorts:** unchanged; enable only after the existing
   generation/verification/full-stack runbooks' checks pass.
5. **Widen the cohort** only after the acceptance checklist below.

Stop conditions: repeated gateway 503s, any `payment.webhook_failed` with
`amount_mismatch`, a migration warning in the owner panel, or a deployment that
is shown ready without provider readiness. Remove the project from the cohort
and use **Stop payments** for a project-level pause.

## What to watch (log-based; no metrics vendor)

- `[payments]` `payment.gateway_unavailable`, `payment.order_failed`,
  `payment.webhook_failed`, `payment.rate_limited`,
  `payment.integration_test_failed`.
- `[generation]` `generation.dead_letter`, repeated `generation.worker_error`,
  `generation.lease_lost`.
- `[verification]` `verification.error`, repeated timeouts.
- Hosting events for deployment failures and `secrets_not_synced`.
- Supabase/PostgREST error codes in server logs (never payloads).

The owner **Business payments** panel shows status, last provider check, recent
orders and webhook events. Failed events are a reconciliation signal, not a
payment result.

## Recovery procedures

### Failed new full-stack deployment

- Confirm the attempt is `failed` and `project_deployments.vercel_deployment_id`
  still points at the previous deployment (migration 20 settlement).
- Fix the reported cause (verification, provider, domain, synced secret,
  database contract), then redeploy.
- Rollback to a previously ready attempt through the deployment history; do not
  delete the previous deployment or snapshot.
- If Vercel accepted a deployment but Mavly could not record it, inspect the
  provider dashboard; do not fabricate a ready row. The attempt fence rejects a
  stale settle.

### Stuck generation or verification job

- Inspect `project_runs.stage`, lease expiry and `generation.dead_letter` /
  `verification.error` events.
- A worker tick recovers expired leases; a job in a terminal state is not
  revived. Use the workspace resume/stop actions, which are authenticated and
  fenced.
- Do not delete the last snapshot or run row to “unstick” a job.

### Provider outage (Razorpay/Vercel/Supabase)

- Gateway/provider failures return 502/504/429; no payment state is guessed.
- Webhooks remain queued at the provider and retry; a local DB failure leaves
  the event recoverable (the signed body is re-sent).
- Pause new payment orders by removing the project from the cohort (this also
  pauses webhook processing) or use **Stop payments** (webhooks continue for
  in-flight orders).

### Invalid or rotated provider secret

- Re-save the three values in **Business payments**; the key pair is retested.
- Rotate `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET` only with a coordinated
  re-save of each integration; the stored hash must match.
- A rotated `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` makes existing ciphertext
  unrecoverable. Restore the old key or re-enter secrets; do not delete rows
  merely because decryption failed.

### Missing migration

- The owner panel reports `hardeningReady: false` for migration 23; apply it.
- If the admin layout returns 404 for the real administrator, verify migration
  18, the confirmed `auth.users` email, and the allowlist row. Fail closed.

### Failed webhook-processing operation

- Open **Business payments → Webhook events**.
- `processing_error`: the database write failed; the event row is resettable and
  the provider retry reprocesses it. Check Supabase availability.
- `received` for more than two minutes: a crashed/finish-failed handler. Migration
  23 lets the next signed retry reclaim it; if the provider has stopped retrying,
  re-send the event from the Razorpay dashboard. Do not edit the row to `paid`.
- `order_not_found`: the provider has an order Mavly did not record (for example,
  a crash between the provider response and the local write). Reconcile against
  the Razorpay dashboard; Mavly leaves the event failed and does not mark paid.
- `amount_mismatch`: do not fulfil. Compare the provider order/amount; treat as
  suspicious.
- `invalid_payload` / `invalid_signature`: do not retry blindly; verify the
  webhook secret and provider configuration.

### Accidental integration disablement

**Stop payments** refuses new orders and keeps the webhook address stable;
in-flight webhooks are still recorded. Re-enable by saving the credentials
again (live keys require confirmation). Deleting the project secrets is a
separate, explicit action in **Secrets**.

## Backup and restore

- Project source: immutable snapshots + restore points; a restore captures the
  pre-restore state.
- Secrets: ciphertext only; the encryption key is a separate backup item.
- Payments: provider is authoritative; local rows are audit/state. Reconcile
  uncertain orders from the provider.
- Deployments: previous ready deployment id and Vercel Instant Rollback.
- Database/platform backups: external Supabase policy; **not implemented in this
  repository**. Confirm the operator's retention/PITR before production.
- Never copy plaintext secrets into a backup, ticket, log or export.

## Human acceptance checklist

1. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` (human-run;
   the agent did not run these).
2. Apply 18, 21, 23; confirm `production_hardening_schema_version()` returns 23.
3. Signed-out `/adminsh/dashboard` → `/login`; signed-in non-admin → 404;
   allowlisted admin → page.
4. Payment panel shows `hardeningReady: true`; save test keys; test connection.
5. Create an idempotent order; repeat the same key → same provider order; pay
   with a test card; verify → `paid` only with a valid signature and provider
   record.
6. Forge the verify signature → 400, no state change.
7. Resend `payment.captured` → 200, one event row, no duplicate fulfilment;
   wrong signature → 401, no change.
8. Exceed 30 order attempts/60 s → 429 with `Retry-After`; wait for the window.
9. Direct anon gateway/webhook RPCs without the server RPC hash → no state change.
10. Trigger an unmatched webhook (if safely possible) and confirm it appears as
    `failed` with no payment state.
11. Confirm a failed new deployment leaves the previous deployment live; rollback
    to a ready attempt; takedown only removes the owned project's resources.
12. Confirm the admin console shows no fabricated real data and its controls are
    mock; do not present it as a live control plane.

## Known limitations

- A database read compromise exposes the hashes the anon RPCs accept; the
  service-role/asymmetric redesign is not implemented (needs approval).
- Full-stack claim/settle self-attestation remains for the owner's own project.
- No shared webhook limiter (provider retries must not be dropped).
- No platform-wide database backup engine in this repository.
- No live Razorpay/Vercel/Supabase/worker/browser acceptance was performed by
  the implementation agent.

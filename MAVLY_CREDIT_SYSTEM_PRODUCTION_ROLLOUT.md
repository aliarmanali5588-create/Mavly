# Mavly Credit System Production Rollout

Production enablement is gated on a completed staging runbook and explicit operator approval. This document does not authorize applying migrations or enabling live charges by itself.

## Release gates

- Staging migration sequence completed with no unresolved accounting discrepancy.
- Razorpay test payments, subscription renewals, refunds, and webhook replays accepted.
- Dodo test checkout, Standard Webhooks, currency handling, and reconciliation accepted.
- Concurrent credit admission and worker recovery accepted.
- Admin billing and INR AI-cost reports reconcile to database rows.
- F-02 regression accepted.
- Provider, Supabase, Storage, worker, DNS, and canonical-origin credentials are stored in the production secret manager only.
- A rollback owner and payment-support owner are named.

## Migration order

Apply the normal repository migrations first, then apply:

```text
57_platform_billing.sql
58_multi_agent_lifecycle_observability.sql
59_inr_billing_and_ai_costs.sql
60_business_integration_rpc_proof_hardening.sql
```

Apply migrations with the application version that understands both the old and new boundaries. Do not manually mutate existing catalog versions. Keep a database backup and migration transcript according to the operator's Supabase policy.

## Production configuration

1. Set `MAVLY_PLATFORM_BILLING_ENABLED` off until post-migration smoke checks finish.
2. Configure live Razorpay credentials and webhook secret for platform billing only.
3. Configure live Dodo credentials, Standard Webhooks signing key, exact live origin, and server-side product mappings.
4. Configure HTTPS `NEXT_PUBLIC_APP_URL`; Dodo checkout fails closed without it.
5. Configure trusted country resolution and verify the origin lock.
6. Install only approved INR rate-card and exchange-rate rows. Every rate must have an owner, source, version, effective time, and change record.
7. Configure the explicit billing cohort if a gradual launch is required. Never use a wildcard cohort.

## Controlled enablement

1. Keep checkout disabled and inspect schema markers, catalog rows, grants, and webhook endpoints.
2. Enable one internal operator account or explicitly approved cohort.
3. Run one low-value Razorpay test-mode-to-live readiness check using the provider's approved production procedure; do not use an unapproved real charge.
4. Enable live billing for the first cohort.
5. Watch payment settlement, webhook failures, reconciliation backlog, refund manual-review count, credit ledger invariants, and worker health.
6. Expand the cohort only after the support and reconciliation owners sign off.

## Monitoring and alerts

Alert on:

- webhook signature failures or repeated processing failures;
- amount/currency mismatches and missing INR-rate reconciliation rows;
- duplicate/idempotency conflicts above expected retry volume;
- payment rows stuck in `pending`/`processing`;
- subscription periods without entitlements;
- credit reservations older than the worker recovery bound;
- refund provider success without database completion;
- negative or inconsistent reconciliation results;
- unknown AI-cost rate-card coverage rising unexpectedly;
- F-02 RPC permission drift.

Financial reports must use INR paise snapshots. Provider settlement currency, exchange-rate metadata, and unknown values must remain visibly separate from revenue and margin figures.

## Rollback and pause

- First set `MAVLY_PLATFORM_BILLING_ENABLED` off to stop new checkout creation.
- Keep webhook endpoints available while queued provider events are reconciled; disabling ingestion can strand paid events.
- Do not delete payments, ledger rows, credit lots, subscriptions, refunds, or webhook events.
- If a catalog defect is found, retire the catalog version and publish a corrected immutable version.
- If settlement is unsafe, leave the event/payment in reconciliation or manual review; never grant credits from an operator guess.
- If provider credentials are compromised, rotate provider credentials and webhook signing keys through the provider dashboards, then update the server secret manager.
- If F-02 permissions regress, disable generated-app business payment writes separately; platform billing is a distinct boundary.

## Post-rollout reconciliation

At least daily during the first launch week:

1. Compare provider-confirmed payments with `platform_payments`.
2. Compare INR payment snapshots with provider-native amounts and approved rate versions.
3. Reconcile payment grants, subscription entitlements, credit lots, ledger balance, and reserved credits.
4. Review every manual-review refund and every unknown AI cost.
5. Confirm generated-app Razorpay revenue is excluded from Mavly platform revenue.
6. Store a signed operator report with counts and sanitized identifiers only.

## Current verification boundary

This repository change has not applied production migrations, used production financial data, called live Razorpay or Dodo, run a live worker, or run automated tests/typecheck/lint/build. Human staging acceptance is required before production rollout.

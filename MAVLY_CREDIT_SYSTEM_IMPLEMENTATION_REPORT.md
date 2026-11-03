# Mavly Credit System Implementation Report

**Date:** 2026-11-03  
**Status:** Implemented in the repository; staging and production verification pending.

## Outcome

Mavly now has an additive platform-billing boundary that is separate from generated-app Razorpay payments. The authoritative commercial currency is INR paise.

Implemented catalog:

| Product | Price | Credits / limit |
| --- | ---: | ---: |
| Starter | ₹399/month | 100 credits / 5 projects |
| Creator | ₹599/month | 200 credits / 15 projects |
| Pro | ₹1,999/month | 600 credits / 50 projects |
| Starter Pack | ₹199 one-time | 90 credits |
| Growth Pack | ₹299 one-time | 300 credits |
| Power Pack | ₹799 one-time | 1,000 credits |

India routes to Razorpay. Global users route to Dodo, but active catalog prices and Mavly financial reporting remain INR. Provider-native amounts are retained as reconciliation metadata only.

## Changed boundaries

- `supabase/migrations/57_platform_billing.sql` provides the platform billing domain: immutable catalog, payments, subscriptions, invoices, webhook events, entitlements, credit lots, refunds, reconciliation jobs, and server-side settlement RPCs.
- `supabase/migrations/59_inr_billing_and_ai_costs.sql` hardens the domain for INR, adds provider amount snapshots, explicit INR exchange-rate records, INR AI rate-card fields, lot attribution, unused-credit refund gates, and INR admin projections.
- `supabase/migrations/60_business_integration_rpc_proof_hardening.sql` closes F-02 for generated-app Razorpay: the owner cannot choose `rpc_secret_hash`; the server-only RPC writes the hash supplied by the trusted server path.
- `src/lib/billing/` contains market resolution, catalog types, provider adapters, event normalization, entitlement reads, and billing persistence.
- `src/app/api/billing/` contains authenticated checkout, subscription, verification, entitlement, payment, cancellation, admin refund, and raw-body webhook routes.
- `src/components/billing/CheckoutButton.tsx` provides provider-aware checkout for subscriptions and credit packs.
- `/billing/return` gives Dodo a canonical return page that does not claim payment success.
- `src/app/adminsh/billing/` and the INR AI-usage route expose database-owned admin projections.

## Accounting behavior

- Provider prices are never accepted from the browser. The server sends product/plan mappings and the catalog version.
- Duplicate requests use a user-scoped idempotency key. A changed product, market, provider, currency, or amount is an idempotency conflict.
- Credits are granted only after a verified provider event or verified Razorpay payment read reaches the database settlement RPC.
- Subscription grants are unique per subscription period.
- Credit packs create source lots. Generation settlement consumes lots in deterministic order and records lot consumption.
- Purchased-credit refunds require the complete purchased lot to remain unused. A consumed or partially consumed lot becomes manual review; no negative balance or clawback is produced.
- Refund and webhook retries are idempotent at the payment, event, refund, lot, and ledger boundaries.

## AI-cost behavior

- Existing USD provider fields remain historical diagnostics.
- INR estimated cost requires an operator-installed INR rate card.
- Provider-reported non-INR cost requires an explicit, versioned `billing_inr_exchange_rates` row.
- Unknown or uncertain cost remains `NULL`; it is not reported as zero.
- Admin AI usage reports actual INR, estimated INR, and unknown counts separately.

## Security behavior

- Platform provider credentials are server-only and separate from customer-app credentials.
- Webhooks verify the exact raw body before JSON parsing.
- Billing routes require a verified Mavly session; admin routes require the existing admin gate.
- Dodo return URLs fail closed without a configured canonical app origin.
- Generated-app payment storage remains separate from platform billing.
- F-02 is remediated through the service-role-only `save_payment_integration_server` RPC and migration 60.

## Verification status

No automated test, typecheck, lint, build, provider request, Supabase migration, sandbox payment, webhook delivery, worker tick, or production financial operation was run. Repository inspection was static only, as required by `AGENTS.md`.

The human developer must execute the staging sequence in `MAVLY_CREDIT_SYSTEM_STAGING_RUNBOOK.md` before using the production rollout document.

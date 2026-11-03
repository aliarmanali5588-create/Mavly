# Mavly Credit System Staging Runbook

Use only staging Supabase, Razorpay test mode, and Dodo test mode. Never use production financial data or live provider credentials in this procedure.

## 1. Preconditions

1. Confirm Node 20+ and the repository environment.
2. Configure staging Supabase and server-only provider variables from `.env.example`.
3. Set `MAVLY_PLATFORM_BILLING_ENABLED=true` only in staging.
4. Configure an explicit trusted country source. Do not use a browser-supplied country header.
5. Configure `NEXT_PUBLIC_APP_URL` to the staging HTTPS origin.
6. Configure server-only Dodo product ids and Razorpay subscription plan ids for the locked INR catalog.
7. Keep all customer-app Razorpay credentials and platform credentials separate.

## 2. Apply migrations

Apply in order through the existing repository baseline, then:

```text
supabase/migrations/57_platform_billing.sql
supabase/migrations/58_multi_agent_lifecycle_observability.sql
supabase/migrations/59_inr_billing_and_ai_costs.sql
supabase/migrations/60_business_integration_rpc_proof_hardening.sql
```

Confirm the billing schema marker reports `59` and the F-02 server RPC exists. Do not edit catalog rows in place; publish a new catalog version for any future commercial change.

## 3. Catalog and market checks

- Read `/api/billing/catalog` while billing is enabled.
- Confirm only the locked INR prices are active and approved.
- Confirm India resolves to Razorpay and a non-India verified country resolves to Dodo.
- Confirm unresolved or conflicting country signals refuse checkout.
- Confirm an attempted browser-supplied amount, provider, currency, product mapping, or catalog version cannot change the server result.

## 4. Razorpay test flow

1. Create a Starter Pack checkout.
2. Submit the same idempotency key twice; confirm one platform payment and one credit lot.
3. Reuse the key with a different product; confirm `IDEMPOTENCY_CONFLICT`.
4. Complete a test payment and verify the Razorpay signature plus authoritative payment read.
5. Replay the captured webhook; confirm no duplicate ledger grant.
6. Test failed, cancelled, invalid-signature, wrong-amount, wrong-currency, and unknown-payment events.
7. Create a test Starter subscription and confirm activation creates one period entitlement.
8. Replay activation and renewal events; confirm one grant per subscription period.
9. Test past-due, cancelled, expired, and failed subscription events.

## 5. Dodo test flow

1. Create a test Dodo checkout for a locked INR product.
2. Confirm the checkout URL returns to `/billing/return` and the page does not claim payment success.
3. Deliver a valid Standard Webhooks event and confirm one settlement.
4. Replay the exact webhook and deliver the same event id with a changed body; confirm duplicate and hash-mismatch behavior.
5. Deliver a non-INR event without an exchange-rate row; confirm no credit grant and a reconciliation/manual-review record.
6. Install a versioned operator exchange-rate row in staging, replay the event, and confirm the INR snapshot is explicit and auditable.

## 6. Refund flow

1. Purchase a credit pack and leave the entire lot unused.
2. Use the admin refund action for the full INR amount; confirm the provider refund, one compensating `refund` ledger row, zero remaining lot, and `refunded` payment state.
3. Retry the same admin request; confirm it is idempotent.
4. Consume part of a purchased lot, then attempt a refund; confirm `REFUND_REQUIRES_MANUAL_REVIEW` and no balance reduction.
5. Make the provider refund succeed but interrupt database completion; confirm the next reconciliation attempt does not grant or reverse twice.

## 7. Generation and lot allocation

- Grant or purchase multiple lot types.
- Start concurrent generations through the existing credit cohort.
- Confirm reservation, settlement, release, append-only ledger entries, and lot consumption remain consistent.
- Confirm a failed/cancelled run releases its hold and does not consume a lot.
- Confirm an uncertain provider attempt remains unknown in AI-cost reporting.

## 8. AI usage and Admin Panel

- Install one staging INR rate-card row and one explicit USD→INR exchange-rate row.
- Confirm admin AI usage distinguishes actual INR, estimated INR, and unavailable cost.
- Confirm token counts include provider attempts and multi-agent role attempts.
- Confirm Billing & Revenue shows only platform payments, not generated-app Razorpay rows.
- Confirm totals are INR paise and provider-native amounts are reconciliation metadata.
- Confirm non-admin users receive the existing fail-closed admin response.

## 9. F-02 regression

1. Attempt to call the old authenticated `save_payment_integration` RPC; confirm it is denied.
2. Save generated-app payment credentials through the server owner flow.
3. Confirm the stored hash is derived from the server secret and cannot be replaced by a browser-selected hash.
4. Confirm generated-app gateway calls still require the stored server proof and project API-key scope.

## 10. Evidence to retain

Record migration markers, sanitized request ids, payment ids, provider ids, event ids, ledger ids, lot ids, refund ids, reconciliation ids, and admin screenshots. Never retain secrets, raw webhook bodies, signatures, API keys, or full authorization headers.

Automated checks, live provider calls, migration execution, concurrency, and staging acceptance remain pending human execution.

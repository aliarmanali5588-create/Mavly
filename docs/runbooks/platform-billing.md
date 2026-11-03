# Platform billing runbook

Migrations `57_platform_billing.sql` and `59_inr_billing_and_ai_costs.sql`
install Mavly's own billing domain. Apply the repository's migration 58 files
first. Migration `60_business_integration_rpc_proof_hardening.sql` closes the
separate generated-app gateway proof issue. The billing domain is separate from
customer-app Razorpay integrations and from the generation credit reservation
engine in migrations 31/32.

## Apply order

Apply migrations through `56_aws_frontend_fencing_and_status.sql`, then apply:

```text
supabase/migrations/57_platform_billing.sql
supabase/migrations/58_multi_agent_lifecycle_observability.sql
supabase/migrations/59_inr_billing_and_ai_costs.sql
supabase/migrations/60_business_integration_rpc_proof_hardening.sql
```

The migrations are additive. They seed the locked INR catalog: Starter ₹399,
Creator ₹599, Pro ₹1,999, and credit packs ₹199/90, ₹299/300, ₹799/1,000.
Global users are routed to Dodo, but the authoritative catalog and all Mavly
financial reporting remain INR. Provider-native amounts are retained only as
reconciliation metadata; a non-INR provider event requires an explicit,
versioned INR exchange-rate row before settlement can grant credits.

## Required server configuration

| Variable | Purpose | Secret | Needed for |
| --- | --- | ---: | --- |
| `MAVLY_TRUSTED_COUNTRY_MODE` | `signed` ingress HMAC or explicitly locked `vercel` edge country header | No | Request-country fallback |
| `MAVLY_TRUSTED_COUNTRY_SECRET` | HMAC key for signed ingress country headers | Yes | Signed country fallback |
| `MAVLY_COUNTRY_ORIGIN_LOCKED` | Confirms direct origin access is locked when using Vercel edge country headers | No | Vercel country fallback |
| `MAVLY_RAZORPAY_KEY_ID` | Platform Razorpay test/live key id | No | India checkout |
| `MAVLY_RAZORPAY_KEY_SECRET` | Platform Razorpay API secret | Yes | India checkout, verification and refunds |
| `MAVLY_RAZORPAY_WEBHOOK_SECRET` | Platform Razorpay webhook signing secret | Yes | India webhooks |
| `DODO_PAYMENTS_API_KEY` | Dodo test/live API key | Yes | Global checkout and refunds |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Dodo Standard Webhooks signing key | Yes | Global webhooks |
| `DODO_PAYMENTS_MODE` | `test` by default; `live` only after approval | No | Dodo endpoint selection |
| `DODO_PAYMENTS_BASE_URL` | Optional exact test/live Dodo origin | No | Dodo endpoint selection |
| `MAVLY_DODO_PRODUCT_*` | Server-side Dodo product ids for the locked INR catalog | No | Global checkout |
| `MAVLY_RAZORPAY_PLAN_*` | Server-side Razorpay plan ids for India subscriptions | No | India subscriptions |
| `MAVLY_BILLING_RECONCILIATION_ENABLED` | Operator flag for billing reconciliation operations | No | Operations policy |
| `MAVLY_PLATFORM_BILLING_ENABLED` | Explicitly enables platform checkout routes | No | Checkout and catalog |

Provider secrets are platform-only. They must never be copied into
`project_secrets`, `NEXT_PUBLIC_*`, generated files, or customer-app payment
configuration.

## Country and market

Checkout uses this precedence:

1. A service/admin-verified `billing_profiles.country_code`.
2. A trusted signed ingress country signal.
3. An explicitly locked Vercel edge country signal.

Without one of these, checkout returns `MARKET_UNRESOLVED`; it never defaults
to India or Global. Verified profile country wins over a conflicting request
signal and the conflict is retained in the resolver result. Operators verify a
profile through `/api/adminsh/billing/profile` after the user identity and
country evidence have been checked.

The signed ingress contract is documented in
`src/lib/billing/country.ts`. The edge must send
`x-mavly-country`, `x-mavly-country-timestamp`, and an HMAC-SHA256
`x-mavly-country-signature` over `COUNTRY.TIMESTAMP` using the server secret.

## Provider setup

### Razorpay test mode

1. Create Razorpay test Plans for each approved India subscription plan.
2. Create a test webhook pointed at `/api/billing/webhooks/razorpay`.
3. Subscribe at minimum to payment captured/failed, refund, and subscription
   authenticated/activated/charged/pending/halted/cancelled events.
4. Create a new immutable `price_catalog_versions` version and rows with the
   approved amount, `razorpay_product_id`, `active = true`, and `approved = true`.
5. Set the test credentials only in the server environment.

### Dodo test mode

1. Create test one-time and recurring INR products for each approved catalog row.
2. Create a Standard Webhooks endpoint at `/api/billing/webhooks/dodo`.
3. Subscribe to payment succeeded/failed/processing/cancelled, refund, and
   subscription active/renewed/past_due/on_hold/cancelled/expired events.
4. Configure the server-only `MAVLY_DODO_PRODUCT_*` mappings for the exact Dodo
   products. Do not accept product ids from the browser.
5. Use a test-mode key with only the required Payments, Refunds, Subscriptions,
   Products, Customers and Webhooks permissions.

## Settlement rules

Provider webhooks are verified over the exact raw body before parsing. The
durable `billing_process_webhook_inr` RPC records the event and payment transition,
validates amount/currency/product association, and grants credits in the same
database transaction. Duplicate provider event IDs are no-ops.

Credit-pack grants create `purchase` ledger rows and a source lot. Subscription
activation/renewal creates a unique period entitlement and a
`subscription_grant` ledger row. Refunds create a `refund` compensating ledger
row only when the purchased credit lot is still available; otherwise the refund
is retained as `manual_review` and never drives a negative/corrupt balance.

The existing generation reservation/settlement functions remain the authority
for generation consumption and were not replaced.

## Reconciliation

Every provider-confirmed payment enqueues one durable reconciliation job. The
AWS generation worker advances one bounded billing reconciliation job per tick,
compares the provider amount/currency with the internal payment, and writes an
open/manual-review discrepancy without granting credits. A provider outage
requeues the job with bounded backoff.

## Sandbox acceptance checklist

- Use Razorpay test credentials and Dodo test credentials only.
- Verify a credit-pack webhook twice and confirm one ledger grant.
- Verify a subscription activation and renewal replay and confirm one grant per
  `(subscription, period)`.
- Verify failed/cancelled payment events create no credit lot.
- Verify a full refund with unused credits creates one compensating ledger row.
- Verify a refund after credit consumption creates `manual_review` and no
  negative balance.
- Verify invalid signatures, amount mismatches, currency mismatches and unknown
  payment identifiers are rejected or retained as discrepancies.
- Verify the admin dashboard reads only `paid` provider-confirmed rows and
  reports financial totals only in INR; provider currency remains reconciliation
  metadata.

Live charges are not enabled by this repository change. Provider account setup,
product/plan mappings, webhook delivery, DNS/origin locking and human sandbox
acceptance remain deployment responsibilities.

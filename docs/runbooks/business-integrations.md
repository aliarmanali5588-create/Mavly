# Runbook — business integrations (Razorpay payments)

## Prerequisites

- Migration `supabase/migrations/21_business_integrations.sql` applied after 11
  (project secrets) and 12 (project API keys).
- Migration `supabase/migrations/23_production_hardening.sql` applied after 21
  and 22; the payment gateway fails closed if its rate-limit RPC is missing.
- Server environment:
  - `MAVLY_BUSINESS_INTEGRATIONS_ENABLED=on`
  - `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS=<explicit ids>` (never `*`)
  - `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` (32 random bytes, base64)
  - `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET` (≥32 random characters, server-only;
    authorizes the webhook write RPCs)
  - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_APP_URL` (the canonical origin; it is the webhook URL origin
    and must be the public HTTPS origin for Razorpay to accept the address)
- A Razorpay account. Use **test keys** (`rzp_test_…`) first.
- For a Mavly-hosted app to call the gateway, the project must be able to run
  server code (Phase 5 full-stack hosting or another server runtime). Never put
  the project API key in browser code.

## Setup

1. Open the project → **More** → **Business payments**.
2. Enter the Razorpay key id, key secret and webhook secret. Saving tests the
   key pair with a read-only call; a rejected pair is not stored.
3. Copy the webhook address shown in the panel.
4. In the Razorpay dashboard create a webhook with that exact URL and the same
   secret, subscribing to:
   - `payment.authorized`
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
5. Create a project API key with the `integrations:*` scope and `env` `live`
   or `both` (a `dev` key is refused by the gateway), and store it in the app's
   server environment, e.g. `MAVLY_PROJECT_API_KEY`. The key alone is not enough
   to call the database RPCs; the app must use the HTTP gateway.
6. In the app's server code call the **canonical Mavly origin**, not the app's
   own tenant host (`<project>.mavly.xyz` is rewritten to the tenant runtime and
   does not serve the gateway):

```ts
const base = process.env.MAVLY_APP_ORIGIN; // https://<canonical Mavly origin>
const res = await fetch(`${base}/api/app/v1/payments/orders`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.MAVLY_PROJECT_API_KEY}`,
  },
  body: JSON.stringify({
    amount: 49900, // minor units (₹499.00)
    currency: "INR",
    idempotencyKey: `order-${businessOrderId}`,
    notes: { businessOrderId },
  }),
});
```

The response contains `keyId`, `orderId`, `amountMinor`, `currency`, `testMode`.
Open Razorpay Checkout in the browser with those values. On success, send
`razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature` to the app's
server, which calls `POST /api/app/v1/payments/verify`. Only a response with
`status: "paid"` and `paid: true` may fulfil the business order.

## Manual acceptance (test mode)

A direct server-side check (never run this from a browser):

```bash
# 1. Create an idempotent order (amount in minor units; INR default).
curl -sS -X POST "$MAVLY_APP_ORIGIN/api/app/v1/payments/orders" \
  -H "authorization: Bearer $MAVLY_PROJECT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"amount":100,"currency":"INR","idempotencyKey":"acceptance-2026-01"}'

# 2. After Razorpay Checkout returns, verify the callback.
curl -sS -X POST "$MAVLY_APP_ORIGIN/api/app/v1/payments/verify" \
  -H "authorization: Bearer $MAVLY_PROJECT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"orderId":"order_…","paymentId":"pay_…","signature":"…"}'

# 3. Read the recorded state.
curl -sS "$MAVLY_APP_ORIGIN/api/app/v1/payments/order_…" \
  -H "authorization: Bearer $MAVLY_PROJECT_API_KEY"
```

1. Save test keys; the status becomes `verified` and mode `test`.
2. Create a ₹1 order through the app server; confirm a Razorpay order id is
   returned and appears under **Recent orders** with status `created`.
3. Repeat the same request with the same idempotency key; confirm the SAME
   order id is returned and only one row exists.
4. Pay with Razorpay's test card in Checkout.
5. Confirm `/verify` returns `paid: true` only after Razorpay accepted the
   payment, and the panel shows `paid`.
6. Send a forged verify request (random signature); confirm 400 and no state
   change.
7. In the Razorpay dashboard resend the `payment.captured` webhook; confirm a
   200 and no duplicate fulfilment (one event row, one payment row).
8. Send a webhook with an invalid signature; confirm 401 and no state change.
9. Disable payments; confirm new order calls are refused, the webhook URL is
   unchanged, and stored secrets remain until deleted in **Secrets**.
10. Call one of the webhook write RPCs directly with the public anon key and no
    RPC hash (or a wrong one); confirm no payment or event state changes. This
    pins the anon-RPC gate.

## Monitoring

- Workspace status (`lastCheckedAt`, `lastError`) is the owner view.
- Server logs contain only migration/provider-failure codes; no secret, raw
  body or authorization header is logged.
- Razorpay events that could not be applied are recorded with `failed` and a
  short `error_code` (`order_not_found`, `amount_mismatch`, `invalid_payload`,
  `processing_error`).

## Pause, drain, rollback

- **Pause new orders:** remove the project from
  `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS` (or set the flag off). The gateway and
  webhook return 404 immediately; no data is deleted. ⚠️ This also stops webhook
  processing for that project. For a project-level pause that keeps in-flight
  webhooks flowing, use **Stop payments** in the panel instead.
- **Stop one project:** use **Stop payments** in the panel. It refuses new
  orders and keeps the webhook address stable. Signed webhooks for orders
  already created continue to be recorded (the integration row is disabled, not
  deleted), so an in-flight payment is not lost.
- **Revoke credentials:** delete `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
  `RAZORPAY_WEBHOOK_SECRET` in **Secrets**. The provider account is unchanged.
- **Rotate the RPC secret:** update `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET`,
  then re-save each integration so its stored hash matches. Until re-saved,
  that integration's webhooks are refused (no payment state is lost; the provider
  retries, and re-saving resumes processing).
- **Rollback:** reverting the code does not delete migration 21 tables or
  history. Revert the migration only with a deliberate, backed-up plan.

## Known limits

- One-time orders only. Refunds, subscriptions and payouts are not implemented.
- Webhook replay protection is the SHA-256 of the signed body, not the unsigned
  event-id header; Razorpay does not sign a timestamp. Do not delete event rows
  while retries may still arrive.
- Rate limits are durable and shared (migration 23): 30 order attempts and 60
  verification attempts per 60 seconds per integration, fixed in SQL. Webhooks
  are not rate-limited by this table; duplicates are idempotent and provider
  retries must not be dropped.
- A payment that Razorpay reports as `authorized` but not `captured` is shown as
  `authorized` and must not be fulfilled.
- One active key set per project. Switching between test and live keys replaces
  the same three secret values; the mode is derived from the key id and shown in
  the panel. There is no simultaneous test+live configuration.
- Manage the three values through the Business payments panel. If they are
  changed directly in Secrets, the panel's displayed key id/mode can be stale and
  the integration may fail until it is re-saved and re-tested; the gateway always
  uses the stored secret values, not the displayed metadata.
- Amounts are minor units; the panel and docs assume two decimal places (INR and
  Razorpay's other major currencies). Do not use a zero-decimal currency.
- A process crash between the Razorpay order response and recording it leaves an
  orphan provider order with no local row; a webhook for it is recorded as
  `order_not_found` and is not fulfilled. Reconcile manually from the Razorpay
  dashboard. The gateway never retries order creation, so it cannot create a
  duplicate on its own.
- Webhook events are persisted for audit but not yet shown in the workspace UI.
- The webhook write RPCs are authorized by a stored SHA-256 hash of the
  server-only RPC secret. An actor who can read that hash (database read access
  or a captured PostgREST request body) could call the write RPCs; database
  compromise is out of scope, but treat the hash as sensitive. Rotate it if you
  suspect exposure (see above).
- No live Razorpay account, real payment or delivered webhook has been verified
  in development. Complete the manual acceptance checklist before enabling a
  production cohort.

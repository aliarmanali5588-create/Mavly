# Phase 6 — Business integrations

## Scope

Phase 6 lets a **generated application** use a real business provider through
Mavly. The first implemented provider is **Razorpay payments**. Mavly's own
billing is untouched: its Razorpay-only plans, credit packs and prices are not
part of this phase, and no Stripe/Dodo/USD path is reintroduced.

Not implemented and deliberately absent from the workspace catalog:

- transactional email, WhatsApp/messaging, storage;
- refunds, subscriptions, payouts, saved cards, card data;
- additional payment providers (Stripe, PayPal) — empty placeholder files were
  removed/left unlisted;
- automatic code injection into generated projects.

## Why Razorpay

- It matches Mavly's existing Indian-merchant billing context.
- Its server API is small and fixed-origin: create an order, read a payment.
- Checkout verification is a documented HMAC over `order_id|payment_id`.
- Webhooks are an HMAC-SHA256 of the exact raw body with a per-account secret.
- Its test keys (`rzp_test_…`) allow manual acceptance without moving money.

## Architecture

```
generated app server code
  │  Authorization: Bearer <project API key, scope integrations:*>
  ▼
/api/app/v1/payments/orders|verify|{orderId}   (public prefix, self-authenticating)
  │
  ├── src/lib/integrations/payments/gateway.ts
  │      ├── SHA-256(key) → gateway_payment_context RPC
  │      │      · key not revoked, env live/both, scope integrations:*
  │      │      · enabled integration for that key's OWN project
  │      │      · ciphertext rows from that project's project_secrets
  │      ├── decrypt in-process with MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY
  │      ├── local idempotency + payment rows (gateway_* RPCs)
  │      └── src/lib/integrations/payments/razorpay.ts → api.razorpay.com
  │
Razorpay webhook
  ▼
/api/integrations/webhooks/razorpay/{unguessable-token}   (public, self-authenticating)
  │
  └── token → integration → decrypt webhook secret → verify raw-body HMAC
         → record event once → apply payment state (idempotent)
```

The Mavly workspace manages the integration through authenticated project
routes (`GET/PUT/DELETE …/integrations/payments`, `POST …/test`) and the
**Business payments** section of the More view. No UI state is optimistic.

## Security model

### Credential storage

- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` are saved
  as encrypted `project_secrets` (AES-256-GCM, owner/project/row AAD).
- The workspace never receives a value or ciphertext; the status response
  carries metadata and the publishable key id only.
- A save runs a **side-effect-free** `GET /v1/orders?count=1` first. Invalid
  credentials are not written. This proves the key pair; the webhook secret can
  only be proven when Razorpay sends its first signed event.
- Saving is not enabling: the request defaults `enabled` to `false`. The
  workspace enables on an explicit save, and **live keys** (`rzp_live_…`) require
  a separate confirmation that names the real-money consequence. Test keys move
  no money.
- For a project in the full-stack hosting cohort, Phase 5's existing write-through
  also pushes the values to the generated app's production environment. That is
  optional; the gateway works without it. Provider env-sync failures are reported
  by Phase 5's deployment readiness, not duplicated in this panel.

### Webhook write authorization

The webhook route has no user session, so its database writes run through
anon-executable `SECURITY DEFINER` RPCs. The anon key alone must not be enough to
record or apply an event. Every integration row stores
`sha256(MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET)`; the route computes that hash
from the server-only secret and passes it, and each write RPC refuses without it.
The secret is never stored in or sent to the database — only its hash is. The
provider signature remains the authority for the event content; this hash is what
proves the caller is Mavly's webhook route rather than an arbitrary anon client.
Rotating it requires re-saving each integration (the owner save refreshes the
stored hash).

### Generated-app authentication

- The generated app uses an existing **project API key** with the
  `integrations:*` scope over HTTPS, server-side only, against the canonical
  Mavly origin (not its own `<project>.mavly.xyz` tenant host, which is rewritten
  to the tenant runtime).
- The app calls the HTTP gateway, never PostgREST directly. Every gateway DB RPC
  also requires the server-only RPC hash, so the API key alone cannot create,
  fail or mark an order paid by calling the database; only Mavly's route holds
  both credentials.
- Only the SHA-256 hash reaches the database. Every gateway RPC re-checks:
  key not revoked, `env in (live,both)`, scope present, integration enabled, and
  `order.project_id = key.project_id`.
- Browser calls are not the supported path. In production the proxy's origin
  policy rejects a mutation from a tenant origin, and a static app cannot keep a
  key secret.
- The Phase 6 in-process windows were superseded by Phase 7's durable
  `consume_integration_rate_limit` RPC (migration 23): 30 order attempts and 60
  verification attempts per 60 seconds per integration. The limits are fixed in
  SQL, shared across instances, and fail closed if the RPC is missing.

### Payment integrity

- Order creation is idempotent on `(integration_id, idempotency_key)`.
  The provider call is **never retried blindly**; a replay returns the recorded
  order, and a crashed `creating` row is failed after one minute.
- `POST …/verify` checks the Checkout HMAC **and** reads
  `GET /v1/payments/{payment_id}`. The provider order id, amount and currency
  must match the recorded order before `paid`.
- Webhooks verify the raw body HMAC before JSON parsing. Idempotency is keyed
  on the SHA-256 of the **signed body**, not on the unsigned event-id header, so
  redelivery (or a captured body replayed with a new header) is processed once.
  Only the digest, event type and header id are stored — never the body.
- `paid` never regresses. A late verified capture is accepted from any state.
  Only `paid` may fulfil an order.
- A signed event for an unknown order, or with a mismatched amount, is recorded
  as `failed` and acknowledged without changing a payment.

### Execution boundaries

- Provider calls originate from Mavly with a **fixed origin**; no route accepts
  a client-supplied URL. No SSRF surface is added.
- Generated code is not executed on Mavly hosts. Only the app's own server code
  calls the gateway; the Phase 3/4 sandbox never receives these credentials.
- No raw webhook body, authorization header, key secret or ciphertext is logged.
- The gateway and webhook prefixes are the only new public API exemptions
  (`src/lib/api-access.ts`), and both authenticate inside the route.

## Data model (migration 21)

| Table | Purpose |
|---|---|
| `project_integrations` | provider, enabled/status, non-secret config (`keyId`, `mode`), webhook token, credential secret names, webhook-write RPC hash |
| `project_integration_payments` | one order per `(integration, idempotency_key)`, provider ids, amount/currency, status, `paid_at` |
| `project_integration_events` | provider event id/type/digest/status — never the raw body |

All three are RLS-enabled and owner SELECT-only. Writes go through
`SECURITY DEFINER` RPCs with a pinned `search_path`:

- owner: `save_payment_integration`, `mark_payment_integration_checked`,
  `disable_payment_integration`, `owner_payment_credentials`;
- gateway: `gateway_payment_context`, `gateway_begin_payment`,
  `gateway_set_payment_order`, `gateway_fail_payment`, `gateway_mark_payment`,
  `gateway_payment_status`;
- webhook: `gateway_webhook_context`, `gateway_record_webhook_event`,
  `gateway_finish_webhook_event`, `gateway_apply_webhook_payment`.

## Failure modes

| Situation | Behavior |
|---|---|
| flag/cohort/secrets key/RPC secret missing | owner routes 503 `BACKEND_NOT_CONFIGURED`; gateway/webhook 404/503 |
| webhook write RPC called without the RPC hash | no-op (event/state unchanged) |
| migration 21 missing | 503 `MIGRATION_REQUIRED` |
| provider timeout/unavailable/rate limit | 504/502/429 with no state change (except the order row's truthful failure) |
| invalid key pair on save | 401 `CREDENTIALS_INVALID`, nothing stored |
| invalid checkout signature | 400 `signature_invalid`, nothing changes |
| provider payment/order mismatch | 409, nothing marked paid |
| invalid webhook signature | 401, nothing parsed or written |
| duplicate webhook event | 200, no second apply |
| order already created (same idempotency key) | 200 with the recorded order |
| same key after a terminal failure | 409, use a new idempotency key |
| disable | new orders are refused; the webhook address stays stable and signed webhooks for orders already created are still recorded; stored secrets remain |

## Rollout

1. Apply `21_business_integrations.sql` after 11 and 12.
2. Set `MAVLY_BUSINESS_INTEGRATIONS_ENABLED=on`, an explicit
   `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS` cohort, `NEXT_PUBLIC_APP_URL`,
   `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`, and a ≥32-character server-only
   `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET`.
3. Add a Razorpay test account and the three values in the workspace.
4. Register the webhook URL shown in the panel in the Razorpay dashboard.
5. Create a project API key with `integrations:*`, store it on the app server.
6. Run the manual acceptance procedure in the runbook.

Rollback: remove the project from the cohort (or turn the flag off). No data is
deleted; payment/webhook history stays readable to the owner. The gateway and
webhook refuse new work immediately.

## Unverified

No live Razorpay account, real payment, delivered webhook, deployed generated
app, or database-applied migration has been exercised by an agent. See
`docs/runbooks/business-integrations.md` for the human acceptance checklist.

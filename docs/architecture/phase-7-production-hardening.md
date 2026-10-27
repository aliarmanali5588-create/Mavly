# Phase 7 — Production hardening and scale

## Scope

This is an incremental hardening phase over the existing Phases 1–6. It does not
add a new product surface, a new hosting provider, a new queue, or a new billing
path. Mavly's Razorpay-only billing, prices, credits and entitlements are
untouched.

The actual implementations were audited first. Their live behavior is still
**unverified**: no Supabase migration, Razorpay account, Vercel deployment,
worker invocation, browser interaction or production database was exercised by
the implementation agent.

## Threat model and boundaries

| Boundary | Authority | Notes |
|---|---|---|
| Builder pages | Supabase session (`getCurrentUser`) | `/dashboard`, `/project/*`; existing. |
| Admin console | session + `public.current_user_is_admin()` | New server layout; 404 for a signed-in non-admin. |
| Project data | RLS through the caller's client | Missing/foreign rows are the same 403. |
| Generated-app gateway | project API key (`integrations:*`) + server RPC hash | HTTP only; the app never calls PostgREST. |
| Provider webhook | per-integration token + raw-body HMAC + server RPC hash | Signature verified before parsing. |
| Hosting provider | server-only Vercel token | Fixed origin; owner-bound project name. |
| Verification sandbox | provider microVM | No production secrets; no Mavly host execution. |

The service-role key remains confined to the generation worker and its route.
Phase 7 deliberately does **not** widen that boundary.

## Concrete changes

### 1. The admin console is no longer public

Before: `/adminsh/*` was reachable while signed out, `/adminsh/auth` was a
client-side `setTimeout`, and migration 18's `current_user_is_admin()` was
unused.

Now:

- `src/proxy.ts` requires a session for every `/adminsh` path (coarse gate).
- `src/app/adminsh/layout.tsx` is a server component that verifies the session,
  calls `current_user_is_admin()`, and returns 404 to a signed-in non-admin.
- A missing migration 18 or any RPC error fails closed with 404.
- The pages remain visual simulations; no mock action became a privileged API.

### 2. Durable, shared payment rate limits

Before: Phase 6's limits were per process and multiplied across serverless
instances.

Now: `supabase/migrations/23_production_hardening.sql` adds
`integration_rate_limits` and `consume_integration_rate_limit()`. The limits are
fixed in SQL and keyed by integration (= project + provider):

| Operation | Limit | Window |
|---|---|---|
| `order_create` | 30 attempts | 60 s |
| `payment_verify` | 60 attempts | 60 s |

The RPC repeats the key-hash, scope, revocation, live/both-env and RPC-hash
checks. It is atomic (`insert … on conflict do update`), bounded (counter capped,
old windows cleaned up 50 rows at a time) and not caller-tunable.
**The gateway fails closed with 503 if the RPC is missing.** The owner status
shows a migration warning (`hardeningReady: false`).

Webhook delivery is deliberately **not** routed through this limiter: dropping a
provider retry would lose a payment event. Webhooks are authenticated and
deduplicated instead.

### 3. Webhook reconciliation visibility

The owner status now includes the last 20 webhook audit rows: event type,
status, error code and timestamps. The projection
(`src/lib/integrations/payments/event-view.ts`) cannot carry the raw body, its
digest, a signature or a secret.

Unmatched (`order_not_found`) and mismatched (`amount_mismatch`) events remain
**failed**. Mavly does not invent a payment result from them. The owner compares
the event time/type with the Razorpay dashboard and reconciles manually.

Migration 23 also replaces the Phase 6 event recorder with a bounded stale-row
recovery: a `received` event older than two minutes is reclaimed by the next
signed retry, so a crash between applying the payment state and finishing the
audit row cannot leave the event stuck forever. Concurrent duplicates inside the
window are acknowledged without racing the live handler; `processed`/`ignored`
events remain terminal and are never re-applied.

### 4. Structured payment diagnostics

`src/lib/observability/payments.ts` emits `[payments]` JSON lines with an
allowlist: integration UUID, project slug, operation, closed-set status/error
class, HTTP status, retry-after and duration. It has no free-form field, no
amount, no order/payment id, no raw body and no secret.

## Reliability invariants preserved

- Generation: one job per worker tick; atomic claim; fenced lease; bounded
  recovery; retries 15 s→300 s; dead letters are not deleted; cancellation is
  persistent.
- Verification: one stage per tick and only when the generation queue is empty;
  sandboxes are destroyed on every terminal path.
- Full-stack deploy: one attempt per project; monotonic attempt fence; a failed
  new deployment restores the previous deployment id; `ready` requires provider
  READY, a verified domain, synced production secrets and a verified database
  contract; rollback targets a previously ready, owned attempt.
- Shared static hosting: activation is atomic; public resolution reads the active
  version, not the latest attempt status; a failed republish leaves the previous
  version live.
- Payments: local idempotency, no blind provider-order retry, `paid` is
  monotonic, only a verified provider read/webhook can set it, and fulfilment is
  the app's decision on `paid`.

## Capacity assumptions (configured, not benchmarked)

| Resource | Current bound | Evidence |
|---|---|---|
| Generation concurrency | 2/user, 8 global unfinished runs | migration 10 admission RPC |
| Worker work | one job per invocation; verification only when idle | `generation/worker.ts` |
| Verification | one stage per tick | `sandbox/verification.ts` |
| Full-stack deploys | one attempt per project | `claim_fullstack_attempt` |
| Payment orders | 30/60 s/integration | migration 23 |
| Payment verification | 60/60 s/integration | migration 23 |
| Image generation | 5/user, 40/instance per 10 min | `mavly/image-limits.ts` |
| Uploads/body | route-specific caps (preview/gateway/webhook) | route handlers |

No load test has been run. Do not scale these numbers to a user count without
measurement.

## Database and rollout order

1. `18_admin_allowlist.sql` before opening `/adminsh`.
2. `21_business_integrations.sql` after 11 and 12.
3. `23_production_hardening.sql` after 21 and 22.
4. Deploy the application build.

Migration 23 is additive and safe while the previous application version is
still deployed. The new application build requires it for payment gateway
operations; apply it before the payment cohort is enabled. A rollback of the
application does not need a schema rollback (the old build ignores the new
objects).

## Observability and diagnosis

Existing: structured generation/verification events, hosting events, bounded
provider failure classifications, correlation ids for generation runs, redacted
error text.

Added: `[payments]` events (above) and the owner webhook-event list.

Recommended log-based alerts before production:

- repeated `payment.gateway_unavailable` or `payment.order_failed`;
- `payment.webhook_failed` with `order_not_found` / `amount_mismatch`;
- sustained `payment.rate_limited`;
- `payment.integration_test_failed`;
- `generation.dead_letter`, repeated `generation.worker_error`, or
  `verification.error`;
- full-stack deployment failures and `secrets_not_synced`;
- Mavly database connectivity failures.

There is no metrics vendor and no fabricated dashboard. The log lines above and
the owner UI are the current evidence.

## Backup, restore and disaster recovery

Reality in this repository:

- **Project source** has durable, immutable snapshots (`project_snapshots` /
  `project_snapshot_files`) and a restore path that first captures the
  pre-restore state. This is the recoverable source history.
- **Project secrets** are AES-256-GCM ciphertext. Restoring them requires the
  same `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`; losing that key makes existing
  ciphertext unrecoverable. Back up the key separately and securely.
- **Payment records** are in Supabase. The provider remains the authority for
  money movement; Mavly's rows are the local audit/state. A lost local row must be
  reconciled from the provider, not reconstructed from guesses.
- **Full-stack deployments** depend on Vercel project/deployment state. The
  previous ready deployment id is retained; Instant Rollback is the provider-side
  recovery. Mavly does not store the provider build artifacts.
- **No platform-wide database backup/restore feature is implemented here.** The
  copied database-backup UI types are not a real backup engine. Production must
  rely on the configured Supabase backup/PITR policy (operator-verified) and
  provider retention.

## Known unresolved risks

1. **Database-read pass-the-hash.** The anon gateway/webhook RPCs accept the
   stored API-key hash and RPC-secret hash as bearer values. A database read
   compromise exposes both and can call those RPCs. A pepper does not fix this
   because the verifier would still accept the stored hash. The proper fix is a
   service-role-only gateway client or an asymmetric server→DB proof; that is a
   security-architecture change and remains blocked/unapproved.
2. **Full-stack self-attestation.** `claim_fullstack_attempt` and
   `settle_fullstack_attempt` are authenticated RPCs. An owner can misrepresent
   their own deployment attempt/readiness; they cannot target another project's
   name (the service derives it) but they can bypass the service's provider
   checks for their own row. A service-role-only deployment path is the
   documented follow-up.
3. **Webhook endpoint DoS surface.** Random valid-shaped tokens cause one indexed
   DB lookup; there is no shared limiter because dropping provider retries is
   worse. The token is 192 bits.
4. **No live acceptance.** Migrations, Razorpay, webhooks, Vercel, workers and the
   admin gate have not been run against real infrastructure.
5. **Legacy mock surfaces.** The admin pages remain visual simulations even when
   gated; the copied Stripe Connect “Payments” panel remains pre-existing and
   unimplemented.

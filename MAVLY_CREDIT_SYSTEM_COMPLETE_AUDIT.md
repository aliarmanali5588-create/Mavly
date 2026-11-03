# Mavly Credit System — Complete Audit

**Audit date:** 2026-11-03  
**Scope:** Supabase credit accounting, generation admission and settlement, AI usage, provider cost tracking, Razorpay, refunds, workspace credit UX, Admin Panel, and operational/security integration.  
**Method:** Read-only static inspection of the current repository.  
**Changes made:** This report only. No source, migration, database, secret, configuration, UI, or infrastructure changes were made for this audit.

## 1. Executive verdict

The repository contains a substantial **credit-accounting foundation**, but not a complete commercial credit product.

| Area | Verdict | Meaning |
|---|---|---|
| Authoritative Supabase ledger | **COMPLETE in repository / NOT VERIFIED live** | Whole-credit balances, holds, append-only entries, invariants, idempotency, and RLS/RPC boundaries exist. |
| Generation charging | **COMPLETE in repository / NOT VERIFIED live** | A configured cohort is charged a fixed server-side amount per successful generation, with admission-time reservation. |
| AI usage metering | **PARTIAL** | Provider-attempt usage and reported USD cost are recorded; provider cost does not determine credit cost. |
| Credit funding/top-up | **MISSING** | No user payment-to-`grant_credits` path exists. Operator grants and admin adjustments are the only funding mechanisms. |
| Refunds | **PARTIAL** | Audited service-role refunds exist for consumed generation reservations; no customer-facing or payment-linked refund flow exists. |
| Razorpay | **COMPLETE for generated-app business payments / NOT a Mavly credit system** | It accepts payments for customer-owned generated applications, not for Mavly credits. |
| Workspace credit balance | **PARTIAL** | The indicator reads the authoritative balance when enabled, but there is no purchase action that funds it. |
| Admin Credits | **COMPLETE in repository / NOT VERIFIED live** | Admin-only ledger reads and atomic audited adjustments exist. |
| Admin AI Usage | **PARTIAL** | Real run-level aggregates and per-attempt detail exist, but the two scopes must not be treated as one total spend number. |
| Admin Billing / platform revenue | **MISSING by design** | The page truthfully reports no Mavly platform billing source. |

### Final answer to the business question

Mavly can **reserve and settle operator-granted credits for generation runs** when migrations, worker, policy rows, and environment configuration are all enabled. Mavly cannot currently sell those credits, reconcile a Razorpay credit purchase into a user balance, or automatically refund a customer payment. Generated-app Razorpay payments are a separate product boundary and must not be counted as Mavly revenue or credit funding.

The implementation is therefore suitable to describe as an **opt-in, service-funded credit accounting foundation**, not as an end-to-end paid credit wallet.

---

## 2. Status and evidence rules

- **COMPLETE:** The repository contains the required implementation for the stated scope; live behavior is separately identified.
- **PARTIAL:** Material pieces exist, but a requested business or operational capability is absent or intentionally separated.
- **MISSING:** No implementation path was found.
- **BROKEN:** The repository contains a design or integration defect that can violate the stated contract. Static findings are not represented as live exploits.
- **NOT VERIFIED:** A live database, provider, worker, or deployed environment is required and was not available.

Repository evidence takes precedence over historical audit documents. The current evidence includes migrations 31, 32, 50, 52, the current credit/generation/payment code, and the related tests. The current working tree also contains unrelated pre-existing AWS frontend-hosting edits; they were preserved and are outside this audit.

---

# Part A — Supabase credit accounts, reservations, and ledger

**Status: COMPLETE in repository; NOT VERIFIED against PostgreSQL.**

### A.1 Data model

Migration `31_credit_foundation.sql` creates:

- `credit_accounts`: one account per Auth user, with `balance_credits`, `reserved_credits`, and non-negative/in-range constraints (`supabase/migrations/31_credit_foundation.sql:75-86`).
- `credit_project_policies`: service-managed project cohort and fixed generation price, bounded to 1–100,000 credits (`31:95-112`).
- `credit_reservations`: one hold per generation run, with consumed/released/refunded amounts and status consistency checks (`31:116-153`).
- A partial unique index allowing at most one live `reserved` hold per run (`31:155-159`).
- `credit_ledger`: the accounting authority, with signed balance movement, reserved deltas, after-balances, idempotency keys, and an allowed operation set (`31:344-373`).
- `ai_cost_rates` and `ai_usage_attempts` for optional USD estimation and per-attempt provider metering (`31:409-445`).

The intended invariant is:

```text
sum(credit_ledger.amount_credits) = credit_accounts.balance_credits
sum(credit_ledger.reserved_delta_credits) = credit_accounts.reserved_credits
balance_credits >= reserved_credits >= 0
available = balance_credits - reserved_credits
```

### A.2 Append-only and audit behavior

`credit_ledger_reject_mutation()` rejects UPDATE and DELETE, so correction must be represented by a new compensating entry (`31:388-407`). Holds write `amount_credits = 0` and a positive reserved delta; a hold is therefore not reported as spend. The UI and Admin Panel preserve this distinction.

### A.3 Security boundary

Authenticated users do not receive direct credit-table mutation grants. The database exposes owner-scoped reads/reconciliation and service-role-only admission, release, refund, funding, worker recovery, and provider-attempt mutation paths. The policy and run-state triggers independently block unreserved or inline writes for enabled credit projects (`31:262-335`; `32:110-162`).

### A.4 Audit conclusion

The accounting structure is materially stronger than a client-side balance or mutable wallet column. It has the right primitives for concurrency and recovery. This conclusion is repository-only: the migration has not been applied and its constraints, triggers, grants, and concurrent transactions have not been exercised against a live database.

---

# Part B — Credit funding, packages, and entitlement allocation

**Status: MISSING; P1 product gap.**

### B.1 What exists

`grant_credits(user, amount, reason, idempotency_key)` is implemented as a service-role-only RPC. It locks the user account, updates the account and appends one `grant` ledger row transactionally (`31:644-731`). Migration 50 also exposes an admin-only `admin_adjust_credits()` path for grants and adjustments.

### B.2 What does not exist

No route or webhook was found that:

1. creates a Mavly credit order;
2. charges a Mavly customer through Razorpay or another platform provider;
3. verifies that payment against a package price and currency;
4. allocates the package quantity through `grant_credits`; or
5. records a Mavly platform payment/invoice/entitlement event.

The architecture document explicitly records that there is no Mavly credit-funding flow (`docs/architecture/phase-11-credit-foundation.md:200-206`). The runbook instructs an operator to fund staging accounts directly through the service-role RPC (`docs/runbooks/credits.md:53-65`).

### B.3 UI finding

`src/app/credit-topup/credit-topup-client.tsx:282-333` presents provisional packages and a purchase button, but the checkout modal says the payment gateway is offline and that no credits can be granted without verified payment. The package values are therefore presentation placeholders, not commercial entitlements.

### B.4 Consequence

An enabled credit project without pre-funded accounts returns insufficient-credit behavior by design. There is no legitimate user path from money to balance. Any statement that users can buy Mavly credits is unsupported by the current backend.

---

# Part C — Generation admission, reservation, and idempotency

**Status: COMPLETE in repository; NOT VERIFIED live.**

### C.1 Admission flow

The server derives credit eligibility from:

- `MAVLY_CREDITS_ENABLED`;
- an explicit, non-wildcard `MAVLY_CREDITS_PROJECTS` cohort; and
- a whole-number `MAVLY_CREDITS_GENERATION_COST` from 1 to 100,000.

This is parsed in `src/lib/credits/config.ts:1-17,89-157`. The browser does not supply the price.

For a credit project, the API selects worker dispatch and calls `createGenerationJobWithCredits()` (`src/lib/mavly/api.ts:891-974`, `src/lib/credits/store.ts:235-305`). The ordered migration-32 wrapper calls the existing generation admission RPC and then performs the credit reservation in one transaction (`supabase/migrations/32_credit_reliability_hardening.sql:172-239`; underlying implementation `31:748-947`).

### C.2 Correct refusal behavior

- Insufficient available credits raises from the database, rolling back the run insert and reservation (`31:875-889`).
- Reusing an idempotency key with a different prompt/model returns a conflict (`31:833-845`).
- Duplicate delivery with the same request identity returns the existing run/hold rather than charging again.
- The policy row must match the environment-derived project and price; mismatches fail closed.
- Credit projects require `dispatch_mode = 'worker'`; inline credit execution is rejected (`31:802-807`).

### C.3 Concurrency controls

The implementation combines the generation advisory lock, account row lock, a one-live-hold-per-run index, unique `(user_id, idempotency_key)` ledger/reservation keys, and user/global generation caps. Migration 32 explicitly orders admission and policy locking to avoid the earlier inverted lock order (`32:35-45`, `docs/architecture/phase-11-credit-foundation.md:101-119`).

### C.4 Verdict

The repository has a credible atomic admission design. The real acceptance cases—concurrent overspend, duplicate launch, rollback on insufficient balance, and policy activation with active runs—remain unverified until staging PostgreSQL execution.

---

# Part D — Settlement, release, resume, refund, and reconciliation

**Status: PARTIAL; accounting paths exist, commercial refund policy does not.**

### D.1 Successful completion

`settle_generation_reservation()` requires a finished run with `status = 'done'` and `stage = 'completed'`, locks the run and account, consumes the hold, updates the reservation, and appends one negative `generation_consumed` ledger row (`31:967-1074`). A second settlement sees no live reservation and is a no-op.

Migration 32 adds an `AFTER UPDATE` trigger that performs settlement or release in the same transaction as the terminal run update (`32:247-302`). This prevents a committed successful run from being separated from its credit consumption by an application crash.

### D.2 Failure and cancellation

`release_generation_reservation()` is service-role-only and releases only a finished non-success run (`31:1080-1177`). `finish_credit_generation_run()` validates the terminal state, rechecks owner/project/worker mode, writes the terminal state, and releases the hold through the trusted path (`31:1179-1273`).

### D.3 Resume

The credit-aware resume path requires a configured policy and worker dispatch, reuses a live hold when appropriate, and takes a new hold only after the previous failed hold is released (`31:2067-2129`; `32:203-239`). An active duplicate resume is refused rather than double-charging.

### D.4 Operator refund

`refund_generation_reservation()` is service-role-only, requires a consumed reservation, bounds the amount by the remaining consumed amount, locks the account, and writes an idempotent positive `generation_refunded` ledger row (`31:1275-1396`). This is an accounting refund of generation credits, not a payment-provider refund.

### D.5 Recovery

- Owner balance reads settle up to 25 successful stranded holds (`31:1895-1967`).
- The worker performs bounded settlement/release, orphan-hold recovery, and usage backfill (`32:703-821`).
- Orphan holds older than one hour whose run row was deleted are released by a service-role sweep (`31:1780-1887`).

### D.6 Gaps

There is no automatic refund policy for failed generations beyond release of an unused hold, no customer-facing refund request, no payment-provider refund, and no payment-to-credit entitlement ledger. The runbook explicitly says refunds are operator decisions (`docs/runbooks/credits.md:155-162`).

---

# Part E — AI usage, model calls, tokens, and provider cost

**Status: PARTIAL/COMPLETE for metering; intentionally separate from credit charging.**

### E.1 Run-derived usage

`record_ai_usage_attempts(run_id)` accepts only a run id and derives attempt rows from server-written `project_runs.provider_attempts`; it does not accept browser-supplied token or cost values (`31:1473-1638`). Migration 32 revokes the earlier authenticated grant and makes this recorder service-role-only (`32:572-576`).

### E.2 Durable provider-attempt lifecycle

Before a worker provider call, `begin_ai_provider_attempt()` inserts an uncertain marker containing the run, lease, role, task, phase, model, and stable attempt id. It requires service role, project ownership, a live worker lease, and a non-terminal worker run (`32:304-428`). `complete_ai_provider_attempt()` updates that same row, validates non-negative usage, preserves uncertainty for timeout/network/unknown results, and never turns an unknown cost into zero (`32:431-570`).

### E.3 Cost semantics

The system records:

- provider-reported actual USD cost when present;
- optional rate-card estimated cost when an operator installs `ai_cost_rates`;
- `unavailable` when neither is known; and
- `uncertain` when the provider call may have reached OpenRouter but the outcome is ambiguous.

The rate card is empty by default (`31:409-430`). Credits are fixed whole units and provider USD cost is expressly not converted into credits (`31:41-47`; `docs/architecture/phase-11-credit-foundation.md:121-145`).

### E.4 Specialist/orchestration calls

The orchestration engine records role-level provider attempts with the same durable lifecycle (`src/lib/orchestration/engine.ts:617-705`). It records the result even when the usage write fails, and logs the metering failure without discarding an already-produced advisory result. Pinned role models are resolved without silent fallback (`src/lib/ai/model-roles.ts:15-28,125-145`).

### E.5 Accounting conclusion

AI spend observability exists; usage-based billing does not. A user can be charged the configured fixed generation amount even when provider USD cost is unknown, and a known provider cost never changes the credit debit. That is an explicit product model, not an accidental exchange-rate implementation.

---

# Part F — Worker, retries, orchestration, and generation integration

**Status: COMPLETE in repository for the enabled worker design; NOT VERIFIED operationally.**

### F.1 Worker gate

The durable worker checks configuration, service-role availability, migration marker 32, and account-restriction prerequisites before it claims work (`src/lib/generation/worker.ts:107-148`). It runs credit reconciliation before claiming a job (`worker.ts:150-169`).

### F.2 Fencing and retries

Worker claims carry a lease token and expiry. `run-agent.ts` uses the service-role client only under a verified worker context, and provider attempts are tied to the active lease. Expired work is recovered into bounded retry/dead-letter paths. Credit settlement is based on the terminal run state, not on an untrusted provider callback.

### F.3 Multi-agent behavior

Multi-agent orchestration is worker-only and cohort-gated. Coding remains the source-writing engine; planner/UI/UX/QA/security/repair outputs are advisory. Role usage is recorded per attempt and model failure cannot create a credit pass. Current repository documentation says specialist model verification and live workflow execution remain unverified (`docs/architecture/phase-11-credit-foundation.md:147-172`).

### F.4 Operational weakness

Migration 32's worker reconciliation loops catch all exceptions and continue without persisting a failure counter or incident row (`32:750-753`, `32:800-803`). The next sweep can retry, but a persistent settlement/usage-reconciliation failure may be difficult to distinguish from a clean zero-result sweep. This is an operational observability gap, not evidence of incorrect accounting.

---

# Part G — Workspace balance, top-up UI, and user-facing credit behavior

**Status: PARTIAL.**

### G.1 Authoritative balance display

`creditSnapshotForOwner()` returns disabled/unready state with null values, reconciles successful terminal holds before reading the account, and refuses to fabricate a balance (`src/lib/credits/service.ts:181-269`). The `/vcaas/credits` response is wired through the server API (`src/lib/mavly/api.ts:374-385,725-726`).

`CreditsIndicator` displays available credits (`balance - reserved`) from that API and renders `—` for disabled, unavailable, or invalid data (`src/components/workspace/CreditsIndicator.tsx:8-20,30-65`). It refreshes on mount and when the parent `refreshKey` changes; there is no realtime subscription.

### G.2 Launch behavior

The launch/start/resume paths surface insufficient-credit refusal without creating or reopening a run. The server, not the browser, derives the cost and cohort. This is consistent with the database boundary.

### G.3 Top-up behavior

The top-up page has no purchase API call. Its modal states that Razorpay/Stripe automation is in development, no charge was made, and verified payment is required before credit grant (`src/app/credit-topup/credit-topup-client.tsx:282-333`).

### G.4 UX risk

The page also uses copy such as “Complimentary starter credits active” while saying the live ledger is in transition (`credit-topup-client.tsx:104-127`). Because the actual credit API returns null/unavailable when the feature is off or unconfigured, this copy should not be interpreted as a persisted numeric entitlement. The backend correctly avoids displaying a fabricated number.

---

# Part H — Razorpay, platform billing boundary, and generated-app payments

**Status: COMPLETE in repository for the separate generated-app payment capability; NOT VERIFIED live; MISSING for Mavly credit funding.**

### H.1 What Razorpay implements

The Phase 6 adapter supports Razorpay payments for a generated customer application:

- owner saves encrypted project credentials and configures the integration;
- generated application server code authenticates with a project API key carrying `integrations:*`;
- Mavly creates an idempotent Razorpay order;
- checkout verification checks the HMAC and then reads the provider payment authoritatively;
- webhooks verify the exact raw body before parsing;
- signed event bodies are deduplicated by integration plus SHA-256 body digest;
- payment state is amount/currency matched and `paid` never regresses.

Evidence: `src/lib/integrations/payments/gateway.ts:1-18,118-190,252-425`; `src/lib/integrations/payments/webhooks.ts:1-15,134-239,282-361`; `supabase/migrations/21_business_integrations.sql:610-935,1006-1259`; durable gateway limits in `supabase/migrations/23_production_hardening.sql:20-33,69-177`.

### H.2 What Razorpay does not implement

The generated-app payment tables and webhooks do not call `grant_credits`, do not update `credit_accounts`, do not create Mavly invoices, and do not produce Mavly platform revenue. `docs/architecture/phase-6-business-integrations.md:1-7` and migration 52's billing comments explicitly separate customer-app payments from Mavly billing.

### H.3 Refund boundary

The payment provider catalog reports refunds unsupported, and the business integration has no provider refund route. The credit refund RPC is unrelated and cannot refund a Razorpay charge. Therefore a generated-app payment refund cannot currently restore Mavly credits, and a Mavly credit refund cannot currently issue a Razorpay refund.

---

# Part I — Admin Panel, credit operations, AI usage, and billing

**Status: PARTIAL overall; Credits and AI Usage are real repository-backed sections, Billing is intentionally unavailable.**

### I.1 Admin authentication

`src/app/adminsh/layout.tsx:1-52` requires a verified session and an active database admin status. Admin RPCs independently call `current_user_is_admin()`; the layout and database are both required gates.

### I.2 Admin Credits

`admin_credit_ledger()` reads real ledger rows and computes issued, consumed, refunded, outstanding, reserved, wallet, reversal, and transaction summaries from database data (`supabase/migrations/50_admin_console_backend.sql:225-380`). The API calls it through `requireAdmin()` and returns migration/unavailable errors rather than an empty fake ledger (`src/app/api/adminsh/credits/route.ts:18-99`).

`admin_adjust_credits()` is the only Admin Panel balance-write path. It validates the target user, amount, operation, reason, maximum adjustment, and idempotency key; locks the account; writes the account and one ledger row; and writes an audit row (`50:382-544`). The route requires a reason for negative adjustments and a key (`src/app/api/adminsh/credits/adjust/route.ts:75-159`).

### I.3 Admin AI Usage

The current migration 52 definition of `admin_ai_usage()` uses the shared Asia/Kolkata reporting window and reads run-level tokens/cost from `project_runs`; per-attempt rows are returned separately from `ai_usage_attempts` (`supabase/migrations/52_admin_notifications_and_reporting.sql:639-819`). The client displays “Cost unavailable” or “partial” rather than treating unknown provider cost as zero (`src/lib/admin/console.ts:232-254`; `src/app/adminsh/ai-usage/page.tsx:48-68,202-236`).

This is two observability views, not one settled spend total: run-level summary fields and per-attempt rows have different scopes. In particular, operator reports must not sum the run summary and the attempt table together.

There is also a static filter-scope defect: migration 52 applies `p_model` to the grouped model rows and attempt rows (`52:710-798`), but the summary CTE used for the headline cards has no model predicate (`52:670-708`). The page still displays “Filtered to …” when a model is selected (`src/app/adminsh/ai-usage/page.tsx:167-171`), so the headline request/token/cost/success figures can remain all-model totals while the lower sections are model-filtered.

### I.4 Admin generation operations

The generation monitor reads real run rows and exposes retry/cancel actions through guarded RPCs. Admin retry refuses credit-enforced projects because it would spend the owner's credits without the owner's credit-aware resume path (`src/app/api/adminsh/generation-monitor/actions/route.ts:8-33,70-123`).

### I.5 Admin Billing

`src/app/adminsh/billing/page.tsx:14-66,70-142` intentionally renders dashes and “No Mavly platform billing source.” It excludes customer-owned Razorpay application payments. This is truthful, but it means the Admin Panel cannot report platform revenue, Mavly subscription revenue, credit sales, invoices, or payment refunds.

---

# Part J — Security, data-flow integrity, tests, and verification limits

**Status: PARTIAL repository controls; NOT VERIFIED live. One static security-design finding requires remediation before treating the generated-app gateway proof as strong.**

## J.1 Positive controls

1. Credit balances and reservations are server/database-owned; clients cannot submit a balance, price, refund entitlement, or usage row.
2. Ledger history is append-only.
3. Credit admission is atomic with the run insert and reservation.
4. Terminal settlement/release is trigger-protected and idempotent.
5. Provider-attempt markers are durable and uncertain outcomes remain uncertain.
6. Admin routes require an authenticated admin and the RPCs repeat the admin predicate.
7. Razorpay webhooks verify the raw signed body before JSON parsing.
8. Payment state checks amount/currency and never trusts a redirect alone.
9. Secrets are encrypted and not returned to the browser.
10. The credit worker and service-role client are confined to trusted server/worker boundaries.

## J.2 Static finding: owner-controlled generated-app RPC proof

**Finding ID:** F-02  
**Priority:** P1  
**Status:** BROKEN contract boundary; live exploitability NOT VERIFIED.

`save_payment_integration()` is callable by an authenticated project owner and accepts `p_rpc_secret_hash` from its caller (`supabase/migrations/21_business_integrations.sql:282-387`, grant at `21:474-476`). The normal server service passes the hash derived from `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET` (`src/lib/integrations/payments/service.ts:300-349`), but the database RPC itself does not enforce that the supplied hash equals the deployment's server-only secret hash.

Every anon-callable generated-app payment and webhook RPC then trusts the `project_integrations.rpc_secret_hash` value (`21:540-604,610-935,1008-1259`; `23:105-117`). Consequently, an owner can replace the stored proof with an arbitrary valid-looking hash. If a project API key and PostgREST access are available to an untrusted generated-app caller, that caller could present the owner-selected hash directly to state-changing gateway RPCs instead of proving knowledge of the deployment secret. This does not grant cross-project access—the row is still project/key scoped—but it weakens the stated “server-only proof” against forged payment state within the project.

This is a static contract concern, not a claim that a live attack was executed. The correction must make the proof deployment-owned (for example, a service-role-only enrollment/update path or a database-side secret-proof design) before this boundary is described as a strong server-only control.

## J.3 Operational and governance gaps

- Credit policy rows must be synchronized manually with environment cohort and price. A mismatch fails closed, but there is no repository-backed deployment synchronizer.
- Admin credit adjustments are atomic and audited, but no dual approval or separation-of-duties workflow exists.
- Refund RPC authority is service-role-only, but there is no customer-facing support workflow, payment refund linkage, or refund approval record beyond the ledger reason/audit metadata.
- Worker reconciliation catches and suppresses errors in the SQL loop. Repeated failures need stronger alerting and durable error visibility.
- A live worker, live OpenRouter call, live Supabase session, live Razorpay account, and actual webhook delivery are not verified here.

## J.4 Tests inspected

The repository contains static/pure contract coverage in:

- `tests/credit-foundation.test.ts`: credit configuration, balance rules, settlement/release decisions, RPC contracts, migration grants/triggers, worker/orchestration wiring, and no fabricated values.
- `tests/business-integrations.test.ts`: Razorpay validation/signatures/provider error mapping, route scope, payment migration contracts, idempotency, and metadata boundaries. Its header explicitly says it never contacts Razorpay or writes a database (`tests/business-integrations.test.ts:59`).
- `tests/admin-console.test.ts`: admin operation labels, ledger display rules, CSV safety, admin guards, adjustment transaction shape, and unknown-cost behavior.
- `tests/admin-overview.test.ts`, `tests/admin-notifications.test.ts`, and related admin tests: admin routes, reporting/notifications, and migration contracts.
- `tests/openrouter-metadata.test.ts`: provider usage and cost metadata parsing.

These tests are useful repository contracts, but they do not prove migrations against Postgres, RLS behavior, provider calls, worker leases, payment delivery, or financial settlement. No automated check, typecheck, lint, build, browser, HTTP, database, worker, or provider validation was run for this audit, in accordance with the repository's verification policy.

---

# 3. End-to-end data-flow maps

## 3.1 Generation credit flow

```text
Workspace launch
  -> authenticated Mavly API
  -> server parses MAVLY_CREDITS_* and derives project price
  -> service-role create_generation_job_with_credits_ordered
       -> policy/project ownership check
       -> durable generation admission/idempotency/caps
       -> account row lock
       -> available-credit check
       -> project_run + credit_reservation + generation_reserved ledger row
  -> durable worker claim with lease
  -> OpenRouter generation / checkpoints / retries
  -> terminal project_run write
       -> migration-32 trigger
            completed -> consume hold + generation_consumed ledger row
            failed/cancelled -> release hold + generation_released ledger row
  -> worker/owner bounded reconciliation if a prior process died
```

No browser-supplied amount enters the authoritative path. No Razorpay event enters this path.

## 3.2 AI usage flow

```text
Worker claims run and lease
  -> begin_ai_provider_attempt(attempt UUID, lease, role/model)
  -> uncertain attempt row committed
  -> OpenRouter request
  -> complete_ai_provider_attempt(same UUID, tokens, request id, cost, error/uncertain)
  -> ai_usage_attempts row updated
  -> run-level provider_attempts also remain available for recovery
  -> optional rate-card estimate when actual cost is absent
  -> Admin AI Usage reads project_runs summary + ai_usage_attempts detail
```

Provider USD is observability. The credit debit is the fixed policy amount, independent of provider USD.

## 3.3 Generated-app Razorpay flow

```text
Generated app server
  -> project API key with integrations:* 
  -> Mavly gateway authenticates key + configured RPC proof
  -> gateway_begin_payment idempotent local order row
  -> Razorpay create order
  -> gateway_set_payment_order
  -> checkout signature + authoritative Razorpay payment read
  -> gateway_mark_payment, amount/currency checked

Razorpay webhook
  -> integration token lookup + encrypted webhook secret
  -> HMAC over exact raw body
  -> digest-idempotent event row
  -> gateway_apply_webhook_payment
  -> gateway_finish_webhook_event
```

This flow terminates in `project_integration_payments`; it never reaches `credit_accounts` or `credit_ledger`.

## 3.4 Missing commercial flow

```text
Mavly user selects provisional package
  -> UI opens offline/in-development modal
  -> no platform order is created
  -> no payment is verified
  -> no grant_credits call occurs
  -> no credit entitlement is issued
```

---

# 4. Prioritized findings

| ID | Priority | Status | Finding | Evidence | Impact |
|---|---:|---|---|---|---|
| F-01 | P1 | MISSING | No Mavly credit purchase/funding path exists. | `31:646-731`; `phase-11-credit-foundation.md:200-206`; `credit-topup-client.tsx:282-333` | Users cannot buy credits; all balances require service-role/admin funding. |
| F-02 | P1 | BROKEN contract boundary | Authenticated owner can choose `rpc_secret_hash`; gateway state-changing RPCs trust that stored value. | `21:282-387,540-604,1008-1259`; `service.ts:300-349` | Weakens the claimed server-only proof if a project API key is exposed. Live exploitability was not tested. |
| F-03 | P1 | MISSING | No payment-provider refund or customer-facing credit refund workflow. | `31:1285-1396`; `credits.md:155-162`; payment catalog capability tests | Support cannot reconcile a Mavly purchase refund because no purchase exists; generated-app refunds are also unsupported. |
| F-04 | P2 | PARTIAL | Provider USD usage is recorded separately and never prices credits. | `31:41-47,581-619`; `phase-11-credit-foundation.md:121-145` | Correct for fixed-price policy, insufficient for usage-based commercial billing. |
| F-05 | P2 | PARTIAL | Worker reconciliation suppresses errors without a durable failure metric. | `32:725-805` | Persistent settlement or usage failures may be hard to detect promptly. |
| F-06 | P2 | PARTIAL | Admin credit writes have atomic auditability but no dual-control approval. | `50:382-544`; `credits/adjust/route.ts:75-159` | A compromised or mistaken admin session can grant/debit within configured limits. |
| F-07 | P2 | PARTIAL | Admin run summary and per-attempt usage are separate scopes. | `52:670-810`; `admin/console.ts:170-230` | Operators can misread run-level cost as total provider spend if they combine views incorrectly. |
| F-08 | P2 | NOT VERIFIED | No live validation of migration order, RLS/RPC grants, worker leases, settlement, or provider behavior. | `phase-11-credit-foundation.md:211-214`; runbook acceptance checklist | Repository contracts cannot establish production financial correctness. |
| F-09 | P2 | BROKEN UI/reporting contract | Selecting an AI model filters detail rows but not the Admin AI Usage headline summary. | `52:670-708,710-798`; `ai-usage/page.tsx:167-171` | Headline usage/cost/success figures can contradict the selected model filter. |

---

# 5. Recommended roadmap

## P0/P1 before commercial credit sales

1. Implement a dedicated Mavly platform billing contract: product/package ids, immutable price/currency, order table, payment state machine, provider signature/webhook handling, idempotency, and a transactionally audited payment-to-`grant_credits` allocation path.
2. Define whether credits are fixed per generation or usage-priced. If fixed, expose that clearly as a policy; if usage-priced, add an authoritative reservation/settlement formula rather than deriving it in the browser.
3. Replace the owner-supplied payment RPC proof with a deployment-owned proof that cannot be rewritten by an authenticated project owner through an anon-callable gateway trust field.
4. Define refund policy: failed generation release, charged-generation support refund, payment reversal, partial refund, expiry, dispute/chargeback, and idempotent compensating ledger behavior.

## P2 before broad rollout

5. Add durable worker reconciliation failure telemetry with bounded error classes, alerting, and an operator-visible backlog of unreconciled holds/usage rows.
6. Add a platform billing/admin revenue source before populating Billing metrics. Keep customer-app Razorpay rows separate.
7. Decide whether Admin credit adjustment needs two-person approval, reason taxonomy, maximums by operation, and stronger audit retention.
8. Provide a single documented Admin AI cost model that distinguishes run-level provider cost, per-attempt cost, orchestration role cost, unknown cost, and estimated cost.

## Acceptance sequence

1. Apply the required predecessor migrations and migrations 31 and 32 to a disposable staging database; verify schema markers and grants.
2. Configure one disposable project policy and fund one disposable test account through service role.
3. Exercise concurrent admissions, duplicate launch, insufficient balance, worker retry, terminal success, terminal failure, cancellation, resume, orphan cleanup, and repeated settlement.
4. Exercise provider-attempt start/result/crash/timeout behavior and confirm uncertain cost remains uncertain.
5. Exercise Admin ledger reads, positive/negative adjustments, idempotency conflict, audit row, and non-admin rejection.
6. If commercial billing is added, exercise the full payment-to-grant path with provider sandbox signatures, duplicate webhook delivery, failed webhook processing, retry, refund, and chargeback semantics.
7. Only after staging evidence, enable an explicit production cohort.

---

# 6. Ten-system verdict

1. **Supabase credit ledger:** implemented with strong repository-level invariants; live database behavior not verified.
2. **Credit accounts and reservations:** implemented; atomic holds and one-live-hold protection exist.
3. **Generation admission:** implemented for a worker-only, explicit cohort and fixed server-derived price.
4. **Generation settlement/release:** implemented with migration-32 terminal trigger and recovery sweeps; live execution not verified.
5. **AI usage and provider cost:** implemented as per-attempt observability with uncertainty handling; not connected to credit pricing.
6. **Credit funding and entitlements:** not implemented; service-role/admin grants are the only source.
7. **Refunds:** operator-only generation-credit refund exists; no customer/payment refund flow exists.
8. **Razorpay:** implemented for generated-app business payments, not Mavly credits or platform revenue.
9. **Workspace and top-up UX:** balance read is real when enabled; top-up is explicitly offline/provisional.
10. **Admin Panel and operational assurance:** Credits/AI Usage/generation monitoring are backed by real guarded RPCs; Billing has no source; the AI model-filter headline mismatch needs correction; no live financial or production verification was performed.

## Final verdict

**Mavly’s credit accounting is a real, carefully fenced opt-in foundation, but the complete paid credit system requested by a commercial product is not present.** The largest missing capability is the payment-to-credit funding path. The most important static security concern is the owner-controlled generated-app Razorpay RPC proof. Until those are resolved and the staging acceptance sequence is executed, the system should be described as **operator-funded credit accounting with separate generated-app payments**, not as a production-ready Mavly wallet, billing, and refund system.

---

## 7. Follow-up implementation status — static review only

The working tree now contains a separate platform-billing implementation that
addresses the commercial gaps above in repository code. This section records
what was inspected after the original audit; it does not claim live provider or
database verification.

- `57_platform_billing.sql` adds an immutable catalog, India payment/subscription
  records, provider webhooks, credit lots, entitlement grants, refunds,
  reconciliation jobs, and admin projections. India rows use Razorpay/INR.
- `59_inr_billing_and_ai_costs.sql` keeps Global rows inactive until approved
  USD amounts and Dodo mappings exist, adds explicit INR snapshots/exchange-rate
  records, free-credit initialization, and the INR admin billing/AI views.
- Billing checkout is gated by `MAVLY_PLATFORM_BILLING_ENABLED`, derives the
  market from a verified profile or trusted ingress, rejects conflicts, and
  does not default an unresolved country. Global checkout is Dodo/USD when an
  approved Global catalog row exists.
- The public pricing and credit top-up surfaces read the approved catalog;
  they no longer own paid amounts or credit quantities in client code. Annual
  pricing is not shown because no yearly catalog rows or annual checkout path
  are installed.
- Checkout retries return an existing provider action where it is durably
  attached, and provider-creation/attachment failures mark the pending payment
  failed. Webhook event hashes, amount, currency, and payment identity are
  checked before settlement.
- `60_business_integration_rpc_proof_hardening.sql` makes the generated-app
  payment integration write service-role-only and prevents an authenticated
  owner from choosing the gateway proof hash.

Remaining evidence limits are unchanged: no migration was applied to a live
Postgres database here, no Razorpay/Dodo sandbox call or webhook delivery was
performed, no worker reconciliation was exercised, and no automated test,
lint, typecheck, build, browser, HTTP, or smoke verification was run under the
repository policy.

# Mavly Production Stability — Findings & Plan

## Audit result summary

| Issue | Status | Root cause |
|---|---|---|
| Sidebar `12.4k` vs 74 | **Confirmed** | `AdminSidebar.tsx:64` hardcoded badge; `live` prop never passed outside dashboard |
| Block/Unblock unsupported | **Confirmed** | Feature never built — disabled button, no route, no table, no `auth.admin` call |
| 3s navigation | **Confirmed (4 causes)** | App-wide `force-dynamic`; `no-store` on all paths; 3–4 sequential auth round-trips; no loading states |
| Projects directory error | **UNVERIFIED** | Cannot query deployed schema — no credentials in this workspace |

## What I can fix with certainty

### 1. Users count — one source of truth
- Remove the hardcoded `"12.4k"` from `ADMIN_NAV_GROUPS`.
- Fetch the real `auth.users` count once in `AdminShell` (shared parent of every admin page) via a lightweight count endpoint, and pass it down.
- Show a skeleton until resolved — never a fake number.
- Result: sidebar, Users page total, and Customer Directory all read the same population.

### 2. Truthful directory errors
- `directory-errors.ts` currently maps four distinct DB codes into one "missing table or column" message. Replace with the actual code + a precise, actionable diagnostic.
- Ship a read-only reconciliation SQL script (`supabase/diagnostics/`) that reports which of the 44 migrations' objects are actually present, so the real cause is identified from evidence instead of guessed.

### 3. Performance (no redesign, no route changes)
- Move `force-dynamic` off the root layout; scope it to routes that genuinely need it.
- Stop sending `no-store` for immutable `/_next/static/*` assets.
- Deduplicate auth: one `getUser()` per request, reused by layout and route handler.
- Add `loading.tsx` skeletons to admin routes for instant navigation feedback.
- Remove the fabricated `setTimeout` + `Math.random()` "ping test" telemetry (violates no-fabrication rule).

### 4. Block / Unblock
- Server route with server-side admin re-check, self-block guard, idempotency.
- Uses Supabase native `auth.admin.updateUserById` ban — no duplicate status system.
- Enforcement: blocked check in proxy + protected API gate, so existing JWTs can't be used.
- Restriction screen with Logout + Contact Support (existing `/support` route).
- Audit trail in a new table.

## The one decision I need from you

Block/Unblock needs **one new migration (45)** for the audit table. Everything else reuses existing schema. You said not to create SQL blindly — this is the case where it's genuinely required, because no audit table exists.

## What I will NOT claim
- No test/lint/build results (AGENTS.md forbids agents running them).
- No measured before/after timings — I can't run the app without credentials.
- No fix for the Projects schema error until the diagnostic tells us the real code.

## Execution order
1. Users count (safe, isolated)
2. Truthful errors + diagnostic script
3. Performance
4. Block/Unblock (+ migration 45 on your approval)
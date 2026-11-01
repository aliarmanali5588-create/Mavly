# Phase 14 — Managed backend runtime (Neon + verified schema + data API)

Status: **implemented, off by default, not verified against a live Neon account or a hosted generated app.**
This document describes what exists in this repository, what it refuses to claim, and the exact
external dependencies that remain.

## 1. Why this phase exists

Before this phase Mavly could create a Neon project and prove that a server-side `select 1`
succeeded. That is infrastructure, not a backend:

- generated code had no schema;
- there was no way for a generated app to read or write rows;
- a `provisioned` row could be mistaken for "CRUD works".

Phase 14 closes the *server-side* part of that gap. It does **not** invent a hosting runtime:
see §9.

## 2. Lifecycle

`src/lib/managed-backend/lifecycle.ts` is the single vocabulary.

| State | Meaning |
|---|---|
| `not_required` | The product needs no persistent data. No registry row exists. |
| `pending_approval` | A backend is needed, but provisioning is not approved/configured. |
| `provisioning` | Neon create/reconcile in progress (existing lease/fencing from migration 30). |
| `provisioned` | Neon project exists; server-side connection verified. **No schema.** |
| `configuring` | Schema compile/apply/verify + gateway configuration in progress. |
| `ready` | Connection verified **and** schema verified **and** gateway configured. |
| `failed` | A step failed; the database and its rows are preserved. |
| `outcome_unknown` | A create may or may not have succeeded; reconcile by name before retrying. |
| `cleanup_pending` | Bookkeeping only. No automatic deletion is implemented. |

`ready` is enforced twice: in `lifecycle.ts` for callers, and by
`project_managed_backends_ready_requires_schema` in migration 35, which refuses a `ready`
row without a data model, a schema verification timestamp, a runtime verification timestamp,
a configured gateway origin and its proof hash.

Capability projection (`managedBackendCapabilities`) keeps four facts separate:
`database`, `schema`, `dataApi`, `authentication`, `persistentCrud`. A database without a
schema cannot project `persistentCrud: true`.

## 3. Requirement detection

`src/lib/managed-backend/requirement.ts`:

- static products (landing pages, portfolios, one-pagers, read-only prototypes) never get a
  database, even if the planner asks for one;
- a planner `requiresDatabase: true` must be backed by a validated data model before anything
  is provisioned;
- a prompt that clearly needs records but whose plan has no data model gets **no** database and
  an explicit "no data model" message — never an empty database and never in-memory storage
  presented as persistence;
- authentication is enabled only when the backend is required and the product actually needs
  end-user accounts.

## 4. Application data model and schema compiler

`src/lib/managed-backend/model.ts` validates the planner's `dataModel`:
1–12 tables, 1–24 columns, closed type allowlist (`text`, `integer`, `bigint`, `boolean`,
`timestamptz`, `date`, `numeric`, `jsonb`), reserved names (`id`, `owner_id`, `created_at`,
`updated_at`, anything `_mavly*`, `pg_*`, `sql_*`), bounded text lengths, declarative
resources with an operation allowlist and `user`/`public` ownership. A `public` resource is
read-only; a user-owned table requires `auth.required`.

`src/lib/managed-backend/migrations.ts` compiles that model into deterministic steps:

- one step per table plus an `auth:init` step;
- identifiers are quoted only after the strict identifier regex;
- every statement is `if not exists` and additive — the compiler contains no `drop`,
  `truncate`, `alter column`, `grant`, extension install, function body or `do` block;
- each step has a SHA-256 checksum and a stable name.

`src/lib/managed-backend/runner.ts` applies them in the customer database:

1. bounded connection (8 s connect, 15 s statement timeout);
2. **one transaction** for the whole run;
3. `pg_advisory_xact_lock` so two workers cannot migrate concurrently (this is also
   correct on Neon's pooled endpoint, because one transaction is one backend session);
4. `mavly_schema_migrations(name, checksum, applied_at)` ledger, created inside it;
5. each unapplied `(name, checksum)` step;
6. the resulting schema is read back from `information_schema.columns` and compared;
7. `commit` only when every step applied **and** the read-back matched.

Postgres DDL is transactional, so a failure leaves no partial schema and no partial ledger;
a retry re-applies the idempotent steps. A changed model adds new `(name, checksum)` rows and
`add column if not exists`; it never removes or retypes a column. Dropping customer data is
an owner-approved lifecycle action, not a generation side effect.

**An added column is nullable.** `add column ... not null` fails on a table that already
holds rows, and back-filling an invented value would write fabricated data into a customer's
records, so the additive step succeeds without touching existing rows and `required` stays a
gateway input rule. Verification therefore asserts presence and type for every expected
column, and exact nullability only for a table the run created from scratch (the tables that
did not exist when the migration transaction began). A pre-existing table's nullable column
is not reported as drift, so a healthy backend cannot appear permanently broken.

## 5. Data API (the trusted runtime for app data)

`src/app/api/app/v1/apps/{projectId}/…` is reached by the generated app, not by Mavly's own UI.
It executes only Mavly-authored, parameterized SQL against the customer's Neon database.
**It does not execute generated code.**

| Method | Path | Purpose |
|---|---|---|
| GET | `/data/{resource}?limit&offset&q&<filter>` | list, bounded 1–100, offset ≤ 10 000 |
| POST | `/data/{resource}` | create |
| GET | `/data/{resource}/{id}` | read |
| PATCH | `/data/{resource}/{id}` | update |
| DELETE | `/data/{resource}/{id}` | delete |
| POST | `/auth/signup` \| `/auth/login` \| `/auth/logout` | end-user accounts |
| GET | `/auth/session` | current session |

Resolution: `data_gateway_context(project_id, rpc_hash)` requires a `ready` row and the
SHA-256 of the server-only `MAVLY_MANAGED_BACKENDS_RPC_SECRET`. The encrypted Neon URI is
decrypted with `MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY` and the owner/project/registry AAD;
it never leaves the server.

Authorization:

- resource and column names come only from the applied model;
- values are bind parameters; `owner_id` is always the session user id;
- a user-owned table without a session throws in the query builder (fail closed);
- `id`, `owner_id`, `created_at`, `updated_at` are not writable;
- unknown fields are rejected;
- row counts are bounded and filters are limited to declared `filterable` columns.

Transport:

- `Authorization: Bearer <session token>` is the portable path (works cross-site);
- an HttpOnly, Secure, `SameSite=Lax`, project-scoped cookie
  (`mavly_s_<project-id>`, path `/api/app/v1/apps/<project-id>`) is also set for same-site
  Mavly hosting;
- CORS allows only `https://<project-id>.mavly.xyz` (derived server-side) and, outside
  production, `http://localhost:*` for local development;
- mutations from a disallowed `Origin` are refused.

Rate limits are durable and fixed in SQL (migration 35), shared across instances:
**240 reads / 60 writes / 20 auth attempts per project per minute.** An RPC failure is a
refusal, never an in-memory fallback.

## 6. Generated-app end-user authentication

`src/lib/app-data/auth.ts` + `auth-service.ts`:

- passwords: scrypt (N=16384, r=8, p=1), 16-byte random salt, 64-byte key, self-describing
  storage string; constant-time verification; a malformed stored value is a non-match;
- sessions: 32 random bytes, stored only as SHA-256, 7-day absolute expiry, explicit
  `revoked_at`; logout revokes the row and clears the cookie;
- login failures are generic and cost-uniform (an unknown account still runs one scrypt);
- accounts and sessions live in `_mavly_auth_users` / `_mavly_auth_sessions` in the
  **customer's** database. They are unrelated to Mavly's Supabase users.

**Password reset is not implemented.** There is no email transport in this repository, and a
fake reset flow would be a security regression. This is a documented gap (§9).

## 7. Generation integration

`src/lib/mavly/run-agent.ts` runs one managed-backend stage between the persisted plan and the
first code batch:

```
plan (persisted)
  → detectBackendRequirement
  → data model required? ── no → static site, nothing created
  → cohort/worker/config gates
  → ensureManagedBackend (existing provision/reconcile)
  → configureManagedBackend (schema + verify + gateway)
  → "ready" + server-authored data-API contract
  → code batches
```

The contract (`src/lib/managed-backend/prompt.ts`) is generated from the validated model and
lists the exact endpoints and fields. The system prompt states that this contract is the only
data layer, forbids database clients/`DATABASE_URL`/hand-rolled auth, and requires real
loading/empty/error/signed-out states.

An **update** that does not itself need new tables (for example "make the header blue")
reuses the project's `ready` model as the contract instead of telling the model the app has
no backend, so a follow-up edit cannot silently delete the data layer. No new schema step is
applied in that case.

Failure handling:

- a blocked requirement (no model, flag off, inline path) does not fail the generation; it
  produces a labelled prototype and a message naming the missing capability;
- a provider, configuration or schema failure also does **not** fail the generation: the
  stage reports the sanitized reason (`provisioning_*` / `configuration_*`), switches the app
  to an explicitly labelled prototype (`not_provisioned`), names the fact that existing
  database data was not deleted or changed, and continues with the code batches so the
  user's work is preserved. A retry can finish the backend without restarting generation;
- an unexpected exception inside the stage still fails the run, because that is a bug in
  Mavly, not a backend decision;
- `agent/status` exposes the owner-visible `managedBackend` projection
  (state, capabilities, tables, error code, last step, next action) with no ciphertext.

## 8. Security and isolation

- Neon API origin is fixed (`https://console.neon.tech/api/v2`), redirects refused, 12 s timeout.
- Project resource names are server-derived (`mavly-<sha256 prefix>`), so a create that may
  have succeeded is reconciled by name instead of repeated.
- The connection URI is AES-256-GCM ciphertext bound to `(user, project, registry)`; the
  authenticated role cannot select it.
- The gateway's project id is public (it is in the published hostname) but is not a
  credential: without the server-only RPC proof the context RPC returns nothing.
- Each request creates its own bounded `pg` client; no pool is shared between projects.
- Structured errors carry no SQL, connection string, password, session token or provider key.
- **Quota:** one managed database per project incarnation. `claim_managed_backend` is keyed by
  `(project_id, project_created_at)`, the Neon project name is server-derived from that tuple,
  and every create is bounded by the quotas in §9/runbook. There is no per-user database
  counter of its own; the limit is one database per project, and project creation is the
  existing admission boundary. No path creates a database for a static site.
- **Residual (documented):** the gateway connects with the project's own Neon role, the only
  credential Neon issues at provisioning. Query text is built exclusively by Mavly's builder
  and every connection is per request with a 5 s statement timeout, so a customer cannot name
  a table, SQL fragment or role — but Mavly-side database access is not sandboxed to a
  separately created least-privileged role. Creating a migration-only role plus a DML-only
  application role is a follow-up that needs a Neon role/credential design; it is not claimed
  here.
- **Residual risk (documented):** `data_gateway_context` is executable by `anon` and accepts
  the SHA-256 of the server-only secret. A database read compromise that exposes
  `gateway_secret_hash` would let an attacker with the anon key read the ciphertext (not the
  plaintext, which needs the server-only encryption key). This mirrors Phase 6's documented
  gateway residual; a service-role/asymmetric redesign would remove it.

## 9. What is BLOCKED (do not claim otherwise)

1. **A hosting runtime for generated Next.js server code.** This repository has no approved
   runtime for generated app server code: Phase 5 full-stack hosting is Vercel-based and
   off by default, customer Vercel publishing is retired, and Phase 13's E2B sandbox is a
   React + Vite *dev-server preview*, not hosting. Per this task's constraints Vercel is not
   to be reintroduced. Consequence: the data API and auth endpoints are real and exercisable
   over HTTP, but a generated app cannot be served end-to-end inside this repository today.
   Next action: an approved container/microVM hosting provider (credentials + security
   review) or a Cloudflare Workers + Hyperdrive design with OpenNext; both need operator
   approval before implementation.
2. **Password reset / account recovery** — requires an email transport that does not exist
   here.
3. **Neon Agent Plan enrollment** — active Scale plan + explicit Neon team approval, and
   `NEON_API_KEY`/`NEON_ORG_ID`/`NEON_REGION_ID`. Without them provisioning stays off.
4. **Automated or live verification** — the repository's `AGENTS.md` forbids agents from
   running tests, typecheck, build, servers or browser checks. None were run for this phase.
5. **Destructive schema evolution / data deletion** — additive only by design. A reviewed,
   owner-approved migration/cleanup path does not exist yet; `cleanup_pending` is bookkeeping.

## 10. Enrollment and cohort authorization (migration 37)

### The problem this solves

Before migration 37, the only authorization for a managed backend was
`MAVLY_MANAGED_BACKENDS_PROJECTS`: an operator pasted every eligible project UUID into an
environment variable. That does not scale past a handful of customers, and it made "the id is
in a list" the entire security story. It also meant a project id alone was, effectively, the
authorization.

### Two independent state machines

```
ENROLLMENT (project_managed_backend_enrollments)   LIFECYCLE (project_managed_backends)
not_enrolled (no row)                              not_required
pending                                            pending_approval
approved                                           provisioning → provisioned → configuring → ready
rejected                                           failed
revoked                                            outcome_unknown
suspended                                          cleanup_pending
```

Enrollment answers *"is this project authorized to receive a managed backend?"*. Lifecycle
answers *"what is the current state of its Neon backend?"*. They are deliberately not merged:

- a project can be `approved` with no database yet;
- a project can have a `ready` database and later be `suspended`;
- a provisioning failure is a lifecycle fact, never an authorization fact;
- a revocation is an authorization fact, never a data-loss event.

`managedBackendStatusView` therefore carries `state` and `enrollment` as two fields, and
`enrollment.state === "approved"` with `state === "not_required"` is a real, meaningful
combination: "allowed, nothing built yet".

### Where the decision is made

`src/lib/managed-backend/enrollment.ts` is the policy engine — pure, no I/O, no clock, no
environment. `evaluateEnrollment` returns `{ eligible, reasonCode, policyVersion, cohort,
bucket, decisionTimestamp }`.

Inputs, in evaluation order:

1. **Operator overrides** — `revoked` / `suspended` / `rejected` outrank everything. A rollout
   change can never re-admit them.
2. **Platform readiness** — `disabled` mode, then incomplete prerequisites. Reported as
   `platform_not_ready`, never blamed on the project's cohort.
3. **Grandfathering** — an already-`approved` enrollment stays authorized even if the rollout
   has narrowed since. This is what makes a percentage decrease safe.
4. **Requirement** — a static site (`backend_not_required`) and a missing data model
   (`no_data_model`) are refused before consuming a rollout or capacity slot.
5. **Cohort** — `internal` / `allowlisted` / `percentage` / `general_availability`.

`src/lib/managed-backend/enrollment-service.ts` persists the decision through the RPCs and is
the only writer. `src/lib/managed-backend/enrollment-store.ts` is the only module that touches
the registry at all, and it only calls `security definer` RPCs.

### Deterministic percentage rollout

```
bucket = sha256(salt ‖ project_id ‖ project_created_at) mod 100
admitted = bucket < rolloutPercent
```

- Stable across evaluations, so a project never flaps between enrolled and not.
- Raising 10 → 25 admits exactly buckets 10–24; nobody is reassigned.
- Lowering stops new admissions and grandfathers existing approvals.
- `project_created_at` is in the hash, so a recreated slug is a different subject and cannot
  inherit a previous incarnation's approval.
- The salt is server-only and never appears in a status projection or a log line.

### Two gates, deliberately different

| | Enrollment-time (`ensureEnrollment`) | Execution-time (`recheckAuthorization`) |
|---|---|---|
| When | Once, when the project first needs a backend | Before **every** provisioning and configuration |
| Runs the percentage lottery | Yes | **No** |
| Checks capacity | Yes | No (the lease serializes work) |
| Checks approved status, owner, incarnation, platform | Yes | **Yes, against live rows** |
| Stamps `last_authorized_at` | No | Yes |

The split is what makes a rollout decrease safe *and* a revocation immediate. A stale worker
cannot provision after revocation because the execution-time gate reads the live row rather
than trusting the decision that queued the work.

### Defense in depth

The execution-time gate is enforced in three places, not one:

1. `recheckAuthorization()` in the run stage, before `ensureManagedBackend`.
2. A second `recheckAuthorization()` before `configureManagedBackend`, because applying a schema
   writes into the customer database and is a separate act from creating it.
3. SQL: `mark_managed_backend_create_started` (the last gate before the provider call, already
   lease-fenced) and `begin_managed_backend_configuration` both refuse when a registry row exists
   and is not `approved`.

The SQL guard is **conditional on a row existing**, so a deployment still on the legacy static
list — which has no rows — keeps byte-for-byte its previous behavior.

### What the model can never do

The planner's `requiresDatabase` and `authentication` are *inputs* to
`detectBackendRequirement`, which re-reads them defensively and can override them in both
directions. Neither is an authorization. There is no code path where model output sets an
enrollment status, a cohort, an approval flag, or an owner identity. The enrollment service's
inputs are booleans produced by trusted server code, and a test asserts the service never reads
a planner object.

### Security model

- Supabase is the authoritative control plane; Neon is never consulted for an enrollment
  decision.
- Both tables are RLS-enabled with **zero policies** and no privilege for `anon` or
  `authenticated`. Owners read their own projection through a `security definer` RPC.
- Every mutation RPC is `security definer` with an empty `search_path`.
- The policy write path (`enroll_managed_backend`) refuses any caller that is not
  `service_role`, and resolves the owner and incarnation from `public.projects` itself.
- Administrative actions (`set_managed_backend_enrollment`) require
  `public.current_user_is_admin()`, which resolves the caller's own `auth.uid()`. There is no
  `isAdmin` parameter anywhere.
- The audit table is append-only: no UPDATE/DELETE grant, plus a trigger that refuses both.
- Revocation never deletes a Neon project, a schema, a row, or a registry record.

### Observability

`managed_backend.enrollment.requested|approved|rejected|revoked|suspended|resumed`,
`managed_backend.cohort.assigned`, `managed_backend.authorization.denied`,
`managed_backend.provisioning.authorized`. Each carries a project id, cohort, policy version,
reason code and rollout bucket. The allowlist in `src/lib/observability/events.ts` drops every
other field, and `redactSensitiveText` runs on every string, so a salt, a connection URI or an
operator note cannot reach a log line.

## 11. Not implemented on purpose

- No generic admin/data endpoint; only declared resources.
- No arbitrary SQL from a model.
- No automatic Neon project deletion, no automatic database backup/restore.
- No per-request user-supplied database, host, command or environment.
- No Mavly credit pricing for managed databases (provider spend only; Phase 11 still prices
  generation runs only).
- No UI for enrollment administration; the actions are HTTP endpoints behind the existing admin
  gate.
- No external metrics vendor for enrollment volume or cohort distribution; the structured log
  lines are the metric source.
- No automatic backfill of pre-existing `project_managed_backends` rows into the enrollment
  registry. A project that already has a database but no enrollment row is refused by the
  execution-time gate until it is approved (or the deployment stays on the legacy path).

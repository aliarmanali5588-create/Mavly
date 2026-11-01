# Runbook — Customer-owned Supabase via Management API OAuth

Mavly connects a customer's own Supabase project by having the user authorize Mavly
in Supabase's consent screen. Mavly holds a revocable, expiring, refreshable OAuth
token pair instead of a hand-minted service-role key.

**This replaces the manual credentials form.** There is no field anywhere in the
workspace for a project URL, an anon key, a service-role key or a database password.

---

## ⚠️ Which OAuth product this is

Two different Supabase products are easy to confuse, and using the wrong one produces
a token that cannot list projects:

| | This integration | Not this |
|---|---|---|
| Product | **Management API OAuth** | Supabase Auth's OAuth 2.1 server |
| Authorizes | Mavly to act on the user's **organizations and projects** | a third party to act as an **end user of one project** |
| Endpoints | `api.supabase.com/v1/oauth/*` | `<ref>.supabase.co/auth/v1/*` |

---

## External setup (required before the flow works)

### 1. Register the OAuth app

Create an OAuth app in the Supabase dashboard (Account → Apps / OAuth Apps) and grant
**exactly** these scopes:

```
projects:read
organizations:read
database:read
database:write
edge_functions:read
```

Requesting more violates least privilege. Requesting fewer makes the broker refuse
actions the UI offers — the UI and the broker read the same declared set in
`src/lib/integrations/supabase/config.ts` (`SUPABASE_REQUIRED_SCOPES`).

### 2. Set the redirect URL

Must be exactly:

```
<origin>/auth/supabase/callback
```

`SUPABASE_OAUTH_REDIRECT_URI` is validated at startup: it must be https (or http on
loopback for local work), must carry no query or fragment, and must have that exact
path. A mismatch fails closed rather than sending a code to the wrong place.

### 3. Set the environment variables

```bash
SUPABASE_OAUTH_CLIENT_ID=        # from the OAuth app
SUPABASE_OAUTH_CLIENT_SECRET=    # server-only; never NEXT_PUBLIC_
SUPABASE_OAUTH_REDIRECT_URI=     # https://<origin>/auth/supabase/callback
MAVLY_INTEGRATION_ENCRYPTION_KEY= # 32 random bytes, base64 — shared with the GitHub integration
```

Without all four, every Supabase OAuth route answers `503 SUPABASE_OAUTH_NOT_CONFIGURED`
and names the missing variables. It does not degrade silently.

The encryption key is deliberately shared with the GitHub integration: a second key
would be a second thing to rotate. Ciphertexts stay mutually undecryptable because the
AAD binds each value to `supabase-oauth:<purpose>:<userId>:<projectId>`.

### 4. Apply migration 40

```bash
# after 39
psql "$DATABASE_URL" -f supabase/migrations/40_supabase_oauth.sql
```

Additive and non-destructive. It does not alter `project_backend_providers`,
`project_secrets` or `projects`, and it never deletes a customer database or data.
Migration 39's `service_role_ciphertext` column is left in place; OAuth rows simply
leave it null.

Before it is applied, the routes answer `503 SUPABASE_OAUTH_MIGRATION_REQUIRED`.

---

## The flow

1. **Start** — `POST /api/projects/{projectId}/supabase/start`. Verifies the Mavly
   session and project ownership, generates a 32-byte `state` and a 48-byte PKCE
   verifier server-side, stores the verifier **encrypted** with AAD bound to
   `(user, stateHash, pkce)`, and returns only the authorization URL. The browser never
   holds a verifier or a secret.
2. **Consent** — the user signs in to Supabase and authorizes Mavly.
3. **Callback** — `GET /auth/supabase/callback`. Verifies the Mavly session, consumes
   the state row with `DELETE … RETURNING` (single-use: two simultaneous callbacks
   cannot both find it), checks expiry, exchanges the code, and lists the projects the
   token can actually see.
4. **Pending** — the token pair is stored as a `pending_selection` row. **A pending row
   authorizes nothing**: the broker refuses it, so an abandoned flow leaves an unusable
   row rather than a working credential.
5. **Select** — `POST /api/projects/{projectId}/supabase` with `{action:"select"}`. The
   browser sends only a project ref; the server re-lists projects with the stored token
   and refuses a ref that is not in that list. Selection then registers the
   `external_supabase` provider row (`verified: true`, no service-role key) so the
   Backend Center can offer "Use this backend".
6. **Connected** — `GET` returns metadata only: ref, name, organization, status, granted
   scopes, expiry. Never a token.

## Refresh, revocation, disconnect

- **Refresh** — `{action:"refresh"}`, and automatically inside the broker. A token within
  60 s of expiry is refreshed **before use** by `resolveAccessToken`, which exchanges the
  stored refresh token and writes the new pair back. A refreshable token is never reported
  as "reconnect": that would tell the user to redo work Mavly can do itself.
- **Refused refresh** — terminal. Supabase answers 401 when the user revoked the app, so the
  row is marked `revoked` (or `reconnection_required` for any other failure) and the UI asks
  for a reconnection. Retrying would loop forever against a credential that will never work.
- **Revoked / expired** — the broker refuses with `token_revoked` or `token_expired`,
  and the card shows "Access revoked" / "Authorization expired" with a Reconnect action.
- **Disconnect** — `{action:"disconnect"}` deletes Mavly's token row only. The customer's
  Supabase project, its database and its data are untouched. The provider row is refused
  while it is the active backend, so a project is never left with none.

---

### How the agent actually uses this

The generation pipeline's provider contract has **no tool-calling support**: a request
carries messages and options, and a `tool_calls` finish reason is treated as a failure
(`src/lib/ai/chat-contract.ts`). There is therefore no tool loop for the agent to call the
broker from mid-generation, and adding one would be a new provider capability rather than a
Supabase change.

What exists instead, and works today:

1. **Schema context, read once before generation.** When the owner's `external_supabase`
   provider is the **active** backend, `loadSupabaseSchemaForRun` in
   `src/lib/mavly/run-agent.ts` reads the schema through the broker's read-only
   `read_schema` action and injects a bounded snapshot into the coding prompt
   (`src/lib/integrations/supabase/agent-context.ts`). The model builds against real tables
   instead of inventing them. It is website-only, capped at 12,000 characters, and labelled
   as data rather than instructions.
2. **Every failure is a null, never a failed run.** No connection, no OAuth app configured,
   a revoked token, a missing scope or an upstream error all mean "no schema context". The
   run proceeds exactly as it did before this integration existed.
3. **The action endpoint is the only execution path.** `POST …/supabase/actions` runs the
   full broker decision for the UI (and for any future caller). The agent never holds a
   token, and a mutating statement still requires explicit approval.

`src/lib/orchestration/tools.ts` declares `read_supabase_schema` and `run_supabase_sql` as
agent tool names and classifies SQL at validation time, but **the orchestration engine does
not execute them** — `toolCannotExecuteHere` says so explicitly. That registry is a
validation layer, not a live tool loop. Do not describe it as one.

## The agent action broker

`src/lib/integrations/supabase/broker.ts` is the only path from an agent or the UI to a
customer's Supabase project. **The agent never receives a token.** It proposes a
structured action; the server resolves the token, then checks action, scope, ownership
and approval before calling the Management API.

| Action | Scope | Mutating |
|---|---|---|
| `list_organizations` | `organizations:read` | no |
| `list_projects` | `projects:read` | no |
| `read_project_config` | `projects:read` | no |
| `read_schema` | `database:read` | no |
| `list_edge_functions` | `edge_functions:read` | no |
| `run_sql` | `database:write` | **yes — approval required** |

The action set is closed. There is no "run this raw request" action and no way to supply
a host, path, method or header. Adding an action is a code change, not a payload.

### SQL policy

Classification lives in `src/lib/integrations/supabase/sql-policy.ts` — pure, so the
orchestration layer can refuse a blocked statement at validation time without importing
the Management API client, the token store or the encryption key.

- **Refused outright, even with approval:** `drop database|schema`, `create/alter
  extension`, `create/alter role|user`, `grant`/`revoke`, `alter system`,
  `pg_read_file`/`pg_write_file`/`copy … from program`, `dblink`/`postgres_fdw`,
  `set session authorization`, and any multi-statement input.
- **Approval required:** `drop`, `truncate`, `delete`, `alter`, `update`, `insert`,
  `create`, `replace`, `rename` — and anything the classifier does not recognise, which
  fails closed.
- **No approval:** `select`, `with`, `explain`, `show`, `describe`, `table`.

This is a heuristic, not a parser. It fails closed by design.

### Audit

`supabase_oauth_audit` records who, which action, which project, allowed/refused/
pending_approval, and why. It stores **counts and identifiers only** — never SQL text,
never a row value, never a token fragment. The table is owner-readable, so it must be
safe to read.

---

## What is implemented vs. what still needs the external app

**Implemented and exercised by tests (`tests/supabase-oauth.test.ts`):**
state entropy and single-use consumption, PKCE S256, authorize-URL shape and the absent
`scope` parameter, token encryption round-trip and AAD isolation across user/project/
purpose/key, tamper rejection, project-ref validation, the full broker decision (closed
action set, pending-row refusal, cross-project isolation, revoked/expired, scope
enforcement, approval for destructive SQL, blocked-statement refusal, multi-statement
refusal), the schema-context projection and its bounds, the broker's refresh-not-reconnect
behaviour, and the migration's structural invariants (additive, transactional, no
plaintext token column, no authenticated write grant, pinned `search_path` on every
SECURITY DEFINER function, owner-checked token read).

**Requires the external OAuth app and a real Supabase account — not verified here:**
a live authorization round trip, a real code exchange, a real token refresh, a real
Management API call, a real SQL execution against a customer database, and migration 40
against a live database.

**Not implemented:** a hosting runtime for generated Next.js server code. The data
gateway does not yet resolve an `external_supabase` provider to serve a published
generated app, so generated-app runtime connectivity through this provider is **not**
claimed. The broker works server-side; the published app path does not exist yet.

**Also not implemented:** a mid-generation agent tool loop. The agent reads the schema
before generation and builds against it; it cannot issue further Supabase calls during a
run. See "How the agent actually uses this" above.

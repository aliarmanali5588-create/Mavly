# Backend & Source Control Center

The project Database page, rebuilt as three independent integration cards. Migration 39.

## What the page is

One page, three decisions that are deliberately not coupled:

| Card | Question it answers | Backed by |
| --- | --- | --- |
| Enable Backend on Mavly | Should Mavly provision and own my database? | Managed backend lifecycle + enrollment (migrations 30/35/37/38) |
| Connect Your Own Backend | Should my app use a Supabase project I own? | `project_backend_providers` (migration 39) |
| Connect GitHub | Where does my source live? | GitHub integration (existing, unchanged) |

GitHub is **source control, not a backend**. It never participates in provider
selection, and the page works fully without it.

## The authoritative-provider rule

A project has at most one active backend. This is a **database constraint**, not a
convention the UI is trusted to keep:

```sql
create unique index project_backend_providers_one_active_idx
  on public.project_backend_providers (project_id)
  where active;
```

Activation deactivates the previous provider and activates the target inside one
transaction, serialized by `pg_advisory_xact_lock(hashtext('backend_provider:' || project_id))`.
A concurrent pair of switches cannot leave two active rows.

### Selection and lifecycle are separate facts

- `status` — is the connection usable? (`not_connected`, `connecting`, `provisioning`,
  `ready`, `failed`, `suspended`, `disconnecting`, `reconnection_required`)
- `active` — is this the backend the generated app uses?

A provider can be `ready` and not `active`: a verified alternative the user has not
switched to. The UI shows both and never collapses them.

## Why the service-role key is not a project secret

`project_secrets` is the mechanism by which values reach a **deployed application's
environment** — see `DATABASE_URL_SECRET_NAME` in `src/lib/hosting/fullstack-database.ts`.
A Supabase service-role key bypasses RLS entirely, so storing it there would hand it to
generated code and to every end user of the generated app.

It therefore lives in `project_backend_providers.service_role_ciphertext`:

- AES-256-GCM via the existing `project-secrets` key.
- Associated data binds it to `(userId, projectId, "backend-provider:external_supabase")`,
  so a ciphertext copied to another row, project or account fails to decrypt rather than
  silently returning another user's key.
- Readable only through `read_backend_provider_secret`, which requires
  `auth.role() = 'service_role'`. No owner session can obtain it.
- Never returned by any route. The owner projection carries `hasServiceRoleKey` (a boolean).

The **anon key** is public by design and may be referenced as a project secret; only its
name is stored here.

## Credential validation

Validation is a real network check, not a shape check. `verifySupabaseCredentials`:

1. **Preflight (no network).** The URL must be `https` and match
   `^([a-z0-9-]+)\.supabase\.(co|in)$`. This is an allowlist, not a suffix test —
   `evil-supabase.co` ends with `supabase.co` and would pass a naive check, and the
   service-role key is sent to this origin.
2. **Key coherence.** Both JWTs must carry the same `ref` claim, and it must match the
   URL's project ref. The service-role key must actually carry `role: "service_role"` — an
   anon key pasted into that field would otherwise produce a connection that appears to
   work while every request silently ran with RLS applied.
3. **Two live probes** against `/rest/v1/` — one with the anon key, one with the
   service-role key. A timeout is a failure, never a pass.

Failure messages are fixed strings and never echo a credential.

## Switching

`decideBackendSwitch` is the single source of truth, used by both the API and the UI:

| Situation | Result |
| --- | --- |
| No active provider yet | Allowed, no confirmation (a first choice, not a switch) |
| Target already active | Refused: `already_active` |
| Target not connected | Refused: `target_not_connected` |
| Target not `ready`/`provisioning` | Refused: `target_not_ready` |
| Replacing a live provider, unconfirmed | `409 BACKEND_SWITCH_CONFIRMATION_REQUIRED` |
| Replacing a live provider, confirmed | Allowed |

The confirmation message states plainly that the existing database is not deleted and can
be switched back to. **Nothing in this flow deletes a Neon project, a Supabase project, or
customer data.** Only the `active` flag moves.

Disconnecting the active Supabase provider is refused by the RPC itself
(`switch to another backend before disconnecting this one`), so a direct RPC call cannot
leave a project with no backend.

## API

`GET|POST /api/projects/{projectId}/backend-providers`

Authorization order for every method: verified Mavly session → project ownership row →
provider table. The RPCs re-check ownership via `backend_provider_owner_ok`, so the route
is a fast honest refusal rather than the security boundary.

| Action | Body | Effect |
| --- | --- | --- |
| `connect_supabase` | `{ credentials: { projectUrl, anonKey, serviceRoleKey } }` | Verify, encrypt, store. Does **not** activate. |
| `switch` | `{ provider, confirmed? }` | Make one provider authoritative. |
| `disconnect_supabase` | — | Clear the row. Refused while active. |

`userId` is taken from the verified session, never the body. It is not cosmetic: the
ciphertext's associated data binds to it, so encrypting under a different id would produce
a key that can never be decrypted.

## Migration 39

Additive and non-destructive. Apply **after 38**.

- Creates `project_backend_providers` and its indexes.
- Creates `backend_provider_owner_ok`, `read_backend_providers`,
  `connect_external_supabase`, `activate_backend_provider`,
  `disconnect_external_supabase`, `read_backend_provider_secret`.
- Enables RLS with an owner `SELECT` policy and **no** `INSERT`/`UPDATE`/`DELETE` grant for
  `authenticated` or `anon`: every write goes through a fenced RPC.
- Records `backend_providers_schema_version() = 39` (the house convention from 35/37 is a
  version function, not a marker table).

It does not alter `projects`, `project_managed_backends`, `project_secrets`, or any earlier
table, and it contains no `drop`, `truncate` or `delete`.

### Pre-migration-39 projects

A project whose managed backend reached `ready` before this migration has no provider row.
`buildBackendCenterView` reports it as an active `mavly_managed_neon` provider
(`legacyManagedBackend: true`) rather than telling the owner they have no backend. No
backfill is required for the page to be correct.

## What is not verified

- No live Supabase project has been connected through this flow.
- Migration 39 has not been applied to any database.
- No generated app has been pointed at an `external_supabase` provider. The data path for
  a customer Supabase backend is **not** wired into the generation pipeline; this change
  establishes the authoritative provider record and the credential lifecycle, and the
  generated-app data path remains the managed-backend data API.

# Admin Users, Projects, and Billing Data

The Users and Projects sections are read-only views over Mavly's existing
Supabase records. The API routes use the signed-in caller's RLS-scoped client;
the database RPCs independently require `public.current_user_is_admin()`. They
do not use a service-role key and do not accept caller-supplied owner IDs.

## Database prerequisite

Migration 41 adds two admin-only read RPCs and a supporting index; it does not
change RLS policies, project ownership, payment data, or the generation queue.
It requires the admin/generation/deployment schema from migrations 7, 9, 10,
14, 15, 18, and 20. Migration 31's credit table is optional. Migration 44
updates the RPC output so missing names remain null instead of being inferred
from an email prefix or project ID. Apply migration 44 after migration 43; it
assumes migration 41's RPCs exist and replaces their exposed wrappers without
creating new tables.

## Users

`GET /api/adminsh/users` reads `auth.users`, optional `profiles` names,
project counts, admin allowlist membership, and available credits when the
credit-account table exists. Search supports name, email, and auth ID; status
uses the persisted `banned_until` field. Creation counts use UTC calendar
boundaries.

Plan and subscription fields are not present in the platform schema and are
shown as unavailable. A missing credit account is not interpreted as a funded
balance. Invite, plan-change, suspend/activate, and delete controls remain
disabled because no corresponding supported admin mutations exist.

## Projects

`GET /api/adminsh/projects` reads project labels, owner identity, creation and
update timestamps, the latest durable generation stage/model, and persisted
deployment/publication metadata. Search and status/visibility filters and
pagination run in the database RPC.

“Published Records” counts an active shared-hosting version, or a legacy
deployment row recorded as `ready` with a URL. It is not a live availability
probe. A shared-hosted project is considered published only when the
deployment points to an `active` version and is not explicitly unpublished.
Verified Mavly hostnames are displayed only for a recorded published state.
Route counts are not persisted and remain unavailable. URL links are limited to
validated HTTPS URLs. Project deletion and live preview actions are not
implemented and are not offered.

If the directory request fails, its response distinguishes an unavailable
RPC/schema-cache entry (`PGRST202` or `42883`) from missing prerequisite
relations/columns (`42P01` or `42703`), authorization (`42501`), database query
timeout (`57014`), and other query failures. Check the returned application
error code and sanitized server log SQLSTATE before changing the database.
Reapplying migration 41 is not an appropriate response to a missing prerequisite
table/column or stale PostgREST schema cache.

Read-only checks for the deployed schema:

```sql
select
  to_regprocedure('public.admin_user_directory(text,text,integer,integer)') as users_rpc,
  to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') as projects_rpc,
  to_regprocedure('public.current_user_is_admin()') as admin_gate;

with expected(table_schema, table_name, column_name) as (
  values
    ('public', 'projects', 'project_id'),
    ('public', 'projects', 'user_id'),
    ('public', 'projects', 'label'),
    ('public', 'project_runs', 'stage'),
    ('public', 'project_runs', 'model_used'),
    ('public', 'project_deployments', 'lifecycle'),
    ('public', 'project_deployments', 'active_version_id'),
    ('public', 'project_deployments', 'mavly_hostname'),
    ('public', 'project_deployments', 'mavly_domain_status'),
    ('public', 'project_published_versions', 'status'),
    ('public', 'admin_allowlist', 'email')
)
select
  expected.table_schema,
  expected.table_name,
  expected.column_name,
  installed_columns.column_name is not null as installed
from expected
left join information_schema.columns installed_columns
  on installed_columns.table_schema = expected.table_schema
 and installed_columns.table_name = expected.table_name
 and installed_columns.column_name = expected.column_name
order by expected.table_schema, expected.table_name, expected.column_name;
```

After confirming the application deployment, an authenticated admin can inspect
`GET /api/adminsh/projects?status=all&visibility=all&page=1&pageSize=10` and
`GET /api/adminsh/users?status=all&page=1&pageSize=5`. These are operator-run
checks; this change has not queried the production database or endpoints.

## Billing

The Billing & Revenue section intentionally displays unavailable values and an
empty transaction table. This repository has no Mavly-platform subscription,
invoice, or payment ledger. The credit ledger records generation usage and
reservations; it is not evidence of revenue. Razorpay orders and webhooks are
for customer-generated applications and must not be aggregated as Mavly
platform revenue. Search/export and refund actions are unavailable until a
real platform billing source and authorized backend are implemented.

## Mock-data scope

The Users, Projects, and Billing pages no longer consume demo datasets. Their
shared revenue chart also has no demo rendering path. The admin shell omits its
mock-telemetry ribbon only on these three sections; it remains unchanged for
the other admin sections. `MOCK_USERS_LIST` and credit fixtures are retained
for the separate Credits section and are not imported by the Users page.

## Manual acceptance

After the deployed database schema and application build are confirmed, an
authorized admin can inspect the Users and Projects pages and compare sample rows and
aggregates against the corresponding Supabase records. Also verify a signed-in
non-admin receives the same non-enumerating denial used by the existing admin
routes, and that Billing continues to show no fabricated platform transactions.
Repository inspection cannot confirm the live database schema, deployment
version, or API response. Those production checks require operator access and
are not performed by this runbook change. Automated checks are governed by the
repository's `AGENTS.md` policy.

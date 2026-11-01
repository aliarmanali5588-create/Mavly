# Admin Users, Projects, and Billing Data

The Users and Projects sections are read-only views over Mavly's existing
Supabase records. The API routes use the signed-in caller's RLS-scoped client;
the database RPCs independently require `public.current_user_is_admin()`. They
do not use a service-role key and do not accept caller-supplied owner IDs.

## Database prerequisite

Apply `supabase/migrations/41_admin_directory.sql` after the existing migrations
through 40, including the admin/generation/deployment schema from migrations
7, 9, 10, 14, 15, 18, and 20. Migration 31's credit table is optional. It adds
two admin-only read RPCs and a supporting index; it does not
change RLS policies, project ownership, payment data, or the generation queue.
The migration has not been applied to any live database by this change.

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

## Billing

The Billing & Revenue section intentionally displays unavailable values and an
empty transaction table. This repository has no Mavly-platform subscription,
invoice, or payment ledger. The credit ledger records generation usage and
reservations; it is not evidence of revenue. Razorpay orders and webhooks are
for customer-generated applications and must not be aggregated as Mavly
platform revenue. Search/export and refund actions are unavailable until a
real platform billing source and authorized backend are implemented.

## Manual acceptance

After applying the migration in a non-production environment, an authorized
admin can inspect the Users and Projects pages and compare sample rows and
aggregates against the corresponding Supabase records. Also verify a signed-in
non-admin receives the same non-enumerating denial used by the existing admin
routes, and that Billing continues to show no fabricated platform transactions.
Automated checks are governed by the repository's `AGENTS.md` policy.

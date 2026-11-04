# Phase 15: AWS static frontend hosting

## Status

Repository implementation is **opt-in and not production-ready**. This task does not
change AWS resources, DNS records, database state, production environment variables,
or live publications. The supplied account-side bucket, KVS, instance role, and
policy are production candidates with only the operator-reported partial verification;
the dedicated staging stack still requires operator deployment and acceptance.

The feature adds an immutable S3 publisher, a CloudFront KeyValueStore (KVS) tenant
router, and a durable publication side queue processed by the existing AWS generation
worker. Supabase remains authoritative for Mavly users, projects, files, versions,
deployment state, and queue leases. Neon remains the existing customer-application
database provider; this phase does not replace or modify its provisioning, encryption,
schema compiler, or data gateway.

## Request and publication flow

1. The authenticated project API verifies ownership and evaluates database-driven
   hosting eligibility (migration 61). There is no per-customer project allowlist:
   the rules are ownership, an unrestricted account, a website project with
   completed generated source, the canonical billing plan's project ceiling, the
   number of already-published sites and platform capacity. Existing Vercel and
   shared-hosting rows are refused with a migration-required response instead of
   being silently switched.
2. The deployment service persists a draft `project_published_versions` record and
   its `project_published_files`, then queues it through migration 51. Existing
   deployment rows, generation queue rows, and user data are not seeded or rewritten.
3. When no generation, verification, or Android build job advances on a worker tick,
   the existing worker claims one AWS unpublish or publication using a database lease
   and fencing token. It verifies the owner, immutable file manifest, size limits,
   content hash, and entry path before a publication.
4. The worker writes objects to
   `<project-id>/<version-id>/<relative-file-path>` using the existing EC2 instance
   profile. Per-object SHA-256, byte length, content type, project ID, and version ID
   are checked. Objects already matching the exact manifest are reused on retries;
   conflicting immutable objects fail the attempt. The worker has no object-delete
   permission.
5. After S3 verification, the worker renews its queue lease, updates the KVS mapping,
   and calls the fenced completion RPC. The database transaction activates the new
   version and marks the deployment ready. If KVS activation or completion fails, the
   worker attempts to restore the route to the database's prior active version; a
   failed compensation remains a recoverable worker error, not a reported success.
6. CloudFront's viewer-request Function resolves a hostname through KVS and rewrites
   the URI to the immutable S3 prefix. The browser URL remains
   `<project-id>.mavly.xyz`; the Function makes no Supabase/PostgREST request.
7. An AWS unpublish request queues durable work and remains `unpublishing`. The
   worker writes a generation-fenced disabled KVS tombstone, verifies the public
   tenant route returns 404, and only then calls the fenced RPC that clears the
   active-version pointer. Project deletion waits until that operation is complete.

The KVS value is JSON:

```json
{
  "projectId": "<project-id>",
  "versionId": "<published-version-uuid>",
  "entryPath": "index.html",
  "spaFallback": true,
  "generation": 12
}
```

The key is the exact project ID derived from the validated tenant hostname. The
Function checks that the value's project ID matches the hostname and validates the
version and relative path before rewriting. A monotonically increasing database
generation fences stale workers and unpublish operations; removal writes a disabled
tombstone instead of deleting the KVS key. The rewritten URI includes both project
and version, so cache entries cannot collide across tenants or publications.

## Safety and rollout boundary

- S3 is private, blocks public access, enforces bucket ownership, enables encryption
  and versioning, and is readable only through CloudFront OAC.
- Publication keys are immutable. There is no arbitrary `DeleteObject` permission,
  no public S3 website endpoint, and no cache invalidation dependency.
- The database publication lease is renewed every minute during bounded S3 upload and
  verification, with a six-minute operation deadline inside the seven-minute lease.
  Stale workers cannot complete a newer worker's lease.
- Authenticated callers may create an AWS queued attempt and request unpublish, but
  migrations 51 and 56 block owner-side project reassignment, live-pointer,
  generation, ready/unpublished, provider-migration, publication-timestamp, and
  unsafe-delete mutations. Worker-only SECURITY DEFINER functions own live
  activation, route mutation, and terminal unpublish. The worker completion RPC
  records `verified` only after the exact owner/project route probe; the authenticated
  status read re-probes a pending route and projects `verified` only for that response;
  no browser-callable RPC can mark a route verified. The project-delete trigger
  requires the worker-confirmed `unpublished` state.
- A failed publish leaves the existing database active-version pointer unchanged.
  Cross-service activation is not a distributed transaction; the worker uses a
  lease/CAS- and expected-version-fenced compensating KVS restore and retries when
  the result is uncertain.
- AWS status and unpublish use the persisted provider. The API only queues AWS route
  removal; KVS mutations run on the existing EC2 worker. Removal remains available
  with the feature flag disabled if the KVS ARN and worker credentials are retained.
- Deleting an AWS-hosted project waits for the worker to remove its public KVS route
  and confirm the public 404. If that cannot be confirmed, project deletion is
  refused so an orphaned public route is not left behind.
- Existing shared-hosting and legacy Vercel sites are not automatically copied,
  backfilled, or served through CloudFront. **Do not point the wildcard DNS record
  at this distribution.** A resumable legacy migration utility and CloudFront
  dual-read fallback are not implemented. A DNS cutover before those exist would
  break unmapped existing tenant hostnames.
- There is no AWS rollback endpoint/UI yet. Republish is supported; switching back
  to a prior immutable AWS version requires a separately implemented, owner-checked
  rollback operation. Do not describe this release as having rollback support.
- CloudFront access-log delivery and live AWS alerting are not configured in the
  template. The normal worker emits sanitized publication outcome events. Logging
  setup remains operator work before production acceptance.

## Infrastructure reconciliation and staging

The operator supplied these existing production candidates:

- account `505384438340`, worker region `eu-north-1`;
- EC2 `i-05ac7a8d4a0e1d499` (`mavly-generation-worker`) with role `MavlyEC2SSMRole`;
- S3 bucket `mavly-frontend-505384438340-eu-north-1-an`;
- CloudFront KVS `mavly-tenant-routing-prod`, ARN
  `arn:aws:cloudfront::505384438340:key-value-store/5ea7516a-8088-4833-9749-4aac8b6f652c`;
- attached policy `MavlyAWSFrontendHostingPublisher`.

The operator reported successful role assumption, `HeadBucket`, KVS description, and
IAM policy simulation. Actual object writes, object reads, KVS reads, and KVS updates
remain only partially verified. No CloudFront distribution, OAC, Function, certificate,
or DNS change is claimed here. The existing bucket and KVS are therefore treated as
production candidates and are not staging resources.

`infra/aws-frontend-hosting/template.yaml` now has an isolated staging default:

- creates a new retained private/versioned S3 bucket and a stack-named KVS;
- uses the existing EC2 role but attaches a stack-scoped publisher policy only when
  `AttachWorkerHostingPolicy=true`;
- grants only the S3 object actions, bucket-scoped `s3:ListBucket` needed to
  distinguish missing `HeadObject` results, and KVS actions used by the code, with no
  delete access, other-bucket listing, IAM, or CloudFront administration;
- derives one exact staging alias from the validated `StagingProjectId`, while the
  production branch is the only branch that contains the reviewed `*.mavly.xyz`
  alias;
- can reuse an existing bucket/KVS only with explicit parameters, and can leave an
  existing bucket policy untouched with `ManageFrontendBucketPolicy=false`.

It does not create an EC2 instance, instance profile, ACM certificate, or DNS record.
The ACM certificate must already exist in `us-east-1`. The staging runbook requires an
exact DNS record for one disposable internal project; it never changes `*.mavly.xyz`.

The application and worker need the same non-secret hosting configuration:

- `MAVLY_AWS_FRONTEND_HOSTING_ENABLED`
- `MAVLY_AWS_S3_BUCKET`
- `MAVLY_AWS_REGION`
- `MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN`
- `MAVLY_AWS_FRONTEND_HOSTING_PROJECTS` — **optional emergency restriction only**

These are environment-level infrastructure identifiers, set once. New customer
projects require no variable change, because eligibility is read from Supabase.
`MAVLY_AWS_FRONTEND_HOSTING_PROJECTS` is empty in normal operation; an explicit list
temporarily confines a deployment (for example staging) to those project ids. A
wildcard is rejected. Removing the list needs no AWS or DNS change.

Keep the flag unset/off until migrations 51, 56 and 61 are applied, the worker role is
confirmed, and staging acceptance is complete. Production must use
`MAVLY_AWS_FRONTEND_HOSTING_ENABLED=false` until that acceptance happens.

## Automatic eligibility, entitlements and capacity (migration 61)

### What decides eligibility

The owner-scoped `public.aws_hosting_eligibility(p_project_id)` RPC is the authority
for an authenticated caller. It derives every fact from `auth.uid()`; the browser
supplies no plan, quota, ownership or capacity value. The structured reasons are
`eligible`, `project_not_found`, `ownership_mismatch`, `project_not_publishable`,
`generation_incomplete`, `plan_not_allowed`, `project_limit_reached`,
`user_suspended`, `hosting_capacity_exceeded` and `platform_hosting_disabled`.

Order matters: ownership and suspension outrank plan and capacity, so a caller never
learns capacity details for a project they do not own. The enqueue RPC re-evaluates
the same rules inside its transaction; a direct RPC call cannot bypass them. The EC2
worker re-proves the owner and re-evaluates eligibility with the service-role-only
`aws_hosting_worker_authorization` before touching S3.

### Entitlements use the canonical billing system

No second pricing or entitlement system exists. The project ceiling comes from the
existing billing catalog (`price_catalog.project_limit`, read through
`billing_user_entitlements()` for the owner and the same catalog for the worker).
The concurrently published-site ceiling is that canonical project limit, unless an
operator sets the optional platform-wide `max_published_sites` bound. Publishing does
not reserve or consume generation credits; the eligibility response reports
`creditsRequired = 0` and available credits are informational only.

No new customer-facing plan feature or price is introduced by this phase. If a
future product decision adds a hosting-specific entitlement, it must be added to the
canonical catalog and consumed here rather than hardcoded in application code.

### Platform capacity and abuse protection

`public.hosting_platform_settings` is one service-role-only row with
`publication_enabled`, `max_active_publications`, `max_queued_publications` and an
optional `max_published_sites`. It is stable platform configuration, never a
per-customer value. `publication_enabled = false` refuses new publications without
taking an existing route down.

The existing per-instance deploy/unpublish window (`publish-limits.ts`) remains a
best-effort anti-loop guard; the durable queue bound above is the authoritative
platform ceiling and is shared across instances.

When the queue is saturated, admission returns `429 HOSTING_CAPACITY_EXCEEDED` and
does **not** enqueue the request; no uncontrolled retry loop is created. When a worker
tick sees capacity unavailable, it advances no publication and the already-queued job
stays queued, so work resumes automatically on a later tick. Existing per-user and
global deployment admission windows (`src/lib/hosting/publish-limits.ts`) and the
durable per-version retry ceiling remain in force.

## Database and existing systems

Apply `supabase/migrations/51_aws_frontend_deployment.sql` only after migrations 13,
14, 15, 32 and 49, then apply
`supabase/migrations/56_aws_frontend_fencing_and_status.sql` after migration 55, then
apply `supabase/migrations/61_aws_hosting_eligibility.sql` after migration 57.
Migration 51 adds
provider support, the AWS publication queue and fenced lifecycle RPCs. Migration 56
adds the corrective ownership CAS, worker-verified completion, protected authenticated
column grants, and marker 56. Migration 61 adds the platform capacity singleton
(`hosting_platform_settings`), the owner eligibility RPC, the service-role worker
authorization RPC, capacity admission, and the enqueue-time eligibility guard; it
derives customer limits from the canonical billing catalog instead of introducing a
second entitlement system. Neither migration depends on migration 20 or 50,
alters Neon provisioning authority, or has been applied or exercised against a
database in this task.

Neon provisioning and generated-app connectivity continue through the existing
managed-backend enrollment, configuration, migration runner, and data-gateway
contracts. This phase does not provision Neon automatically or change generation
requirements. AWS hosting serves static files only; it is not a runtime for generated
Next.js server code.

## Required acceptance before production

1. Reconcile the supplied bucket, KVS, IAM role, and policy using the runbook's
   read-only commands; do not overwrite them.
2. Deploy and inspect the isolated staging stack with one exact approved tenant alias.
3. Review and apply migrations 51, 56 and 61 after their prerequisites in a staging
   database, then verify every schema marker (51, 56 and 61).
4. Run the existing AWS worker with the same feature settings and confirmed EC2
   instance profile; do not install long-lived access keys or a second worker.
5. Test a disposable internal project end-to-end: publish, retry after partial upload,
   verify exact asset bytes and SPA behavior, unpublish, delete, and confirm the old
   route is not served.
6. Add CloudFront access logging and alerts, and implement/test owner-checked rollback
   and a resumable shared/Vercel migration with dual-read compatibility.
7. Only after every existing hostname has a verified serving path may operators review
   a wildcard DNS cutover; production DNS cutover is outside this task.

Until then, production readiness is **BLOCKED**. See
[the AWS frontend setup runbook](../runbooks/aws-frontend-setup.md).

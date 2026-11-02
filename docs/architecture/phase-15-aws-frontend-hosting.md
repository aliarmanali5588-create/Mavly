# Phase 15: AWS static frontend hosting

## Status

Repository implementation is **opt-in and not production-ready**. No AWS resources,
DNS records, migrations, production environment variables, or live publications have
been changed or verified.

The feature adds an immutable S3 publisher, a CloudFront KeyValueStore (KVS) tenant
router, and a durable publication side queue processed by the existing AWS generation
worker. Supabase remains authoritative for Mavly users, projects, files, versions,
deployment state, and queue leases. Neon remains the existing customer-application
database provider; this phase does not replace or modify its provisioning, encryption,
schema compiler, or data gateway.

## Request and publication flow

1. The authenticated project API verifies ownership and checks the AWS feature flag
   and explicit project cohort. Existing Vercel and shared-hosting rows are refused
   with a migration-required response instead of being silently switched.
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
- The database publication lease is renewed before the external routing mutation.
  Stale workers cannot complete a newer worker's lease.
- A failed publish leaves the existing database active-version pointer unchanged.
  Cross-service activation is not a distributed transaction; the worker uses a
  compensating KVS restore and retries when the result is uncertain.
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

## Infrastructure and configuration

`infra/aws-frontend-hosting/template.yaml` prepares a private bucket, OAC, KVS,
CloudFront Function/distribution, wildcard alias, and a least-privilege policy
attached to a **named existing worker role**. It does not create an EC2 instance or
instance profile. The template has not been deployed or validated against an AWS
account. The ACM certificate must already exist in `us-east-1`.

The application and worker need the same non-secret hosting configuration:

- `MAVLY_AWS_FRONTEND_HOSTING_ENABLED`
- `MAVLY_AWS_S3_BUCKET`
- `MAVLY_AWS_REGION`
- `MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN`
- `MAVLY_AWS_FRONTEND_HOSTING_PROJECTS`

Keep the flag unset/off until the migration is applied, the worker role is confirmed,
and staging acceptance is complete. A wildcard (`*`) cohort is not a safe rollout
shortcut.

## Database and existing systems

Apply `supabase/migrations/51_aws_frontend_deployment.sql` only after migrations 14,
15, and 16 through the project's reviewed migration process. It adds provider support,
the AWS publication queue and fenced lifecycle RPCs, and immutable-version guards.
It is additive and does not depend on migration 50 or alter Neon provisioning
authority. It has not been applied or exercised against a database.

Neon provisioning and generated-app connectivity continue through the existing
managed-backend enrollment, configuration, migration runner, and data-gateway
contracts. This phase does not provision Neon automatically or change generation
requirements. AWS hosting serves static files only; it is not a runtime for generated
Next.js server code.

## Required acceptance before production

1. Review and apply migration 51 after its prerequisites in a staging database.
2. Deploy the infrastructure template in a non-production AWS account/stack and
   verify its actual resource and role policy.
3. Run the existing AWS worker with the same feature settings and confirmed EC2
   instance profile; do not install long-lived access keys.
4. Test a new internal project end-to-end: publish, retry after partial upload,
   verify exact asset bytes and SPA behavior, unpublish, delete, and confirm the old
   route is not served.
5. Add CloudFront access logging and alerts, and implement/test rollback and a
   resumable shared/Vercel migration with dual-read compatibility.
6. Only after every existing hostname has a verified serving path may operators
   review a wildcard DNS cutover.

Until then, production readiness is **BLOCKED**. See
[the AWS frontend setup runbook](../runbooks/aws-frontend-setup.md).
